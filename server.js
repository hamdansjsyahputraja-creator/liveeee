require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ganti-password-ini";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

// =======================================================
// DUA JALUR WEBSOCKET DI SATU SERVER HTTP YANG SAMA:
//   "/"          -> koneksi DARI Minecraft (lewat command /connect)
//   "/admin-ws"  -> koneksi dari web admin panel (live update di browser)
// =======================================================
const wssAdmin = new WebSocketServer({ noServer: true });
const wssGame = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/admin-ws")) {
    wssAdmin.handleUpgrade(req, socket, head, (ws) => wssAdmin.emit("connection", ws, req));
  } else {
    wssGame.handleUpgrade(req, socket, head, (ws) => wssGame.emit("connection", ws, req));
  }
});

// =======================================================
// STATE
// =======================================================
const state = {
  connection: null, // koneksi TikTok Live
  connected: false,
  username: null,
  viewerCount: 0,
  tntQueue: 0,
  totalTntSpawned: 0,
  mcConnections: 0,
  log: [],
};

const mcClients = new Set();

function pushLog(type, message) {
  const entry = { type, message, time: new Date().toISOString() };
  state.log.unshift(entry);
  if (state.log.length > 50) state.log.pop();
  broadcastAdmin({ event: "log", data: entry });
}

function broadcastAdmin(payload) {
  const text = JSON.stringify(payload);
  wssAdmin.clients.forEach((client) => {
    if (client.readyState === 1) client.send(text);
  });
}

function broadcastStatus() {
  broadcastAdmin({
    event: "status",
    data: {
      connected: state.connected,
      username: state.username,
      viewerCount: state.viewerCount,
      tntQueue: state.tntQueue,
      totalTntSpawned: state.totalTntSpawned,
      mcConnections: state.mcConnections,
    },
  });
}

function requireAdminPassword(req, res, next) {
  const pass = req.header("X-Admin-Password");
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password admin salah" });
  }
  next();
}

// =======================================================
// JEMBATAN KE MINECRAFT (lewat /connect command)
// =======================================================
function sendCommand(ws, commandLine) {
  const message = {
    header: {
      version: 1,
      requestId: crypto.randomUUID(),
      messagePurpose: "commandRequest",
    },
    body: {
      version: 1,
      commandLine,
      origin: { type: "player" },
    },
  };
  try {
    ws.send(JSON.stringify(message));
  } catch (_) {
    // koneksi mungkin sudah putus, abaikan
  }
}

// @r = pilih 1 player ONLINE secara random (vanilla selector).
// Jadi 1 panggilan = 1 TNT muncul di salah satu player yang online.
function spawnOneTnt() {
  if (mcClients.size === 0) return false;
  const client = mcClients.values().next().value;
  const offsetX = (Math.random() * 4 - 2).toFixed(1);
  const offsetZ = (Math.random() * 4 - 2).toFixed(1);
  sendCommand(client, `execute as @r at @s run summon tnt ~${offsetX} ~3 ~${offsetZ}`);
  return true;
}

wssGame.on("connection", (ws) => {
  mcClients.add(ws);
  state.mcConnections = mcClients.size;
  pushLog("connect", `Minecraft terhubung ke bridge (${mcClients.size} koneksi aktif)`);
  broadcastStatus();

  ws.on("close", () => {
    mcClients.delete(ws);
    state.mcConnections = mcClients.size;
    pushLog("disconnect", "Minecraft putus dari bridge");
    broadcastStatus();
  });

  ws.on("message", () => {
    // Kita cuma kirim command, balasan dari game diabaikan.
  });
  ws.on("error", () => {});
});

// Drip-feed antrian TNT pelan-pelan (bukan sekaligus), biar nggak banjir
// command kalau ada gift besar yang masuk dalam satu waktu.
setInterval(() => {
  if (state.tntQueue <= 0) return;
  const batch = Math.min(state.tntQueue, 5);
  let spawned = 0;
  for (let i = 0; i < batch; i++) {
    if (!spawnOneTnt()) break; // tidak ada Minecraft yang connect, stop
    spawned++;
  }
  if (spawned > 0) {
    state.tntQueue -= spawned;
    state.totalTntSpawned += spawned;
    broadcastStatus();
  }
}, 300);

