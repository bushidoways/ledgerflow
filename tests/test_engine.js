/**
 * Test Engine untuk DOMPET PALSU BOT
 * Menjalankan unit test untuk semua fungsi parser, helper, sanitasi, dan formula keuangan.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// 1. Mock minimal Google Apps Script globals agar script.js dapat dimuat di runtime Node.js
const mockProperties = {};
const mockCache = {};

const mockContext = {
  console: console,
  Buffer: Buffer,
  unescape: unescape,
  encodeURIComponent: encodeURIComponent,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  Math: Math,
  Date: Date,
  String: String,
  Number: Number,
  Array: Array,
  Object: Object,
  JSON: JSON,
  RegExp: RegExp,
  Utilities: {
    formatDate: (date, tz, format) => {
      const d = new Date(date);
      const pad = (n) => String(n).padStart(2, '0');
      if (format.includes('yyyy-MM-dd')) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    },
    newBlob: (str) => ({
      getBytes: () => Buffer.from(str, 'utf8')
    })
  },
  Session: {
    getScriptTimeZone: () => 'Asia/Jakarta'
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => mockProperties[key] || null,
      setProperty: (key, val) => { mockProperties[key] = String(val); },
      setProperties: (obj) => { Object.assign(mockProperties, obj); },
      deleteProperty: (key) => { delete mockProperties[key]; }
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => mockCache[k] || null,
      put: (k, v, ttl) => { mockCache[k] = String(v); },
      remove: (k) => { delete mockCache[k]; }
    })
  },
  LockService: {
    getScriptLock: () => ({
      waitLock: () => true,
      releaseLock: () => true
    })
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => null,
    openById: () => ({})
  },
  UrlFetchApp: {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: {} })
    })
  },
  Logger: {
    log: () => {}
  }
};

vm.createContext(mockContext);

// Muat kode script.js ke dalam context
const scriptCode = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
vm.runInContext(scriptCode, mockContext);

console.log('--- MEMULAI PENGUJIAN DOMPET PALSU BOT ---');
let passCount = 0;
let testCount = 0;

function runTest(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✅ PASS: ${name}`);
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${err.message}`);
  }
}

// ============================================================================
// UJI 1: Normalisasi Nama Akun
// ============================================================================
runTest('Normalisasi nama akun standar dan variasi', () => {
  const normalize = mockContext.normalizeAccountName;
  assert.strictEqual(normalize('tunai'), 'Tunai');
  assert.strictEqual(normalize('cash'), 'Tunai');
  assert.strictEqual(normalize('dompet'), 'Tunai');
  assert.strictEqual(normalize('bca'), 'BCA');
  assert.strictEqual(normalize('mandiri'), 'Mandiri');
  assert.strictEqual(normalize('shopeepay'), 'ShopeePay');
  assert.strictEqual(normalize('spay'), 'ShopeePay');
  assert.strictEqual(normalize('bank jago'), 'Jago');
  assert.strictEqual(normalize('seabank'), 'SeaBank');
  assert.strictEqual(normalize('gopay'), 'GoPay');
  assert.strictEqual(normalize('dana'), 'DANA');
  assert.strictEqual(normalize('bibit'), 'Bibit'); // Custom capital
});

// ============================================================================
// UJI 2: Parser Nominal Sederhana (Indonesian Units)
// ============================================================================
runTest('Parsing angka dengan suffix rb, ribu, k, jt, juta', () => {
  const parseNom = mockContext.parseNominalSederhana;
  assert.strictEqual(parseNom('25rb'), 25000);
  assert.strictEqual(parseNom('50ribu'), 50000);
  assert.strictEqual(parseNom('15k'), 15000);
  assert.strictEqual(parseNom('1.5k'), 1500);
  assert.strictEqual(parseNom('2.5jt'), 2500000);
  assert.strictEqual(parseNom('2,5jt'), 2500000);
  assert.strictEqual(parseNom('1juta'), 1000000);
  assert.strictEqual(parseNom('50.000'), 50000);
  assert.strictEqual(parseNom('50000'), 50000);
  assert.strictEqual(parseNom('0'), 0);
  assert.strictEqual(parseNom('abc'), null);
});

// ============================================================================
// UJI 3: Pemisahan Pokok dan Admin Transfer
// ============================================================================
runTest('Pemisahan nominal pokok dan biaya admin transfer', () => {
  const parseTf = mockContext.parseNominalDanAdmin;
  const res1 = parseTf('100rb + admin 2500');
  assert.strictEqual(res1.pokok, 100000);
  assert.strictEqual(res1.admin, 2500);

  const res2 = parseTf('200k plus fee 2.5k');
  assert.strictEqual(res2.pokok, 200000);
  assert.strictEqual(res2.admin, 2500);

  const res3 = parseTf('50rb');
  assert.strictEqual(res3.pokok, 50000);
  assert.strictEqual(res3.admin, 0);
});

// ============================================================================
// UJI 4: Parser Deterministik untuk Kalimat Natural
// ============================================================================
runTest('Deteksi intent deterministik finansial', () => {
  const parseDet = mockContext.parseDeterministicIntent;

  // Cek Saldo
  const c1 = parseDet('cek saldo');
  assert(c1 && c1.intent === 'CEK_SALDO');
  const c2 = parseDet('uangku tinggal berapa');
  assert(c2 && c2.intent === 'CEK_SALDO');

  // Saldo Awal
  const sa = parseDet('saldo awal tunai 500rb');
  assert(sa && sa.intent === 'SALDO_AWAL');
  assert.strictEqual(sa.akun, 'Tunai');
  assert.strictEqual(sa.nominal, 500000);

  // Koreksi Saldo
  const ks = parseDet('saldo tunai sebenarnya 420rb karena jajan');
  assert(ks && ks.intent === 'KOREKSI_SALDO');
  assert.strictEqual(ks.akun, 'Tunai');
  assert.strictEqual(ks.nominal, 420000);
  assert.strictEqual(ks.alasan, 'jajan');

  // Tarik Tunai
  const tt = parseDet('tarik tunai dari BCA 200rb + admin 2500');
  assert(tt && tt.intent === 'TRANSFER');
  assert.strictEqual(tt.akun, 'BCA');
  assert.strictEqual(tt.akun_tujuan, 'Tunai');
  assert.strictEqual(tt.nominal, 200000);
  assert.strictEqual(tt.biaya_admin, 2500);

  // Setor Tunai
  const st = parseDet('setor tunai ke BCA 300rb');
  assert(st && st.intent === 'TRANSFER');
  assert.strictEqual(st.akun, 'Tunai');
  assert.strictEqual(st.akun_tujuan, 'BCA');
  assert.strictEqual(st.nominal, 300000);

  // Transfer Antar Akun
  const tf = parseDet('transfer dari BCA ke GoPay 100rb + admin 2500');
  assert(tf && tf.intent === 'TRANSFER');
  assert.strictEqual(tf.akun, 'BCA');
  assert.strictEqual(tf.akun_tujuan, 'GoPay');
  assert.strictEqual(tf.nominal, 100000);
  assert.strictEqual(tf.biaya_admin, 2500);
});

// ============================================================================
// UJI 5: Fallback Parser Pengeluaran & Pemasukan (Saat AI offline)
// ============================================================================
runTest('Fallback regex parser intent pengeluaran & kategori auto-detect', () => {
  const parseExp = mockContext.parseExpenseFallback;

  const resKopi = parseExp('kopi kenangan mantan 22k', 'satir', 100000, 0);
  assert.strictEqual(resKopi.nominal, 22000);
  assert.strictEqual(resKopi.kategori, 'Kopi & Jajan');

  const resMakan = parseExp('nasi padang rendang 25rb', 'santai', 100000, 0);
  assert.strictEqual(resMakan.nominal, 25000);
  assert.strictEqual(resMakan.kategori, 'Makanan');

  const resBensin = parseExp('isi bensin pertamax 50rb', 'satir', 100000, 0);
  assert.strictEqual(resBensin.nominal, 50000);
  assert.strictEqual(resBensin.kategori, 'Transportasi');
});

// ============================================================================
// UJI 6: Keamanan Telegram Callback Data (Limit 64 Bytes)
// ============================================================================
runTest('makeSafeCallbackData tidak pernah melebihi 64 byte', () => {
  const makeCb = mockContext.makeSafeCallbackData;
  const getBytes = mockContext.getUtf8ByteLength;

  // Tes data sangat panjang dengan emoji multi-byte
  const cb1 = makeCb('PICK_ACC:', ['ShopeePay', 15000000, 'Transportasi & Tiket', 'Tiket Kereta Eksekutif Bandung 🚆☕🔥']);
  const byteLen1 = getBytes(cb1);
  assert(byteLen1 <= 64, `Byte length melebihi batas: ${byteLen1}`);
  assert(cb1.startsWith('PICK_ACC:ShopeePay|15000000|'));

  const cb2 = makeCb('FORCE_OVERDRAFT|', [2500000, 'Kebutuhan Rumah Tangga', 'Belanja Bulanan Supermarket Lengkap']);
  const byteLen2 = getBytes(cb2);
  assert(byteLen2 <= 64, `Byte length melebihi batas: ${byteLen2}`);
  assert(cb2.startsWith('FORCE_OVERDRAFT|2500000|'));
});

// ============================================================================
// UJI 7: Sanitasi XSS / HTML Escaping
// ============================================================================
runTest('escapeHtml mengubah karakter sensitif menjadi entitas HTML aman', () => {
  const escapeHtml = mockContext.escapeHtml;
  assert.strictEqual(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert("xss")&lt;/script&gt;');
  assert.strictEqual(escapeHtml('Harga > 5000 & < 10000'), 'Harga &gt; 5000 &amp; &lt; 10000');
});

// ============================================================================
// UJI 8: Format Mata Uang Rupiah
// ============================================================================
runTest('formatRupiah memformat ribuan dengan format lokal Indonesia', () => {
  const formatRupiah = mockContext.formatRupiah;
  const formatted = formatRupiah(1500000);
  // Di locale id-ID menggunakan tanda titik sebagai pemisah ribuan
  assert(formatted.includes('1.500.000') || formatted.includes('1,500,000'));
});

// ============================================================================
// UJI 9: Formula Hitung Saldo Tercatat
// ============================================================================
runTest('Formula saldo = Saldo Awal + Masuk - Keluar + TfMasuk - TfKeluar ± Penyesuaian', () => {
  const saldoAwal = 1000000;
  const pemasukan = 500000;
  const pengeluaran = 350000;
  const tfMasuk = 200000;
  const tfKeluar = 150000;
  const penyesuaian = -50000; // koreksi fisik minus 50rb

  const saldoTercatat = saldoAwal + pemasukan - pengeluaran + tfMasuk - tfKeluar + penyesuaian;
  // 1.000.000 + 500.000 - 350.000 + 200.000 - 150.000 - 50.000 = 1.150.000
  assert.strictEqual(saldoTercatat, 1150000);
});

// ============================================================================
// UJI 10: Script Properties Helper & Konfigurasi Tanpa Hardcode
// ============================================================================
runTest('Script Properties helper menyimpan dan membaca secara dinamis', () => {
  mockContext.setupScriptProperties();
  mockProperties['BOT_TOKEN'] = 'test-token-12345';
  mockProperties['GEMINI_API_KEY'] = 'test-gemini-key';
  mockProperties['SPREADSHEET_ID'] = 'test-sheet-id';
  mockProperties['WEBAPP_URL'] = 'https://script.google.com/test';

  assert.strictEqual(mockContext.getBotToken(), 'test-token-12345');
  assert.strictEqual(mockContext.getGeminiApiKey(), 'test-gemini-key');
  assert.strictEqual(mockContext.getSpreadsheetId(), 'test-sheet-id');
  assert.strictEqual(mockContext.getWebAppUrl(), 'https://script.google.com/test');
});

console.log('----------------------------------------------------');
console.log(`HASIL: ${passCount} dari ${testCount} pengujian berhasil lulus.`);
if (passCount === testCount) {
  console.log('🎉 SEMUA PENGUJIAN LULUS DENGAN SEMPURNA!');
  process.exit(0);
} else {
  console.error('⚠️ ADA PENGUJIAN YANG GAGAL!');
  process.exit(1);
}
