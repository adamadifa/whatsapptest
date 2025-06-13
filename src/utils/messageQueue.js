// Message queue & worker for rate-limited WhatsApp sending
require('dotenv').config();
const { logger } = require('./logger');
const { saveMessage } = require('./messageLogger'); // Import untuk log ke DB

// Helper untuk timeout promise
function withTimeout(promise, ms, onTimeout) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Timeout: sendFunc tidak merespon dalam ' + ms + 'ms'));
      if (onTimeout) onTimeout();
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    timeoutPromise
  ]);
}


const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '10');
const INTERVAL_MS = Math.ceil(60000 / RATE_LIMIT_PER_MIN); // ms antar pesan

const queue = [];
let isWorkerActive = false;
let lastSentAt = 0;
let pendingSend = false;
let inFlightMessage = null;

// Fungsi untuk enqueue pesan
function enqueueMessage(message, sendFunc, callback) {
  queue.push({
    message: {
      jid: message.jid,
      text: message.text,
      enqueued_at: new Date().toISOString(),
      sender: message.sender || '-' // Tambahkan sender ke queue, default '-'
    },
    sendFunc,
    callback,
    retryCount: 0 // Tambahan retry counter
  });
  startWorker();
}

function getInFlightMessage() {
  return inFlightMessage;
}

// Untuk monitoring detail antrian
function __getPendingSend() { return pendingSend; }
function getQueueDetails() {
  return queue.map((item) => ({
    jid: item.message.jid,
    enqueued_at: item.message.enqueued_at
  }));
}

// Worker: proses queue satu per satu dengan jeda INTERVAL_MS
function startWorker() {
  logger.info('[QUEUE] startWorker dipanggil. isWorkerActive=' + isWorkerActive + ', queue.length=' + queue.length);

  if (isWorkerActive) return;
  isWorkerActive = true;
  processQueue();
}

function processQueue() {
  logger.info('[QUEUE] processQueue dipanggil. pendingSend=' + pendingSend + ', queue.length=' + queue.length);

  if (pendingSend || queue.length === 0) {
    logger.info('[QUEUE] Worker idle. pendingSend=' + pendingSend + ', queue.length=' + queue.length);

    isWorkerActive = false;
    inFlightMessage = null;
    return;
  }
  // Cek status koneksi WhatsApp sebelum kirim
  let connectionStatus = 'disconnected';
  try {
    const { getStatus } = require('../gateway');
    if (getStatus) connectionStatus = getStatus();
  } catch (e) {
    connectionStatus = 'disconnected';
  }
  if (connectionStatus !== 'connected') {
    logger.warn(`[QUEUE] WhatsApp not connected. Waiting before sending. Status: ${connectionStatus}`);

    logger.warn(`[QUEUE] WhatsApp not connected. Waiting before sending. Status: ${connectionStatus}`);
    // Jangan hapus dari queue, worker coba lagi 5 detik lagi
    setTimeout(processQueue, 5000);
    return;
  }
  if (connectionStatus === 'open') {
    // Reset worker status agar worker queue aktif ulang
    try {
      const { resetWorkerStatus } = require('./utils/messageQueue');
      resetWorkerStatus && resetWorkerStatus();
    } catch (e) {
      logger.warn('Failed to reset message queue worker status:', e.message);
    }
  }
  const queueItem = queue.shift();
  if (!queueItem) {
    logger.warn('[QUEUE] Tidak ada item di queue saat akan proses.');
    isWorkerActive = false;
    return;
  }
  const { message, sendFunc, callback } = queueItem;
  const retryCount = queueItem.retryCount || 0;
  logger.info(`[QUEUE] Mengirim pesan ke ${message.jid}, text: ${message.text}, retryCount: ${retryCount}`);
  pendingSend = true;
  inFlightMessage = Object.assign({}, message, { started_at: new Date().toISOString() });
  const now = Date.now();
  const delay = Math.max(0, INTERVAL_MS - (now - lastSentAt));

  setTimeout(async () => {
    lastSentAt = Date.now();

    // Cek status socket WhatsApp sebelum kirim
    let sock;
    try {
      const { getSocket } = require('../gateway');
      sock = getSocket();
    } catch (e) {
      logger.error('[QUEUE] Tidak bisa import getSocket:', e && e.message);
      pendingSend = false;
      inFlightMessage = null;
      // Retry 5 detik
      setTimeout(processQueue, 5000);
      return;
    }
    if (!sock || !sock.user) {
      logger.warn('[QUEUE] Socket WhatsApp belum siap, akan retry 1 detik. Detail sock:', JSON.stringify(sock));
      pendingSend = false;
      inFlightMessage = null;
      setTimeout(processQueue, 1000);
      return;
    }

    // Bungkus sendFunc dengan timeout 10 detik
    withTimeout(sendFunc(message), 10000, () => {
      logger.error(`[QUEUE] Timeout kirim pesan ke ${message.jid}`);
    })
      .then((result) => {
        logger.info(`[QUEUE] Pesan ke ${message.jid} berhasil dikirim.`);
        pendingSend = false;
        inFlightMessage = null;
        try {
          callback && callback(null, result);
        } catch (e) {
          logger.error('[QUEUE] Error pada callback sukses:', e.message);
        }
        processQueue();
      })
      .catch(async (err) => {
        logger.error(`[QUEUE] Gagal mengirim pesan ke ${message.jid}:`, err && err.message, `Retry ke-${retryCount + 1}`);
        // Jika error karena connection closed, retry lebih lama
        let retryDelay = 0;
        if (err && err.message && err.message.toLowerCase().includes('connection closed')) {
          logger.warn('[QUEUE] Gagal karena Connection Closed, retry 10 detik.');
          retryDelay = 10000;
        }
        pendingSend = false;
        inFlightMessage = null;
        if (retryCount < 5) {
          queue.push({ ...queueItem, retryCount: retryCount + 1 });
          logger.warn(`[QUEUE] Pesan ke ${message.jid} akan dicoba ulang (retry ke-${retryCount + 1}).`);
          if (retryDelay > 0) {
            setTimeout(processQueue, retryDelay);
            return;
          }
        } else {
          logger.error(`[QUEUE] Pesan ke ${message.jid} gagal dikirim setelah 5x percobaan. Pesan: ${message.text}`);
          try {
            await saveMessage({
              sender: message.sender || '-',
              receiver: message.jid,
              message: message.text,
              status: false,
              error_message: err && (err.message || err.toString())
            });
          } catch (dbErr) {
            logger.error('[QUEUE] Gagal menyimpan pesan gagal ke database:', dbErr.message);
          }
        }
        try {
          callback && callback(err);
        } catch (e) {
          logger.error('[QUEUE] Error pada callback gagal:', e.message);
        }
        processQueue();
      });
  }, delay);
}

// Untuk cek posisi dalam antrian
function getQueueLength() {
  return queue.length;
}

function resetWorkerStatus() {
  isWorkerActive = false;
}

module.exports = {
  enqueueMessage,
  getQueueLength,
  getQueueDetails,
  getInFlightMessage,
  RATE_LIMIT_PER_MIN,
  INTERVAL_MS,
  __getPendingSend,
  startWorker
};
