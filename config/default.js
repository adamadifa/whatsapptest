module.exports = {
  port: process.env.PORT || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',
  sessionPath: process.env.SESSION_PATH || './sessions/',
  webhookUrl: process.env.WEBHOOK_URL || '',
};
