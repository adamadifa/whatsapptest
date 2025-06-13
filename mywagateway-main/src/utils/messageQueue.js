// Message queue & worker for rate-limited WhatsApp sending
require('dotenv').config();
const { logger } = require('./logger');

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
      enqueued_at: new Date().toISOString()
    },
    sendFunc,
    callback
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
  if (isWorkerActive) return;
  isWorkerActive = true;
  processQueue();
}

function processQueue() {
  if (pendingSend || queue.length === 0) {
    isWorkerActive = false;
    inFlightMessage = null;
    return;
  }
  const { message, sendFunc, callback } = queue.shift();
  pendingSend = true;
  inFlightMessage = Object.assign({}, message, { started_at: new Date().toISOString() });
  const now = Date.now();
  const delay = Math.max(0, INTERVAL_MS - (now - lastSentAt));
  setTimeout(() => {
    lastSentAt = Date.now();
    sendFunc(message)
      .then((result) => {
        pendingSend = false;
        inFlightMessage = null;
        callback(null, result);
        processQueue();
      })
      .catch((err) => {
        pendingSend = false;
        inFlightMessage = null;
        callback(err);
        processQueue();
      });
  }, delay);
}

// Untuk cek posisi dalam antrian
function getQueueLength() {
  return queue.length;
}

module.exports = {
  enqueueMessage,
  getQueueLength,
  getQueueDetails,
  getInFlightMessage,
  RATE_LIMIT_PER_MIN,
  INTERVAL_MS,
  __getPendingSend
};
