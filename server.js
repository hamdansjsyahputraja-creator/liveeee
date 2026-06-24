const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

// === STATE (single source of truth, disimpan di memory) ===
const state = {
  remainingSeconds: parseInt(process.env.DEFAULT_DURATION || '60', 10),
  secondsPerCoin: parseInt(process.env.SECONDS_PER_COIN || '5', 10),
  paused: true,
  tiktokUsername: process.env.TIKTOK_USERNAME || '',
  connected: false,
  lastEvent: null,
  labelText: process.env.LABEL_TEXT || 'MARATHON TIME',
};

let clients = [];
let tiktokConnection = null;

wss.on('connection', (ws) => {
  clients.push(ws);
  ws.send(JSON.stringify({ type: 'state', state }));
  ws.on('close', () => {
    clients = clients.filter((c) => c !== ws);
  });
});

function broadcastState() {
  const msg = JSON.stringify({ type: 'state', state });
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastGift(payload) {
  const msg = JSON.stringify({ type: 'gift', ...payload });
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Countdown tick tiap 1 detik, server yang pegang kontrol penuh
setInterval(() => {
  if (!state.paused && state.remainingSeconds > 0) {
    state.remainingSeconds--;
    broadcastState();
  }
}, 1000);

// === TIKTOK CONNECTION ===
function connectTikTok(username) {
  if (tiktokConnection) {
    try { tiktokConnection.disconnect(); } catch (e) {}
    tiktokConnection = null;
  }
  if (!username) {
    state.connected = false;
    broadcastState();
    return;
  }

  tiktokConnection = new TikTokLiveConnection(username);

  tiktokConnection
    .connect()
    .then((info) => {
      state.connected = true;
      state.tiktokUsername = username;
      console.log(`Connected ke room TikTok: ${info.roomId}`);
      broadcastState();
    })
    .catch((err) => {
      state.connected = false;
      console.error('Gagal connect ke TikTok Live:', err.message || err);
      broadcastState();
    });

  tiktokConnection.on(ControlEvent.DISCONNECTED, () => {
    state.connected = false;
    broadcastState();
  });

  tiktokConnection.on(WebcastEvent.GIFT, (data) => {
    const giftType = data.giftDetails?.giftType;
    const giftName = data.giftDetails?.giftName || 'Gift';
    const uniqueId = data.user?.uniqueId || 'someone';

    if (giftType === 1 && !data.repeatEnd) return; // tunggu streak selesai

    const totalCoins = (data.diamondCount || 0) * (data.repeatCount || 1);
    const addedSeconds = totalCoins * state.secondsPerCoin;

    state.remainingSeconds += addedSeconds;
    state.lastEvent = `${uniqueId} +${addedSeconds}s (${giftName} x${data.repeatCount})`;

    broadcastGift({
      seconds: addedSeconds,
      coins: totalCoins,
      user: uniqueId,
      giftName,
    });
    broadcastState();
  });

  tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
    const uniqueId = data.user?.uniqueId || 'someone';
    state.remainingSeconds += 5;
    state.lastEvent = `${uniqueId} follow +5s`;
    broadcastGift({ seconds: 5, coins: 0, user: uniqueId, giftName: 'Follow' });
    broadcastState();
  });
}

if (state.tiktokUsername) connectTikTok(state.tiktokUsername);

// === REST API untuk admin panel ===
app.post('/api/tiktok/connect', (req, res) => {
  const { username } = req.body;
  connectTikTok(username);
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const { secondsPerCoin, labelText } = req.body;
  if (secondsPerCoin !== undefined) state.secondsPerCoin = parseInt(secondsPerCoin, 10);
  if (labelText !== undefined) state.labelText = labelText;
  broadcastState();
  res.json({ ok: true, state });
});

app.post('/api/timer/set', (req, res) => {
  const { seconds } = req.body;
  state.remainingSeconds = parseInt(seconds, 10) || 0;
  broadcastState();
  res.json({ ok: true, state });
});

app.post('/api/timer/add', (req, res) => {
  const { seconds } = req.body;
  state.remainingSeconds = Math.max(0, state.remainingSeconds + (parseInt(seconds, 10) || 0));
  broadcastState();
  res.json({ ok: true, state });
});

app.post('/api/timer/pause', (req, res) => {
  state.paused = true;
  broadcastState();
  res.json({ ok: true, state });
});

app.post('/api/timer/resume', (req, res) => {
  state.paused = false;
  broadcastState();
  res.json({ ok: true, state });
});

app.get('/api/state', (req, res) => res.json(state));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
