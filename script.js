/**
 * ============================================================================
 * DOMPET PALSU BOT v2.0 - MULTI-USER, MULTI-ACCOUNT LEDGER & AI EDITION
 * ============================================================================
 * Paket Fitur Lengkap:
 * 1. Multi-Akun & Saldo Awal per Akun (dengan Tanggal Mulai Saldo)
 * 2. Pencatatan Pemasukan, Pengeluaran per Akun, & Transfer Antar-Akun
 * 3. Pemisahan Otomatis Biaya Admin Transfer (Transfer + Pengeluaran Admin)
 * 4. Perhitungan "Saldo Tercatat" Murni dari Riwayat Transaksi:
 *    Saldo = Saldo Awal + Pemasukan - Pengeluaran + Transfer Masuk - Transfer Keluar ± Penyesuaian
 * 5. Konfirmasi Interaktif (Inline Keyboard & Chat):
 *    - Tanya akun ("Pakai Tunai atau BCA?") jika belum ada akun default / ambigu
 *    - Konfirmasi saat Saldo Tercatat kurang (tidak pindah akun diam-diam)
 *    - Koreksi Saldo ("Saldo tunai sebenarnya 420rb") dengan konfirmasi & alasan
 * 6. Undo (/undo) & Edit (/edit) yang langsung menghitung ulang Saldo Tercatat
 * 7. Rekap Harian (/rekap), Cek Saldo (/saldo), & Rekap Grafik Bulanan (/bulan)
 * ============================================================================
 */

/**
 * Konfigurasi Utama Dompet Palsu Bot.
 * Konfigurasi dibaca aman dari Script Properties (Project Settings > Script Properties)
 * atau dapat diisi melalui fungsi setupScriptProperties() di bawah.
 */
function getBotToken() {
  const props = PropertiesService.getScriptProperties();
  return (props.getProperty('BOT_TOKEN') || props.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
}

function getGeminiApiKey() {
  return (PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '').trim();
}

function getSpreadsheetId() {
  return (PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '').trim();
}

function getWebAppUrl() {
  return (PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '').trim();
}

// Model Gemini resmi yang didukung (fallback berurutan)
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

const SHEET_PENGELUARAN = 'Pengeluaran';
const SHEET_USERS = 'Users';
const SHEET_AKUN = 'Akun';
const SHEET_TRANSAKSI = 'Transaksi';

const PENDING_TTL_SECONDS = 900; // 15 menit untuk sesi konfirmasi interaktif

/**
 * Helper untuk membuka Spreadsheet (mendukung container-bound script maupun standalone)
 */
function getSpreadsheet() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}
  const id = getSpreadsheetId();
  if (!id) {
    throw new Error('Spreadsheet ID belum diatur. Masukkan SPREADSHEET_ID di Script Properties atau pasang script ini sebagai Container-Bound Script (Extensions > Apps Script).');
  }
  return SpreadsheetApp.openById(id);
}

/**
 * ============================================================================
 * 1. FUNGSI UTAMA WEBHOOK (MENANGANI MESSAGE & CALLBACK QUERY)
 * ============================================================================
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput("OK");
    }

    const update = JSON.parse(e.postData.contents);

    // Deduplikasi update_id agar webhook tidak memproses pesan dua kali
    if (update.update_id) {
      const cache = CacheService.getScriptCache();
      const updateKey = 'upd_' + update.update_id;
      if (cache.get(updateKey)) return HtmlService.createHtmlOutput("OK");
      cache.put(updateKey, 'true', 300);
    }

    ensureSheetsReady();

    // A. TANGANI TOMBOL INLINE KEYBOARD (CALLBACK QUERY)
    if (update.callback_query) {
      handleCallbackQuery(update.callback_query);
      return HtmlService.createHtmlOutput("OK");
    }

    // B. TANGANI PESAN TEKS BIASA
    if (!update.message || !update.message.text) {
      return HtmlService.createHtmlOutput("OK");
    }

    const chatId = String(update.message.chat.id);
    const text = update.message.text.trim();
    const username = (update.message.from && update.message.from.username) || '';
    const firstName = (update.message.from && update.message.from.first_name) || 'Kawan';

    const userConfig = getOrCreateUser(chatId, username, firstName);

    // Cek apakah user sedang berada dalam sesi konfirmasi interaktif (pending state)
    const pendingState = getPendingState(chatId);
    if (pendingState && !text.startsWith('/')) {
      const handled = handlePendingTextReply(chatId, firstName, text, userConfig, pendingState);
      if (handled) return HtmlService.createHtmlOutput("OK");
    }

    // ROUTING PERINTAH SLASH (/)
    if (text.startsWith('/start') || text.startsWith('/help')) {
      clearPendingState(chatId);
      handleStart(chatId, firstName, userConfig);
    } else if (text.startsWith('/saldo') || text.startsWith('/dompet') || text.startsWith('/akun')) {
      handleCekSaldo(chatId, userConfig);
    } else if (text.startsWith('/rekap') || text.startsWith('/cek')) {
      handleRekap(chatId, userConfig);
    } else if (text.startsWith('/bulan')) {
      handleRekapBulanan(chatId, text, userConfig);
    } else if (text.startsWith('/setakun') || text.startsWith('/default')) {
      handleSetDefaultAkun(chatId, text, userConfig);
    } else if (text.startsWith('/undo') || text.startsWith('/batal')) {
      handleUndoCommand(chatId, text, userConfig);
    } else if (text.startsWith('/edit') || text.startsWith('/ubah')) {
      handleEditCommand(chatId, text, userConfig, firstName);
    } else if (text.startsWith('/setbudget')) {
      handleSetBudget(chatId, text, userConfig);
    } else if (text.startsWith('/setpersona')) {
      handleSetPersona(chatId, text, userConfig);
    } else {
      handlePesanUser(chatId, firstName, text, userConfig);
    }

  } catch (error) {
    console.error("Webhook Error: " + error.stack);
  }

  return HtmlService.createHtmlOutput("OK");
}

function doGet(e) {
  ensureWebhookCallbackEnabled(true);
  return HtmlService.createHtmlOutput(
    "<b>Dompet Palsu Bot v2.1:</b> Aktif & Callback Query (Tombol Inline) Siap! Mendukung Multi-Akun, Saldo Tercatat, Pemasukan, Pengeluaran, Transfer, Koreksi Saldo, Undo/Edit & AI! 🚀"
  );
}

/**
 * Memastikan webhook Telegram mengizinkan update 'callback_query' (klik tombol inline).
 * Jika sebelumnya webhook terdaftar hanya dengan allowed_updates: ["message"],
 * fungsi ini otomatis memperbaruinya tanpa perlu setWebhook manual.
 */
function ensureWebhookCallbackEnabled(forceCheck) {
  try {
    const cache = CacheService.getScriptCache();
    if (!forceCheck && cache.get('wh_cb_verified_v21')) return;

    const token = getBotToken();
    if (!token) return;

    const infoUrl = `https://api.telegram.org/bot${token}/getWebhookInfo`;
    const res = UrlFetchApp.fetch(infoUrl, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;

    const data = JSON.parse(res.getContentText());
    if (!data || !data.ok || !data.result) return;

    const currentUrl = data.result.url || getWebAppUrl();
    const allowed = data.result.allowed_updates;

    // Jika callback_query belum terdaftar secara eksplisit di allowed_updates, perbarui otomatis
    if (currentUrl && (!Array.isArray(allowed) || !allowed.includes('callback_query'))) {
      const setUrl = `https://api.telegram.org/bot${token}/setWebhook`;
      UrlFetchApp.fetch(setUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          url: currentUrl,
          allowed_updates: ['message', 'edited_message', 'callback_query'],
          drop_pending_updates: false
        }),
        muteHttpExceptions: true
      });
    }

    cache.put('wh_cb_verified_v21', 'true', 21600); // cache 6 jam
  } catch (e) {
    console.warn('Auto-check webhook error: ' + e.message);
  }
}

/**
 * ============================================================================
 * 2. INISIALISASI & MIGRASI SKEMA GOOGLE SHEETS OTOMATIS
 * ============================================================================
 */
function ensureSheetsReady() {
  ensureWebhookCallbackEnabled(false);
  const cache = CacheService.getScriptCache();
  if (cache.get('schema_v2_ready')) return;

  const ss = getSpreadsheet();

  // 1. Sheet Users
  let userSheet = ss.getSheetByName(SHEET_USERS);
  if (!userSheet) {
    userSheet = ss.insertSheet(SHEET_USERS);
    userSheet.appendRow(["Chat ID", "Username", "Nama", "Daily Budget", "Persona", "Created At", "Default Akun"]);
  } else {
    const lastCol = Math.max(userSheet.getLastColumn(), 6);
    const headers = userSheet.getRange(1, 1, 1, lastCol).getValues()[0];
    if (headers.length < 7 || String(headers[6]).trim() === '') {
      userSheet.getRange(1, 7).setValue("Default Akun");
    }
  }

  // 2. Sheet Akun
  let akunSheet = ss.getSheetByName(SHEET_AKUN);
  if (!akunSheet) {
    akunSheet = ss.insertSheet(SHEET_AKUN);
    akunSheet.appendRow(["Chat ID", "Nama Akun", "Saldo Awal", "Tanggal Mulai Saldo", "Updated At", "Catatan"]);
  }

  // 3. Sheet Transaksi (Ledger Utama)
  let txSheet = ss.getSheetByName(SHEET_TRANSAKSI);
  if (!txSheet) {
    txSheet = ss.insertSheet(SHEET_TRANSAKSI);
    txSheet.appendRow([
      "ID Transaksi",
      "Timestamp",
      "Chat ID",
      "Tipe",
      "Akun",
      "Akun Tujuan",
      "Nominal",
      "Kategori",
      "Item",
      "Alasan / Catatan",
      "Pesan Asli",
      "Status",
      "User"
    ]);
  }

  // 4. Sheet Pengeluaran (Kompatibilitas Rekap & Grafik Bulanan)
  let expSheet = ss.getSheetByName(SHEET_PENGELUARAN);
  if (!expSheet) {
    expSheet = ss.insertSheet(SHEET_PENGELUARAN);
    expSheet.appendRow([
      "TimeStamp", "Chat ID", "Nominal", "Kategori", "Chat Asli", "Chat Asli User", "User", "ID Transaksi", "Akun", "Status"
    ]);
  } else {
    const expCols = Math.max(expSheet.getLastColumn(), 7);
    const expHeaders = expSheet.getRange(1, 1, 1, expCols).getValues()[0];
    if (expHeaders.length < 10 || String(expHeaders[7] || '').trim() === '') {
      expSheet.getRange(1, 8, 1, 3).setValues([["ID Transaksi", "Akun", "Status"]]);
    }
  }

  cache.put('schema_v2_ready', 'true', 1800);
}

/**
 * ============================================================================
 * 3. REGISTRASI & PENGELOLAAN USER (MULTI-USER ENGINE + DEFAULT AKUN)
 * ============================================================================
 */
function getOrCreateUser(chatId, username, firstName) {
  const cache = CacheService.getScriptCache();
  const cachedUser = cache.get('u_cfg_' + chatId);
  if (cachedUser) return JSON.parse(cachedUser);

  const ss = getSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  const data = userSheet.getDataRange().getValues();
  let foundUser = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(chatId)) {
      foundUser = {
        rowIndex: i + 1,
        chat_id: String(chatId),
        username: data[i][1] || '',
        name: data[i][2] || firstName,
        daily_budget: Number(data[i][3]) || 100000,
        persona: data[i][4] || 'satir',
        default_akun: String(data[i][6] || '').trim()
      };
      break;
    }
  }

  if (!foundUser) {
    const defaultBudget = 100000;
    const defaultPersona = 'satir';
    userSheet.appendRow([String(chatId), username, firstName, defaultBudget, defaultPersona, new Date(), '']);

    foundUser = {
      rowIndex: userSheet.getLastRow(),
      chat_id: String(chatId),
      username: username,
      name: firstName,
      daily_budget: defaultBudget,
      persona: defaultPersona,
      default_akun: ''
    };
  }

  cache.put('u_cfg_' + chatId, JSON.stringify(foundUser), 600);
  return foundUser;
}

function updateUserDefaultAkun(chatId, userConfig, namaAkun) {
  const cleanAkun = namaAkun ? normalizeAccountName(namaAkun) : '';
  const ss = getSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  userSheet.getRange(userConfig.rowIndex, 7).setValue(cleanAkun);
  userConfig.default_akun = cleanAkun;
  CacheService.getScriptCache().put('u_cfg_' + chatId, JSON.stringify(userConfig), 600);
  return cleanAkun;
}

/**
 * ============================================================================
 * 4. MANAJEMEN AKUN & PERHITUNGAN "SALDO TERCATAT" DARI RIWAYAT TRANSAKSI
 * ============================================================================
 * Rumus Utama:
 * Saldo Tercatat = Saldo Awal + Pemasukan - Pengeluaran + Transfer Masuk - Transfer Keluar ± Penyesuaian
 * (Hanya menghitung transaksi AKTIF sejak Tanggal Mulai Saldo masing-masing akun)
 */
