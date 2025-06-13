const db = require('../db');

async function saveMessage({ sender, receiver, message, status, error_message }) {
  // Pastikan sender tidak null/undefined
  const safeSender = sender == null ? '-' : sender;
  await db.query(
    'INSERT INTO wamessages (sender, receiver, message, status, error_message) VALUES (?, ?, ?, ?, ?)',
    [safeSender, receiver, message, status, error_message]
  );
}

module.exports = { saveMessage };
