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

// Fungsi untuk flush queue saat QR scan ulang (logout/login ulang)
async function flushQueue() {
  while (queue.length > 0) {
    const queueItem = queue.shift();
    const { message } = queueItem;
    try {
      await saveMessage({
        sender: message.sender || '-',
        receiver: message.jid,
        message: message.text,
        status: false,
        error_message: 'Session changed / QR scanned ulang'
      });
    } catch (err) {
      logger.error('[QUEUE] Gagal mencatat flush queue:', err.message);
    }
  }
  pendingSend = false;
  inFlightMessage = null;
  isWorkerActive = false;
  logger.warn('[QUEUE] Queue di-flush karena QR scan ulang/session berubah.');
}

let isWorkerActive = false;
let lastSentAt = 0;
let pendingSend = false;
let inFlightMessage = null;

function resetWorkerState() {
  pendingSend = false;
  inFlightMessage = null;
  isWorkerActive = false;
}


// Fungsi untuk enqueue pesan
const QUEUE_LIMIT = 1000; // batas maksimal antrian

function enqueueMessage(message, sendFunc, callback) {
  if (queue.length >= QUEUE_LIMIT) {
    logger.error(`[QUEUE] Queue penuh (${QUEUE_LIMIT}), pesan dari ${message.sender || '-'} ke ${message.jid} ditolak.`);
    if (callback) callback(new Error('Queue penuh, silakan coba lagi nanti.'));
    return;
  }
  queue.push({
    message: {
      jid: message.jid,
      text: message.text,
      enqueued_at: new Date().toISOString(),
      sender: message.sender || '-'
    },
    sendFunc,
    callback,
    retryCount: 0
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
  // Cek status kesiapan gateway (termasuk warm-up) sebelum kirim
  let gatewayReady = false;
  try {
    const { isReady } = require('../gateway');
    if (isReady) gatewayReady = isReady();
  } catch (e) {
    gatewayReady = false;
  }
  if (!gatewayReady) {
    logger.warn('[QUEUE] Gateway not ready (connecting or in warm-up). Waiting before sending.');
    // Jangan keluarkan item dari queue, worker akan coba lagi 5 detik lagi
    isWorkerActive = false;
    setTimeout(() => startWorker(), 5000);
    return;
  }
  // Koneksi sudah siap, pastikan sock benar-benar siap sebelum shift queue
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
    // Perkuat readiness sock
    if (!sock || !sock.user) {
      logger.warn('[QUEUE] Sock belum siap: sock.user belum ada. Menunggu 5 detik sebelum retry. Detail sock:', JSON.stringify(sock));
      pendingSend = false;
      inFlightMessage = null;
      setTimeout(processQueue, 5000);
      return;
    }
    if (typeof sock.state === 'string' && sock.state !== 'open') {
      logger.warn('[QUEUE] Sock.state belum open (state=' + sock.state + '). Menunggu 2 detik sebelum retry.');
      pendingSend = false;
      inFlightMessage = null;
      setTimeout(processQueue, 2000);
      return;
    }
    logger.info('[QUEUE] Sock siap, detail:', JSON.stringify({ user: sock.user, state: sock.state }));

    // Bungkus sendFunc dengan timeout 10 detik
    withTimeout(sendFunc(message), 10000, () => {
      logger.error(`[QUEUE] Timeout kirim pesan ke ${message.jid}`);
    })
      .then(async (result) => {
        logger.info(`[QUEUE] Pesan ke ${message.jid} berhasil dikirim.`);
        pendingSend = false;
        inFlightMessage = null;
        // Catat pesan sukses ke database
        try {
          await saveMessageWithRetry({
            sender: message.sender || '-',
            receiver: message.jid,
            message: message.text,
            status: true,
            error_message: null
          });
        } catch (dbErr) {
          logger.error('[QUEUE] Gagal menyimpan pesan sukses ke database:', dbErr.message);
        }
        try {
          callback && callback(null, result);
        } catch (e) {
          logger.error('[QUEUE] Error pada callback sukses:', e.message);
        }
        processQueue();
      })
      .catch(async (err) => {
        logger.error(`[QUEUE] Gagal mengirim pesan ke ${message.jid}:`, err && err.message, `Retry ke-${retryCount + 1}`);
        if (err && err.stack) {
          logger.error(`[QUEUE] Detail error stack:`, err.stack);
        }
        logger.error(`[QUEUE] Detail error objek:`, JSON.stringify(err, Object.getOwnPropertyNames(err)));

        pendingSend = false;
        inFlightMessage = null;

        // Logika Smart Retry
        let retryDelay = 5000; // Default retry delay 5 detik
        if (err && err.message && err.message.toLowerCase().includes('connection closed')) {
          const ts = new Date().toISOString();
          // Jika ini adalah kegagalan pertama (retryCount 0), anggap sebagai 'hiccup' dan coba lagi dengan cepat.
          if (retryCount === 0) {
            logger.warn(`[QUEUE] Gagal karena Connection Closed pada percobaan pertama. Melakukan retry cepat dalam 2 detik. [${ts}]`);
            retryDelay = 2000; // Retry cepat 2 detik
          } else {
            // Jika masih gagal pada percobaan berikutnya, berarti ada masalah serius. Gunakan delay panjang.
            logger.warn(`[QUEUE] Gagal lagi karena Connection Closed. Menggunakan retry standar 15 detik. [${ts}]`);
            retryDelay = 15000; // Retry standar 15 detik
          }
        }

        isWorkerActive = false; // PENTING: Reset status worker agar bisa jalan lagi

        const newRetryCount = retryCount + 1;
        if (newRetryCount < 5) {
          // Retry error lain (bukan connection closed)
          queue.unshift({ ...queueItem, retryCount: newRetryCount });
          logger.warn(`[QUEUE] Pesan ke ${message.jid} akan dicoba ulang (retry ke-${newRetryCount}) dalam ${retryDelay / 1000} detik.`);
          setTimeout(() => startWorker(), retryDelay);
          return;
        } else {
          logger.error(`[QUEUE] Pesan ke ${message.jid} gagal dikirim setelah 5x percobaan. Pesan: ${message.text}`);
          try {
            await saveMessageWithRetry({
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

// Helper retry untuk saveMessage
async function saveMessageWithRetry(data, retry = 0) {
  try {
    await saveMessage(data);
  } catch (dbErr) {
    logger.error(`[QUEUE] Gagal menyimpan pesan ke DB (attempt ${retry + 1}):`, dbErr.message);
    if (retry < 2) {
      await new Promise(res => setTimeout(res, 1000));
      return saveMessageWithRetry(data, retry + 1);
    } else {
      logger.error('[QUEUE] saveMessage gagal setelah 3x percobaan, data:', JSON.stringify(data));
    }
  }
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