function normalizeAccountName(rawName) {
  if (!rawName) return '';
  const cleaned = String(rawName).trim().replace(/^['"]+|['"]+$/g, '');
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();

  const knownMap = {
    'tunai': 'Tunai',
    'cash': 'Tunai',
    'dompet': 'Tunai',
    'bca': 'BCA',
    'mandiri': 'Mandiri',
    'bri': 'BRI',
    'bni': 'BNI',
    'bsi': 'BSI',
    'cimb': 'CIMB',
    'permata': 'Permata',
    'jago': 'Jago',
    'bank jago': 'Jago',
    'seabank': 'SeaBank',
    'blu': 'blu',
    'gopay': 'GoPay',
    'ovo': 'OVO',
    'dana': 'DANA',
    'shopeepay': 'ShopeePay',
    'spay': 'ShopeePay',
    'linkaja': 'LinkAja',
    'flazz': 'Flazz',
    'emoney': 'e-Money',
    'e-money': 'e-Money',
    'qris': 'QRIS'
  };

  if (knownMap[lower]) return knownMap[lower];
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Concurrency guard menggunakan LockService Apps Script untuk mencegah race condition.
 */
function withScriptLock(fn) {
  let lock = null;
  if (typeof LockService !== 'undefined') {
    try {
      lock = LockService.getScriptLock();
      lock.waitLock(10000);
    } catch (e) {
      console.warn('Gagal mendapatkan ScriptLock: ' + e.message);
    }
  }
  try {
    return fn();
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

/**
 * Menetapkan Saldo Awal untuk suatu akun sekaligus menetapkan Tanggal Mulai Saldo
 * agar pengeluaran lama sebelum saldo awal baru tidak dipotong dua kali.
 */
function setAccountOpeningBalance(chatId, rawAkun, nominal, customStartDate, pesanAsli, userName) {
  return withScriptLock(() => {
    const namaAkun = normalizeAccountName(rawAkun || 'Tunai');
    const startDate = customStartDate ? new Date(customStartDate) : new Date();
    const ss = getSpreadsheet();
    const akunSheet = ss.getSheetByName(SHEET_AKUN);
    const data = akunSheet.getDataRange().getValues();

    let foundRow = -1;
    let prevSaldoAwal = null;
    let prevStartDate = null;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(chatId) &&
          normalizeAccountName(data[i][1]).toLowerCase() === namaAkun.toLowerCase()) {
        foundRow = i + 1;
        prevSaldoAwal = Number(data[i][2]) || 0;
        prevStartDate = data[i][3] ? new Date(data[i][3]).toISOString() : null;
        break;
      }
    }

    const catatanMeta = prevSaldoAwal !== null
      ? `PREV_SALDO:${prevSaldoAwal}|PREV_DATE:${prevStartDate || ''}`
      : 'INIT';

    if (foundRow > 0) {
      akunSheet.getRange(foundRow, 2, 1, 5).setValues([[
        namaAkun, Number(nominal), startDate, new Date(), catatanMeta
      ]]);
    } else {
      akunSheet.appendRow([
        String(chatId), namaAkun, Number(nominal), startDate, new Date(), catatanMeta
      ]);
    }

    // Nonaktifkan baris SALDO_AWAL lama untuk akun ini di sheet Transaksi agar riwayat jelas
    const txSheet = ss.getSheetByName(SHEET_TRANSAKSI);
    const txData = txSheet.getDataRange().getValues();
    for (let i = 1; i < txData.length; i++) {
      if (String(txData[i][2]) === String(chatId) &&
          String(txData[i][3]) === 'SALDO_AWAL' &&
          normalizeAccountName(txData[i][4]).toLowerCase() === namaAkun.toLowerCase() &&
          String(txData[i][11]) === 'AKTIF') {
        txSheet.getRange(i + 1, 12).setValue('DIGANTI');
      }
    }

    // Catat peristiwa penetapan Saldo Awal di Transaksi (terpisah dari PEMASUKAN)
    const txId = generateTxId();
    txSheet.appendRow([
      txId,
      startDate,
      String(chatId),
      'SALDO_AWAL',
      namaAkun,
      '-',
      Number(nominal),
      'Saldo Awal',
      `Saldo Awal ${namaAkun}`,
      catatanMeta,
      pesanAsli || `Saldo awal ${namaAkun} ${nominal}`,
      'AKTIF',
      userName || ''
    ]);

    return {
      txId: txId,
      akun: namaAkun,
      saldoAwal: Number(nominal),
      tanggalMulai: startDate
    };
  });
}

/**
 * Memastikan akun terdaftar di sheet Akun (jika belum ada, dibuat dengan Saldo Awal 0 dan Tanggal Mulai = Epoch)
 */
function ensureAccountExists(chatId, rawAkun) {
  const namaAkun = normalizeAccountName(rawAkun);
  if (!namaAkun) return '';

  const ss = getSpreadsheet();
  const akunSheet = ss.getSheetByName(SHEET_AKUN);
  const data = akunSheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(chatId) &&
        normalizeAccountName(data[i][1]).toLowerCase() === namaAkun.toLowerCase()) {
      return normalizeAccountName(data[i][1]);
    }
  }

  // Buat akun baru dengan tanggal mulai 2020-01-01 agar semua transaksi baru terhitung
  const initialStart = new Date(2020, 0, 1);
  akunSheet.appendRow([
    String(chatId), namaAkun, 0, initialStart, new Date(), 'Auto-created'
  ]);
  return namaAkun;
}

/**
 * Menghitung Saldo Tercatat untuk seluruh akun milik user dari riwayat transaksi
 */
function getUserBalances(chatId) {
  const ss = getSpreadsheet();
  const akunSheet = ss.getSheetByName(SHEET_AKUN);
  const txSheet = ss.getSheetByName(SHEET_TRANSAKSI);

  const akunData = akunSheet ? akunSheet.getDataRange().getValues() : [];
  const txData = txSheet ? txSheet.getDataRange().getValues() : [];

  const accountsMap = {};

  // 1. Muat daftar akun dan titik Saldo Awal + Tanggal Mulai Saldo
  for (let i = 1; i < akunData.length; i++) {
    if (String(akunData[i][0]) !== String(chatId)) continue;
    const nama = normalizeAccountName(akunData[i][1]);
    if (!nama) continue;
    const key = nama.toLowerCase();
    const saldoAwal = Number(akunData[i][2]) || 0;
    const tglMulai = akunData[i][3] ? new Date(akunData[i][3]) : new Date(2020, 0, 1);
    const hasExplicitInit = String(akunData[i][5] || '') !== 'Auto-created';

    accountsMap[key] = {
      nama: nama,
      saldoAwal: saldoAwal,
      tanggalMulai: tglMulai,
      hasExplicitOpening: hasExplicitInit,
      pemasukan: 0,
      pengeluaran: 0,
      transferMasuk: 0,
      transferKeluar: 0,
      penyesuaian: 0,
      saldoTercatat: saldoAwal,
      txCount: 0
    };
  }

  // Helper internal bila ada transaksi pada akun yang belum masuk sheet Akun
  function getOrInitAcc(rawName) {
    const nama = normalizeAccountName(rawName);
    if (!nama || nama === '-') return null;
    const key = nama.toLowerCase();
    if (!accountsMap[key]) {
      accountsMap[key] = {
        nama: nama,
        saldoAwal: 0,
        tanggalMulai: new Date(2020, 0, 1),
        hasExplicitOpening: false,
        pemasukan: 0,
        pengeluaran: 0,
        transferMasuk: 0,
        transferKeluar: 0,
        penyesuaian: 0,
        saldoTercatat: 0,
        txCount: 0
      };
    }
    return accountsMap[key];
  }

  // 2. Telusuri seluruh riwayat transaksi AKTIF
  for (let i = 1; i < txData.length; i++) {
    if (String(txData[i][2]) !== String(chatId)) continue;
    const status = String(txData[i][11] || 'AKTIF').trim().toUpperCase();
    if (status !== 'AKTIF') continue;

    const tipe = String(txData[i][3] || '').trim().toUpperCase();
    if (tipe === 'SALDO_AWAL') continue; // Sudah diwakili oleh titik saldoAwal & tanggalMulai akun

    const txTime = txData[i][1] ? new Date(txData[i][1]) : new Date();
    const akunAsal = normalizeAccountName(txData[i][4]);
    const akunTujuan = normalizeAccountName(txData[i][5]);
    const nominal = Number(txData[i][6]) || 0;

    if (tipe === 'PEMASUKAN') {
      const acc = getOrInitAcc(akunAsal);
      if (acc && txTime.getTime() >= acc.tanggalMulai.getTime()) {
        acc.pemasukan += nominal;
        acc.txCount++;
      }
    } else if (tipe === 'PENGELUARAN') {
      const acc = getOrInitAcc(akunAsal);
      if (acc && txTime.getTime() >= acc.tanggalMulai.getTime()) {
        acc.pengeluaran += nominal;
        acc.txCount++;
      }
    } else if (tipe === 'TRANSFER') {
      const accOut = getOrInitAcc(akunAsal);
      if (accOut && txTime.getTime() >= accOut.tanggalMulai.getTime()) {
        accOut.transferKeluar += nominal;
        accOut.txCount++;
      }
      const accIn = getOrInitAcc(akunTujuan);
      if (accIn && txTime.getTime() >= accIn.tanggalMulai.getTime()) {
        accIn.transferMasuk += nominal;
        accIn.txCount++;
      }
    } else if (tipe === 'PENYESUAIAN') {
      const acc = getOrInitAcc(akunAsal);
      if (acc && txTime.getTime() >= acc.tanggalMulai.getTime()) {
        acc.penyesuaian += nominal; // nominal penyesuaian bisa positif atau negatif
        acc.txCount++;
      }
    }
  }

  // 3. Hitung rumus akhir Saldo Tercatat per akun dan total keseluruhan
  const accountList = Object.values(accountsMap);
  let totalSaldo = 0;

  accountList.forEach(acc => {
    acc.saldoTercatat =
      acc.saldoAwal +
      acc.pemasukan -
      acc.pengeluaran +
      acc.transferMasuk -
      acc.transferKeluar +
      acc.penyesuaian;
    totalSaldo += acc.saldoTercatat;
  });

  return {
    accounts: accountList,
    byKey: accountsMap,
    totalSaldo: totalSaldo
  };
}

function getSingleAccountBalance(chatId, rawAkun) {
  const namaAkun = normalizeAccountName(rawAkun);
  const all = getUserBalances(chatId);
  const key = namaAkun.toLowerCase();
  if (all.byKey[key]) {
    return all.byKey[key];
  }
  return {
    nama: namaAkun,
    saldoAwal: 0,
    tanggalMulai: new Date(2020, 0, 1),
    hasExplicitOpening: false,
    pemasukan: 0,
    pengeluaran: 0,
    transferMasuk: 0,
    transferKeluar: 0,
    penyesuaian: 0,
    saldoTercatat: 0,
    txCount: 0
  };
}

/**
 * Mengambil daftar pilihan nama akun untuk ditampilkan di tombol interaktif
 */
function getCandidateAccountsForPrompt(chatId, userConfig) {
  const balances = getUserBalances(chatId);
  const names = balances.accounts.map(a => a.nama);

  if (userConfig && userConfig.default_akun) {
    const def = normalizeAccountName(userConfig.default_akun);
    if (def && !names.some(n => n.toLowerCase() === def.toLowerCase())) {
      names.unshift(def);
    }
  }

  // Jika user belum punya2 akun, pastikan minimal ada pilihan "Tunai" dan "BCA"
  ['Tunai', 'BCA'].forEach(std => {
    if (!names.some(n => n.toLowerCase() === std.toLowerCase())) {
      names.push(std);
    }
  });

  return names.slice(0, 6);
}

/**
 * ============================================================================
 * 5. PENCATATAN TRANSAKSI KE SHEET TRANSAKSI & SHEET PENGELUARAN
 * ============================================================================
 */
function generateTxId() {
  const now = new Date();
  const stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyMMddHHmmss");
  const rand = Math.floor(100 + Math.random() * 900);
  return `TRX-${stamp}-${rand}`;
}

/**
 * Mencatat transaksi baru (PEMASUKAN, PENGELUARAN, TRANSFER, PENYESUAIAN)
 * Jika TRANSFER memiliki biayaAdmin > 0, otomatis dipecah menjadi 2 transaksi:
 * 1) TRANSFER sebesar nominal pokok
 * 2) PENGELUARAN sebesar biayaAdmin (Kategori: Biaya Admin) dengan referensi parent ID
 */
function recordTransaction(params) {
  return withScriptLock(() => {
    const {
      chatId,
      tipe,
      akun,
      akunTujuan,
      nominal,
      biayaAdmin,
      kategori,
      item,
      alasan,
      pesanAsli,
      userName
    } = params;

    const ss = getSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSAKSI);
    const expSheet = ss.getSheetByName(SHEET_PENGELUARAN);
    const now = new Date();

    const cleanAkun = ensureAccountExists(chatId, akun || 'Tunai');
    const cleanTujuan = akunTujuan && akunTujuan !== '-' ? ensureAccountExists(chatId, akunTujuan) : '-';
    const txId = generateTxId();

    // 1. Simpan baris utama di Transaksi
    txSheet.appendRow([
      txId,
      now,
      String(chatId),
      tipe,
      cleanAkun,
      cleanTujuan,
      Number(nominal),
      kategori || '-',
      item || '-',
      alasan || '-',
      pesanAsli || '',
      'AKTIF',
      userName || ''
    ]);

    // Jika tipe PENGELUARAN, sinkronkan juga ke sheet Pengeluaran agar fitur /rekap & /bulan tetap jalan
    if (tipe === 'PENGELUARAN' && expSheet) {
      expSheet.appendRow([
        now,
        String(chatId),
        Number(nominal),
        kategori || 'Lainnya',
        item || 'Pengeluaran',
        pesanAsli || '',
        userName || '',
        txId,
        cleanAkun,
        'AKTIF'
      ]);
    }

    let adminTxId = null;
    const adminFee = Number(biayaAdmin) || 0;

    // 2. Aturan Pemisahan Biaya Admin Transfer:
    // Transfer Rp100.000 + admin Rp2.500 -> Transfer Rp100.000 & Pengeluaran Rp2.500
    if (tipe === 'TRANSFER' && adminFee > 0) {
      adminTxId = txId + '-ADM';
      const adminKategori = 'Biaya Admin';
      const adminItem = `Biaya Admin Transfer (${cleanAkun} → ${cleanTujuan})`;

      txSheet.appendRow([
        adminTxId,
        now,
        String(chatId),
        'PENGELUARAN',
        cleanAkun,
        '-',
        adminFee,
        adminKategori,
        adminItem,
        `PARENT:${txId}`,
        pesanAsli || '',
        'AKTIF',
        userName || ''
      ]);

      if (expSheet) {
        expSheet.appendRow([
          now,
          String(chatId),
          adminFee,
          adminKategori,
          adminItem,
          pesanAsli || '',
          userName || '',
          adminTxId,
          cleanAkun,
          'AKTIF'
        ]);
      }
    }

    return {
      txId: txId,
      adminTxId: adminTxId,
      akun: cleanAkun,
      akunTujuan: cleanTujuan,
      nominal: Number(nominal),
      biayaAdmin: adminFee
    };
  });
}

/**
 * ============================================================================
 * 6. FITUR UNDO (/undo) & EDIT (/edit) DENGAN PERHITUNGAN ULANG SALDO
 * ============================================================================
 */
