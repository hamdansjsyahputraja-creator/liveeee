require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

const PORT = process.env.PORT || 3000;
const ADDON_SECRET = process.env.ADDON_SECRET || "ganti-secret-ini";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ganti-password-ini";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// =======================================================
// STATE
// =======================================================
const state = {
  connection: null,
  connected: false,
  username: null,
  viewerCount: 0,
  tntQueue: 0,
  totalTntSpawned: 0,
  log: [], // log event terbaru, max 50
};

function pushLog(type, message) {
  const entry = { type, message, time: new Date().toISOString() };
  state.log.unshift(entry);
  if (state.log.length > 50) state.log.pop();
  broadcast({ event: "log", data: entry });
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(text);
  });
}

function broadcastStatus() {
  broadcast({
    event: "status",
    data: {
      connected: state.connected,
      username: state.username,
      viewerCount: state.viewerCount,
      tntQueue: state.tntQueue,
      totalTntSpawned: state.totalTntSpawned,
    },
  });
}

// =======================================================
// MIDDLEWARE AUTH
// =======================================================
function requireAddonSecret(req, res, next) {
  const secret = req.header("X-Addon-Secret");
  if (secret !== ADDON_SECRET) {
    return res.status(401).json({ error: "Secret addon salah" });
  }
  next();
}

function requireAdminPassword(req, res, next) {
  const pass = req.header("X-Admin-Password");
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password admin salah" });
  }
  next();
}

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
    // Gift streak (giftType 1) terus menembak event sampai repeatEnd true.
    // Kita hanya proses sekali di akhir streak biar tidak dobel hitung.
    const isStreakInProgress = data.giftType === 1 && !data.repeatEnd;
    if (isStreakInProgress) return;

    const coins = (data.diamondCount || 0) * (data.repeatCount || 1);
    if (coins <= 0) return;

    state.tntQueue += coins;
    state.totalTntSpawned += coins;

    pushLog(
      "gift",
      `${data.nickname || data.uniqueId} kirim ${data.giftName || "gift"} x${data.repeatCount} (${coins} coin -> ${coins} TNT)`
    );
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
// API: DIPAKAI ADDON MINECRAFT
// =======================================================

// Addon polling endpoint ini. Hanya melepas sejumlah "max" TNT,
// sisanya tetap tersimpan di queue untuk polling berikutnya.
app.get("/api/tnt-queue", requireAddonSecret, (req, res) => {
  const max = Math.max(0, parseInt(req.query.max, 10) || 40);
  const release = Math.min(state.tntQueue, max);
  state.tntQueue -= release;
  if (release > 0) broadcastStatus();
  res.json({ count: release, remaining: state.tntQueue });
});

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

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      event: "status",
      data: {
        connected: state.connected,
        username: state.username,
        viewerCount: state.viewerCount,
        tntQueue: state.tntQueue,
        totalTntSpawned: state.totalTntSpawned,
      },
    })
  );
});

server.listen(PORT, () => {
  console.log(`Gift TNT backend jalan di port ${PORT}`);
});
