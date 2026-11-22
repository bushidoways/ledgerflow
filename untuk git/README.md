# Dompet Palsu Bot

Bot Telegram untuk pembukuan keuangan pribadi berbasis Google Apps Script dan Google Spreadsheet, dilengkapi integrasi Google Gemini AI.

## Fitur Utama

- **Multi-Akun**: Mendukung berbagai rekening bank dan dompet digital (Tunai, BCA, Mandiri, GoPay, OVO, ShopeePay, DANA, dsb).
- **Saldo Tercatat Berbasis Riwayat**: Perhitungan saldo murni dari catatan pemasukan, pengeluaran, transfer, dan koreksi fisik.
- **Deteksi Biaya Admin**: Memisahkan nominal transfer pokok dan biaya admin secara otomatis.
- **Konfirmasi Interaktif**: Tombol inline Telegram saat saldo tercatat tidak mencukupi atau pemilihan akun ambigu.
- **Rekap & Visualisasi**: Rekap harian (`/rekap`), cek saldo (`/saldo`), dan ringkasan bulanan (`/bulan`).
- **Mode AI & Fallback**: Menggunakan Gemini AI untuk parsing bahasa alami, dengan fallback parser lokal saat offline.

## Persiapan & Pemasangan

### 1. Buat Google Spreadsheet
1. Buka Google Sheets baru di browser Anda.
2. Buat empat lembar kerja (sheet) dengan nama:
   - `Users`
   - `Akun`
   - `Transaksi`
   - `Pengeluaran`

### 2. Pasang Skrip ke Google Apps Script
1. Di menu spreadsheet, pilih **Ekstensi** > **Apps Script**.
2. Salin seluruh isi berkas `script.js` ke editor skrip.
3. Simpan proyek.

### 3. Konfigurasi Kredensial
Buka **Project Settings** (ikon gerigi) > **Script Properties**, lalu tambahkan:
- `BOT_TOKEN`: Token bot dari Telegram @BotFather.
- `GEMINI_API_KEY`: Kunci API dari Google AI Studio (opsional).
- `WEBAPP_URL`: URL aplikasi web setelah proses deploy.
- `SPREADSHEET_ID`: (Hanya diperlukan jika skrip dibuat standalone / terpisah dari spreadsheet).

*Catatan: Anda juga dapat menggunakan fungsi bantuan `setupScriptProperties()` di dalam skrip untuk mengisi nilai-nilai ini satu kali.*

### 4. Deploy sebagai Web App
1. Klik tombol **Deploy** > **New deployment**.
2. Pilih jenis **Web app**.
3. Atur **Execute as**: *Me (email Anda)*.
4. Atur **Who has access**: *Anyone*.
5. Klik **Deploy** dan salin URL Web App yang dihasilkan. Masukkan URL tersebut ke Script Property `WEBAPP_URL`.

### 5. Hubungkan Webhook & Pasang Jadwal
1. Di editor Apps Script, pilih fungsi `setWebhook` lalu klik **Run**.
2. Pilih fungsi `pasangTriggerBulanan` lalu klik **Run** untuk mengaktifkan pengiriman rekap otomatis setiap tanggal 1.

## Daftar Perintah Bot

| Perintah | Fungsi |
| :--- | :--- |
| `/start` atau `/help` | Menampilkan panduan awal dan profil pengguna |
| `/saldo` | Memeriksa rincian saldo tercatat tiap akun dan total |
| `/setakun [Nama]` | Menentukan akun pembayaran default |
| `/undo` | Membatalkan transaksi terakhir dan menghitung ulang saldo |
| `/edit [Nominal]` | Mengubah nominal transaksi terakhir |
| `/setbudget [Nominal]` | Mengatur target anggaran harian |
| `/setpersona [satir/santai]` | Memilih persona respon asisten |
| `/rekap` | Menampilkan pengeluaran hari ini dan sisa anggaran |
| `/bulan [MM-YYYY]` | Melihat grafik tren dan evaluasi bulanan |

## Pengujian Lokal

Untuk menjalankan pengujian unit terhadap mesin parser dan helper:
```bash
npm test
```

## Keamanan & Privasi

- Data transaksi sepenuhnya berada di Google Drive / Spreadsheet pribadi Anda.
- Token bot dan kunci API tidak disimpan di dalam kode sumber repositori publik, melainkan melalui Script Properties.
- Pastikan folder cadangan lokal atau berkas berisi token pribadi tidak diikutsertakan saat melakukan commit git.
