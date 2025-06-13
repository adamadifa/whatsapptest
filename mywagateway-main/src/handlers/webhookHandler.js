const { logger } = require('../utils/logger');

async function webhookHandler(req, res) {
  logger.info('Webhook received:', req.body);
  // Implementasi: bisa diteruskan ke WhatsApp, atau proses lain
  res.json({ received: true });
}

module.exports = { webhookHandler };