function undoTransactionByIdOrLast(chatId, targetTxId) {
  return withScriptLock(() => {
    const ss = getSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSAKSI);
    const expSheet = ss.getSheetByName(SHEET_PENGELUARAN);
    const akunSheet = ss.getSheetByName(SHEET_AKUN);

    const txData = txSheet.getDataRange().getValues();
    let targetRowIdx = -1;

    for (let i = txData.length - 1; i >= 1; i--) {
      if (String(txData[i][2]) !== String(chatId)) continue;
      if (String(txData[i][11]).toUpperCase() !== 'AKTIF') continue;

      const currentId = String(txData[i][0]).trim();
      const catatan = String(txData[i][9] || '');

      // Jika user tidak menyebut ID spesifik dan baris terakhir adalah child biaya admin, ambil induk transfernya
      if (!targetTxId && catatan.startsWith('PARENT:')) {
        const parentId = catatan.replace('PARENT:', '').trim();
        for (let j = i - 1; j >= 1; j--) {
          if (String(txData[j][0]).trim() === parentId && String(txData[j][11]).toUpperCase() === 'AKTIF') {
            targetRowIdx = j;
            break;
          }
        }
        if (targetRowIdx !== -1) break;
      }

      if (!targetTxId || currentId.toLowerCase() === targetTxId.toLowerCase()) {
        targetRowIdx = i;
        break;
      }
    }

    if (targetRowIdx === -1) {
      return { success: false, message: 'Tidak ditemukan transaksi aktif yang bisa dibatalkan.' };
    }

    const row = txData[targetRowIdx];
    const txId = String(row[0]);
    const tipe = String(row[3]).toUpperCase();
    const akun = normalizeAccountName(row[4]);
    const akunTujuan = normalizeAccountName(row[5]);
    const nominal = Number(row[6]) || 0;
    const kategori = String(row[7] || '-');
    const item = String(row[8] || '-');
    const catatan = String(row[9] || '');

    // Tandai BATAL di sheet Transaksi
    txSheet.getRange(targetRowIdx + 1, 12).setValue('BATAL');

    // Jika yang di-undo adalah SALDO_AWAL, pulihkan saldo awal sebelumnya di sheet Akun
    if (tipe === 'SALDO_AWAL' && akunSheet) {
      const akunData = akunSheet.getDataRange().getValues();
      for (let k = 1; k < akunData.length; k++) {
        if (String(akunData[k][0]) === String(chatId) &&
            normalizeAccountName(akunData[k][1]).toLowerCase() === akun.toLowerCase()) {
          if (catatan.startsWith('PREV_SALDO:')) {
            const parts = catatan.split('|');
            const prevSaldo = Number((parts[0] || '').replace('PREV_SALDO:', '')) || 0;
            const prevDateStr = (parts[1] || '').replace('PREV_DATE:', '');
            const prevDate = prevDateStr ? new Date(prevDateStr) : new Date(2020, 0, 1);
            akunSheet.getRange(k + 1, 3, 1, 3).setValues([[prevSaldo, prevDate, new Date()]]);
          } else {
            akunSheet.getRange(k + 1, 3, 1, 3).setValues([[0, new Date(2020, 0, 1), new Date()]]);
          }
          break;
        }
      }
    }

    // Cek apakah ada transaksi anak (misal biaya admin transfer) yang terhubung ke txId ini
    let cancelledAdminFee = 0;
    const idsToCancelInExp = [txId];

    for (let i = 1; i < txData.length; i++) {
      if (String(txData[i][2]) === String(chatId) &&
          String(txData[i][11]).toUpperCase() === 'AKTIF' &&
          (String(txData[i][9]) === `PARENT:${txId}` || String(txData[i][0]) === `${txId}-ADM`)) {
        txSheet.getRange(i + 1, 12).setValue('BATAL');
        cancelledAdminFee += Number(txData[i][6]) || 0;
        idsToCancelInExp.push(String(txData[i][0]));
      }
    }

    // Tandai BATAL juga di sheet Pengeluaran agar laporan harian & bulanan ikut bersih
    if (expSheet) {
      const expData = expSheet.getDataRange().getValues();
      for (let i = expData.length - 1; i >= 1; i--) {
        if (String(expData[i][1]) === String(chatId) &&
            idsToCancelInExp.includes(String(expData[i][7]))) {
          expSheet.getRange(i + 1, 10).setValue('BATAL');
        }
      }
    }

    // Hitung ulang saldo tercatat setelah pembatalan
    const updatedAcc = getSingleAccountBalance(chatId, akun);
    const updatedTujuan = (tipe === 'TRANSFER' && akunTujuan && akunTujuan !== '-')
      ? getSingleAccountBalance(chatId, akunTujuan)
      : null;

    return {
      success: true,
      txId: txId,
      tipe: tipe,
      akun: akun,
      akunTujuan: akunTujuan,
      nominal: nominal,
      cancelledAdminFee: cancelledAdminFee,
      kategori: kategori,
      item: item,
      saldoBaru: updatedAcc.saldoTercatat,
      saldoTujuanBaru: updatedTujuan ? updatedTujuan.saldoTercatat : null
    };
  });
}

/**
 * Mengubah nominal (dan opsional akun/item) pada transaksi terakhir atau ID tertentu,
 * lalu menghitung ulang Saldo Tercatat dari riwayat.
 */
function editTransactionByIdOrLast(chatId, targetTxId, nominalBaru, akunBaru, itemBaru) {
  return withScriptLock(() => {
    const ss = getSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSAKSI);
    const expSheet = ss.getSheetByName(SHEET_PENGELUARAN);
    const akunSheet = ss.getSheetByName(SHEET_AKUN);

    const txData = txSheet.getDataRange().getValues();
    let targetRowIdx = -1;

    for (let i = txData.length - 1; i >= 1; i--) {
      if (String(txData[i][2]) !== String(chatId)) continue;
      if (String(txData[i][11]).toUpperCase() !== 'AKTIF') continue;

      const currentId = String(txData[i][0]).trim();
      const catatan = String(txData[i][9] || '');

      if (!targetTxId && catatan.startsWith('PARENT:')) continue;

      if (!targetTxId || currentId.toLowerCase() === targetTxId.toLowerCase()) {
        targetRowIdx = i;
        break;
      }
    }

    if (targetRowIdx === -1) {
      return { success: false, message: 'Tidak ditemukan transaksi aktif untuk diubah.' };
    }

    const row = txData[targetRowIdx];
    const txId = String(row[0]);
    const tipe = String(row[3]).toUpperCase();
    const akunLama = normalizeAccountName(row[4]);
    const akunTujuan = normalizeAccountName(row[5]);
    const nominalLama = Number(row[6]) || 0;
    const itemLama = String(row[8] || '-');

    const finalAkun = akunBaru ? ensureAccountExists(chatId, akunBaru) : akunLama;
    const finalItem = itemBaru ? itemBaru : itemLama;
    const finalNominal = (nominalBaru !== null && nominalBaru !== undefined) ? Number(nominalBaru) : nominalLama;

    // Perbarui di sheet Transaksi
    txSheet.getRange(targetRowIdx + 1, 5).setValue(finalAkun);
    txSheet.getRange(targetRowIdx + 1, 7).setValue(finalNominal);
    txSheet.getRange(targetRowIdx + 1, 9).setValue(finalItem);

    // Jika tipe SALDO_AWAL, perbarui juga di sheet Akun
    if (tipe === 'SALDO_AWAL' && akunSheet) {
      const akunData = akunSheet.getDataRange().getValues();
      for (let k = 1; k < akunData.length; k++) {
        if (String(akunData[k][0]) === String(chatId) &&
            normalizeAccountName(akunData[k][1]).toLowerCase() === finalAkun.toLowerCase()) {
          akunSheet.getRange(k + 1, 3).setValue(finalNominal);
          break;
        }
      }
    }

    // Sinkronkan perubahan ke sheet Pengeluaran bila transaksi tersebut adalah PENGELUARAN
    if (tipe === 'PENGELUARAN' && expSheet) {
      const expData = expSheet.getDataRange().getValues();
      for (let i = expData.length - 1; i >= 1; i--) {
        if (String(expData[i][1]) === String(chatId) && String(expData[i][7]) === txId) {
          expSheet.getRange(i + 1, 3).setValue(finalNominal);
          expSheet.getRange(i + 1, 5).setValue(finalItem);
          expSheet.getRange(i + 1, 9).setValue(finalAkun);
          break;
        }
      }
    }

    // Hitung ulang saldo tercatat dari riwayat
    const updatedAcc = getSingleAccountBalance(chatId, finalAkun);
    const updatedOldAcc = (finalAkun.toLowerCase() !== akunLama.toLowerCase())
      ? getSingleAccountBalance(chatId, akunLama)
      : null;
    const updatedTujuan = (tipe === 'TRANSFER' && akunTujuan && akunTujuan !== '-')
      ? getSingleAccountBalance(chatId, akunTujuan)
      : null;

    return {
      success: true,
      txId: txId,
      tipe: tipe,
      akunLama: akunLama,
      akunBaru: finalAkun,
      akunTujuan: akunTujuan,
      nominalLama: nominalLama,
      nominalBaru: finalNominal,
      itemBaru: finalItem,
      saldoBaru: updatedAcc.saldoTercatat,
      saldoAkunLama: updatedOldAcc ? updatedOldAcc.saldoTercatat : null,
      saldoTujuanBaru: updatedTujuan ? updatedTujuan.saldoTercatat : null
    };
  });
}

/**
 * ============================================================================
 * 7. MANAJEMEN PENDING STATE (SESI INTERAKTIF TANYA AKUN / KONFIRMASI)
 * ============================================================================
 */
function savePendingState(chatId, stateObj) {
  const key = 'pend_' + String(chatId);
  const payload = JSON.stringify(Object.assign({}, stateObj, { savedAt: Date.now() }));
  CacheService.getScriptCache().put(key, payload, PENDING_TTL_SECONDS);
  try {
    PropertiesService.getScriptProperties().setProperty(key, payload);
  } catch (e) {
    console.warn('Failed saving pending state to ScriptProperties: ' + e.message);
  }
}

