const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { logger } = require('./utils/logger');
const config = require('../config/default');
const path = require('path');

let sock;
let lastQr = null; // Simpan QR code terakhir
let connectionStatus = 'connecting'; // Status: 'connecting', 'qr', 'connected', 'disconnected'
let heartbeatInterval = null; // Simpan interval heartbeat

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
      }, 1000 * 60 * 2); // setiap 2 menit
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
      if (isLoggedOut) {
        logger.warn('Logged out detected. Removing session and restarting for new QR.');
        const fs = require('fs');
        const sessionPath = path.resolve(config.sessionPath);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        setTimeout(startGateway, 1000); // restart koneksi agar QR baru muncul
        connectionStatus = 'connecting';
        return;
      }
      const shouldReconnect = !isLoggedOut;
      logger.warn('Connection closed. Reconnecting: ' + shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startGateway, 5000);
        connectionStatus = 'connecting';
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

module.exports = { startGateway, getSocket, getLastQr, getStatus };

