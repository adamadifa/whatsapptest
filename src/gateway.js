const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { logger } = require('./utils/logger');
const config = require('../config/default');
const path = require('path');
const { startWorker } = require('./utils/messageQueue');

let sock;
let lastQr = null; // Simpan QR code terakhir
let connectionStatus = 'connecting'; // Status: 'connecting', 'qr', 'connected', 'disconnected'
let heartbeatInterval = null; // Simpan interval heartbeat
let reconnectAttempts = 0; // Untuk exponential backoff reconnect

function getLastQr() {
  return lastQr;
}

function getStatus() {
  // Status: 'qr', 'connected', 'connecting', 'disconnected'
  if (lastQr) return 'qr';
  return connectionStatus;
}

async function startGateway() {
  const { state, saveCreds } = await useMultiFileAuthState(path.resolve(config.sessionPath));
  sock = makeWASocket({
    auth: state,
    // printQRInTerminal sudah deprecated, hapus!
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQr = qr; // Simpan QR code terbaru
      connectionStatus = 'qr';
      logger.info('QR code updated and available via /qr endpoint');
      try {
        require('qrcode-terminal').generate(qr, { small: true });
        logger.info(qr);
      } catch (e) {
        logger.info(qr);
      }
    }
    if (connection === 'open') {
      lastQr = null; // Reset QR jika sudah login
      connectionStatus = 'connected';
      logger.info('WhatsApp connection established.');
      // Trigger worker to process message queue immediately after reconnect
      try {
        startWorker && startWorker();
      } catch (e) {
        logger.warn('Failed to trigger message queue worker:', e.message);
      }
      // Mulai heartbeat baru, clear sebelumnya
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        try {
          if (sock?.user) {
            sock.sendPresenceUpdate('available');
            logger.debug('Heartbeat: Presence update sent.');
          }
        } catch (e) {
          logger.warn('Heartbeat error (ignored):', e.message);
        }
      }, 1000 * 60 * 1); // setiap 1 menit
    }
    if (connection === 'close') {
      connectionStatus = 'disconnected';
      // Bersihkan heartbeat agar tidak error pada socket lama
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      // Jika logout, hapus session dan restart agar QR baru muncul
      const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      logger.error('Connection closed detail:', {
        reason: lastDisconnect?.error?.output?.statusCode,
        error: lastDisconnect?.error,
        isLoggedOut,
        reconnectAttempts
      });
      if (isLoggedOut) {
        logger.warn('Logged out detected. Removing session and restarting for new QR.');
        const fs = require('fs');
        const sessionPath = path.resolve(config.sessionPath);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        reconnectAttempts = 0;
        setTimeout(startGateway, 1000); // restart koneksi agar QR baru muncul
        connectionStatus = 'connecting';
        return;
      }
      const shouldReconnect = !isLoggedOut;
      logger.warn('Connection closed. Reconnecting: ' + shouldReconnect);
      if (shouldReconnect) {
        // Exponential backoff: 5s, 15s, 30s, 60s, 120s (maks 2 menit)
        reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
        const backoff = [5000, 15000, 30000, 60000, 120000][reconnectAttempts - 1];
        logger.warn(`Reconnect attempt #${reconnectAttempts}, waiting ${backoff / 1000}s...`);
        setTimeout(startGateway, backoff);
        connectionStatus = 'connecting';
      } else {
        reconnectAttempts = 0;
      }
    }
  });

  // Message handler
  const { messageHandler } = require('./handlers/messageHandler');
  sock.ev.on('messages.upsert', messageHandler(sock));
}

function getSocket() {
  return sock;
}

// Global error handler agar proses tidak crash
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (reason && reason.stack) {
    logger.error('Stack:', reason.stack);
    console.error('Unhandled Rejection Stack:', reason.stack);
  } else {
    console.error('Unhandled Rejection:', reason);
  }
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown:', err);
  if (err && err.stack) {
    logger.error('Stack:', err.stack);
    console.error('Uncaught Exception Stack:', err.stack);
  } else {
    console.error('Uncaught Exception:', err);
  }
});

module.exports = { startGateway, getSocket, getLastQr, getStatus };


