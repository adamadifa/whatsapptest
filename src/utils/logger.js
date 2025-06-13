const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('../../config/default');

// Pastikan folder logs ada
const logDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const stream = fs.createWriteStream(path.join(logDir, 'gateway.log'), { flags: 'a' });
const logger = pino({
  level: config.logLevel || 'info',
}, stream);

module.exports = { logger };
