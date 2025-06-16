const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const { logger } = require('./utils/logger');
const config = require('../config/default.js');
const { startWorker } = require('./utils/messageQueue');
const { messageHandler } = require('./handlers/messageHandler');

let sock;
let lastQr = null;
let connectionStatus = 'connecting';
let reconnectAttempts = 0;
let isGatewayReady = false;

function getLastQr() {
  return lastQr;
}

function getSocket() {
  return sock;
}

function isReady() {
  return isGatewayReady;
}

function getStatus() {
  if (lastQr) return 'qr';
  return connectionStatus;
}

async function startGateway() {
  const sessionPath = path.resolve(__dirname, '..', 'sessions');
  logger.info(`[GATEWAY] Using session path: ${sessionPath}`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    // --- Event Handlers ---
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        lastQr = qr;
        connectionStatus = 'qr';
        logger.info('QR code received, please scan.');
      }

      // Log error WhatsApp jika ada
      if (update?.lastDisconnect?.error) {
        const err = update.lastDisconnect.error;
        logger.error('[GATEWAY] WhatsApp disconnect error:', err && (err.stack || err.message || JSON.stringify(err)));
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        lastQr = null;
        connectionStatus = 'connected';
        isGatewayReady = false;
        logger.info('WhatsApp connection established. Starting 10-second warm-up period...');

        setTimeout(() => {
          logger.info('[GATEWAY] Warm-up finished. Gateway is ready.');
          isGatewayReady = true;
          if (typeof startWorker === 'function') {
            startWorker();
          }
        }, 10000); // 10-second warm-up
      }

      if (connection === 'close') {
        isGatewayReady = false;
        connectionStatus = 'disconnected';
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn(`Connection closed. Reason: ${lastDisconnect.error?.output?.statusCode}. Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.pow(2, reconnectAttempts - 1) * 5000;
          logger.info(`Reconnect attempt #${reconnectAttempts}, waiting ${delay / 1000}s...`);

          // Proteksi: Jika gagal reconnect lebih dari 5x, anggap session corrupt, flush session dan restart
          if (reconnectAttempts >= 5) {
            logger.error('[GATEWAY] Gagal reconnect lebih dari 5x. Kemungkinan session corrupt. Flushing session folder dan restart gateway.');
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            process.exit(1);
          } else {
            setTimeout(startGateway, delay);
          }
        } else {
          logger.error('Not reconnecting. Session may be invalid. Clearing session and exiting.');
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          process.exit(1); // Exit to allow process manager to restart and generate new QR
        }
      }
    });

    sock.ev.on('messages.upsert', messageHandler(sock));

  } catch (error) {
    logger.error('[GATEWAY] Failed to start gateway:', error);
    process.exit(1);
  }
}

module.exports = { startGateway, getSocket, getLastQr, getStatus, isReady };