function getPendingState(chatId) {
  const key = 'pend_' + String(chatId);
  let raw = CacheService.getScriptCache().get(key);
  if (!raw) {
    try {
      raw = PropertiesService.getScriptProperties().getProperty(key);
    } catch (e) {}
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearPendingState(chatId) {
  const key = 'pend_' + String(chatId);
  CacheService.getScriptCache().remove(key);
  try {
    PropertiesService.getScriptProperties().deleteProperty(key);
  } catch (e) {}
}

/**
 * Fallback pemulihan draft transaksi langsung dari teks pesan Telegram atau callback_data
 * jika tombol diklik setelah sesi CacheService habis (misal tombol lama di ruang chat).
 */
function recoverDraftFromCallbackMessage(msgObj, cbData) {
  const text = String((msgObj && msgObj.text) || '');
  let akunAsal = '';
  let nominal = 0;
  let item = 'Pengeluaran';
  let kategori = 'Lainnya';

  // 1. Cek jika callback_data mengandung parameter terenkode (contoh: PICK_ACC:Mandiri|19000|Makanan|parkir)
  if (cbData && cbData.includes('|')) {
    const parts = cbData.split('|');
    if (parts.length >= 2) {
      const parsedNom = parseInt(String(parts[1]).replace(/[^\d]/g, ''), 10);
      if (parsedNom > 0) nominal = parsedNom;
    }
    if (parts.length >= 3 && parts[2]) kategori = parts[2];
    if (parts.length >= 4 && parts[3]) item = parts.slice(3).join('|');
  }

  // 2. Ekstrak dari pesan "⚠️ Saldo tercatat Tunai kurang!"
  const akunMatch = text.match(/Saldo tercatat\s+([^\s!]+)\s+kurang/i);
  if (akunMatch) {
    akunAsal = normalizeAccountName(akunMatch[1]);
  }

  const itemLineMatch = text.match(/•\s*Item:\s*(.+?)(?:\s*\(([^)]+)\))?\s*(?:\n|$)/i);
  if (itemLineMatch) {
    item = itemLineMatch[1].trim();
    if (itemLineMatch[2]) kategori = itemLineMatch[2].trim();
  }

  const txMatch = text.match(/•\s*Transaksi:\s*Rp\s*([\d.,]+)/i);
  if (txMatch && !nominal) {
    nominal = parseInt(txMatch[1].replace(/[^\d]/g, ''), 10) || 0;
  }

  // 3. Ekstrak dari pesan "Transaksi <item> (Rp<nominal>) pakai akun apa?"
  const askMatch = text.match(/Transaksi\s+(.+?)\s*\(Rp\s*([\d.,]+)\)/i);
  if (askMatch) {
    if (!item || item === 'Pengeluaran') item = askMatch[1].trim();
    if (!nominal) nominal = parseInt(askMatch[2].replace(/[^\d]/g, ''), 10) || 0;
  }

  if (nominal <= 0) return null;

  if (kategori === 'Lainnya' && item && item !== 'Pengeluaran') {
    const parsedFallback = parseExpenseFallback(`${item} ${nominal}`, 'santai', 100000, 0);
    if (parsedFallback && parsedFallback.kategori) {
      kategori = parsedFallback.kategori;
    }
  }

  return {
    tipe: 'PENGELUARAN',
    akun: akunAsal || 'Tunai',
    akun_tujuan: '-',
    akun_ambigu: false,
    nominal: nominal,
    biaya_admin: 0,
    kategori: kategori,
    item: item,
    alasan: '-',
    pesan_asli: `${item} ${nominal}`,
    reply: ''
  };
}

/**
 * Handler ketika user mengklik tombol Inline Keyboard di Telegram
 */
function handleCallbackQuery(cb) {
  const cbId = cb.id;
  const msgObj = cb.message || {};
  const chatId = String((msgObj.chat && msgObj.chat.id) || (cb.from && cb.from.id) || '');
  const messageId = msgObj.message_id;
  const data = String(cb.data || '');
  const username = (cb.from && cb.from.username) || '';
  const firstName = (cb.from && cb.from.first_name) || 'Kawan';

  if (!chatId) {
    answerCallbackQuery(cbId, 'Chat ID tidak ditemukan.');
    return;
  }

  const userConfig = getOrCreateUser(chatId, username, firstName);
  let pending = getPendingState(chatId);

  // 1. Tombol Undo Cepat dari pesan transaksi
  if (data.startsWith('UNDO:')) {
    const txId = data.replace('UNDO:', '').trim();
    answerCallbackQuery(cbId, 'Membatalkan transaksi...');
    const res = undoTransactionByIdOrLast(chatId, txId);
    if (res.success) {
      let msg = `↩️ <b>Transaksi Dibatalkan (${escapeHtml(res.txId)})</b>\n` +
                `• Item: ${escapeHtml(res.item)} (Rp${formatRupiah(res.nominal)})\n` +
                `• Saldo tercatat <b>${escapeHtml(res.akun)}</b> kini: <b>Rp${formatRupiah(res.saldoBaru)}</b>`;
      if (res.saldoTujuanBaru !== null) {
        msg += `\n• Saldo tercatat <b>${escapeHtml(res.akunTujuan)}</b> kini: <b>Rp${formatRupiah(res.saldoTujuanBaru)}</b>`;
      }
      sendTelegramMessage(chatId, msg);
    } else {
      sendTelegramMessage(chatId, `⚠️ ${escapeHtml(res.message)}`);
    }
    return;
  }

  // 2. Tombol Set Default Akun Cepat
  if (data.startsWith('SETDEF:')) {
    const newDef = updateUserDefaultAkun(chatId, userConfig, data.replace('SETDEF:', '').trim());
    answerCallbackQuery(cbId, `Akun default: ${newDef}`);
    sendTelegramMessage(
      chatId,
      `✅ Akun default berhasil diatur ke <b>${escapeHtml(newDef)}</b>. Transaksi berikutnya otomatis memakai akun ini jika tidak disebutkan.`
    );
    return;
  }

  // 3. Tombol Batal Sesi Interaktif (Selalu bisa diklik meskipun cache pending sudah habis)
  if (data === 'CANCEL_PENDING') {
    clearPendingState(chatId);
    answerCallbackQuery(cbId, 'Dibatalkan.');
    editTelegramMessage(chatId, messageId, `❌ <i>Pencatatan dibatalkan. Saldo tercatat tidak berubah.</i>`);
    return;
  }

  // Jika pending tidak ada di Cache maupun Properties, pulihkan otomatis dari isi pesan / callback_data
  if (!pending) {
    const recoveredDraft = recoverDraftFromCallbackMessage(msgObj, data);
    if (recoveredDraft) {
      pending = {
        step: 'RECOVERED',
        draft: recoveredDraft
      };
    } else {
      answerCallbackQuery(cbId, '⚠️ Sesi konfirmasi sudah kedaluwarsa, silakan kirim ulang transaksinya.');
      editTelegramMessage(
        chatId,
        messageId,
        `⚠️ <i>Sesi konfirmasi untuk pesan ini sudah kedaluwarsa. Silakan ketik ulang transaksinya (misal: <code>19k parkir pakai Mandiri</code>).</i>`
      );
      return;
    }
  }

  // 4. Pemilihan Akun ("Pakai Tunai atau BCA?" ATAU tombol "🔄 Pakai Mandiri / 🔄 Pakai BCA" saat saldo kurang)
  if (data.startsWith('PICK_ACC:')) {
    const rawAccPart = data.replace('PICK_ACC:', '').split('|')[0].trim();
    const chosenAcc = normalizeAccountName(rawAccPart);
    answerCallbackQuery(cbId, `Memilih ${chosenAcc}...`);
    clearPendingState(chatId);

    const txDraft = pending.draft;
    txDraft.akun = chosenAcc;
    processVerifiedTransaction(chatId, firstName, userConfig, txDraft, false, messageId);
    return;
  }

  // 5. Konfirmasi Tetap Catat Saat Saldo Kurang (Overdraft)
  if (data.startsWith('FORCE_OVERDRAFT')) {
    answerCallbackQuery(cbId, 'Mencatat transaksi...');
    clearPendingState(chatId);
    const txDraft = pending.draft;
    if (data.includes('|')) {
      const parts = data.split('|');
      if (parts[1] && isNaN(Number(parts[1]))) {
        txDraft.akun = normalizeAccountName(parts[1]);
      }
    }
    processVerifiedTransaction(chatId, firstName, userConfig, txDraft, true, messageId);
    return;
  }

  // 6. Konfirmasi Koreksi Saldo / Penyesuaian
  if (data === 'CONFIRM_ADJUST' && pending.adjustData) {
    answerCallbackQuery(cbId, 'Menyimpan koreksi saldo...');
    clearPendingState(chatId);
    executeBalanceAdjustment(chatId, firstName, pending.adjustData, messageId);
    return;
  }
}

/**
 * Handler ketika user membalas pertanyaan interaktif menggunakan teks biasa
 * (Misal bot tanya "Pakai Tunai atau BCA?", lalu user ketik "Tunai")
 */
function handlePendingTextReply(chatId, firstName, text, userConfig, pending) {
  const lower = text.trim().toLowerCase();

  if (lower === 'batal' || lower === 'cancel' || lower === 'ga jadi' || lower === 'gak jadi') {
    clearPendingState(chatId);
    sendTelegramMessage(chatId, `❌ Pencatatan dibatalkan. Saldo tercatat tidak berubah.`);
    return true;
  }

  // KASUS A: Sedang menunggu jawaban "Pakai akun apa?"
  if (pending.step === 'WAITING_ACCOUNT') {
    // Jika teks user mengandung angka nominal baru (misal dia kirim transaksi baru), jangan dianggap nama akun
    if (/\d{3,}|\d+\s*(rb|ribu|k|jt|juta)\b/i.test(text)) {
      clearPendingState(chatId);
      return false;
    }

    const cleanedAcc = normalizeAccountName(
      text.replace(/^(pakai|pake|via|dari|ke|akun)\s+/i, '').trim()
    );
    if (!cleanedAcc || cleanedAcc.length > 25) return false;

    clearPendingState(chatId);
    const txDraft = pending.draft;
    txDraft.akun = cleanedAcc;
    processVerifiedTransaction(chatId, firstName, userConfig, txDraft, false, null);
    return true;
  }

  // KASUS B: Sedang menunggu konfirmasi "Saldo tercatat kurang, tetap lanjut?"
  if (pending.step === 'WAITING_OVERDRAFT_CONFIRM') {
    // Jika user mengetik transaksi baru yang punya angka nominal, batalkan sesi lama & proses transaksi baru
    if (/\d{3,}|\d+\s*(rb|ribu|k|jt|juta)\b/i.test(text)) {
      clearPendingState(chatId);
      return false;
    }
    if (/^(ya|iya|lanjut|tetap|tetap catat|tetap catat di .+|oke|ok|gas|y)$/i.test(lower)) {
      clearPendingState(chatId);
      processVerifiedTransaction(chatId, firstName, userConfig, pending.draft, true, null);
      return true;
    }
    const gantiMatch = text.match(/^(?:(?:pakai|pake|ganti|via|ke|akun)\s+)?(tunai|cash|bca|mandiri|bri|bni|bsi|cimb|permata|jago|seabank|blu|gopay|ovo|dana|shopeepay|linkaja|flazz|emoney|e-money|qris)$/i);
    if (gantiMatch) {
      clearPendingState(chatId);
      const txDraft = pending.draft;
      txDraft.akun = normalizeAccountName(gantiMatch[1]);
      processVerifiedTransaction(chatId, firstName, userConfig, txDraft, false, null);
      return true;
    }
    return false;
  }

  // KASUS C: Sedang menunggu konfirmasi & alasan Koreksi Saldo ("Saldo tunai sebenarnya 420rb")
  if (pending.step === 'WAITING_ADJUSTMENT_REASON') {
    if (/^(ya|iya|konfirmasi|oke|ok|lanjut)$/i.test(lower)) {
      clearPendingState(chatId);
      executeBalanceAdjustment(chatId, firstName, pending.adjustData, null);
      return true;
    }
    // User mengetik alasan koreksi (misal: "Lupa catat parkir dan jajan sore")
    pending.adjustData.alasan = text.trim();
    clearPendingState(chatId);
    executeBalanceAdjustment(chatId, firstName, pending.adjustData, null);
    return true;
  }

  return false;
}

/**
 * Helper untuk memastikan callback_data Telegram tidak melebihi batas 64 byte.
 */
function getUtf8ByteLength(str) {
  if (typeof Utilities !== 'undefined' && Utilities.newBlob) {
    return Utilities.newBlob(str).getBytes().length;
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(str, 'utf8');
  }
  return unescape(encodeURIComponent(str)).length;
}

function makeSafeCallbackData(prefix, parts) {
  const safeParts = parts.map(p => String(p || '').replace(/[|:]/g, ' '));
  let joined = prefix + safeParts.join('|');
  while (getUtf8ByteLength(joined) > 64 && safeParts.length > 0) {
    const last = safeParts[safeParts.length - 1];
    if (last.length > 2) {
      safeParts[safeParts.length - 1] = last.slice(0, -2);
    } else {
      safeParts.pop();
    }
    joined = prefix + safeParts.join('|');
  }
  return joined;
}

/**
 * ============================================================================
 * 8. EKSEKUSI TRANSAKSI DENGAN VALIDASI AKUN & CEK SALDO KURANG
 * ============================================================================
 */
function processVerifiedTransaction(chatId, firstName, userConfig, draft, forceOverdraft, editMsgId) {
  const tipe = draft.tipe; // 'PENGELUARAN' | 'PEMASUKAN' | 'TRANSFER'
  let akun = draft.akun ? normalizeAccountName(draft.akun) : '';

  // 1. Jika akun belum ditentukan atau pesan ambigu:
  if (!akun || draft.akun_ambigu) {
    if (!draft.akun_ambigu && userConfig.default_akun) {
      akun = normalizeAccountName(userConfig.default_akun);
      draft.akun = akun;
    } else {
      // Tanya ke user: "Pakai Tunai atau BCA?"
      const candidates = getCandidateAccountsForPrompt(chatId, userConfig);
      savePendingState(chatId, {
        step: 'WAITING_ACCOUNT',
        draft: Object.assign({}, draft, { akun_ambigu: false })
      });

      const safeKatAsk = String(draft.kategori || 'Lainnya').replace(/[|:]/g, '').substring(0, 12);
      const safeItemAsk = String(draft.item || 'Pengeluaran').replace(/[|:]/g, '').substring(0, 18);

      const buttonRow = candidates.slice(0, 3).map(accName => ({
        text: `💳 ${accName}`,
        callback_data: makeSafeCallbackData('PICK_ACC:', [accName, draft.nominal, safeKatAsk, safeItemAsk])
      }));
      const buttonRow2 = candidates.slice(3, 6).map(accName => ({
        text: `💳 ${accName}`,
        callback_data: makeSafeCallbackData('PICK_ACC:', [accName, draft.nominal, safeKatAsk, safeItemAsk])
      }));

      const keyboard = [buttonRow];
      if (buttonRow2.length > 0) keyboard.push(buttonRow2);
      keyboard.push([{ text: '❌ Batal', callback_data: 'CANCEL_PENDING' }]);

      const labelJenis = tipe === 'PEMASUKAN' ? 'masuk ke akun mana' : 'pakai akun apa';
      const contohPilihan = candidates.slice(0, 2).join(' atau ');
      const promptMsg =
        `🤔 <b>Pakai ${escapeHtml(contohPilihan)}?</b>\n` +
        `Transaksi <b>${escapeHtml(draft.item)} (Rp${formatRupiah(draft.nominal)})</b> ${labelJenis}?\n\n` +
        `<i>Pilih tombol di bawah atau balas nama akunnya. (Tips: ketik <code>/setakun Tunai</code> agar tidak ditanya terus).</i>`;

      sendTelegramMessageWithKeyboard(chatId, promptMsg, keyboard);
      return;
    }
  }

  // 2. Cek kecukupan Saldo Tercatat untuk PENGELUARAN & TRANSFER
  if ((tipe === 'PENGELUARAN' || tipe === 'TRANSFER') && !forceOverdraft) {
    const accBal = getSingleAccountBalance(chatId, akun);
    const totalKeluar = Number(draft.nominal) + (Number(draft.biaya_admin) || 0);

    if (accBal.saldoTercatat < totalKeluar) {
      const kurangnya = totalKeluar - accBal.saldoTercatat;
      savePendingState(chatId, {
        step: 'WAITING_OVERDRAFT_CONFIRM',
        draft: draft
      });

      const otherAccs = getCandidateAccountsForPrompt(chatId, userConfig)
        .filter(a => a.toLowerCase() !== akun.toLowerCase())
        .slice(0, 2);

      const safeKat = String(draft.kategori || 'Lainnya').replace(/[|:]/g, '').substring(0, 12);
      const safeItem = String(draft.item || 'Pengeluaran').replace(/[|:]/g, '').substring(0, 18);

      const altButtons = otherAccs.map(a => ({
        text: `🔄 Pakai ${a}`,
        callback_data: makeSafeCallbackData('PICK_ACC:', [a, totalKeluar, safeKat, safeItem])
      }));

      const keyboard = [
        [{ text: `✅ Tetap Catat di ${akun}`, callback_data: makeSafeCallbackData('FORCE_OVERDRAFT|', [totalKeluar, safeKat, safeItem]) }],
        altButtons,
        [{ text: '❌ Batal', callback_data: 'CANCEL_PENDING' }]
      ].filter(row => row.length > 0);

      const warnMsg =
        `⚠️ <b>Saldo tercatat ${escapeHtml(akun)} kurang!</b>\n` +
        `• Saldo tercatat ${escapeHtml(akun)}: <b>Rp${formatRupiah(accBal.saldoTercatat)}</b>\n` +
        `• Item: <b>${escapeHtml(draft.item || 'Pengeluaran')}</b> (${escapeHtml(draft.kategori || 'Lainnya')})\n` +
        `• Transaksi: <b>Rp${formatRupiah(totalKeluar)}</b> (kurang Rp${formatRupiah(kurangnya)})\n\n` +
        `<i>Bisa jadi ada pemasukan atau saldo awal yang belum dicatat. Jangan lupa catat pemasukanmu, atau konfirmasi di bawah:</i>`;

      if (editMsgId) {
        editTelegramMessage(chatId, editMsgId, warnMsg, keyboard);
      } else {
        sendTelegramMessageWithKeyboard(chatId, warnMsg, keyboard);
      }
      return;
    }
  }

  // 3. Simpan Transaksi ke Google Sheets
  const saved = recordTransaction({
    chatId: chatId,
    tipe: tipe,
    akun: akun,
    akunTujuan: draft.akun_tujuan || '-',
    nominal: draft.nominal,
    biayaAdmin: draft.biaya_admin || 0,
    kategori: draft.kategori || (tipe === 'PEMASUKAN' ? 'Pemasukan' : (tipe === 'TRANSFER' ? 'Transfer' : 'Lainnya')),
    item: draft.item || tipe,
    alasan: draft.alasan || '-',
    pesanAsli: draft.pesan_asli || '',
    userName: firstName
  });

  // 4. Hitung Saldo Tercatat terbaru setelah disimpan
  const updatedSource = getSingleAccountBalance(chatId, saved.akun);
  let reply = '';

  if (tipe === 'PENGELUARAN') {
    const statsHariIni = getTodayStats(chatId);
    const sisaHarian = userConfig.daily_budget - statsHariIni.total;
    const infoBudget = sisaHarian >= 0
      ? `🟢 Sisa budget harian: Rp${formatRupiah(sisaHarian)}`
      : `🔴 Overbudget harian: -Rp${formatRupiah(Math.abs(sisaHarian))}`;

    reply =
      `✅ <b>Tercatat Rp${formatRupiah(saved.nominal)} · ${escapeHtml(draft.kategori || 'Lainnya')}</b>\n` +
      `📝 Item: ${escapeHtml(draft.item)}\n` +
      `💳 Saldo tercatat <b>${escapeHtml(saved.akun)}</b>: <b>Rp${formatRupiah(updatedSource.saldoTercatat)}</b>\n` +
      `📊 ${infoBudget}` +
      (draft.reply ? `\n\n💬 <i>"${escapeHtml(draft.reply)}"</i>` : '');

  } else if (tipe === 'PEMASUKAN') {
    reply =
      `💵 <b>Pemasukan Tercatat! (+Rp${formatRupiah(saved.nominal)})</b>\n` +
      `📝 Sumber: ${escapeHtml(draft.item)} (${escapeHtml(draft.kategori || 'Pemasukan')})\n` +
      `🏦 Akun: <b>${escapeHtml(saved.akun)}</b>\n` +
      `💰 Saldo tercatat <b>${escapeHtml(saved.akun)}</b>: <b>Rp${formatRupiah(updatedSource.saldoTercatat)}</b>` +
      (draft.reply ? `\n\n💬 <i>"${escapeHtml(draft.reply)}"</i>` : '');

  } else if (tipe === 'TRANSFER') {
    const updatedDest = getSingleAccountBalance(chatId, saved.akunTujuan);
    const allBal = getUserBalances(chatId);
    const infoAdmin = saved.biayaAdmin > 0
      ? `\n🧾 Biaya Admin (Pengeluaran): <b>Rp${formatRupiah(saved.biayaAdmin)}</b>`
      : '';

    reply =
      `🔄 <b>Transfer Tercatat! (Rp${formatRupiah(saved.nominal)})</b>\n` +
      `📤 Dari <b>${escapeHtml(saved.akun)}</b> → 📥 Ke <b>${escapeHtml(saved.akunTujuan)}</b>` +
      infoAdmin + `\n\n` +
      `• Saldo tercatat <b>${escapeHtml(saved.akun)}</b>: <b>Rp${formatRupiah(updatedSource.saldoTercatat)}</b>\n` +
      `• Saldo tercatat <b>${escapeHtml(saved.akunTujuan)}</b>: <b>Rp${formatRupiah(updatedDest.saldoTercatat)}</b>\n` +
      `• Total saldo tercatat: <b>Rp${formatRupiah(allBal.totalSaldo)}</b>`;
  }

  // Sertakan tombol Undo cepat dan opsi jadikan default jika user belum punya akun default
  const actionButtons = [[{ text: '↩️ Undo', callback_data: `UNDO:${saved.txId}` }]];
  if (!userConfig.default_akun && tipe === 'PENGELUARAN') {
    actionButtons[0].push({
      text: `⭐ Jadikan ${saved.akun} Default`,
      callback_data: `SETDEF:${saved.akun}`
    });
  }

  if (editMsgId) {
    editTelegramMessage(chatId, editMsgId, reply, actionButtons);
  } else {
    sendTelegramMessageWithKeyboard(chatId, reply, actionButtons);
  }
}

/**
 * Eksekusi Koreksi Saldo ("Saldo tunai sebenarnya 420rb") sebagai transaksi PENYESUAIAN
 */
function executeBalanceAdjustment(chatId, firstName, adjustData, editMsgId) {
  const akun = ensureAccountExists(chatId, adjustData.akun);
  const currentAcc = getSingleAccountBalance(chatId, akun);
  const saldoSebenarnya = Number(adjustData.saldoSebenarnya);
  const selisih = saldoSebenarnya - currentAcc.saldoTercatat;
  const alasan = adjustData.alasan || 'Penyesuaian saldo manual';

  if (selisih === 0) {
    const sameMsg = `✅ Saldo tercatat <b>${escapeHtml(akun)}</b> sudah sesuai yaitu <b>Rp${formatRupiah(saldoSebenarnya)}</b>. Tidak perlu penyesuaian.`;
    if (editMsgId) editTelegramMessage(chatId, editMsgId, sameMsg);
    else sendTelegramMessage(chatId, sameMsg);
    return;
  }

  const saved = recordTransaction({
    chatId: chatId,
    tipe: 'PENYESUAIAN',
    akun: akun,
    akunTujuan: '-',
    nominal: selisih, // signed delta (+ atau -)
    biayaAdmin: 0,
    kategori: 'Penyesuaian Saldo',
    item: `Koreksi Saldo ${akun}`,
    alasan: alasan,
    pesanAsli: adjustData.pesanAsli || '',
    userName: firstName
  });

  const updatedAcc = getSingleAccountBalance(chatId, akun);
  const signStr = selisih >= 0 ? `+Rp${formatRupiah(selisih)}` : `-Rp${formatRupiah(Math.abs(selisih))}`;

  const msg =
    `⚖️ <b>Koreksi Saldo Tercatat Berhasil!</b>\n` +
    `• Akun: <b>${escapeHtml(akun)}</b>\n` +
    `• Saldo tercatat sebelumnya: Rp${formatRupiah(currentAcc.saldoTercatat)}\n` +
    `• Penyesuaian: <b>${signStr}</b>\n` +
    `• Alasan: <i>${escapeHtml(alasan)}</i>\n` +
    `• <b>Saldo tercatat ${escapeHtml(akun)} sekarang: Rp${formatRupiah(updatedAcc.saldoTercatat)}</b>`;

  const kb = [[{ text: '↩️ Undo Koreksi', callback_data: `UNDO:${saved.txId}` }]];
  if (editMsgId) editTelegramMessage(chatId, editMsgId, msg, kb);
  else sendTelegramMessageWithKeyboard(chatId, msg, kb);
}

/**
 * ============================================================================
 * 9. HANDLER PERINTAH SLASH (/start, /saldo, /setakun, /undo, /edit)
 * ============================================================================
 */
function handleStart(chatId, firstName, userConfig) {
  const infoDefAkun = userConfig.default_akun
    ? `<b>${escapeHtml(userConfig.default_akun)}</b>`
    : `<i>Belum diatur (ketik <code>/setakun Tunai</code>)</i>`;

  const pesan =
    `Halo <b>${escapeHtml(firstName)}</b>! 👋\n` +
    `Selamat datang di <b>Dompet Palsu Bot v2.0 (Multi-Account & AI Edition)</b>.\n\n` +
    `Sekarang aku bisa melacak uangmu tinggal berapa, ada di akun mana saja, dan bergeraknya ke mana!\n\n` +
    `⚙️ <b>Profil Keuanganmu:</b>\n` +
    `• Target Budget Harian: <b>Rp${formatRupiah(userConfig.daily_budget)}</b>\n` +
    `• Akun Default: ${infoDefAkun}\n` +
    `• Persona AI: <b>${userConfig.persona.toUpperCase()}</b>\n\n` +
    `📌 <b>Contoh Pesan Langsung:</b>\n` +
    `• <b>Saldo Awal:</b> <code>Saldo awal tunai 500rb</code>\n` +
    `• <b>Pemasukan:</b> <code>Gaji masuk BCA 5jt</code>\n` +
    `• <b>Pengeluaran:</b> <code>Makan 25rb pakai tunai</code>\n` +
    `• <b>Transfer:</b> <code>Tarik tunai dari BCA 200rb</code>\n` +
    `• <b>Transfer + Admin:</b> <code>Transfer BCA ke GoPay 100rb + admin 2500</code>\n` +
    `• <b>Koreksi Saldo:</b> <code>Saldo tunai sebenarnya 420rb</code>\n\n` +
    `🛠️ <b>Perintah Bot:</b>\n` +
    `• /saldo — Cek saldo tercatat tiap akun & total\n` +
    `• /setakun <code>[Nama]</code> — Atur akun pembayaran default\n` +
    `• /undo — Batalkan transaksi terakhir & hitung ulang saldo\n` +
    `• /edit <code>[Nominal Baru]</code> — Ubah nominal transaksi terakhir\n` +
    `• /rekap — Rekap pengeluaran hari ini\n` +
    `• /bulan — Grafik & evaluasi AI bulanan`;

  sendTelegramMessage(chatId, pesan);
}

function handleCekSaldo(chatId, userConfig) {
  const balData = getUserBalances(chatId);

  if (balData.accounts.length === 0) {
    const emptyMsg =
      `👛 <b>Cek Saldo Tercatat</b>\n\n` +
      `Belum ada akun atau saldo yang tercatat.\n` +
      `Yuk mulai tetapkan titik awal pencatatanmu! Contoh:\n` +
      `• <code>Saldo awal tunai 500rb</code>\n` +
      `• <code>Saldo awal BCA 2jt</code>`;
    sendTelegramMessage(chatId, emptyMsg);
    return;
  }

  const lines = balData.accounts.map(acc => {
    const isDef = userConfig.default_akun &&
      userConfig.default_akun.toLowerCase() === acc.nama.toLowerCase() ? ' ⭐' : '';
    const tglStr = Utilities.formatDate(acc.tanggalMulai, Session.getScriptTimeZone(), "dd/MM/yyyy");
    const detailParts = [`Awal Rp${formatRupiah(acc.saldoAwal)}`];
    if (acc.pemasukan > 0) detailParts.push(`+Masuk Rp${formatRupiah(acc.pemasukan)}`);
    if (acc.pengeluaran > 0) detailParts.push(`-Keluar Rp${formatRupiah(acc.pengeluaran)}`);
    if (acc.transferMasuk > 0) detailParts.push(`+Tf Masuk Rp${formatRupiah(acc.transferMasuk)}`);
    if (acc.transferKeluar > 0) detailParts.push(`-Tf Keluar Rp${formatRupiah(acc.transferKeluar)}`);
    if (acc.penyesuaian !== 0) {
      const adjSign = acc.penyesuaian > 0 ? '+' : '-';
      detailParts.push(`${adjSign}Koreksi Rp${formatRupiah(Math.abs(acc.penyesuaian))}`);
    }

    return `• <b>${escapeHtml(acc.nama)}${isDef}: Rp${formatRupiah(acc.saldoTercatat)}</b>\n` +
           `  <i>(${detailParts.join(' · ')} | sejak ${tglStr})</i>`;
  });

  const pesan =
    `👛 <b> Ringkasan Saldo Tercatat</b>\n\n` +
    lines.join('\n\n') +
    `\n\n━━━━━━━━━━━━━━━\n` +
    `💰 <b>Total Saldo Tercatat: Rp${formatRupiah(balData.totalSaldo)}</b>\n\n` +
    `<i>*Catatan: Ini adalah <b>saldo tercatat</b> berdasarkan riwayat input sejak tanggal mulai saldo masing-masing akun (belum terhubung langsung ke mutasi bank).</i>`;

  sendTelegramMessage(chatId, pesan);
}

function handleSetDefaultAkun(chatId, text, userConfig) {
  const rawArg = text.replace(/^\/(setakun|default)\s*/i, '').trim();
  if (!rawArg) {
    const cur = userConfig.default_akun || 'Belum diatur';
    sendTelegramMessage(
      chatId,
      `⚙️ Akun default saat ini: <b>${escapeHtml(cur)}</b>\n` +
      `Ketik <code>/setakun Tunai</code> atau <code>/setakun BCA</code> untuk mengatur akun default, atau <code>/setakun reset</code> untuk selalu ditanya.`
    );
    return;
  }

  if (rawArg.toLowerCase() === 'reset' || rawArg.toLowerCase() === 'off' || rawArg.toLowerCase() === 'none') {
    updateUserDefaultAkun(chatId, userConfig, '');
    sendTelegramMessage(chatId, `✅ Akun default dinonaktifkan. Bot akan menanyakan akun setiap kali kamu mencatat transaksi tanpa menyebut akun.`);
    return;
  }

  const savedAcc = ensureAccountExists(chatId, rawArg);
  updateUserDefaultAkun(chatId, userConfig, savedAcc);
  sendTelegramMessage(
    chatId,
    `✅ Akun default berhasil diatur ke: <b>${escapeHtml(savedAcc)}</b>.\nSekarang kalau kamu ketik <code>Makan siang 25rb</code> tanpa menyebut akun, otomatis tercatat menggunakan <b>${escapeHtml(savedAcc)}</b>.`
  );
}

function handleUndoCommand(chatId, text, userConfig) {
  const parts = text.trim().split(/\s+/);
  const targetTxId = parts[1] ? parts[1].trim() : null;
  const res = undoTransactionByIdOrLast(chatId, targetTxId);

  if (!res.success) {
    sendTelegramMessage(chatId, `⚠️ ${escapeHtml(res.message)}`);
    return;
  }

  let msg =
    `↩️ <b>Undo Berhasil! (${escapeHtml(res.txId)})</b>\n` +
    `• Jenis: ${escapeHtml(res.tipe)}\n` +
    `• Item: ${escapeHtml(res.item)} (Rp${formatRupiah(res.nominal)})\n` +
    (res.cancelledAdminFee > 0 ? `• Biaya Admin Dibatalkan: Rp${formatRupiah(res.cancelledAdminFee)}\n` : '') +
    `• <b>Saldo tercatat ${escapeHtml(res.akun)}</b> diperbarui menjadi: <b>Rp${formatRupiah(res.saldoBaru)}</b>`;

  if (res.saldoTujuanBaru !== null) {
    msg += `\n• <b>Saldo tercatat ${escapeHtml(res.akunTujuan)}</b> diperbarui menjadi: <b>Rp${formatRupiah(res.saldoTujuanBaru)}</b>`;
  }

  sendTelegramMessage(chatId, msg);
}

function handleEditCommand(chatId, text, userConfig, firstName) {
  const clean = text.replace(/^\/(edit|ubah)\s*/i, '').trim();
  if (!clean) {
    sendTelegramMessage(
      chatId,
      `✏️ <b>Format Edit Transaksi Terakhir:</b>\n` +
      `• Ubah nominal: <code>/edit 35rb</code>\n` +
      `• Ubah nominal & akun: <code>/edit 35rb pakai BCA</code>\n` +
      `• Ubah berdasarkan ID: <code>/edit TRX-xxx 40rb</code>`
    );
    return;
  }

  let targetTxId = null;
  let remainder = clean;
  const idMatch = clean.match(/^(TRX-[A-Za-z0-9-]+)\s+(.+)$/i);
  if (idMatch) {
    targetTxId = idMatch[1];
    remainder = idMatch[2];
  }

  const nominalBaru = parseNominalSederhana(remainder);
  if (!nominalBaru || nominalBaru <= 0) {
    sendTelegramMessage(chatId, `⚠️ Nominal baru tidak dikenali. Contoh: <code>/edit 30rb</code>`);
    return;
  }

  let akunBaru = null;
  const accMatch = remainder.match(/(?:pakai|pake|via|ke|dari)\s+([a-zA-Z0-9_-]+)/i);
  if (accMatch) {
    akunBaru = normalizeAccountName(accMatch[1]);
  }

  const res = editTransactionByIdOrLast(chatId, targetTxId, nominalBaru, akunBaru, null);
  if (!res.success) {
    sendTelegramMessage(chatId, `⚠️ ${escapeHtml(res.message)}`);
    return;
  }

  let msg =
    `✏️ <b>Transaksi Diperbarui! (${escapeHtml(res.txId)})</b>\n` +
    `• Item: ${escapeHtml(res.itemBaru)}\n` +
    `• Nominal: Rp${formatRupiah(res.nominalLama)} → <b>Rp${formatRupiah(res.nominalBaru)}</b>\n` +
    `• Akun: <b>${escapeHtml(res.akunBaru)}</b>\n` +
    `• <b>Saldo tercatat ${escapeHtml(res.akunBaru)}</b> kini: <b>Rp${formatRupiah(res.saldoBaru)}</b>`;

  if (res.saldoAkunLama !== null) {
    msg += `\n• <b>Saldo tercatat ${escapeHtml(res.akunLama)}</b> kini: <b>Rp${formatRupiah(res.saldoAkunLama)}</b>`;
  }
  if (res.saldoTujuanBaru !== null) {
    msg += `\n• <b>Saldo tercatat ${escapeHtml(res.akunTujuan)}</b> kini: <b>Rp${formatRupiah(res.saldoTujuanBaru)}</b>`;
  }

  sendTelegramMessage(chatId, msg);
}

function handleSetBudget(chatId, text, userConfig) {
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    sendTelegramMessage(chatId, `⚠️ Format: <code>/setbudget 75k</code> atau <code>/setbudget 150000</code>`);
    return;
  }
  const nominalBaru = parseNominalSederhana(parts[1]);
  if (!nominalBaru || nominalBaru <= 0) {
    sendTelegramMessage(chatId, `⚠️ Nominal tidak valid. Contoh: <code>/setbudget 100k</code>`);
    return;
  }

  const ss = getSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  userSheet.getRange(userConfig.rowIndex, 4).setValue(nominalBaru);
  CacheService.getScriptCache().remove('u_cfg_' + chatId);

  sendTelegramMessage(chatId, `✅ <b>Target budget harianmu diubah menjadi: Rp${formatRupiah(nominalBaru)}/hari</b>.`);
}

