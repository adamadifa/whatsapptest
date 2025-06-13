# WhatsApp API Gateway (Baileys)

Gateway WhatsApp ringan berbasis Node.js & Baileys, dioptimalkan untuk shared hosting.

## Fitur Utama
- Modular, ringan, dan efisien
- Auto-reconnect & heartbeat
- Logging status koneksi dan error
- Handler pesan & webhook
- Mudah di-deploy di shared hosting

## Cara Setup
1. Upload seluruh folder ke shared hosting Node.js
2. Jalankan `npm install`
3. Jalankan `npm start` atau gunakan menu Node.js hosting
4. Scan QR WhatsApp pada saat pertama kali run
5. Endpoint API siap digunakan

## Struktur Folder
- `src/` : Kode utama & handler
- `sessions/` : Data session WhatsApp
- `logs/` : File log
- `config/` : Konfigurasi

## Catatan
- Gunakan Node.js LTS
- Setup cronjob ping `/healthz` untuk keep-alive
- Tidak perlu pm2

---

**_Dibangun dengan fokus pada efisiensi dan stabilitas untuk shared hosting._**
# whatsapptest
