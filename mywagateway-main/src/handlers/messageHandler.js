const { logger } = require('../utils/logger');
const axios = require('axios');
const db = require('../db');

// Handler untuk menerima pesan masuk dari WhatsApp
function messageHandler(sock) {
  return async (msg) => {
    try {
      const messages = msg.messages || [];
      // Loop setiap pesan masuk
      for (const m of messages) {
        if (!m.message) continue;
        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        logger.info(`Received message from ${from}: ${text}`);
        // Webhook trigger (jika ingin tetap aktif per pesan)
        if (process.env.WEBHOOK_URL && from && text) {
          axios.post(process.env.WEBHOOK_URL, {
            from,
            text,
            timestamp: m.messageTimestamp,
            isGroup: from.endsWith('@g.us'),
            groupId: from.endsWith('@g.us') ? from : null
          }, {
            headers: { 'x-api-key': process.env.API_KEY }
          }).catch(e => logger.error('Webhook error:', e && (e.message || e.toString())));
        }
        // Auto reply langsung (dimatikan)
        // if (text) {
        //   await sock.sendMessage(from, { text: 'Terima kasih, pesan Anda sudah kami terima.' });
        // }
        // Contoh: jika pesan == 'ping', balas 'pong' (dimatikan)
        // if (text && text.toLowerCase() === 'ping') {
        //   await sock.sendMessage(from, { text: 'pong' });
        // }
      }
    } catch (err) {
      logger.error('Error in message handler:', err);
    }
  };
}

// Handler untuk endpoint kirim pesan dari eksternal
const messageQueue = require('../utils/messageQueue');
const { enqueueMessage, getQueueLength, RATE_LIMIT_PER_MIN, INTERVAL_MS, __getPendingSend } = messageQueue;

async function saveMessage({ sender, receiver, message, status, error_message }) {
  await db.query(
    'INSERT INTO wamessages (sender, receiver, message, status, error_message) VALUES (?, ?, ?, ?, ?)',
    [sender, receiver, message, status, error_message]
  );
}

async function sendMessageHandler(req, res) {
  let status = false;
  let error_message = null;
  let jid = null;
  let sender = null;
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to & text required' });
    const { getSocket } = require('../gateway');
    const sock = getSocket();
    if (!sock || !sock.user) return res.status(503).json({ error: 'WhatsApp not connected' });
    sender = sock.user.id || null;
    // Normalisasi nomor tujuan
    jid = to;
    if (!jid.includes('@')) {
      let num = to.replace(/[^0-9]/g, '');
      if (num.startsWith('0')) {
        num = '62' + num.slice(1);
      }
      jid = num + '@s.whatsapp.net';
    }
    // Bungkus fungsi pengiriman pesan
    const sendFunc = (msg) => sock.sendMessage(msg.jid, { text: msg.text });
    // Hitung posisi queue
    const queuePos = getQueueLength();
    // Ambil pendingSend dari messageQueue (dengan hack: expose via global)
    let pendingSend = false;
    try { pendingSend = messageQueue.__getPendingSend ? messageQueue.__getPendingSend() : false; } catch(e) {}
    // Jika posisi pertama dan tidak ada pendingSend, queued: false
    const queued = !(queuePos === 0 && !pendingSend);
    enqueueMessage({ jid, text }, sendFunc, async (err) => {
      if (err) {
        logger.error('Send message (queue) error:', err);
        status = false;
        error_message = err && (err.message || err.toString());
      } else {
        status = true;
      }
      // Simpan ke database setelah proses
      await saveMessage({
        sender,
        receiver: jid,
        message: text,
        status,
        error_message
      });
    });
    const estDelay = Math.round((queuePos + 1) * INTERVAL_MS / 1000); // detik
    res.json({ success: true, queued, queue_position: queuePos + 1, est_delay_sec: estDelay });
  } catch (err) {
    logger.error('Send message error:', err);
    status = false;
    error_message = err && (err.message || err.toString());
    // Simpan ke database jika error sebelum enqueue
    await saveMessage({
      sender,
      receiver: jid,
      message: req.body && req.body.text,
      status,
      error_message
    });
    res.status(500).json({ error: error_message, stack: err && err.stack });
  }
}

module.exports = { messageHandler, sendMessageHandler };