function handleSetPersona(chatId, text, userConfig) {
  const parts = text.split(/\s+/);
  const personaBaru = (parts[1] || '').toLowerCase();

  if (personaBaru !== 'satir' && personaBaru !== 'santai') {
    sendTelegramMessage(chatId, `⚠️ Pilihan persona: <code>/setpersona satir</code> atau <code>/setpersona santai</code>`);
    return;
  }

  const ss = getSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  userSheet.getRange(userConfig.rowIndex, 5).setValue(personaBaru);
  CacheService.getScriptCache().remove('u_cfg_' + chatId);

  sendTelegramMessage(chatId, `✅ <b>Persona AI berhasil diubah ke: ${personaBaru.toUpperCase()}!</b>`);
}

/**
 * ============================================================================
 * 10. HANDLER UTAMA PESAN NATURAL (SALDO AWAL, PEMASUKAN, PENGELUARAN,
 *     TRANSFER, KOREKSI SALDO, UNDO/EDIT NATURAL, & CHAT SANTAI)
 * ============================================================================
 */
function handlePesanUser(chatId, firstName, text, userConfig) {
  // 1. Cek pola cepat deterministik untuk perintah natural (Saldo Awal, Koreksi Saldo, Undo/Edit, Cek Saldo)
  const deterministicIntent = parseDeterministicIntent(text);
  if (deterministicIntent) {
    executeParsedIntent(chatId, firstName, text, userConfig, deterministicIntent);
    return;
  }

  // 2. Analisis dengan Gemini AI (mendukung semua intent finansial + obrolan santai)
  const statsHariIni = getTodayStats(chatId);
  const balances = getUserBalances(chatId);
  const aiResult = analyzeWithGemini(text, userConfig, statsHariIni.total, balances);

  if (aiResult && aiResult.intent) {
    executeParsedIntent(chatId, firstName, text, userConfig, aiResult);
    return;
  }

  // 3. Fallback Regex Parser jika Gemini sedang gangguan
  const fallback = parseFallbackIntent(text, userConfig.persona, userConfig.daily_budget, statsHariIni.total);
  if (fallback) {
    executeParsedIntent(chatId, firstName, text, userConfig, fallback);
  } else {
    sendTelegramMessage(
      chatId,
      `Gue lagi agak pusing jaringannya nih bos. Kalau mau catat transaksi, pastiin ada nominal angkanya ya (contoh: <code>Makan 25rb pakai tunai</code> atau <code>Saldo awal tunai 500rb</code>)!`
    );
  }
}