// =======================================================
// TIKTOK LIVE
// =======================================================
async function connectTikTok(username, sessionId) {
  if (state.connection) {
    try {
      await state.connection.disconnect();
    } catch (_) {}
    state.connection = null;
  }

  const options = {};
  if (sessionId && sessionId.trim().length > 0) {
    options.session = { cookie: sessionId.trim() };
  }

  const connection = new TikTokLiveConnection(username, options);
  state.connection = connection;
  state.username = username;

  connection.on(WebcastEvent.CONNECT, () => {
    state.connected = true;
    pushLog("connect", `Berhasil connect ke live @${username}`);
    broadcastStatus();
  });

  connection.on(WebcastEvent.DISCONNECT, () => {
    state.connected = false;
    pushLog("disconnect", `Terputus dari live @${username}`);
    broadcastStatus();
  });

  connection.on(WebcastEvent.ROOM_USER, (data) => {
    if (typeof data.viewerCount === "number") {
      state.viewerCount = data.viewerCount;
      broadcastStatus();
    }
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    const isStreakInProgress = data.giftType === 1 && !data.repeatEnd;
    if (isStreakInProgress) return;

    const coins = (data.diamondCount || 0) * (data.repeatCount || 1);
    if (coins <= 0) return;

    state.tntQueue += coins;
    pushLog(
      "gift",
      `${data.nickname || data.uniqueId} kirim ${data.giftName || "gift"} x${data.repeatCount} (${coins} coin -> ${coins} TNT)`
    );
    broadcastStatus();
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    state.tntQueue += 1;
    pushLog("gift", `${data.nickname || data.uniqueId} follow (+1 TNT)`);
    broadcastStatus();
  });

  await connection.connect();
}

async function disconnectTikTok() {
  if (state.connection) {
    try {
      await state.connection.disconnect();
    } catch (_) {}
    state.connection = null;
  }
  state.connected = false;
  state.username = null;
  state.viewerCount = 0;
  broadcastStatus();
}

// =======================================================
// API: DIPAKAI WEB ADMIN
// =======================================================
app.get("/api/status", (req, res) => {
  res.json({
    connected: state.connected,
    username: state.username,
    viewerCount: state.viewerCount,
    tntQueue: state.tntQueue,
    totalTntSpawned: state.totalTntSpawned,
    mcConnections: state.mcConnections,
    log: state.log,
  });
});

app.post("/api/connect", requireAdminPassword, async (req, res) => {
  const { username, sessionId } = req.body || {};
  if (!username || username.trim().length === 0) {
    return res.status(400).json({ error: "Username TikTok wajib diisi" });
  }
  try {
    await connectTikTok(username.trim().replace(/^@/, ""), sessionId);
    res.json({ ok: true });
  } catch (err) {
    pushLog("error", `Gagal connect: ${err.message || err}`);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/disconnect", requireAdminPassword, async (req, res) => {
  await disconnectTikTok();
  res.json({ ok: true });
});

app.post("/api/test-spawn", requireAdminPassword, (req, res) => {
  const count = Math.max(1, Math.min(500, parseInt(req.body?.count, 10) || 1));
  state.tntQueue += count;
  pushLog("test", `Test spawn manual: +${count} TNT`);
  broadcastStatus();
  res.json({ ok: true, tntQueue: state.tntQueue });
});

app.post("/api/reset-queue", requireAdminPassword, (req, res) => {
  state.tntQueue = 0;
  pushLog("test", "Queue TNT di-reset ke 0");
  broadcastStatus();
  res.json({ ok: true });
});

wssAdmin.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      event: "status",
      data: {
        connected: state.connected,
        username: state.username,
        viewerCount: state.viewerCount,
        tntQueue: state.tntQueue,
        totalTntSpawned: state.totalTntSpawned,
        mcConnections: state.mcConnections,
      },
    })
  );
});

server.listen(PORT, () => {
  console.log(`Gift TNT backend jalan di port ${PORT}`);
});
