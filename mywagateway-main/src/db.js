const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root', // Ganti sesuai user MySQL kamu
  password: '', // Ganti sesuai password MySQL kamu
  database: 'presensigps',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