/**
 * Menjalankan intent hasil ekstraksi (baik dari parser deterministik, Gemini AI, maupun Fallback)
 */
function executeParsedIntent(chatId, firstName, rawText, userConfig, parsed) {
  const intent = String(parsed.intent || 'CHAT').toUpperCase();

  // A. CEK SALDO
  if (intent === 'CEK_SALDO') {
    handleCekSaldo(chatId, userConfig);
    return;
  }

  // B. UNDO TRANSAKSI TERAKHIR
  if (intent === 'UNDO') {
    handleUndoCommand(chatId, '/undo', userConfig);
    return;
  }

  // C. EDIT TRANSAKSI TERAKHIR
  if (intent === 'EDIT' && parsed.nominal > 0) {
    const cmd = `/edit ${parsed.nominal}` + (parsed.akun ? ` pakai ${parsed.akun}` : '');
    handleEditCommand(chatId, cmd, userConfig, firstName);
    return;
  }

  // D. SALDO AWAL PER AKUN ("Saldo awal tunai 500rb")
  if (intent === 'SALDO_AWAL') {
    const akun = normalizeAccountName(parsed.akun || 'Tunai');
    const nominal = Number(parsed.nominal) || 0;
    const res = setAccountOpeningBalance(chatId, akun, nominal, parsed.tanggal_mulai || null, rawText, firstName);
    const bal = getSingleAccountBalance(chatId, res.akun);
    const tglStr = Utilities.formatDate(res.tanggalMulai, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm");

    const msg =
      `🏁 <b>Titik Saldo Awal Ditetapkan!</b>\n` +
      `• Akun: <b>${escapeHtml(res.akun)}</b>\n` +
      `• Saldo Awal: <b>Rp${formatRupiah(res.saldoAwal)}</b>\n` +
      `• Tanggal Mulai Saldo: <code>${tglStr}</code>\n` +
      `• Saldo tercatat <b>${escapeHtml(res.akun)}</b> saat ini: <b>Rp${formatRupiah(bal.saldoTercatat)}</b>\n\n` +
      `<i>Catatan: Saldo awal dipisahkan dari pemasukan bulanan, dan pengeluaran lama sebelum ${tglStr} tidak dipotong dari saldo awal baru ini.</i>`;

    const kb = [[{ text: '↩️ Undo', callback_data: `UNDO:${res.txId}` }]];
    sendTelegramMessageWithKeyboard(chatId, msg, kb);
    return;
  }

  // E. KOREKSI SALDO ("Saldo tunai sebenarnya 420rb")
  if (intent === 'KOREKSI_SALDO') {
    const akun = normalizeAccountName(parsed.akun || userConfig.default_akun || 'Tunai');
    const saldoSebenarnya = Number(parsed.nominal);
    const currentAcc = getSingleAccountBalance(chatId, akun);
    const selisih = saldoSebenarnya - currentAcc.saldoTercatat;
    const signStr = selisih >= 0 ? `+Rp${formatRupiah(selisih)}` : `-Rp${formatRupiah(Math.abs(selisih))}`;
    const alasanAwal = parsed.alasan && parsed.alasan !== '-' ? parsed.alasan : '';

    savePendingState(chatId, {
      step: 'WAITING_ADJUSTMENT_REASON',
      adjustData: {
        akun: akun,
        saldoSebenarnya: saldoSebenarnya,
        alasan: alasanAwal || 'Koreksi saldo sesuai fisik/mutasi',
        pesanAsli: rawText
      }
    });

    const kb = [
      [{ text: '✅ Konfirmasi Penyesuaian', callback_data: 'CONFIRM_ADJUST' }],
      [{ text: '❌ Batal', callback_data: 'CANCEL_PENDING' }]
    ];

    const promptKoreksi =
      `⚖️ <b>Konfirmasi Koreksi Saldo ${escapeHtml(akun)}</b>\n` +
      `• Saldo tercatat saat ini: <b>Rp${formatRupiah(currentAcc.saldoTercatat)}</b>\n` +
      `• Saldo sebenarnya: <b>Rp${formatRupiah(saldoSebenarnya)}</b>\n` +
      `• Penyesuaian: <b>${signStr}</b>\n` +
      (alasanAwal ? `• Alasan: <i>${escapeHtml(alasanAwal)}</i>\n\n` : `\n`) +
      `Ketik <b>alasan penyesuaian</b> (misal: <i>"Lupa catat parkir & jajan sore"</i>) untuk langsung mencatat, atau klik tombol konfirmasi di bawah:`;

    sendTelegramMessageWithKeyboard(chatId, promptKoreksi, kb);
    return;
  }

  // F. PEMASUKAN, PENGELUARAN, ATAU TRANSFER ANTAR-AKUN
  if ((intent === 'PENGELUARAN' || intent === 'PEMASUKAN' || intent === 'TRANSFER') && parsed.nominal > 0) {
    processVerifiedTransaction(chatId, firstName, userConfig, {
      tipe: intent,
      akun: parsed.akun || '',
      akun_tujuan: parsed.akun_tujuan || '-',
      akun_ambigu: Boolean(parsed.akun_ambigu),
      nominal: Number(parsed.nominal),
      biaya_admin: Number(parsed.biaya_admin) || 0,
      kategori: parsed.kategori || (intent === 'PEMASUKAN' ? 'Pemasukan' : (intent === 'TRANSFER' ? 'Transfer' : 'Lainnya')),
      item: parsed.item || intent,
      alasan: parsed.alasan || '-',
      pesan_asli: rawText,
      reply: parsed.reply || ''
    }, false, null);
    return;
  }

  // G. HANYA CHAT / CURHAT SANTAI
  sendTelegramMessage(chatId, escapeHtml(parsed.reply || 'Siap bos! Ada transaksi yang mau dicatat hari ini?'));
}

/**
 * ============================================================================
 * 11. PARSER DETERMINISTIK & GEMINI AI INTENT PARSER
 * ============================================================================
 */
function parseDeterministicIntent(text) {
  const clean = text.trim();
  const lower = clean.toLowerCase();

  // 1. Cek Saldo lewat kalimat natural
  if (/^(cek\s+saldo|info\s+saldo|saldo\s+saya|uangku\s+tinggal\s+berapa|sisa\s+saldo\??)$/i.test(lower)) {
    return { intent: 'CEK_SALDO' };
  }

  // 2. Saldo Awal per Akun: "Saldo awal tunai 500rb" / "Saldo awal BCA 2,5jt"
  const saldoAwalMatch = clean.match(/^saldo\s+awal\s+([a-zA-Z0-9_-]+)\s+(.+)$/i);
  if (saldoAwalMatch) {
    const akun = normalizeAccountName(saldoAwalMatch[1]);
    const nom = parseNominalSederhana(saldoAwalMatch[2]);
    if (nom !== null && nom >= 0) {
      return {
        intent: 'SALDO_AWAL',
        akun: akun,
        nominal: nom
      };
    }
  }

  // 3. Koreksi Saldo: "Saldo tunai sebenarnya 420rb [karena ...]" / "Koreksi saldo BCA 1,2jt"
  const koreksiMatch = clean.match(/^(?:koreksi\s+)?saldo\s+([a-zA-Z0-9_-]+)\s+(?:sebenarnya|aslinya|jadi|sekarang)\s+([^\s]+)(?:\s+(?:karena|alasan|soal(?:nya)?)\s+(.+))?$/i);
  if (koreksiMatch) {
    const akun = normalizeAccountName(koreksiMatch[1]);
    const nom = parseNominalSederhana(koreksiMatch[2]);
    const alasan = (koreksiMatch[3] || '').trim();
    if (nom !== null && nom >= 0) {
      return {
        intent: 'KOREKSI_SALDO',
        akun: akun,
        nominal: nom,
        alasan: alasan
      };
    }
  }

  // 4. Tarik Tunai: "Tarik tunai dari BCA 200rb [+ admin 2500]"
  const tarikMatch = clean.match(/^tarik\s+tunai\s+(?:dari\s+)?([a-zA-Z0-9_-]+)\s+(.+)$/i);
  if (tarikMatch) {
    const akunAsal = normalizeAccountName(tarikMatch[1]);
    const { pokok, admin } = parseNominalDanAdmin(tarikMatch[2]);
    if (pokok > 0) {
      return {
        intent: 'TRANSFER',
        akun: akunAsal,
        akun_tujuan: 'Tunai',
        nominal: pokok,
        biaya_admin: admin,
        kategori: 'Transfer',
        item: `Tarik Tunai dari ${akunAsal}`
      };
    }
  }

  // 5. Setor Tunai: "Setor tunai ke BCA 500rb"
  const setorMatch = clean.match(/^setor\s+tunai\s+(?:ke\s+)?([a-zA-Z0-9_-]+)\s+(.+)$/i);
  if (setorMatch) {
    const akunTujuan = normalizeAccountName(setorMatch[1]);
    const { pokok, admin } = parseNominalDanAdmin(setorMatch[2]);
    if (pokok > 0) {
      return {
        intent: 'TRANSFER',
        akun: 'Tunai',
        akun_tujuan: akunTujuan,
        nominal: pokok,
        biaya_admin: admin,
        kategori: 'Transfer',
        item: `Setor Tunai ke ${akunTujuan}`
      };
    }
  }

  // 6. Transfer Antar-Akun: "Transfer dari BCA ke GoPay 100rb + admin 2500"
  const tfMatch = clean.match(/^(?:transfer|tf|top\s*up|pindah\s+dana)\s+(?:dari\s+)?([a-zA-Z0-9_-]+)\s+(?:ke\s+)([a-zA-Z0-9_-]+)\s+(.+)$/i);
  if (tfMatch) {
    const akunAsal = normalizeAccountName(tfMatch[1]);
    const akunTujuan = normalizeAccountName(tfMatch[2]);
    const { pokok, admin } = parseNominalDanAdmin(tfMatch[3]);
    if (pokok > 0) {
      return {
        intent: 'TRANSFER',
        akun: akunAsal,
        akun_tujuan: akunTujuan,
        nominal: pokok,
        biaya_admin: admin,
        kategori: 'Transfer',
        item: `Transfer ${akunAsal} ke ${akunTujuan}`
      };
    }
  }

  return null;
}

/**
 * Memisahkan nominal pokok dan biaya admin dari teks seperti "100rb + admin 2500"
 */
function parseNominalDanAdmin(str) {
  let admin = 0;
  let mainPart = str;

  const adminMatch = str.match(/(?:\+|plus|biaya|admin|fee)\s*(?:admin|biaya|tf)?\s*(\d+(?:[.,]\d+)?\s*(?:rb|ribu|k|jt|juta)?)/i);
  if (adminMatch) {
    admin = parseNominalSederhana(adminMatch[1]) || 0;
    mainPart = str.replace(adminMatch[0], '').trim();
  }

  const pokok = parseNominalSederhana(mainPart) || 0;
  return { pokok: pokok, admin: admin };
}

/**
 * Analisis pesan natural menggunakan Gemini AI (Multi-Intent Keuangan)
 */
function analyzeWithGemini(text, userConfig, spentToday, balances) {
  const geminiKey = getGeminiApiKey();
  if (!geminiKey || geminiKey.includes('GANTI_DENGAN')) return null;

  const instruksiPersona = userConfig.persona === 'satir'
    ? `Gunakan gaya bahasa anak muda tongkrongan Indonesia yang cerdas, nyelekit tipis-tipis, sarkas/satir lucu namun tetap solutif.`
    : `Gunakan gaya bahasa asisten keuangan yang santai, suportif, bijak, dan ramah.`;

  const daftarAkunUser = balances.accounts.length > 0
    ? balances.accounts.map(a => `${a.nama} (Saldo tercatat: Rp${formatRupiah(a.saldoTercatat)})`).join(', ')
    : 'Belum ada akun tercatat (umum: Tunai, BCA, Mandiri, GoPay, OVO, DANA)';

  const prompt = `Kamu adalah asisten keuangan bernama "Dompet Palsu Bot".
Tugasmu: Klasifikasikan pesan user ke dalam salah satu INTENT berikut dan ekstrak datanya secara akurat:
1. "SALDO_AWAL" -> User menetapkan titik saldo awal akun (contoh: "Saldo awal tunai 500rb", "Saldo awal BCA 2jt").
2. "PEMASUKAN" -> Uang masuk / pendapatan baru ke akun (contoh: "Gaji masuk BCA 5jt", "Bonus 500rb ke Mandiri", "Dikasih ortu 200rb tunai"). Ingat: Saldo awal BUKAN pemasukan!
3. "PENGELUARAN" -> Belanja / bayar sesuatu (contoh: "Makan 25rb pakai tunai", "Makan siang 25rb", "Kopi 22rb").
4. "TRANSFER" -> Pindah uang antar-akun milik sendiri, termasuk tarik tunai atau top up e-wallet (contoh: "Tarik tunai dari BCA 200rb" -> akun: BCA, akun_tujuan: Tunai; "Transfer BCA ke GoPay 100rb + admin 2500" -> nominal: 100000, biaya_admin: 2500).
5. "KOREKSI_SALDO" -> User menyebutkan saldo riil/sebenarnya untuk penyesuaian (contoh: "Saldo tunai sebenarnya 420rb", "Saldo BCA aslinya tinggal 150rb karena lupa catat parkir").
6. "CEK_SALDO" -> User menanyakan sisa uang/saldo akunnya.
7. "UNDO" -> User minta membatalkan transaksi terakhir (contoh: "eh salah catat, batalin dong", "undo transaksi barusan").
8. "EDIT" -> User minta mengubah nominal transaksi terakhir (contoh: "eh makan siang tadi harusnya 30rb bukan 25rb").
9. "CHAT" -> Obrolan santai, curhat, sapaan, atau pertanyaan tanpa transaksi.

Konteks User:
- Target Budget Harian: Rp${userConfig.daily_budget}
- Pengeluaran Hari Ini: Rp${spentToday}
- Akun Default User: "${userConfig.default_akun || ''}"
- Daftar Akun & Saldo Tercatat: ${daftarAkunUser}
- Persona: ${userConfig.persona} (${instruksiPersona})

Pesan User: "${text}"

Kembalikan HANYA JSON murni dengan skema ini:
{
  "intent": "SALDO_AWAL" | "PEMASUKAN" | "PENGELUARAN" | "TRANSFER" | "KOREKSI_SALDO" | "CEK_SALDO" | "UNDO" | "EDIT" | "CHAT",
  "nominal": number (angka Rupiah pokok, 0 jika CHAT/CEK_SALDO/UNDO),
  "biaya_admin": number (khusus TRANSFER jika ada biaya admin terpisah, contoh 2500; selain itu 0),
  "akun": string (nama akun sumber/utama jika disebut eksplisit di pesan seperti "Tunai", "BCA", "GoPay"; kosongkan "" jika TIDAK disebut di pesan! Khusus tarik tunai "Tarik tunai dari BCA 200rb", akun="BCA"),
  "akun_tujuan": string (nama akun tujuan khusus TRANSFER, contoh "Tunai" saat tarik tunai, atau "GoPay" saat top up; selain itu "-"),
  "akun_ambigu": boolean (TRUE jika user menyebut lebih dari satu kemungkinan akun untuk pengeluaran/pemasukan secara meragukan, misal "pakai tunai atau bca ya"),
  "kategori": string (kategori seperti "Makanan", "Transportasi", "Gaji", "Transfer", dll),
  "item": string (deskripsi singkat transaksi),
  "alasan": string (alasan khusus KOREKSI_SALDO jika disebutkan user, selain itu "-"),
  "reply": string (1-2 kalimat komentar singkat sesuai persona ${userConfig.persona})
}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.4,
      maxOutputTokens: 700
    }
  };

  for (let model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() === 200) {
        const resJson = JSON.parse(response.getContentText());
        let rawText = "";
        const parts = resJson.candidates[0].content.parts;
        for (let p of parts) {
          if (!p.thought && p.text) {
            rawText = p.text;
            break;
          }
        }
        if (!rawText && parts[0] && parts[0].text) rawText = parts[0].text;

        const cleanJson = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const result = JSON.parse(cleanJson);
        if (result && result.intent) return result;
      }
    } catch (e) {
      console.warn(`Model ${model} error: ${e.message}`);
    }
  }

  return null;
}

/**
 * ============================================================================
 * 12. FALLBACK REGEX PARSER (JIKA GEMINI OFFLINE)
 * ============================================================================
 */
function parseFallbackIntent(text, persona, dailyBudget, spentToday) {
  const cleanText = text.trim();
  const lower = cleanText.toLowerCase();

  // Deteksi akun jika disebutkan dengan kata depan "pakai / pake / via / dari / ke"
  let detectedAkun = '';
  const accRegex = /\b(?:pakai|pake|via|dari|masuk|ke)\s+(tunai|cash|bca|mandiri|bri|bni|bsi|jago|seabank|gopay|ovo|dana|shopeepay)\b/i;
  const accMatch = cleanText.match(accRegex);
  if (accMatch) {
    detectedAkun = normalizeAccountName(accMatch[1]);
  }

  // Cek apakah pemasukan (Gaji, bonus, uang masuk, dll.)
  const isIncome = /\b(gaji|gajian|bonus|thr|pemasukan|uang\s+masuk|dapat\s+uang|dibayar|cair)\b/i.test(lower);

  const parsedExp = parseExpenseFallback(cleanText, persona, dailyBudget, spentToday);
  if (!parsedExp || parsedExp.nominal <= 0) return null;

  let cleanItem = parsedExp.item
    .replace(/\b(?:pakai|pake|via|dari|masuk|ke)\s+(?:tunai|cash|bca|mandiri|bri|bni|bsi|jago|seabank|gopay|ovo|dana|shopeepay)\b/gi, '')
    .trim() || (isIncome ? 'Pemasukan' : 'Pengeluaran');

  if (isIncome) {
    return {
      intent: 'PEMASUKAN',
      nominal: parsedExp.nominal,
      biaya_admin: 0,
      akun: detectedAkun,
      akun_tujuan: '-',
      kategori: 'Pemasukan',
      item: cleanItem,
      reply: 'Alhamdulillah rezeki masuk! Jangan lupa sisihkan buat tabungan ya.'
    };
  }

  return {
    intent: 'PENGELUARAN',
    nominal: parsedExp.nominal,
    biaya_admin: 0,
    akun: detectedAkun,
    akun_tujuan: '-',
    kategori: parsedExp.kategori,
    item: cleanItem,
    reply: parsedExp.roast
  };
}

function parseExpenseFallback(text, persona, dailyBudget, spentToday) {
  let kategori = 'Lainnya';
  let cleanText = text;
  const hashMatch = text.match(/#(\w+)/);

  if (hashMatch) {
    kategori = hashMatch[1].charAt(0).toUpperCase() + hashMatch[1].slice(1).toLowerCase();
    cleanText = text.replace(hashMatch[0], '').trim();
  }

  let regex = /(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)\b/i;
  let match = cleanText.match(regex);

  if (!match) {
    regex = /(?:^|\s)(\d{1,3}(?:[.,]\d{3})+|\d{4,})(?:\s|$)/;
    match = cleanText.match(regex);
  }

  if (!match) {
    regex = /(\d+(?:[.,]\d+)?)/;
    match = cleanText.match(regex);
  }

  if (!match) return null;

  let rawNum = match[1];
  const suffix = (match[2] || '').toLowerCase();

  let num;
  if (suffix) {
    num = parseFloat(rawNum.replace(',', '.'));
    if (suffix === 'rb' || suffix === 'ribu' || suffix === 'k') num *= 1000;
    if (suffix === 'jt' || suffix === 'juta') num *= 1000000;
  } else {
    num = parseInt(rawNum.replace(/[.,]/g, ''), 10);
  }

  if (isNaN(num) || num <= 0) return null;

  let item = cleanText.replace(match[0], '').replace(/^[-:\s]+|[-:\s]+$/g, '').trim() || 'Pengeluaran';

  if (kategori === 'Lainnya') {
    const lowerItem = item.toLowerCase();
    if (/kopi|americano|espresso|ngopi|jajan|snack|es|jus|teh|boba/.test(lowerItem)) kategori = 'Kopi & Jajan';
    else if (/makan|nasi|ayam|mie|bakso|soto|warteg|lauk|roti|siang|malam|sarapan/.test(lowerItem)) kategori = 'Makanan';
    else if (/bensin|parkir|grab|gojek|tol|kereta|ojol|pertamax/.test(lowerItem)) kategori = 'Transportasi';
    else if (/pancing|umpan|senar|kail|lure|reel|joran|game|steam/.test(lowerItem)) kategori = 'Hobi & Belanja';
    else if (/kucing|whiskas|pasir|oyen|pet/.test(lowerItem)) kategori = 'Kucing & Pet';
    else if (/listrik|air|wifi|pulsa|kuota|token|tagihan/.test(lowerItem)) kategori = 'Tagihan & Utilitas';
  }

  const nominal = Math.round(num);
  let roast = 'Tercatat rapi di pembukuan!';
  if (persona === 'satir') {
    if (spentToday + nominal > dailyBudget) {
      roast = 'Budget harian udah jebol bos, masih aja gas terus kayak nggak ada hari esok! 💀';
    } else if (nominal >= dailyBudget * 0.5) {
      roast = 'Sekali gesek langsung makan setengah budget harian. Mantap jiwa impulsifnya!';
    } else {
      roast = 'Kelihatannya receh sih, tapi kalau bocor halus tiap jam ya rungkad juga.';
    }
  }

  return { nominal: nominal, kategori: kategori, item: item, roast: roast };
}

function parseNominalSederhana(str) {
  if (!str) return null;
  const regex = /(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?/i;
  const match = String(str).match(regex);
  if (!match) return null;
  let rawNum = match[1];
  const suffix = (match[2] || '').toLowerCase();
  let num;
  if (suffix) {
    num = parseFloat(rawNum.replace(',', '.'));
    if (suffix === 'rb' || suffix === 'ribu' || suffix === 'k') num *= 1000;
    if (suffix === 'jt' || suffix === 'juta') num *= 1000000;
  } else {
    num = parseInt(rawNum.replace(/[.,]/g, ''), 10);
  }
  return isNaN(num) || num < 0 ? null : Math.round(num);
}

/**
 * ============================================================================
 * 13. REKAP HARIAN (/rekap) & REKAP BULANAN (/bulan) DENGAN FILTER STATUS AKTIF
 * ============================================================================
 */
function getTodayStats(chatId) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENGELUARAN);
  if (!sheet) return { total: 0, count: 0, rincian: [] };

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { total: 0, count: 0, rincian: [] };

  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  let total = 0;
  let count = 0;
  const rincian = [];

  for (let i = data.length - 1; i >= 1; i--) {
    if (!data[i][0]) continue;
    const status = String(data[i][9] || 'AKTIF').toUpperCase();
    if (status === 'BATAL') continue;

    const rowChatId = String(data[i][1]);
    const rowDate = Utilities.formatDate(new Date(data[i][0]), Session.getScriptTimeZone(), "yyyy-MM-dd");

    if (rowDate === todayStr) {
      if (rowChatId === String(chatId)) {
        const nom = Number(data[i][2]) || 0;
        const akunLabel = data[i][8] ? ` [${escapeHtml(data[i][8])}]` : '';
        total += nom;
        count++;
        rincian.unshift(`• ${escapeHtml(data[i][3])}: Rp${formatRupiah(nom)} (<i>${escapeHtml(data[i][4])}</i>)${akunLabel}`);
      }
    } else if (rowDate < todayStr && count > 0) {
      break;
    }
  }

  return { total: total, count: count, rincian: rincian };
}

function handleRekap(chatId, userConfig) {
  const dailyBudget = userConfig.daily_budget;
  const stats = getTodayStats(chatId);
  const balances = getUserBalances(chatId);

  const sisa = dailyBudget - stats.total;
  let status = sisa >= 0
    ? `🟢 Sisa budget hari ini: <b>Rp${formatRupiah(sisa)}</b>`
    : `🔴 Overbudget: <b>Rp${formatRupiah(Math.abs(sisa))}</b>! Rem dulu jajannya.`;

  const listTransaksi = stats.rincian.length > 0
    ? `\n\n<b>Catatan Pengeluaran Hari Ini:</b>\n` + stats.rincian.slice(-10).join('\n')
    : `\n\n<i>Belum ada pengeluaranmu yang tercatat hari ini.</i>`;

  const infoSaldoTotal = balances.accounts.length > 0
    ? `\n👛 Total Saldo Tercatat: <b>Rp${formatRupiah(balances.totalSaldo)}</b> (cek detail di /saldo)`
    : '';

  const pesan =
    `📊 <b>Rekap Keuangan Harian</b>\n\n` +
    `🧾 Transaksi Keluar: ${stats.count} kali\n` +
    `💸 Total Keluar Hari Ini: <b>Rp${formatRupiah(stats.total)}</b>\n` +
    `🎯 Target Harianmu: Rp${formatRupiah(dailyBudget)}` +
    infoSaldoTotal + `\n\n` +
    status + listTransaksi;

  sendTelegramMessage(chatId, pesan);
}

function handleRekapBulanan(chatId, text, userConfig) {
  const parts = text.trim().split(/\s+/);
  const now = new Date();
  let targetMonth = now.getMonth();
  let targetYear = now.getFullYear();

  if (parts[1]) {
    const subParts = parts[1].split(/[-/]/);
    const parsedM = parseInt(subParts[0], 10);
    if (!isNaN(parsedM) && parsedM >= 1 && parsedM <= 12) {
      targetMonth = parsedM - 1;
    }
    if (subParts[1]) {
      const parsedY = parseInt(subParts[1], 10);
      if (!isNaN(parsedY) && parsedY >= 2020) {
        targetYear = parsedY;
      }
    }
  }

  const namaBulanList = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  const labelPeriode = `${namaBulanList[targetMonth]} ${targetYear}`;

  sendTelegramChatAction(chatId, 'upload_photo');

  const summary = getMonthlyStats(chatId, targetMonth, targetYear);
  if (!summary || summary.totalSpending === 0) {
    sendTelegramMessage(
      chatId,
      `📊 <b>Rekap ${labelPeriode}</b>\n\nBelum ada catatan pengeluaran aktif di periode ini. Dompet masih utuh atau lupa nyatet nih?`
    );
    return;
  }

  const lineChartUrl = generateLineChartUrl(
    summary.dailyDays,
    summary.dailyAmounts,
    userConfig.daily_budget,
    labelPeriode
  );
  const doughnutChartUrl = generateDoughnutChartUrl(summary.categories, labelPeriode);
  const aiEvaluation = analyzeMonthlyWithGemini(summary, userConfig, labelPeriode);

  const infoIncome = summary.totalIncome > 0
    ? `💵 <b>Total Pemasukan:</b> Rp${formatRupiah(summary.totalIncome)} (diluar saldo awal)\n`
    : '';

  let caption =
    `📊 <b>REKAP & EVALUASI: ${labelPeriode.toUpperCase()}</b>\n\n` +
    infoIncome +
    `💸 <b>Total Keluar:</b> Rp${formatRupiah(summary.totalSpending)} (${summary.txCount}x transaksi)\n` +
    `📅 <b>Rata-rata Harian:</b> Rp${formatRupiah(Math.round(summary.dailyAverage))}/hari\n` +
    `🔥 <b>Puncak Boncos:</b> Tgl ${summary.highestDay.day} (Rp${formatRupiah(summary.highestDay.amount)})\n` +
    `🏆 <b>Pos Terbesar:</b> ${escapeHtml(summary.topCategory.name)} (${summary.topCategory.percent}%)\n\n` +
    `🧠 <b>Evaluasi Dompet Palsu:</b>\n${escapeHtml(aiEvaluation)}`;

  if (caption.length > 1020) {
    caption = caption.substring(0, 1015) + '...';
  }

  const sent = sendTelegramMediaGroup(chatId, [
    { type: 'photo', media: lineChartUrl, caption: caption, parse_mode: 'HTML' },
    { type: 'photo', media: doughnutChartUrl }
  ]);

  if (!sent) {
    sendTelegramMessage(chatId, caption);
  }
}

function getMonthlyStats(chatId, month, year) {
  const ss = getSpreadsheet();
  const expSheet = ss.getSheetByName(SHEET_PENGELUARAN);
  const txSheet = ss.getSheetByName(SHEET_TRANSAKSI);
  if (!expSheet) return null;

  const data = expSheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dailyTotals = Array(daysInMonth).fill(0);
  const categories = {};
  const allItems = [];
  let totalSpending = 0;
  let txCount = 0;

  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    const status = String(data[i][9] || 'AKTIF').toUpperCase();
    if (status === 'BATAL') continue;

    const rowChatId = String(data[i][1]);
    if (rowChatId !== String(chatId)) continue;

    const rowDate = new Date(data[i][0]);
    const nominal = Number(data[i][2]) || 0;
    const kategori = String(data[i][3] || 'Lainnya').trim();
    const item = String(data[i][4] || 'Pengeluaran').trim();

    if (rowDate.getMonth() === month && rowDate.getFullYear() === year && nominal > 0) {
      const dayIndex = rowDate.getDate() - 1;
      dailyTotals[dayIndex] += nominal;
      categories[kategori] = (categories[kategori] || 0) + nominal;
      totalSpending += nominal;
      txCount++;
      allItems.push({ item: item, nominal: nominal, kategori: kategori, tanggal: rowDate.getDate() });
    }
  }

  // Hitung pemasukan bulan ini (murni PEMASUKAN, tidak termasuk SALDO_AWAL atau TRANSFER)
  let totalIncome = 0;
  if (txSheet) {
    const txData = txSheet.getDataRange().getValues();
    for (let i = 1; i < txData.length; i++) {
      if (String(txData[i][2]) !== String(chatId)) continue;
      if (String(txData[i][11] || 'AKTIF').toUpperCase() !== 'AKTIF') continue;
      if (String(txData[i][3]).toUpperCase() !== 'PEMASUKAN') continue;
      const d = new Date(txData[i][1]);
      if (d.getMonth() === month && d.getFullYear() === year) {
        totalIncome += Number(txData[i][6]) || 0;
      }
    }
  }

  if (totalSpending === 0) return null;

  const now = new Date();
  const isCurrentMonth = (now.getMonth() === month && now.getFullYear() === year);
  const elapsedDays = isCurrentMonth ? Math.max(1, now.getDate()) : daysInMonth;

  const sortedCategories = Object.keys(categories).sort((a, b) => categories[b] - categories[a]);
  const categoriesSortedObj = {};
  const categoriesBreakdownText = [];

  sortedCategories.forEach(cat => {
    const amt = categories[cat];
    const pct = ((amt / totalSpending) * 100).toFixed(1);
    categoriesSortedObj[cat] = amt;
    categoriesBreakdownText.push(`${cat}: Rp${formatRupiah(amt)} (${pct}%)`);
  });

  const topCatName = sortedCategories[0];
  const topCatPercent = ((categories[topCatName] / totalSpending) * 100).toFixed(1);

  let maxDay = { day: 1, amount: 0 };
  dailyTotals.forEach((amt, idx) => {
    if (amt > maxDay.amount) {
      maxDay = { day: idx + 1, amount: amt };
    }
  });

  allItems.sort((a, b) => b.nominal - a.nominal);
  const topExpenses = allItems.slice(0, 3).map(x => `${x.item} (Rp${formatRupiah(x.nominal)} Tgl ${x.tanggal})`);

  return {
    totalSpending: totalSpending,
    totalIncome: totalIncome,
    txCount: txCount,
    dailyAverage: totalSpending / elapsedDays,
    elapsedDays: elapsedDays,
    highestDay: maxDay,
    categories: categoriesSortedObj,
    categoriesBreakdownText: categoriesBreakdownText,
    topCategory: { name: topCatName, amount: categories[topCatName], percent: topCatPercent },
    topExpenses: topExpenses,
    dailyDays: Array.from({ length: daysInMonth }, (_, i) => i + 1),
    dailyAmounts: dailyTotals
  };
}

function analyzeMonthlyWithGemini(summary, userConfig, labelPeriode) {
  const geminiKey = getGeminiApiKey();
  if (!geminiKey || geminiKey.includes('GANTI_DENGAN')) {
    return `Pengeluaran terbesar ada di pos ${summary.topCategory.name} (${summary.topCategory.percent}%). Coba tekan pos ini bulan depan biar tabungan lebih aman!`;
  }

  const gayaBahasa = userConfig.persona === 'satir'
    ? `santai, anak muda tongkrongan, sarkas-humoris, nyelekit tipis-tipis tapi cerdas dan solutif`
    : `santai, ramah, suportif, dan bijak`;

  const prompt = `Kamu adalah "Dompet Palsu Bot", asisten keuangan pribadi dengan gaya bahasa: ${gayaBahasa}.
Analisis rekap keuangan bulanan user untuk periode ${labelPeriode}:
- Total Pemasukan Baru (diluar saldo awal): Rp${formatRupiah(summary.totalIncome || 0)}
- Total Pengeluaran: Rp${formatRupiah(summary.totalSpending)} (${summary.txCount} transaksi dalam ${summary.elapsedDays} hari berjalan)
- Rata-rata Harian: Rp${formatRupiah(Math.round(summary.dailyAverage))}/hari (Target Budget Harian user: Rp${formatRupiah(userConfig.daily_budget)}/hari)
- Puncak Kebocoran: Tanggal ${summary.highestDay.day} sebesar Rp${formatRupiah(summary.highestDay.amount)}
- Rincian Kategori: ${summary.categoriesBreakdownText.join(', ')}
- 3 Item Belanja Terbesar: ${summary.topExpenses.join(', ')}

Buat evaluasi singkat (MAKSIMAL 95 KATA, tanpa tanda bintang/markdown) yang mencakup 3 poin mengalir:
1. Larinya Kemana: Bedah pos kategori yang paling banyak menyedot uang dan komentari item belanja terbesarnya.
2. Evaluasi Pola: Bandingkan rata-rata harian dengan target budget hariannya serta tanggal puncak boncosnya.
3. Saran Konkret: Berikan 1 saran praktis yang bisa langsung diterapkan bulan depan.`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 350
    }
  };

  for (let model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() === 200) {
        const resJson = JSON.parse(response.getContentText());
        const parts = resJson.candidates[0].content.parts;
        for (let p of parts) {
          if (!p.thought && p.text) {
            return p.text.replace(/\*\*/g, '').replace(/\*/g, '').trim();
          }
        }
      }
    } catch (e) {
      console.warn(`Monthly Gemini error (${model}): ${e.message}`);
    }
  }

  return `Uangmu bulan ini paling banyak lari ke ${summary.topCategory.name} (${summary.topCategory.percent}%). Yuk lebih disiplin jaga batas harian Rp${formatRupiah(userConfig.daily_budget)}!`;
}

function generateLineChartUrl(labels, data, dailyBudget, labelPeriode) {
  const budgetLine = Array(labels.length).fill(dailyBudget);

  const chartConfig = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Pengeluaran Harian',
          data: data,
          fill: true,
          backgroundColor: 'rgba(54, 162, 235, 0.18)',
          borderColor: '#36A2EB',
          borderWidth: 2.5,
          lineTension: 0.3,
          pointRadius: 2.5
        },
        {
          label: 'Target Budget Harian',
          data: budgetLine,
          fill: false,
          borderColor: '#EB5757',
          borderWidth: 1.5,
          borderDash: [5, 5],
          pointRadius: 0
        }
      ]
    },
    options: {
      title: { display: true, text: `Tren Pengeluaran Harian - ${labelPeriode}`, fontSize: 14 },
      legend: { position: 'bottom' },
      scales: {
        xAxes: [{ gridLines: { display: false } }],
        yAxes: [{
          ticks: {
            beginAtZero: true,
            callback: '(val) => (val >= 1000 ? (val/1000) + "k" : val)'
          }
        }]
      }
    }
  };

  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=650&h=360&bkg=white`;
}

function generateDoughnutChartUrl(categories, labelPeriode) {
  const labels = Object.keys(categories);
  const data = Object.values(categories);
  const total = data.reduce((a, b) => a + b, 0);

  const labelsWithPct = labels.map(cat => {
    const pct = Math.round((categories[cat] / total) * 100);
    return `${cat} (${pct}%)`;
  });

  const palette = [
    '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0',
    '#9966FF', '#FF9F40', '#00D2D3', '#54A0FF', '#5F27CD'
  ];

  const chartConfig = {
    type: 'doughnut',
    data: {
      labels: labelsWithPct,
      datasets: [{
        data: data,
        backgroundColor: palette.slice(0, labels.length),
        borderWidth: 1.5
      }]
    },
    options: {
      title: { display: true, text: `Porsi Kategori Pengeluaran - ${labelPeriode}`, fontSize: 14 },
      legend: { position: 'right' },
      cutoutPercentage: 55
    }
  };

  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=600&h=360&bkg=white`;
}

/**
 * ============================================================================
 * 14. HELPER TELEGRAM API & FORMATTING
 * ============================================================================
 */
function sendTelegramMessage(chatId, text) {
  const token = getBotToken();
  if (!token) {
    Logger.log('BOT_TOKEN belum dikonfigurasi di Script Properties.');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: String(chatId),
    text: text,
    parse_mode: 'HTML'
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function sendTelegramMessageWithKeyboard(chatId, text, inlineKeyboardArray) {
  const token = getBotToken();
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: String(chatId),
    text: text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: inlineKeyboardArray
    }
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function editTelegramMessage(chatId, messageId, text, inlineKeyboardArray) {
  const token = getBotToken();
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const payload = {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: text,
    parse_mode: 'HTML'
  };
  if (inlineKeyboardArray) {
    payload.reply_markup = { inline_keyboard: inlineKeyboardArray };
  }

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  const token = getBotToken();
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || ''
    }),
    muteHttpExceptions: true
  });
}

function sendTelegramChatAction(chatId, action) {
  const token = getBotToken();
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: String(chatId), action: action }),
    muteHttpExceptions: true
  });
}

function sendTelegramMediaGroup(chatId, mediaArray) {
  const token = getBotToken();
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
  const payload = {
    chat_id: String(chatId),
    media: JSON.stringify(mediaArray)
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  return res.getResponseCode() === 200;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRupiah(angka) {
  return Number(angka || 0).toLocaleString('id-ID');
}

/**
 * ============================================================================
 * 15. SETUP WEBHOOK & TRIGGER BULANAN OTOMATIS
 * ============================================================================
 */
function resetDanPasangWebhook() {
  const targetUrl = getWebAppUrl();
  const token = getBotToken();
  if (!token) {
    Logger.log('❌ BOT_TOKEN belum diatur di Script Properties!');
    return;
  }
  if (!targetUrl) {
    Logger.log('❌ WEBAPP_URL belum diatur di Script Properties!');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/setWebhook`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      url: targetUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true
    }),
    muteHttpExceptions: true
  });
  Logger.log('Hasil Set Webhook (dengan callback_query): ' + response.getContentText());
}

