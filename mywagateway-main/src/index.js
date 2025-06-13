require('dotenv').config();
const express = require('express');
const config = require('../config/default');
const cors = require('cors');
const { startGateway, getLastQr } = require('./gateway');
const { healthCheck } = require('./utils/keepAlive');
const { logger } = require('./utils/logger');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

// Health check endpoint (untuk keep-alive)
app.get('/healthz', healthCheck);

// Endpoint QR code WhatsApp (HTML interaktif dengan Tailwind)
const QRCode = require('qrcode');
// Serve static file untuk client
const path = require('path');
app.use(express.static(path.join(__dirname, '../client')));
app.use('/client', express.static(path.join(__dirname, '../client')));

// Endpoint status dashboard (status koneksi, queue, dsb)
app.get('/dashboard/status', (req, res) => {
  const { getStatus } = require('./gateway');
  const status = getStatus ? getStatus() : 'unknown';
  const queue_length = getQueueLength();
  const est_delay_sec = queue_length > 0 ? Math.round((queue_length + 1) * INTERVAL_MS / 1000) : 0;
  res.json({ connection_status: status, queue_length, est_delay_sec });
});

// Endpoint root dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Endpoint /qr redirect ke file statis client/qr.html
app.get('/qr', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/qr.html'));
});

// Endpoint mudah untuk test kirim pesan
app.get('/send', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/send.html'));
});

// Endpoint monitoring queue (JSON)
const { getQueueLength, getQueueDetails, getInFlightMessage, RATE_LIMIT_PER_MIN, INTERVAL_MS } = require('./utils/messageQueue');
app.get('/queue/status', (req, res) => {
  const queue_length = getQueueLength();
  const queue_details = getQueueDetails();
  const in_flight = getInFlightMessage();
  const est_delay_sec = queue_length > 0 ? Math.round((queue_length + 1) * INTERVAL_MS / 1000) : 0;
  res.json({ queue_length, rate_limit_per_min: RATE_LIMIT_PER_MIN, est_delay_sec, queue_details, in_flight });
});

// Endpoint monitoring queue (HTML)
app.get('/queue', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, '../client/queue.html'));
});

// Endpoint status QR untuk auto-refresh (AJAX)
app.get('/qr/status', async (req, res) => {
  const { getLastQr, getStatus } = require('./gateway');
  const status = getStatus();
  const qr = getLastQr();
  let qr_svg = null;
  if (qr && status === 'qr') {
    try {
      qr_svg = await QRCode.toString(qr, { type: 'svg', width: 300 });
    } catch {
      qr_svg = null;
    }
  }
  res.json({ status, qr_svg });
});

const { getSocket } = require('./gateway');
// Endpoint daftar grup WhatsApp
app.get('/groups', async (req, res) => {
  try {
    const sock = getSocket();
    if (!sock || !sock.user) {
      console.error('[GROUPS] WhatsApp not connected');
      return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
    }
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
    console.log(`[GROUPS] Found ${groupList.length} groups`);
    res.json({ success: true, groups: groupList });
  } catch (err) {
    console.error('[GROUPS] Error:', err);
    res.status(500).json({ success: false, error: err && (err.message || err.toString()), stack: err && err.stack });
  }
});

// Middleware API Key Auth
const apiKeyAuth = require('./apiKeyAuth');

// Endpoint webhook untuk menerima event dari WhatsApp Gateway (API key protected)
app.post('/webhook', apiKeyAuth, (req, res) => {
  // Data event dikirim oleh gateway
  console.log('[WEBHOOK] Received:', req.body);
  res.json({ success: true });
});

// Webhook endpoint (untuk integrasi eksternal)
const { webhookHandler } = require('./handlers/webhookHandler');
app.post('/webhook', apiKeyAuth, webhookHandler);

// Endpoint kirim pesan dari eksternal
const { sendMessageHandler } = require('./handlers/messageHandler');
app.post('/send-message', apiKeyAuth, sendMessageHandler);

// Endpoint API untuk ambil semua pesan WA
const db = require('./db');
app.get('/api/messages', async (req, res) => {
  try {
    const { start, end } = req.query;
    let sql = 'SELECT * FROM wamessages';
    const params = [];

    if (start && end) {
      sql += ' WHERE DATE(sent_at) BETWEEN ? AND ?';
      params.push(start, end);
    } else if (start) {
      sql += ' WHERE DATE(sent_at) >= ?';
      params.push(start);
    } else if (end) {
      sql += ' WHERE DATE(sent_at) <= ?';
      params.push(end);
    }

    sql += ' ORDER BY sent_at DESC LIMIT 100';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err && (err.message || err.toString()) });
  }
});

// Start WhatsApp Gateway
startGateway();

app.listen(config.port, () => {
  logger.info(`API Gateway listening on port ${config.port}`);
});
