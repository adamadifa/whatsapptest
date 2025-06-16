const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('../../config/default');

// Pastikan folder logs ada
const logDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const fileStream = fs.createWriteStream(path.join(logDir, 'gateway.log'), { flags: 'a' });

// Multi-stream: ke file dan ke terminal
const logger = pino({
  level: config.logLevel || 'info',
}, pino.multistream([
  { stream: process.stdout }, // ke terminal
  { stream: fileStream }      // ke file
]));

module.exports = { logger };