/**
 * Helper opsional: Atur Script Properties melalui kode tanpa menu Project Settings.
 * Cukup isi objek di bawah dan jalankan fungsi ini satu kali di editor Apps Script.
 */
function setupScriptProperties() {
  const properties = {
    BOT_TOKEN: '',       // Token bot Telegram dari @BotFather
    GEMINI_API_KEY: '',  // API Key Google Gemini dari Google AI Studio (opsional)
    SPREADSHEET_ID: '',  // Wajib HANYA jika script tidak terikat (standalone)
    WEBAPP_URL: ''       // URL Deployment Web App setelah deploy
  };

  const toSet = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value && typeof value === 'string' && value.trim() !== '') {
      toSet[key] = value.trim();
    }
  }

  if (Object.keys(toSet).length > 0) {
    PropertiesService.getScriptProperties().setProperties(toSet);
    Logger.log('✅ Berhasil menyimpan Script Properties: ' + Object.keys(toSet).join(', '));
  } else {
    Logger.log('ℹ️ Tidak ada nilai baru yang disimpan. Silakan isi properti di objek properties jika ingin menggunakan helper ini.');
  }
}

function setWebhook() {
  resetDanPasangWebhook();
}

function kirimRekapBulananOtomatis() {
  const ss = getSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_USERS);
  if (!userSheet) return;

  const data = userSheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const targetMonthIndex = prevMonthDate.getMonth();
  const targetMonthNumber = targetMonthIndex + 1;
  const targetYear = prevMonthDate.getFullYear();

  const commandSimulasi = `/bulan ${targetMonthNumber}-${targetYear}`;

  for (let i = 1; i < data.length; i++) {
    const chatId = String(data[i][0]).trim();
    if (!chatId) continue;

    const userConfig = {
      rowIndex: i + 1,
      chat_id: chatId,
      username: data[i][1] || '',
      name: data[i][2] || 'Kawan',
      daily_budget: Number(data[i][3]) || 100000,
      persona: data[i][4] || 'satir',
      default_akun: String(data[i][6] || '').trim()
    };

    try {
      const summary = getMonthlyStats(chatId, targetMonthIndex, targetYear);
      if (summary && summary.totalSpending > 0) {
        sendTelegramMessage(
          chatId,
          `🌅 <b>Selamat pagi, ${escapeHtml(userConfig.name)}!</b>\nPergantian bulan nih. Ini dia rapor dan evaluasi keuanganmu selama bulan kemarin:`
        );
        handleRekapBulanan(chatId, commandSimulasi, userConfig);
        Utilities.sleep(2000);
      }
    } catch (err) {
      console.error(`Gagal mengirim rekap otomatis ke Chat ID ${chatId}: ${err.message}`);
    }
  }
}

function pasangTriggerBulanan() {
  const namaFungsi = 'kirimRekapBulananOtomatis';
  const existingTriggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existingTriggers.length; i++) {
    if (existingTriggers[i].getHandlerFunction() === namaFungsi) {
      ScriptApp.deleteTrigger(existingTriggers[i]);
    }
  }

  ScriptApp.newTrigger(namaFungsi)
    .timeBased()
    .onMonthDay(1)
    .atHour(8)
    .create();

  Logger.log('✅ Trigger otomatis berhasil dipasang! Bot akan mengirim rekap setiap tanggal 1 jam 08.00 pagi.');
}
