/**
 * ============================================================================
 *  TOKO POS — Point of Sale untuk Toko Kelontong (Google Apps Script Web App)
 *  Versi 1.0.0
 * ============================================================================
 *  Catatan keamanan:
 *  - Fungsi berakhiran "_" bersifat privat dan TIDAK dapat dipanggil dari browser.
 *  - Satu-satunya pintu masuk dari browser adalah api(action, token, payload).
 *  - Semua hak akses, harga, stok, voucher, dan total dihitung ulang di server.
 *  - Password disimpan sebagai hash SHA-256 berulang + salt unik per pengguna.
 */

const TZ = 'Asia/Jakarta';
const VERSION = '1.0.0';
const ROLE_LEVEL = { kasir: 1, admin: 2, superadmin: 3 };
const SESSION_TTL = 21600;      // detik (maks. CacheService = 6 jam)
const LOGIN_MAX_FAIL = 5;
const LOGIN_LOCK_SEC = 900;     // 15 menit
const KEEP_BACKUPS = 14;
const PRESENCE_MS = 150000;     // batas detak sesi untuk aturan 1 akun = 1 perangkat

/* ===================== SKEMA DATABASE (Google Sheets) ===================== */
const SCHEMA = {
  Users: ['id', 'username', 'nama', 'role', 'passHash', 'salt', 'aktif', 'mustChange', 'createdAt', 'lastLogin'],
  Products: ['id', 'sku', 'barcode', 'nama', 'kategori', 'satuan', 'hargaBeli', 'hargaJual', 'hargaGrosir', 'minGrosir', 'stok', 'stokMin', 'aktif', 'updatedAt'],
  Categories: ['id', 'nama'],
  Customers: ['id', 'nama', 'hp', 'alamat', 'poin', 'totalBelanja', 'createdAt'],
  Suppliers: ['id', 'nama', 'hp', 'alamat'],
  Vouchers: ['id', 'kode', 'deskripsi', 'jenis', 'nilai', 'minBelanja', 'maksDiskon', 'mulai', 'selesai', 'kuota', 'terpakai', 'aktif'],
  Promos: ['id', 'nama', 'target', 'targetId', 'jenis', 'nilai', 'mulai', 'selesai', 'aktif'],
  Expenses: ['id', 'tanggal', 'kategori', 'keterangan', 'jumlah', 'user'],
  Sales: ['id', 'tanggal', 'kasirId', 'kasirNama', 'pelangganId', 'pelangganNama', 'subtotal', 'diskonPromo', 'diskonVoucher', 'diskonManual', 'diskonPoin', 'pajak', 'pembulatan', 'total', 'metode', 'bayar', 'kembali', 'ref', 'voucherKode', 'poinDapat', 'poinPakai', 'hpp', 'status', 'shiftId', 'catatan'],
  SaleItems: ['saleId', 'productId', 'sku', 'nama', 'qty', 'harga', 'hargaBeli', 'diskon', 'subtotal'],
  Purchases: ['id', 'tanggal', 'supplierNama', 'productId', 'nama', 'qty', 'hargaBeli', 'total', 'user', 'catatan'],
  StockLog: ['id', 'tanggal', 'productId', 'nama', 'jenis', 'qty', 'stokAkhir', 'ref', 'user', 'catatan'],
  Shifts: ['id', 'kasirId', 'kasirNama', 'buka', 'tutup', 'modalAwal', 'tunaiSistem', 'tunaiAktual', 'selisih', 'totalJual', 'jumlahTrx', 'status', 'catatan'],
  Settings: ['key', 'value'],
  AuditLog: ['tanggal', 'user', 'role', 'aksi', 'detail']
};
// Kolom angka. Semua kolom lain disimpan sebagai TEKS (mencegah formula-injection & hilangnya angka 0 di depan).
const NUMCOLS = new Set(['hargaBeli', 'hargaJual', 'hargaGrosir', 'minGrosir', 'stok', 'stokMin', 'poin', 'totalBelanja',
  'nilai', 'minBelanja', 'maksDiskon', 'kuota', 'terpakai', 'jumlah', 'subtotal', 'diskonPromo', 'diskonVoucher', 'diskonManual',
  'diskonPoin', 'pajak', 'pembulatan', 'total', 'bayar', 'kembali', 'poinDapat', 'poinPakai', 'hpp', 'qty', 'harga', 'diskon',
  'stokAkhir', 'modalAwal', 'tunaiSistem', 'tunaiAktual', 'selisih', 'totalJual', 'jumlahTrx']);

const DEFAULTS = {
  namaToko: 'Toko Kelontong', alamat: '', telp: '', footerStruk: 'Terima kasih atas kunjungan Anda.\nBarang yang sudah dibeli tidak dapat dikembalikan.',
  lebarStruk: '58',
  bankNama: 'BCA', bankNoRek: '0332289347', bankAtasNama: 'BAHRUDDIN',
  pajakAktif: 'Tidak', pajakPersen: '11', pembulatan: '0',
  poinAktif: 'Ya', poinPerRupiah: '10000', nilaiPoin: '100',
  wajibShift: 'Ya', kasirBolehDiskon: 'Tidak', stokMinus: 'Tidak', idleMenit: '30',
  logoFile: '', qrisFile: '', lastBackup: '', autoBackup: 'Tidak'
};

const SETSPEC = [
  { k: 'namaToko', l: 'Nama Toko', g: 'Profil Toko', t: 'text', req: true },
  { k: 'telp', l: 'Telepon / WhatsApp', g: 'Profil Toko', t: 'text' },
  { k: 'alamat', l: 'Alamat', g: 'Profil Toko', t: 'textarea', w: 'full' },
  { k: 'footerStruk', l: 'Pesan Footer Struk', g: 'Struk', t: 'textarea', w: 'full' },
  { k: 'lebarStruk', l: 'Lebar Kertas Struk (mm)', g: 'Struk', t: 'select', opts: ['58', '80'] },
  { k: 'bankNama', l: 'Nama Bank', g: 'Pembayaran Transfer', t: 'text' },
  { k: 'bankNoRek', l: 'Nomor Rekening', g: 'Pembayaran Transfer', t: 'text' },
  { k: 'bankAtasNama', l: 'Atas Nama', g: 'Pembayaran Transfer', t: 'text' },
  { k: 'pajakAktif', l: 'Aktifkan Pajak (PPN)', g: 'Pajak & Pembulatan', t: 'switch' },
  { k: 'pajakPersen', l: 'Tarif Pajak (%)', g: 'Pajak & Pembulatan', t: 'num', min: 0, max: 100 },
  { k: 'pembulatan', l: 'Pembulatan Total (Rp)', g: 'Pajak & Pembulatan', t: 'select', opts: ['0', '100', '500', '1000'], help: '0 = tanpa pembulatan' },
  { k: 'poinAktif', l: 'Aktifkan Poin Loyalitas', g: 'Loyalitas Pelanggan', t: 'switch' },
  { k: 'poinPerRupiah', l: 'Belanja per 1 Poin (Rp)', g: 'Loyalitas Pelanggan', t: 'num', min: 1 },
  { k: 'nilaiPoin', l: 'Nilai 1 Poin saat Ditukar (Rp)', g: 'Loyalitas Pelanggan', t: 'num', min: 0 },
  { k: 'wajibShift', l: 'Wajib Buka Shift sebelum Transaksi', g: 'Operasional & Keamanan', t: 'switch' },
  { k: 'kasirBolehDiskon', l: 'Penjaga Toko Boleh Diskon Manual', g: 'Operasional & Keamanan', t: 'switch' },
  { k: 'stokMinus', l: 'Izinkan Penjualan saat Stok Kosong', g: 'Operasional & Keamanan', t: 'switch' },
  { k: 'idleMenit', l: 'Auto-logout bila Tidak Aktif (menit)', g: 'Operasional & Keamanan', t: 'num', min: 5, max: 240 }
];

/* Definisi entitas CRUD generik — dipakai server (validasi) & klien (membangun tabel/form otomatis) */
const ENT = {
  products: {
    sheet: 'Products', prefix: 'P', title: 'Data Produk', sub: 'Kelola katalog, harga, dan batas stok barang', label: 'Produk',
    cols: ['sku', 'nama', 'kategori', 'hargaJual', 'stok', 'aktif'], search: ['sku', 'barcode', 'nama', 'kategori'],
    fields: [
      { n: 'nama', l: 'Nama Produk', t: 'text', req: true, w: 'full' },
      { n: 'sku', l: 'SKU / Kode Barang', t: 'text', unique: true, help: 'Kosongkan untuk dibuat otomatis' },
      { n: 'barcode', l: 'Barcode', t: 'text', unique: true },
      { n: 'kategori', l: 'Kategori', t: 'select', from: 'categories' },
      { n: 'satuan', l: 'Satuan', t: 'text', def: 'pcs' },
      { n: 'hargaBeli', l: 'Harga Beli', t: 'num', rp: true, min: 0, def: 0 },
      { n: 'hargaJual', l: 'Harga Jual', t: 'num', rp: true, min: 0, req: true },
      { n: 'hargaGrosir', l: 'Harga Grosir', t: 'num', rp: true, min: 0, def: 0, help: 'Isi 0 bila tidak ada' },
      { n: 'minGrosir', l: 'Min. Qty Harga Grosir', t: 'num', min: 0, def: 0 },
      { n: 'stok', l: 'Stok Awal', t: 'num', min: 0, def: 0, createOnly: true, help: 'Perubahan stok berikutnya lewat menu Stok & Inventaris' },
      { n: 'stokMin', l: 'Batas Stok Minimum', t: 'num', min: 0, def: 5 },
      { n: 'aktif', l: 'Produk Aktif', t: 'switch', def: 'Ya' }
    ]
  },
  categories: {
    sheet: 'Categories', prefix: 'C', title: 'Kategori Produk', sub: 'Kelompokkan produk agar mudah dicari di kasir', label: 'Kategori',
    cols: ['nama'], search: ['nama'],
    fields: [{ n: 'nama', l: 'Nama Kategori', t: 'text', req: true, unique: true, w: 'full' }]
  },
  customers: {
    sheet: 'Customers', prefix: 'U', title: 'Data Pelanggan', sub: 'Pelanggan tetap, riwayat belanja, dan poin loyalitas', label: 'Pelanggan',
    cols: ['nama', 'hp', 'poin', 'totalBelanja', 'createdAt'], search: ['nama', 'hp', 'alamat'],
    fields: [
      { n: 'nama', l: 'Nama Pelanggan', t: 'text', req: true },
      { n: 'hp', l: 'No. HP / WhatsApp', t: 'text' },
      { n: 'alamat', l: 'Alamat', t: 'textarea', w: 'full' },
      { n: 'poin', l: 'Poin Loyalitas', t: 'num', min: 0, def: 0 }
    ]
  },
  suppliers: {
    sheet: 'Suppliers', prefix: 'S', title: 'Data Supplier', sub: 'Pemasok barang dagangan', label: 'Supplier',
    cols: ['nama', 'hp', 'alamat'], search: ['nama', 'hp', 'alamat'],
    fields: [
      { n: 'nama', l: 'Nama Supplier', t: 'text', req: true },
      { n: 'hp', l: 'No. HP / WhatsApp', t: 'text' },
      { n: 'alamat', l: 'Alamat', t: 'textarea', w: 'full' }
    ]
  },
  vouchers: {
    sheet: 'Vouchers', prefix: 'V', title: 'Voucher', sub: 'Kode voucher potongan harga untuk pelanggan', label: 'Voucher',
    cols: ['kode', 'deskripsi', 'jenis', 'nilai', 'minBelanja', 'selesai', 'terpakai', 'aktif'], search: ['kode', 'deskripsi'],
    fields: [
      { n: 'kode', l: 'Kode Voucher', t: 'text', req: true, unique: true, help: 'Huruf besar & angka, mis. HEMAT10' },
      { n: 'deskripsi', l: 'Deskripsi', t: 'text' },
      { n: 'jenis', l: 'Jenis Potongan', t: 'select', opts: ['PERSEN', 'NOMINAL'], def: 'PERSEN', req: true },
      { n: 'nilai', l: 'Nilai (% atau Rp)', t: 'num', min: 1, req: true },
      { n: 'minBelanja', l: 'Minimal Belanja (Rp)', t: 'num', rp: true, min: 0, def: 0 },
      { n: 'maksDiskon', l: 'Maks. Potongan (Rp)', t: 'num', rp: true, min: 0, def: 0, help: '0 = tanpa batas (untuk jenis persen)' },
      { n: 'mulai', l: 'Berlaku Mulai', t: 'date' },
      { n: 'selesai', l: 'Berlaku Sampai', t: 'date' },
      { n: 'kuota', l: 'Kuota Pemakaian', t: 'num', min: 0, def: 0, help: '0 = tidak terbatas' },
      { n: 'aktif', l: 'Voucher Aktif', t: 'switch', def: 'Ya' }
    ]
  },
  promos: {
    sheet: 'Promos', prefix: 'M', title: 'Promo & Diskon', sub: 'Diskon otomatis per produk atau per kategori', label: 'Promo',
    cols: ['nama', 'target', 'targetId', 'jenis', 'nilai', 'mulai', 'selesai', 'aktif'], search: ['nama', 'targetId'],
    fields: [
      { n: 'nama', l: 'Nama Promo', t: 'text', req: true, w: 'full' },
      { n: 'target', l: 'Berlaku untuk', t: 'select', opts: ['PRODUK', 'KATEGORI'], def: 'PRODUK', req: true },
      { n: 'targetId', l: 'Produk / Kategori', t: 'select', dyn: 'target', req: true },
      { n: 'jenis', l: 'Jenis Diskon', t: 'select', opts: ['PERSEN', 'NOMINAL'], def: 'PERSEN', req: true },
      { n: 'nilai', l: 'Nilai (% atau Rp per unit)', t: 'num', min: 1, req: true },
      { n: 'mulai', l: 'Mulai', t: 'date' },
      { n: 'selesai', l: 'Sampai', t: 'date' },
      { n: 'aktif', l: 'Promo Aktif', t: 'switch', def: 'Ya' }
    ]
  },
  expenses: {
    sheet: 'Expenses', prefix: 'X', title: 'Pengeluaran', sub: 'Catat biaya operasional agar laba bersih akurat', label: 'Pengeluaran',
    cols: ['tanggal', 'kategori', 'keterangan', 'jumlah', 'user'], search: ['kategori', 'keterangan', 'user'],
    fields: [
      { n: 'tanggal', l: 'Tanggal', t: 'date', req: true, def: 'today' },
      { n: 'kategori', l: 'Kategori', t: 'select', opts: ['Operasional', 'Listrik & Air', 'Gaji', 'Sewa', 'Transport', 'Perlengkapan', 'Lainnya'], def: 'Operasional', req: true },
      { n: 'keterangan', l: 'Keterangan', t: 'text', req: true, w: 'full' },
      { n: 'jumlah', l: 'Jumlah', t: 'num', rp: true, min: 1, req: true }
    ]
  },
  users: {
    sheet: 'Users', prefix: 'USR', title: 'Pengguna', sub: 'Kelola akun Super Admin, Admin, dan Penjaga Toko', label: 'Pengguna', nodelete: true,
    cols: ['username', 'nama', 'role', 'online', 'aktif', 'lastLogin'], search: ['username', 'nama', 'role'],
    fields: [
      { n: 'nama', l: 'Nama Lengkap', t: 'text', req: true },
      { n: 'username', l: 'Username', t: 'text', req: true, unique: true, help: 'Huruf kecil, angka, titik, strip (3-30 karakter)' },
      { n: 'role', l: 'Peran', t: 'select', opts: ['kasir', 'admin', 'superadmin'], def: 'kasir', req: true },
      { n: 'password', l: 'Password', t: 'password', virtual: true, help: 'Min. 8 karakter, kombinasi huruf & angka. Saat mengedit, kosongkan jika tidak diubah.' },
      { n: 'aktif', l: 'Akun Aktif', t: 'switch', def: 'Ya' }
    ]
  }
};

/* ============================ ENTRY POINT ============================ */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Toko POS')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}
/** Endpoint API untuk front-end yang dihosting di luar Apps Script (mis. GitHub Pages). Body: JSON {action, token, payload} (kirim sebagai text/plain agar tanpa preflight CORS). */
function doPost(e) {
  let out;
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > 4000000) throw E_('Permintaan terlalu besar');
    const b = JSON.parse(raw || '{}');
    out = api(String(b.action || ''), b.token ? String(b.token) : null, b.payload && typeof b.payload === 'object' ? b.payload : {});
  } catch (err) {
    out = { ok: false, error: (err && err.userMessage) || 'Permintaan tidak valid', code: 'BAD' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function include_(f) { return HtmlService.createHtmlOutputFromFile(f).getContent(); }
function pricingSrc_() { return computeTotals_.toString(); }

/** Jalankan SEKALI dari editor Apps Script untuk memberi izin akses Sheets & Drive. */
function izinkanAkses() {
  ss_();
  DriveApp.getRootFolder();
  ensureAll_();
  return 'Izin berhasil diberikan. Silakan deploy sebagai Web App.';
}

/* ============================ UTILITAS DASAR ============================ */
const N_ = v => Number(v) || 0;
const R3_ = v => Math.round((Number(v) || 0) * 1000) / 1000;
function E_(msg, code) { const e = new Error(msg); e.userMessage = msg; e.code = code || 'USER'; return e; }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function dayStr_(offset) { return Utilities.formatDate(new Date(Date.now() - offset * 86400000), TZ, 'yyyy-MM-dd'); }
function uid_(p) { return p + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(); }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { throw E_('Server sedang sibuk. Silakan coba lagi sebentar.', 'BUSY'); }
  try { _SET = null; return fn(); } finally { lock.releaseLock(); }
}

/* ============================ AKSES DATA ============================ */
let _SS = null, _SET = null;
function ss_() {
  if (_SS) return _SS;
  let s = null;
  try { s = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { s = null; }
  const props = PropertiesService.getScriptProperties();
  if (!s) {
    const id = props.getProperty('SS_ID');
    if (id) { try { s = SpreadsheetApp.openById(id); } catch (e) { s = null; } }
    if (!s) { s = SpreadsheetApp.create('Database Toko POS'); props.setProperty('SS_ID', s.getId()); }
  }
  _SS = s;
  return s;
}
function sh_(name) {
  const ss = ss_();
  let s = ss.getSheetByName(name);
  if (s) return s;
  s = ss.insertSheet(name);
  const cols = SCHEMA[name];
  if (s.getMaxColumns() < cols.length) s.insertColumnsAfter(s.getMaxColumns(), cols.length - s.getMaxColumns());
  cols.forEach((c, i) => { if (!NUMCOLS.has(c)) s.getRange(1, i + 1, s.getMaxRows(), 1).setNumberFormat('@'); });
  s.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#0b7a63').setFontColor('#ffffff');
  s.setFrozenRows(1);
  return s;
}
function ensureAll_() {
  const ss = ss_();
  try { ss.setSpreadsheetTimeZone(TZ); } catch (e) { /* abaikan */ }
  Object.keys(SCHEMA).forEach(sh_);
  ss.getSheets().forEach(s => {
    if (['Sheet1', 'Sheet 1', 'Lembar1', 'Lembar 1'].indexOf(s.getName()) >= 0 && s.getLastRow() === 0 && ss.getSheets().length > 1) { try { ss.deleteSheet(s); } catch (e) { /* abaikan */ } }
  });
}
function cell_(c, v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  if (NUMCOLS.has(c)) return (v === '' || v == null) ? 0 : (Number(v) || 0);
  return v == null ? '' : String(v);
}
function toSheet_(c, v) {
  if (v === undefined || v === null) return NUMCOLS.has(c) ? 0 : '';
  return NUMCOLS.has(c) ? (Number(v) || 0) : String(v);
}
function mapRows_(name, vals, start) {
  const cols = SCHEMA[name];
  return vals.map((r, i) => { const o = { _row: start + i }; cols.forEach((c, j) => { o[c] = cell_(c, r[j]); }); return o; });
}
function readAll_(name) {
  const s = sh_(name), n = s.getLastRow() - 1;
  if (n < 1) return [];
  return mapRows_(name, s.getRange(2, 1, n, SCHEMA[name].length).getValues(), 2);
}
function readTail_(name, n) {
  const s = sh_(name), last = s.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  return mapRows_(name, s.getRange(start, 1, last - start + 1, SCHEMA[name].length).getValues(), start);
}
function appendRows_(name, objs) {
  if (!objs.length) return;
  const s = sh_(name), cols = SCHEMA[name];
  const rows = objs.map(o => cols.map(c => toSheet_(c, o[c])));
  const start = s.getLastRow() + 1, need = start + rows.length - 1;
  if (s.getMaxRows() < need) s.insertRowsAfter(s.getMaxRows(), need - s.getMaxRows() + 200);
  s.getRange(start, 1, rows.length, cols.length).setValues(rows);
}
function updateRow_(name, row, o) {
  const s = sh_(name), cols = SCHEMA[name];
  s.getRange(row, 1, 1, cols.length).setValues([cols.map(c => toSheet_(c, o[c]))]);
}
function colIdx_(name, col) { return SCHEMA[name].indexOf(col) + 1; }
function setCell_(name, row, col, v) { sh_(name).getRange(row, colIdx_(name, col)).setValue(v); }
function strip_(o) { const c = Object.assign({}, o); delete c._row; return c; }

/* ============================ PENGATURAN ============================ */
function settings_() {
  if (_SET) return _SET;
  const o = Object.assign({}, DEFAULTS);
  readAll_('Settings').forEach(r => { if (r.key in DEFAULTS) o[r.key] = r.value; });
  _SET = o;
  return o;
}
function saveSettings_(obj) {
  const rows = readAll_('Settings'), sh = sh_('Settings'), add = [];
  Object.keys(obj).forEach(k => {
    const r = rows.find(x => x.key === k);
    if (r) sh.getRange(r._row, 2).setValue(String(obj[k])); else add.push({ key: k, value: String(obj[k]) });
  });
  appendRows_('Settings', add);
  _SET = null;
}
function pubSettings_() {
  const s = Object.assign({}, settings_());
  s.hasLogo = !!s.logoFile; s.hasQris = !!s.qrisFile;
  delete s.logoFile; delete s.qrisFile; delete s.lastBackup; delete s.autoBackup;
  return s;
}
function dataUrl_(id) {
  if (!id) return '';
  const c = CacheService.getScriptCache(), k = 'du_' + id;
  const hit = c.get(k);
  if (hit) return hit;
  try {
    const b = DriveApp.getFileById(id).getBlob();
    const u = 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
    if (u.length < 95000) c.put(k, u, 21600);
    return u;
  } catch (e) { return ''; }
}

/* ============================ KEAMANAN / AUTENTIKASI ============================ */
function hash_(pw, salt) {
  let h = pw + salt;
  for (let i = 0; i < 300; i++) h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  return h;
}
function safeEq_(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function checkPw_(pw) {
  if (String(pw).length < 8) throw E_('Password minimal 8 karakter');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw E_('Password harus mengandung huruf dan angka');
}
function setPw_(o, pw) { checkPw_(pw); o.salt = Utilities.getUuid(); o.passHash = hash_(pw, o.salt); }
function audit_(u, aksi, detail) {
  try { appendRows_('AuditLog', [{ tanggal: now_(), user: u.username, role: u.role, aksi: aksi, detail: String(detail || '').slice(0, 500) }]); } catch (e) { /* jangan menghentikan alur utama */ }
}
function userPub_(u) { return { id: u.id, username: u.username, nama: u.nama, role: u.role, mustChange: u.mustChange === 'Ya' }; }
function newSession_(u) {
  const token = Utilities.getUuid() + Utilities.getUuid(), n = Date.now();
  CacheService.getScriptCache().put('s_' + token, JSON.stringify({ uid: u.id, last: n, seen: n }), SESSION_TTL);
  return token;
}
// Sesi dianggap "masih aktif" bila ada detak (heartbeat) dalam 150 detik DAN belum melewati batas tidak-aktif.
function sessionAlive_(token) {
  const raw = CacheService.getScriptCache().get('s_' + token);
  if (!raw) return false;
  const s = JSON.parse(raw), n = Date.now(), idle = Math.max(5, N_(settings_().idleMenit) || 30) * 60000;
  return (n - (s.seen || s.last)) < PRESENCE_MS && (n - s.last) <= idle;
}
function isOnline_(u) {
  if (u.role === 'superadmin') return false;
  const t = CacheService.getScriptCache().get('act_' + u.id);
  return !!t && sessionAlive_(t);
}
// bg=true: permintaan latar belakang (auto refresh/heartbeat) — hanya menandai "terlihat", tidak memperpanjang batas tidak-aktif.
function auth_(token, bg) {
  const AUTH = (m) => E_(m || 'Sesi tidak valid. Silakan login kembali.', 'AUTH');
  if (!token || typeof token !== 'string') throw AUTH();
  const c = CacheService.getScriptCache(), raw = c.get('s_' + token);
  if (!raw) throw AUTH('Sesi telah berakhir. Silakan login kembali.');
  const s = JSON.parse(raw);
  const idle = Math.max(5, N_(settings_().idleMenit) || 30) * 60000;
  if (Date.now() - s.last > idle) { c.remove('s_' + token); if (c.get('act_' + s.uid) === token) c.remove('act_' + s.uid); throw AUTH('Sesi berakhir karena tidak ada aktivitas.'); }
  const u = readAll_('Users').find(x => x.id === s.uid);
  if (!u || u.aktif !== 'Ya') { c.remove('s_' + token); throw AUTH('Akun tidak aktif.'); }
  s.seen = Date.now();
  if (!bg) s.last = s.seen;
  c.put('s_' + token, JSON.stringify(s), SESSION_TTL);
  return u;
}
function login_(p) {
  const uname = String(p.username || '').trim().toLowerCase(), pw = String(p.password || '');
  if (!uname || !pw) throw E_('Username dan password wajib diisi');
  const c = CacheService.getScriptCache();
  if (c.get('lk_' + uname)) throw E_('Akun dikunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.', 'LOCKED');
  const u = readAll_('Users').find(x => x.username.toLowerCase() === uname);
  let ok = false;
  if (u && u.aktif === 'Ya') ok = safeEq_(hash_(pw, u.salt), u.passHash); else hash_(pw, 'x');
  if (!ok) {
    const n = (Number(c.get('fl_' + uname)) || 0) + 1;
    c.put('fl_' + uname, String(n), LOGIN_LOCK_SEC);
    audit_({ username: uname, role: '-' }, 'LOGIN_GAGAL', 'Percobaan ke-' + n);
    if (n >= LOGIN_MAX_FAIL) { c.put('lk_' + uname, '1', LOGIN_LOCK_SEC); c.remove('fl_' + uname); audit_({ username: uname, role: '-' }, 'AKUN_DIKUNCI', 'Terlalu banyak percobaan'); }
    throw E_('Username atau password salah' + (n >= 3 && n < LOGIN_MAX_FAIL ? ' (sisa percobaan: ' + (LOGIN_MAX_FAIL - n) + ')' : ''));
  }
  c.remove('fl_' + uname);
  return withLock_(() => {
    // Aturan: 1 akun = 1 perangkat. Hanya Super Admin yang boleh login bersamaan di banyak perangkat.
    if (u.role !== 'superadmin') {
      const prev = c.get('act_' + u.id);
      if (prev && sessionAlive_(prev)) {
        audit_(u, 'LOGIN_DITOLAK', 'Sesi masih aktif di perangkat lain');
        throw E_('Akun ini sedang digunakan di perangkat lain. Keluar (logout) dari perangkat tersebut terlebih dahulu. Jika perangkat lama sudah ditutup, tunggu sekitar 2,5 menit lalu coba lagi.', 'SESSION');
      }
    }
    setCell_('Users', u._row, 'lastLogin', now_());
    audit_(u, 'LOGIN', 'Berhasil masuk');
    const token = newSession_(u);
    if (u.role !== 'superadmin') c.put('act_' + u.id, token, SESSION_TTL);
    return { token: token, user: userPub_(u) };
  });
}
function bootstrap_() {
  const s = settings_();
  return { setup: readAll_('Users').length === 0, toko: s.namaToko, logo: dataUrl_(s.logoFile) };
}
function setup_(p) {
  ensureAll_();
  if (readAll_('Users').length) throw E_('Pengaturan awal sudah dilakukan sebelumnya');
  const nama = String(p.nama || '').trim().slice(0, 100), username = String(p.username || '').trim().toLowerCase();
  if (!nama) throw E_('Nama lengkap wajib diisi');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw E_('Username 3-30 karakter: huruf kecil, angka, titik, strip');
  const u = { id: uid_('USR'), username: username, nama: nama, role: 'superadmin', aktif: 'Ya', mustChange: 'Tidak', createdAt: now_(), lastLogin: now_() };
  setPw_(u, String(p.password || ''));
  appendRows_('Users', [u]);
  const toko = String(p.namaToko || '').trim().slice(0, 100);
  if (toko) saveSettings_({ namaToko: toko });
  audit_(u, 'SETUP_AWAL', 'Super Admin pertama dibuat');
  return { token: newSession_(u), user: userPub_(u) };
}

/* ============================ DISPATCHER ============================ */
const ACTIONS = {
  init:           ['kasir', actInit_],
  ping:           ['kasir', () => ({ ok: 1 })],
  logout:         ['kasir', actLogout_],
  changePassword: ['kasir', actChangePassword_, true],
  assets:         ['kasir', actAssets_],
  dashboard:      ['kasir', actDashboard_],
  posData:        ['kasir', actPosData_],
  voucherFind:    ['kasir', actVoucherFind_],
  customerAdd:    ['kasir', actCustomerAdd_, true],
  checkout:       ['kasir', actCheckout_, true],
  sales:          ['kasir', actSales_],
  saleDetail:     ['kasir', actSaleDetail_],
  voidSale:       ['admin', actVoidSale_, true],
  shiftOpen:      ['kasir', actShiftOpen_, true],
  shiftClose:     ['kasir', actShiftClose_, true],
  shifts:         ['kasir', actShifts_],
  crudList:       ['admin', actCrudList_],
  kickUser:       ['admin', actKick_, true],
  crudSave:       ['admin', actCrudSave_, true],
  crudDelete:     ['admin', actCrudDelete_, true],
  importProducts: ['admin', actImportProducts_, true],
  stockIn:        ['admin', actStockIn_, true],
  stockAdjust:    ['admin', actStockAdjust_, true],
  stockLog:       ['admin', actStockLog_],
  report:         ['admin', actReport_],
  reportPdf:      ['admin', actReportPdf_],
  settingsSave:   ['admin', actSettingsSave_, true],
  uploadAsset:    ['admin', actUploadAsset_, true],
  removeAsset:    ['admin', actRemoveAsset_, true],
  audit:          ['admin', actAudit_],
  system:         ['superadmin', actSystem_],
  backup:         ['superadmin', actBackup_],
  autoBackup:     ['superadmin', actAutoBackup_, true]
};

function api(action, token, p) {
  try {
    p = p || {};
    if (action === 'bootstrap') return { ok: true, data: bootstrap_() };
    if (action === 'login') return { ok: true, data: login_(p) };
    if (action === 'setup') return { ok: true, data: withLock_(() => setup_(p)) };
    const def = ACTIONS[action];
    if (!def) throw E_('Aksi tidak dikenal');
    const u = auth_(token, p._bg === true);
    if (ROLE_LEVEL[u.role] < ROLE_LEVEL[def[0]]) { audit_(u, 'AKSES_DITOLAK', action); throw E_('Anda tidak memiliki akses untuk tindakan ini.', 'FORBIDDEN'); }
    const data = def[2] ? withLock_(() => def[1](u, p, token)) : def[1](u, p, token);
    return { ok: true, data: data };
  } catch (e) {
    if (e && e.userMessage) return { ok: false, error: e.userMessage, code: e.code };
    const id = Utilities.getUuid().slice(0, 8).toUpperCase();
    console.error('[' + id + '] ' + (e && e.stack || e));
    try { audit_({ username: 'sistem', role: '-' }, 'ERROR', id + ': ' + String(e && e.message || e).slice(0, 300)); } catch (x) { /* abaikan */ }
    return { ok: false, error: 'Terjadi kesalahan pada sistem (kode ' + id + '). Silakan coba lagi.', code: 'SERVER' };
  }
}

/* ============================ AKSI: SESI & PROFIL ============================ */
function actInit_(u) {
  const ent = {};
  Object.keys(ENT).forEach(k => { const e = ENT[k]; ent[k] = { title: e.title, sub: e.sub, label: e.label, cols: e.cols, search: e.search, fields: e.fields, nodelete: !!e.nodelete }; });
  return { user: userPub_(u), settings: pubSettings_(), meta: { ent: ent, setspec: SETSPEC }, serverToday: today_(), version: VERSION };
}
function actLogout_(u, p, token) {
  const c = CacheService.getScriptCache();
  c.remove('s_' + token);
  if (c.get('act_' + u.id) === token) c.remove('act_' + u.id);
  audit_(u, 'LOGOUT', '');
  return true;
}
function actKick_(u, p) {
  const t = readAll_('Users').find(x => x.id === p.id);
  if (!t) throw E_('Pengguna tidak ditemukan');
  if (t.role === 'superadmin') throw E_('Sesi Super Admin tidak dapat diputus dari sini.', 'FORBIDDEN');
  const c = CacheService.getScriptCache(), tok = c.get('act_' + t.id);
  if (tok) c.remove('s_' + tok);
  c.remove('act_' + t.id);
  audit_(u, 'PAKSA_KELUAR', t.username);
  return true;
}
function actChangePassword_(u, p) {
  const cur = String(p.current || ''), nw = String(p.password || '');
  if (!safeEq_(hash_(cur, u.salt), u.passHash)) throw E_('Password saat ini salah');
  if (cur === nw) throw E_('Password baru tidak boleh sama dengan password lama');
  const o = Object.assign({}, u);
  setPw_(o, nw); o.mustChange = 'Tidak';
  updateRow_('Users', u._row, o);
  audit_(u, 'GANTI_PASSWORD', '');
  return true;
}
function actAssets_() { const s = settings_(); return { logo: dataUrl_(s.logoFile), qris: dataUrl_(s.qrisFile) }; }

/* ============================ PERHITUNGAN HARGA (dipakai server & klien) ============================ */
// Fungsi MURNI tanpa API Apps Script: kodenya juga dikirim ke browser sehingga hasil tampilan kasir == hasil server.
function computeTotals_(c) {
  const S = c.settings, today = c.today;
  const num = function (v) { return Number(v) || 0; };
  const fmt = function (n) { return 'Rp' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };
  const active = function (x) { return x.aktif === 'Ya' && (!x.mulai || x.mulai <= today) && (!x.selesai || x.selesai >= today); };
  let subtotal = 0, diskonPromo = 0, hpp = 0;
  const lines = c.items.map(function (it) {
    const p = it.product, qty = num(it.qty);
    let harga = num(p.hargaJual), grosir = false;
    if (num(p.hargaGrosir) > 0 && num(p.minGrosir) > 0 && qty >= num(p.minGrosir) && num(p.hargaGrosir) < harga) { harga = num(p.hargaGrosir); grosir = true; }
    let best = 0, bestName = '';
    (c.promos || []).forEach(function (m) {
      if (!active(m)) return;
      if (!((m.target === 'PRODUK' && m.targetId === p.id) || (m.target === 'KATEGORI' && m.targetId === p.kategori))) return;
      let d = m.jenis === 'PERSEN' ? Math.round(harga * num(m.nilai) / 100) : num(m.nilai);
      d = Math.min(d, harga);
      if (d > best) { best = d; bestName = m.nama; }
    });
    const gross = Math.round(harga * qty), disc = Math.round(best * qty);
    subtotal += gross; diskonPromo += disc; hpp += Math.round(num(p.hargaBeli) * qty);
    return { productId: p.id, sku: p.sku, nama: p.nama, satuan: p.satuan, qty: qty, harga: harga, hargaBeli: num(p.hargaBeli), diskon: disc, promo: bestName, grosir: grosir, subtotal: gross - disc };
  });
  let sisa = subtotal - diskonPromo, diskonVoucher = 0, vErr = '';
  const v = c.voucher;
  if (v) {
    if (v.aktif !== 'Ya') vErr = 'Voucher tidak aktif';
    else if (v.mulai && v.mulai > today) vErr = 'Voucher belum berlaku';
    else if (v.selesai && v.selesai < today) vErr = 'Voucher sudah kedaluwarsa';
    else if (num(v.kuota) > 0 && num(v.terpakai) >= num(v.kuota)) vErr = 'Kuota voucher sudah habis';
    else if (sisa < num(v.minBelanja)) vErr = 'Minimal belanja ' + fmt(num(v.minBelanja)) + ' untuk voucher ini';
    else {
      let d = v.jenis === 'PERSEN' ? Math.round(sisa * num(v.nilai) / 100) : num(v.nilai);
      if (num(v.maksDiskon) > 0) d = Math.min(d, num(v.maksDiskon));
      diskonVoucher = Math.max(0, Math.min(d, sisa));
    }
  }
  sisa -= diskonVoucher;
  const diskonManual = Math.min(Math.max(0, Math.round(num(c.manual))), sisa);
  sisa -= diskonManual;
  let poinPakai = 0, diskonPoin = 0;
  if (c.customer && S.poinAktif === 'Ya' && num(c.poinPakai) > 0 && num(S.nilaiPoin) > 0) {
    poinPakai = Math.max(0, Math.min(Math.floor(num(c.poinPakai)), Math.floor(num(c.customer.poin)), Math.floor(sisa / num(S.nilaiPoin))));
    diskonPoin = poinPakai * num(S.nilaiPoin);
    sisa -= diskonPoin;
  }
  const pajak = S.pajakAktif === 'Ya' ? Math.round(sisa * num(S.pajakPersen) / 100) : 0;
  const raw = sisa + pajak, unit = num(S.pembulatan);
  const total = unit > 1 ? Math.round(raw / unit) * unit : raw;
  const poinDapat = (c.customer && S.poinAktif === 'Ya' && num(S.poinPerRupiah) > 0) ? Math.floor(total / num(S.poinPerRupiah)) : 0;
  return { lines: lines, subtotal: subtotal, diskonPromo: diskonPromo, diskonVoucher: diskonVoucher, diskonManual: diskonManual, diskonPoin: diskonPoin, poinPakai: poinPakai, pajak: pajak, pembulatan: total - raw, total: total, hpp: hpp, poinDapat: poinDapat, vErr: vErr };
}

/* ============================ KASIR / POS ============================ */
function openShift_(uid) { return readAll_('Shifts').find(s => s.kasirId === uid && s.status === 'BUKA') || null; }
function activePromos_() { const t = today_(); return readAll_('Promos').filter(m => m.aktif === 'Ya' && (!m.mulai || m.mulai <= t) && (!m.selesai || m.selesai >= t)).map(strip_); }

function actPosData_(u) {
  const hide = u.role === 'kasir';
  const products = readAll_('Products').filter(p => p.aktif === 'Ya').map(p => ({
    id: p.id, sku: p.sku, barcode: p.barcode, nama: p.nama, kategori: p.kategori, satuan: p.satuan,
    hargaBeli: hide ? 0 : p.hargaBeli, hargaJual: p.hargaJual, hargaGrosir: p.hargaGrosir, minGrosir: p.minGrosir, stok: p.stok, stokMin: p.stokMin
  }));
  const customers = readAll_('Customers').map(c => ({ id: c.id, nama: c.nama, hp: c.hp, poin: c.poin }));
  const categories = readAll_('Categories').map(c => c.nama).sort();
  const sh = openShift_(u.id);
  return { products: products, customers: customers, categories: categories, promos: activePromos_(), shift: sh ? strip_(sh) : null };
}
function actVoucherFind_(u, p) {
  const kode = String(p.kode || '').trim().toUpperCase();
  const v = kode && readAll_('Vouchers').find(x => x.kode.toUpperCase() === kode);
  if (!v) throw E_('Kode voucher tidak ditemukan');
  return strip_(v);
}
function actCustomerAdd_(u, p) {
  const nama = String(p.nama || '').trim().slice(0, 100);
  if (!nama) throw E_('Nama pelanggan wajib diisi');
  const hp = String(p.hp || '').replace(/[^0-9+]/g, '').slice(0, 20);
  const c = { id: uid_('U'), nama: nama, hp: hp, alamat: '', poin: 0, totalBelanja: 0, createdAt: now_() };
  appendRows_('Customers', [c]);
  audit_(u, 'PELANGGAN_BARU', nama);
  return { id: c.id, nama: c.nama, hp: c.hp, poin: 0 };
}
function invoiceNo_() {
  const P = PropertiesService.getScriptProperties(), d = Utilities.formatDate(new Date(), TZ, 'yyMMdd'), k = 'inv_' + d;
  const n = (Number(P.getProperty(k)) || 0) + 1;
  if (n === 1) P.getKeys().filter(x => x.indexOf('inv_') === 0 && x !== k).forEach(x => P.deleteProperty(x));
  P.setProperty(k, String(n));
  return 'INV-' + d + '-' + ('000' + n).slice(-4);
}
function actCheckout_(u, p) {
  const cache = CacheService.getScriptCache();
  const idem = p.clientId ? 'idem_' + String(p.clientId).slice(0, 60) : '';
  if (idem) { const prev = cache.get(idem); if (prev) return JSON.parse(prev); }   // cegah transaksi ganda saat klik/koneksi ulang
  const S = settings_();
  const shift = openShift_(u.id);
  if (S.wajibShift === 'Ya' && !shift) throw E_('Shift belum dibuka. Buka shift terlebih dahulu.', 'NOSHIFT');
  const raw = p.items || [];
  if (!raw.length) throw E_('Keranjang masih kosong');
  if (raw.length > 300) throw E_('Terlalu banyak item dalam satu transaksi');
  if (N_(p.manual) > 0 && u.role === 'kasir' && S.kasirBolehDiskon !== 'Ya') throw E_('Anda tidak diizinkan memberi diskon manual.', 'FORBIDDEN');
  const prods = readAll_('Products'), pm = {};
  prods.forEach(x => { pm[x.id] = x; });
  const merged = {}, order = [];
  raw.forEach(it => {
    const q = R3_(it.qty);
    if (!(q > 0)) throw E_('Jumlah barang tidak valid');
    if (!(it.id in merged)) { merged[it.id] = 0; order.push(it.id); }
    merged[it.id] = R3_(merged[it.id] + q);
  });
  const items = order.map(id => {
    const pr = pm[id];
    if (!pr || pr.aktif !== 'Ya') throw E_('Ada produk yang sudah tidak tersedia. Muat ulang halaman kasir.');
    if (S.stokMinus !== 'Ya' && N_(pr.stok) < merged[id] - 1e-9) throw E_('Stok "' + pr.nama + '" tidak cukup (sisa ' + pr.stok + ' ' + pr.satuan + ')', 'STOCK');
    return { product: pr, qty: merged[id] };
  });
  const customer = p.customerId ? readAll_('Customers').find(c => c.id === p.customerId) : null;
  if (p.customerId && !customer) throw E_('Pelanggan tidak ditemukan');
  let voucher = null;
  if (p.voucherKode) {
    const kd = String(p.voucherKode).toUpperCase();
    voucher = readAll_('Vouchers').find(v => v.kode.toUpperCase() === kd);
    if (!voucher) throw E_('Kode voucher tidak ditemukan');
  }
  const T = computeTotals_({ items: items, promos: activePromos_(), voucher: voucher, manual: p.manual, customer: customer, poinPakai: p.poinPakai, settings: S, today: today_() });
  if (T.vErr) throw E_(T.vErr);
  if (N_(p.poinPakai) > 0 && customer && T.poinPakai < Math.floor(N_(p.poinPakai))) throw E_('Poin yang dipakai melebihi batas. Muat ulang keranjang.');
  const metode = String(p.metode || '').toUpperCase();
  if (['TUNAI', 'TRANSFER', 'QRIS'].indexOf(metode) < 0) throw E_('Metode pembayaran tidak valid');
  let bayar = T.total, kembali = 0;
  if (metode === 'TUNAI') {
    bayar = Math.round(N_(p.bayar));
    if (bayar < T.total) throw E_('Uang yang diterima kurang dari total belanja');
    kembali = bayar - T.total;
  }
  const id = invoiceNo_(), ts = now_();
  const sale = {
    id: id, tanggal: ts, kasirId: u.id, kasirNama: u.nama, pelangganId: customer ? customer.id : '', pelangganNama: customer ? customer.nama : '',
    subtotal: T.subtotal, diskonPromo: T.diskonPromo, diskonVoucher: T.diskonVoucher, diskonManual: T.diskonManual, diskonPoin: T.diskonPoin,
    pajak: T.pajak, pembulatan: T.pembulatan, total: T.total, metode: metode, bayar: bayar, kembali: kembali,
    ref: String(p.ref || '').slice(0, 80), voucherKode: voucher ? voucher.kode : '', poinDapat: T.poinDapat, poinPakai: T.poinPakai,
    hpp: T.hpp, status: 'SELESAI', shiftId: shift ? shift.id : '', catatan: String(p.catatan || '').slice(0, 200)
  };
  const saleItems = T.lines.map(l => ({ saleId: id, productId: l.productId, sku: l.sku, nama: l.nama, qty: l.qty, harga: l.harga, hargaBeli: l.hargaBeli, diskon: l.diskon, subtotal: l.subtotal }));
  // tulis data
  appendRows_('Sales', [sale]);
  appendRows_('SaleItems', saleItems);
  const stokCol = colIdx_('Products', 'stok'), psh = sh_('Products'), logs = [], stock = [];
  items.forEach(it => {
    const ns = R3_(N_(it.product.stok) - it.qty);
    psh.getRange(it.product._row, stokCol).setValue(ns);
    stock.push({ id: it.product.id, stok: ns });
    logs.push({ id: uid_('L'), tanggal: ts, productId: it.product.id, nama: it.product.nama, jenis: 'PENJUALAN', qty: -it.qty, stokAkhir: ns, ref: id, user: u.nama, catatan: '' });
  });
  appendRows_('StockLog', logs);
  if (voucher) setCell_('Vouchers', voucher._row, 'terpakai', N_(voucher.terpakai) + 1);
  let poinBaru = null;
  if (customer) {
    poinBaru = Math.max(0, N_(customer.poin) - T.poinPakai + T.poinDapat);
    setCell_('Customers', customer._row, 'poin', poinBaru);
    setCell_('Customers', customer._row, 'totalBelanja', N_(customer.totalBelanja) + T.total);
  }
  audit_(u, 'TRANSAKSI', id + ' | ' + metode + ' | Rp' + T.total);
  const res = { sale: sale, items: T.lines, stock: stock, poin: poinBaru };
  if (idem) { try { cache.put(idem, JSON.stringify(res), 600); } catch (e) { /* abaikan */ } }
  return res;
}

function actSales_(u, p) {
  const td = today_();
  let from = String(p.from || td), to = String(p.to || td);
  let rows = readAll_('Sales');
  if (u.role === 'kasir') { from = td; to = td; rows = rows.filter(s => s.kasirId === u.id); }
  rows = rows.filter(s => { const d = s.tanggal.slice(0, 10); return d >= from && d <= to; });
  if (p.metode) rows = rows.filter(s => s.metode === p.metode);
  if (p.status) rows = rows.filter(s => s.status === p.status);
  const total = rows.length;
  rows = rows.reverse().slice(0, 1000).map(strip_);
  return { rows: rows, total: total, from: from, to: to };
}
function actSaleDetail_(u, p) {
  const s = readAll_('Sales').find(x => x.id === p.id);
  if (!s) throw E_('Transaksi tidak ditemukan');
  if (u.role === 'kasir' && s.kasirId !== u.id) throw E_('Anda tidak memiliki akses ke transaksi ini.', 'FORBIDDEN');
  return { sale: strip_(s), items: readAll_('SaleItems').filter(i => i.saleId === s.id).map(strip_) };
}
function actVoidSale_(u, p) {
  const alasan = String(p.alasan || '').trim().slice(0, 200);
  if (!alasan) throw E_('Alasan pembatalan wajib diisi');
  const s = readAll_('Sales').find(x => x.id === p.id);
  if (!s) throw E_('Transaksi tidak ditemukan');
  if (s.status !== 'SELESAI') throw E_('Transaksi ini sudah dibatalkan');
  const items = readAll_('SaleItems').filter(i => i.saleId === s.id);
  const pm = {};
  readAll_('Products').forEach(x => { pm[x.id] = x; });
  const stokCol = colIdx_('Products', 'stok'), psh = sh_('Products'), ts = now_(), logs = [];
  items.forEach(it => {
    const pr = pm[it.productId];
    if (!pr) return;
    const ns = R3_(N_(pr.stok) + N_(it.qty));
    psh.getRange(pr._row, stokCol).setValue(ns);
    pr.stok = ns;
    logs.push({ id: uid_('L'), tanggal: ts, productId: pr.id, nama: pr.nama, jenis: 'VOID', qty: N_(it.qty), stokAkhir: ns, ref: s.id, user: u.nama, catatan: alasan });
  });
  appendRows_('StockLog', logs);
  if (s.voucherKode) { const v = readAll_('Vouchers').find(x => x.kode === s.voucherKode); if (v) setCell_('Vouchers', v._row, 'terpakai', Math.max(0, N_(v.terpakai) - 1)); }
  if (s.pelangganId) {
    const c = readAll_('Customers').find(x => x.id === s.pelangganId);
    if (c) { setCell_('Customers', c._row, 'poin', Math.max(0, N_(c.poin) - N_(s.poinDapat) + N_(s.poinPakai))); setCell_('Customers', c._row, 'totalBelanja', Math.max(0, N_(c.totalBelanja) - N_(s.total))); }
  }
  setCell_('Sales', s._row, 'status', 'VOID');
  setCell_('Sales', s._row, 'catatan', ('VOID: ' + alasan + ' (' + u.nama + ')').slice(0, 200));
  audit_(u, 'VOID_TRANSAKSI', s.id + ' | ' + alasan);
  return true;
}

/* ============================ SHIFT ============================ */
function sumSales_(arr) {
  const o = { count: 0, omzet: 0, hpp: 0, pajak: 0, byMetode: { TUNAI: 0, TRANSFER: 0, QRIS: 0 } };
  arr.forEach(s => { o.count++; o.omzet += N_(s.total); o.hpp += N_(s.hpp); o.pajak += N_(s.pajak); if (o.byMetode[s.metode] !== undefined) o.byMetode[s.metode] += N_(s.total); });
  return o;
}
function actShiftOpen_(u, p) {
  if (openShift_(u.id)) throw E_('Anda sudah memiliki shift yang sedang berjalan');
  const modal = Math.round(N_(p.modalAwal));
  if (modal < 0) throw E_('Modal awal tidak valid');
  const sh = { id: uid_('SH'), kasirId: u.id, kasirNama: u.nama, buka: now_(), tutup: '', modalAwal: modal, tunaiSistem: 0, tunaiAktual: 0, selisih: 0, totalJual: 0, jumlahTrx: 0, status: 'BUKA', catatan: '' };
  appendRows_('Shifts', [sh]);
  audit_(u, 'SHIFT_BUKA', 'Modal Rp' + modal);
  return sh;
}
function actShiftClose_(u, p) {
  let sh = null;
  if (p.id && u.role !== 'kasir') sh = readAll_('Shifts').find(s => s.id === p.id && s.status === 'BUKA');
  else sh = openShift_(u.id);
  if (!sh) throw E_('Tidak ada shift yang sedang berjalan');
  const aktual = Math.round(N_(p.tunaiAktual));
  if (p.tunaiAktual === '' || p.tunaiAktual == null || aktual < 0) throw E_('Isi jumlah uang tunai di laci kas');
  const sum = sumSales_(readAll_('Sales').filter(s => s.shiftId === sh.id && s.status === 'SELESAI'));
  sh.tunaiSistem = N_(sh.modalAwal) + sum.byMetode.TUNAI;
  sh.tunaiAktual = aktual; sh.selisih = aktual - sh.tunaiSistem;
  sh.totalJual = sum.omzet; sh.jumlahTrx = sum.count;
  sh.tutup = now_(); sh.status = 'TUTUP';
  sh.catatan = String(p.catatan || '').slice(0, 200) + (u.id !== sh.kasirId ? ' [ditutup oleh ' + u.nama + ']' : '');
  updateRow_('Shifts', sh._row, sh);
  audit_(u, 'SHIFT_TUTUP', sh.id + ' | selisih Rp' + sh.selisih);
  return { shift: strip_(sh), summary: sum };
}
function actShifts_(u) {
  let rows = readAll_('Shifts');
  if (u.role === 'kasir') rows = rows.filter(s => s.kasirId === u.id);
  return { rows: rows.reverse().slice(0, 500).map(strip_) };
}

/* ============================ DASHBOARD ============================ */
function actDashboard_(u) {
  const td = today_(), S = settings_();
  const all = readAll_('Sales');
  if (u.role === 'kasir') {
    const mine = all.filter(s => s.kasirId === u.id && s.tanggal.slice(0, 10) === td && s.status === 'SELESAI');
    const sh = openShift_(u.id);
    return { kind: 'kasir', shift: sh ? strip_(sh) : null, today: sumSales_(mine), recent: mine.slice(-6).reverse().map(strip_) };
  }
  const sales = all.filter(s => s.status === 'SELESAI'), wk = dayStr_(6), yd = dayStr_(1);
  const byDay = {};
  sales.forEach(s => { const d = s.tanggal.slice(0, 10); if (d >= wk) (byDay[d] = byDay[d] || []).push(s); });
  const week = [];
  for (let i = 6; i >= 0; i--) { const d = dayStr_(i), a = byDay[d] || []; week.push({ d: d, omzet: sumSales_(a).omzet, trx: a.length }); }
  const tS = byDay[td] || [], today = sumSales_(tS), yesterday = sumSales_(byDay[yd] || []);
  const ids = {};
  Object.keys(byDay).forEach(d => byDay[d].forEach(s => { ids[s.id] = 1; }));
  const tp = {};
  readAll_('SaleItems').forEach(i => { if (ids[i.saleId]) { const o = tp[i.productId] = tp[i.productId] || { nama: i.nama, qty: 0, omzet: 0 }; o.qty += N_(i.qty); o.omzet += N_(i.subtotal); } });
  const top = Object.keys(tp).map(k => tp[k]).sort((a, b) => b.omzet - a.omzet).slice(0, 6);
  const prods = readAll_('Products');
  const low = prods.filter(p => p.aktif === 'Ya' && N_(p.stok) <= N_(p.stokMin)).sort((a, b) => N_(a.stok) - N_(b.stok));
  const exp = readAll_('Expenses').filter(e => e.tanggal.slice(0, 10) === td).reduce((a, e) => a + N_(e.jumlah), 0);
  const netto = tS.reduce((a, s) => a + N_(s.total) - N_(s.pajak) - N_(s.pembulatan), 0);
  const out = {
    kind: u.role === 'superadmin' ? 'superadmin' : 'admin',
    today: today, yesterday: yesterday, laba: netto - today.hpp, pengeluaran: exp, week: week, top: top,
    lowStock: low.slice(0, 8).map(p => ({ id: p.id, nama: p.nama, stok: p.stok, stokMin: p.stokMin, satuan: p.satuan })), lowCount: low.length,
    counts: { produk: prods.filter(p => p.aktif === 'Ya').length, pelanggan: readAll_('Customers').length, voucher: readAll_('Vouchers').filter(v => v.aktif === 'Ya').length },
    shifts: readAll_('Shifts').filter(s => s.status === 'BUKA').map(strip_),
    voidToday: all.filter(s => s.status === 'VOID' && s.tanggal.slice(0, 10) === td).length
  };
  if (u.role === 'superadmin') {
    out.users = readAll_('Users').map(x => ({ nama: x.nama, username: x.username, role: x.role, aktif: x.aktif, lastLogin: x.lastLogin }));
    out.audit = readTail_('AuditLog', 8).reverse().map(strip_);
    out.sys = { lastBackup: S.lastBackup, autoBackup: S.autoBackup, version: VERSION, trxTotal: all.length };
  }
  return out;
}

/* ============================ CRUD GENERIK ============================ */
function entity_(u, key) {
  const en = ENT[key];
  if (!en) throw E_('Data tidak dikenal');
  return en;
}
function pub_(key, o) { const c = strip_(o); if (key === 'users') { delete c.passHash; delete c.salt; } return c; }
function clean_(f, v) {
  if (f.t === 'switch') return (v === 'Ya' || v === true) ? 'Ya' : 'Tidak';
  if (f.t === 'num') {
    if (v === '' || v == null) { if (f.req) throw E_(f.l + ' wajib diisi'); return 0; }
    const n = Number(v);
    if (!isFinite(n)) throw E_(f.l + ' harus berupa angka');
    if (f.min !== undefined && n < f.min) throw E_(f.l + ' minimal ' + f.min);
    if (f.max !== undefined && n > f.max) throw E_(f.l + ' maksimal ' + f.max);
    return R3_(n);
  }
  let s = String(v == null ? '' : v).trim();
  if (f.t === 'date') { if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw E_(f.l + ' tidak valid'); }
  else if (f.t === 'select' && f.opts) { if (s && f.opts.indexOf(s) < 0) throw E_(f.l + ' tidak valid'); }
  else s = s.slice(0, f.t === 'textarea' ? 500 : 150);
  if (f.req && !s) throw E_(f.l + ' wajib diisi');
  return s;
}
function actCrudList_(u, p) {
  const en = entity_(u, p.entity);
  return { rows: readAll_(en.sheet).map(r => { const o = pub_(p.entity, r); if (p.entity === 'users') o.online = isOnline_(r); return o; }) };
}
function actCrudSave_(u, p) {
  const key = p.entity, en = entity_(u, key), data = p.data || {};
  const rows = readAll_(en.sheet);
  const existing = data.id ? rows.find(r => r.id === String(data.id)) : null;
  if (data.id && !existing) throw E_('Data tidak ditemukan. Mungkin sudah dihapus.');
  const obj = existing ? Object.assign({}, existing) : { id: uid_(en.prefix) };
  SCHEMA[en.sheet].forEach(c => { if (obj[c] === undefined) obj[c] = NUMCOLS.has(c) ? 0 : ''; });
  if (!existing) { if ('createdAt' in obj) obj.createdAt = now_(); }
  en.fields.forEach(f => {
    if (f.virtual || (existing && f.createOnly)) return;
    if (f.n in data) obj[f.n] = clean_(f, data[f.n]);
    else if (!existing) obj[f.n] = f.def !== undefined && f.def !== 'today' ? f.def : (f.def === 'today' ? today_() : (f.t === 'num' ? 0 : ''));
  });
  const hook = HOOKS[key];
  if (hook) hook(u, obj, existing, data, rows);
  en.fields.filter(f => f.unique && !f.virtual && obj[f.n]).forEach(f => {
    if (rows.some(r => r.id !== obj.id && String(r[f.n]).toLowerCase() === String(obj[f.n]).toLowerCase())) throw E_(f.l + ' "' + obj[f.n] + '" sudah digunakan');
  });
  if (existing) updateRow_(en.sheet, existing._row, obj);
  else {
    appendRows_(en.sheet, [obj]);
    if (key === 'products' && N_(obj.stok) > 0) appendRows_('StockLog', [{ id: uid_('L'), tanggal: now_(), productId: obj.id, nama: obj.nama, jenis: 'AWAL', qty: obj.stok, stokAkhir: obj.stok, ref: '', user: u.nama, catatan: 'Stok awal' }]);
  }
  audit_(u, (existing ? 'UBAH_' : 'TAMBAH_') + key.toUpperCase(), obj.nama || obj.kode || obj.username || obj.keterangan || obj.id);
  return pub_(key, obj);
}
function actCrudDelete_(u, p) {
  const key = p.entity, en = entity_(u, key);
  if (en.nodelete) throw E_('Data ini tidak dapat dihapus. Nonaktifkan saja.');
  const r = readAll_(en.sheet).find(x => x.id === p.id);
  if (!r) throw E_('Data tidak ditemukan');
  if (key === 'products' && readAll_('SaleItems').some(i => i.productId === r.id)) throw E_('Produk ini sudah pernah terjual. Nonaktifkan saja agar riwayat transaksi tetap utuh.');
  if (key === 'categories' && readAll_('Products').some(x => x.kategori === r.nama)) throw E_('Kategori masih dipakai oleh produk. Pindahkan produknya terlebih dahulu.');
  sh_(en.sheet).deleteRow(r._row);
  audit_(u, 'HAPUS_' + key.toUpperCase(), r.nama || r.kode || r.keterangan || r.id);
  return true;
}

const HOOKS = {
  products: function (u, o, ex, d, rows) {
    o.updatedAt = now_();
    if (!o.sku) o.sku = 'SKU' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    if (N_(o.hargaGrosir) > 0) {
      if (N_(o.minGrosir) < 2) throw E_('Min. Qty Harga Grosir harus 2 atau lebih');
      if (N_(o.hargaGrosir) >= N_(o.hargaJual)) throw E_('Harga grosir harus lebih rendah dari harga jual');
    }
  },
  categories: function (u, o, ex) {
    if (ex && ex.nama !== o.nama) { const col = colIdx_('Products', 'kategori'), s = sh_('Products'); readAll_('Products').filter(p => p.kategori === ex.nama).forEach(p => s.getRange(p._row, col).setValue(o.nama)); }
  },
  customers: function (u, o) { o.hp = String(o.hp).replace(/[^0-9+]/g, ''); },
  vouchers: function (u, o) {
    o.kode = String(o.kode).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9_-]{3,30}$/.test(o.kode)) throw E_('Kode voucher 3-30 karakter: huruf, angka, strip');
    if (o.jenis === 'PERSEN' && N_(o.nilai) > 100) throw E_('Voucher persen maksimal 100%');
    if (o.mulai && o.selesai && o.mulai > o.selesai) throw E_('Tanggal berakhir harus setelah tanggal mulai');
  },
  promos: function (u, o) {
    if (o.jenis === 'PERSEN' && N_(o.nilai) > 100) throw E_('Promo persen maksimal 100%');
    if (o.mulai && o.selesai && o.mulai > o.selesai) throw E_('Tanggal berakhir harus setelah tanggal mulai');
    if (o.target === 'PRODUK' && !readAll_('Products').some(p => p.id === o.targetId)) throw E_('Produk target tidak ditemukan');
    if (o.target === 'KATEGORI' && !readAll_('Categories').some(c => c.nama === o.targetId)) throw E_('Kategori target tidak ditemukan');
  },
  expenses: function (u, o, ex) { if (!ex) o.user = u.nama; },
  users: function (actor, o, ex, d, rows) {
    o.username = String(o.username).toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(o.username)) throw E_('Username 3-30 karakter: huruf kecil, angka, titik, strip');
    if (!ROLE_LEVEL[o.role]) throw E_('Peran tidak valid');
    if (actor.role !== 'superadmin' && (o.role === 'superadmin' || (ex && ex.role === 'superadmin'))) throw E_('Hanya Super Admin yang dapat mengelola akun Super Admin.', 'FORBIDDEN');
    if (ex && ex.id === actor.id) {
      if (o.role !== ex.role) throw E_('Anda tidak dapat mengubah peran akun sendiri');
      if (o.aktif !== 'Ya') throw E_('Anda tidak dapat menonaktifkan akun sendiri');
    }
    if (ex && ex.role === 'superadmin' && (o.role !== 'superadmin' || o.aktif !== 'Ya')) {
      if (!rows.some(r => r.id !== ex.id && r.role === 'superadmin' && r.aktif === 'Ya')) throw E_('Harus ada minimal satu Super Admin aktif');
    }
    if (!ex && !d.password) throw E_('Password wajib diisi untuk akun baru');
    if (d.password) { setPw_(o, String(d.password)); o.mustChange = 'Ya'; }
  }
};

/* ============================ IMPOR PRODUK ============================ */
function actImportProducts_(u, p) {
  const rows = p.rows || [];
  if (!rows.length) throw E_('Tidak ada data untuk diimpor');
  if (rows.length > 1500) throw E_('Maksimal 1500 baris per impor');
  const prods = readAll_('Products'), bySku = {}, byBar = {};
  prods.forEach(x => { if (x.sku) bySku[x.sku.toLowerCase()] = x; if (x.barcode) byBar[x.barcode.toLowerCase()] = x; });
  const cats = {};
  readAll_('Categories').forEach(c => { cats[c.nama.toLowerCase()] = 1; });
  const newCats = [], newProds = [], logs = [], errors = [], ts = now_();
  let updated = 0;
  rows.forEach((r, i) => {
    const line = i + 2;
    try {
      const nama = String(r.nama || '').trim().slice(0, 150);
      if (!nama) throw new Error('nama kosong');
      const hj = Number(r.hargaJual);
      if (!isFinite(hj) || hj < 0 || r.hargaJual === '' || r.hargaJual == null) throw new Error('hargaJual tidak valid');
      const sku = String(r.sku || '').trim().slice(0, 40), bar = String(r.barcode || '').trim().slice(0, 40), kat = String(r.kategori || '').trim().slice(0, 60);
      if (kat && !cats[kat.toLowerCase()]) { cats[kat.toLowerCase()] = 1; newCats.push({ id: uid_('C'), nama: kat }); }
      const ex = (sku && bySku[sku.toLowerCase()]) || (bar && byBar[bar.toLowerCase()]);
      if (ex) {
        const o = Object.assign({}, ex, { nama: nama, kategori: kat || ex.kategori, satuan: String(r.satuan || ex.satuan).slice(0, 20), hargaBeli: R3_(r.hargaBeli !== '' && r.hargaBeli != null ? r.hargaBeli : ex.hargaBeli), hargaJual: hj, updatedAt: ts });
        if (bar) o.barcode = bar;
        updateRow_('Products', ex._row, o);
        updated++;
      } else {
        const stok = Math.max(0, R3_(r.stok));
        const o = { id: uid_('P'), sku: sku || ('SKU' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase()), barcode: bar, nama: nama, kategori: kat, satuan: String(r.satuan || 'pcs').slice(0, 20), hargaBeli: Math.max(0, R3_(r.hargaBeli)), hargaJual: hj, hargaGrosir: 0, minGrosir: 0, stok: stok, stokMin: 5, aktif: 'Ya', updatedAt: ts };
        newProds.push(o); bySku[o.sku.toLowerCase()] = o; if (bar) byBar[bar.toLowerCase()] = o;
        if (stok > 0) logs.push({ id: uid_('L'), tanggal: ts, productId: o.id, nama: nama, jenis: 'AWAL', qty: stok, stokAkhir: stok, ref: 'IMPOR', user: u.nama, catatan: 'Impor produk' });
      }
    } catch (e) { errors.push('Baris ' + line + ': ' + e.message); }
  });
  appendRows_('Categories', newCats);
  appendRows_('Products', newProds);
  appendRows_('StockLog', logs);
  audit_(u, 'IMPOR_PRODUK', 'baru ' + newProds.length + ', ubah ' + updated + ', gagal ' + errors.length);
  return { created: newProds.length, updated: updated, failed: errors.length, errors: errors.slice(0, 15) };
}

/* ============================ STOK ============================ */
function actStockIn_(u, p) {
  const items = p.items || [];
  if (!items.length) throw E_('Tambahkan minimal satu barang');
  const pm = {};
  readAll_('Products').forEach(x => { pm[x.id] = x; });
  const sh = sh_('Products'), cs = colIdx_('Products', 'stok'), ch = colIdx_('Products', 'hargaBeli');
  const ts = now_(), id = uid_('PB'), PU = [], LG = [];
  const sup = String(p.supplier || '').slice(0, 100), note = String(p.catatan || '').slice(0, 200);
  let total = 0;
  items.forEach(it => {
    const pr = pm[it.productId];
    if (!pr) throw E_('Produk tidak ditemukan');
    const qty = R3_(it.qty);
    if (!(qty > 0)) throw E_('Jumlah masuk untuk "' + pr.nama + '" tidak valid');
    const hb = Math.max(0, Math.round(N_(it.hargaBeli)));
    const ns = R3_(N_(pr.stok) + qty);
    pr.stok = ns;
    sh.getRange(pr._row, cs).setValue(ns);
    if (p.updateHarga && hb > 0) sh.getRange(pr._row, ch).setValue(hb);
    total += qty * hb;
    PU.push({ id: id, tanggal: ts, supplierNama: sup, productId: pr.id, nama: pr.nama, qty: qty, hargaBeli: hb, total: Math.round(qty * hb), user: u.nama, catatan: note });
    LG.push({ id: uid_('L'), tanggal: ts, productId: pr.id, nama: pr.nama, jenis: 'MASUK', qty: qty, stokAkhir: ns, ref: id, user: u.nama, catatan: sup });
  });
  appendRows_('Purchases', PU);
  appendRows_('StockLog', LG);
  audit_(u, 'STOK_MASUK', id + ' | ' + PU.length + ' item | Rp' + Math.round(total));
  return { id: id, count: PU.length, total: Math.round(total) };
}
function actStockAdjust_(u, p) {
  const pr = readAll_('Products').find(x => x.id === p.productId);
  if (!pr) throw E_('Produk tidak ditemukan');
  const baru = R3_(p.stokBaru);
  if (p.stokBaru === '' || p.stokBaru == null || baru < 0) throw E_('Stok baru tidak valid');
  const note = String(p.catatan || '').trim().slice(0, 200);
  if (!note) throw E_('Alasan penyesuaian wajib diisi');
  const diff = R3_(baru - N_(pr.stok));
  setCell_('Products', pr._row, 'stok', baru);
  appendRows_('StockLog', [{ id: uid_('L'), tanggal: now_(), productId: pr.id, nama: pr.nama, jenis: 'OPNAME', qty: diff, stokAkhir: baru, ref: '', user: u.nama, catatan: note }]);
  audit_(u, 'OPNAME_STOK', pr.nama + ': ' + pr.stok + ' -> ' + baru + ' | ' + note);
  return { id: pr.id, stok: baru };
}
function actStockLog_(u, p) {
  let rows = readTail_('StockLog', 1500).reverse();
  if (p.jenis) rows = rows.filter(r => r.jenis === p.jenis);
  return { rows: rows.slice(0, 600).map(strip_) };
}

/* ============================ LAPORAN KEUANGAN ============================ */
const MON_ = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function dateAdd_(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekStart_(s) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function netto_(s) { return N_(s.total) - N_(s.pajak) - N_(s.pembulatan); }
function periodSum_(sales, exp) {
  const o = { trx: sales.length, omzet: 0, kotor: 0, diskon: 0, pajak: 0, hpp: 0, netto: 0, promo: 0, voucher: 0, manual: 0, poin: 0 };
  sales.forEach(s => {
    o.omzet += N_(s.total); o.kotor += N_(s.subtotal); o.pajak += N_(s.pajak); o.hpp += N_(s.hpp); o.netto += netto_(s);
    o.promo += N_(s.diskonPromo); o.voucher += N_(s.diskonVoucher); o.manual += N_(s.diskonManual); o.poin += N_(s.diskonPoin);
  });
  o.diskon = o.promo + o.voucher + o.manual + o.poin;
  o.labaKotor = o.netto - o.hpp;
  o.pengeluaran = exp.reduce((a, e) => a + N_(e.jumlah), 0);
  o.labaBersih = o.labaKotor - o.pengeluaran;
  return o;
}
function groupBy_(sales, exp, keyFn) {
  const m = {};
  const g = k => (m[k] = m[k] || { k: k, trx: 0, omzet: 0, diskon: 0, hpp: 0, labaKotor: 0, pengeluaran: 0, labaBersih: 0 });
  sales.forEach(s => {
    const o = g(keyFn(s.tanggal.slice(0, 10)));
    o.trx++; o.omzet += N_(s.total); o.hpp += N_(s.hpp); o.labaKotor += netto_(s) - N_(s.hpp);
    o.diskon += N_(s.diskonPromo) + N_(s.diskonVoucher) + N_(s.diskonManual) + N_(s.diskonPoin);
  });
  exp.forEach(e => { g(keyFn(e.tanggal.slice(0, 10))).pengeluaran += N_(e.jumlah); });
  return Object.keys(m).sort().map(k => { const o = m[k]; o.labaBersih = o.labaKotor - o.pengeluaran; return o; });
}
function reportData_(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw E_('Rentang tanggal tidak valid');
  const days = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  if (days > 400) throw E_('Rentang laporan maksimal 400 hari');
  const pFrom = dateAdd_(from, -days), pTo = dateAdd_(from, -1);
  const allS = readAll_('Sales'), allE = readAll_('Expenses');
  const within = (d, a, b) => { const x = d.slice(0, 10); return x >= a && x <= b; };
  const salesOf = (a, b) => allS.filter(s => s.status === 'SELESAI' && within(s.tanggal, a, b));
  const sales = salesOf(from, to), exp = allE.filter(e => within(e.tanggal, from, to));
  const voids = allS.filter(s => s.status === 'VOID' && within(s.tanggal, from, to));
  const S = periodSum_(sales, exp), P = periodSum_(salesOf(pFrom, pTo), allE.filter(e => within(e.tanggal, pFrom, pTo)));
  const ids = {};
  sales.forEach(s => { ids[s.id] = 1; });
  const pm = {};
  readAll_('Products').forEach(x => { pm[x.id] = x; });
  const metode = {}, kasir = {}, prod = {}, kat = {}, kb = {};
  sales.forEach(s => {
    const m = metode[s.metode] = metode[s.metode] || { k: s.metode, trx: 0, total: 0 }; m.trx++; m.total += N_(s.total);
    const k = kasir[s.kasirNama] = kasir[s.kasirNama] || { k: s.kasirNama, trx: 0, total: 0 }; k.trx++; k.total += N_(s.total);
  });
  readAll_('SaleItems').filter(i => ids[i.saleId]).forEach(i => {
    const laba = N_(i.subtotal) - N_(i.hargaBeli) * N_(i.qty);
    const o = prod[i.productId] = prod[i.productId] || { nama: i.nama, sku: i.sku, qty: 0, omzet: 0, laba: 0 };
    o.qty += N_(i.qty); o.omzet += N_(i.subtotal); o.laba += laba;
    const kn = (pm[i.productId] && pm[i.productId].kategori) || '(Tanpa kategori)';
    const c = kat[kn] = kat[kn] || { k: kn, qty: 0, omzet: 0, laba: 0 };
    c.qty += N_(i.qty); c.omzet += N_(i.subtotal); c.laba += laba;
  });
  exp.forEach(e => { kb[e.kategori || 'Lainnya'] = (kb[e.kategori || 'Lainnya'] || 0) + N_(e.jumlah); });
  const biaya = Object.keys(kb).map(k => ({ k: k, v: kb[k] })).sort((a, b) => b.v - a.v);
  return {
    from: from, to: to, days: days,
    summary: { trx: S.trx, omzet: S.omzet, diskon: S.diskon, pajak: S.pajak, hpp: S.hpp, labaKotor: S.labaKotor, pengeluaran: S.pengeluaran, labaBersih: S.labaBersih, rata: S.trx ? Math.round(S.omzet / S.trx) : 0, voidCount: voids.length, voidTotal: voids.reduce((a, s) => a + N_(s.total), 0) },
    prev: { from: pFrom, to: pTo, trx: P.trx, omzet: P.omzet, labaKotor: P.labaKotor, labaBersih: P.labaBersih, pengeluaran: P.pengeluaran },
    labaRugi: { penjualanKotor: S.kotor, diskonPromo: S.promo, diskonVoucher: S.voucher, diskonManual: S.manual, diskonPoin: S.poin, penjualanBersih: S.netto, hpp: S.hpp, labaKotor: S.labaKotor, biaya: biaya, totalBiaya: S.pengeluaran, labaBersih: S.labaBersih, pajak: S.pajak },
    rekap: { harian: groupBy_(sales, exp, d => d), mingguan: groupBy_(sales, exp, weekStart_), bulanan: groupBy_(sales, exp, d => d.slice(0, 7)) },
    metode: Object.keys(metode).map(k => metode[k]),
    kasir: Object.keys(kasir).map(k => kasir[k]).sort((a, b) => b.total - a.total),
    kategori: Object.keys(kat).map(k => kat[k]).sort((a, b) => b.omzet - a.omzet),
    produk: Object.keys(prod).map(k => prod[k]).sort((a, b) => b.omzet - a.omzet).slice(0, 100),
    pengeluaranRows: exp.map(strip_).sort((a, b) => b.tanggal.localeCompare(a.tanggal))
  };
}
function actReport_(u, p) { return reportData_(String(p.from || ''), String(p.to || '')); }

/* ---- PDF laporan: HTML -> PDF di server, disimpan di Drive "TokoPOS Laporan" ---- */
function h_(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function rpS_(n) { n = Math.round(N_(n)); return (n < 0 ? '-' : '') + 'Rp' + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function tgl_(s) { const d = String(s).slice(0, 10).split('-'); return d.length === 3 ? (+d[2]) + ' ' + MON_[+d[1] - 1] + ' ' + d[0] : String(s); }
function groupLabel_(group, k, from, to) {
  if (group === 'bulanan') { const m = k.split('-'); return MON_[+m[1] - 1] + ' ' + m[0]; }
  if (group === 'mingguan') { const e = dateAdd_(k, 6); return tgl_(k) + ' - ' + tgl_(e) + (k < from || e > to ? ' *' : ''); }
  return tgl_(k);
}
function reportHtml_(r, group, S, user) {
  const th = 'background:#0b7a63;color:#ffffff;padding:5px 7px;text-align:left;font-size:9px;';
  const td = 'padding:4px 7px;border-bottom:1px solid #dfe7e4;font-size:9px;';
  const R = 'text-align:right;';
  const table = (cols, rows, foot) => '<table style="width:100%;border-collapse:collapse;margin:3px 0 12px;"><tr>' + cols.map(c => '<th style="' + th + (c.r ? R : '') + '">' + h_(c.l) + '</th>').join('') + '</tr>' +
    (rows.length ? rows.map(row => '<tr>' + cols.map(c => '<td style="' + td + (c.r ? R : '') + '">' + c.f(row) + '</td>').join('') + '</tr>').join('') : '<tr><td style="' + td + '" colspan="' + cols.length + '">Tidak ada data</td></tr>') + (foot || '') + '</table>';
  const hd = t => '<div style="font-size:12px;font-weight:bold;color:#0b7a63;margin:12px 0 3px;">' + h_(t) + '</div>';
  const sm = r.summary, lr = r.labaRugi;
  const kv = (a, b, bold, ind) => '<tr><td style="' + td + (bold ? 'font-weight:bold;background:#f1f7f5;' : '') + (ind ? 'padding-left:20px;' : '') + '">' + h_(a) + '</td><td style="' + td + R + (bold ? 'font-weight:bold;background:#f1f7f5;' : '') + '">' + h_(b) + '</td></tr>';
  let rows = '';
  const sum = (key) => r.rekap[group].reduce((a, x) => a + x[key], 0);
  const foot = '<tr>' + ['TOTAL', sum('trx'), rpS_(sum('omzet')), rpS_(sum('hpp')), rpS_(sum('labaKotor')), rpS_(sum('pengeluaran')), rpS_(sum('labaBersih'))].map((v, i) => '<td style="' + td + 'font-weight:bold;background:#f1f7f5;' + (i ? R : '') + '">' + h_(v) + '</td>').join('') + '</tr>';
  const title = group === 'bulanan' ? 'Rekap Bulanan' : group === 'mingguan' ? 'Rekap Mingguan' : 'Rekap Harian';
  let html = '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;color:#0e1f1a;">' +
    '<div style="border-bottom:3px solid #0b7a63;padding-bottom:6px;margin-bottom:8px;"><div style="font-size:18px;font-weight:bold;color:#0b7a63;">' + h_(S.namaToko) + '</div>' +
    (S.alamat ? '<div style="font-size:9px;color:#667a73;">' + h_(S.alamat) + (S.telp ? ' | Telp ' + h_(S.telp) : '') + '</div>' : '') +
    '<div style="font-size:14px;font-weight:bold;margin-top:6px;">Laporan Keuangan</div><div style="font-size:10px;">Periode: ' + tgl_(r.from) + ' s/d ' + tgl_(r.to) + ' (' + r.days + ' hari)</div></div>' +
    hd('Ringkasan') + '<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">' + kv('Jumlah transaksi', sm.trx + ' (rata-rata ' + rpS_(sm.rata) + ')') + kv('Omzet (total diterima)', rpS_(sm.omzet)) + kv('Laba kotor', rpS_(sm.labaKotor)) + kv('Pengeluaran', rpS_(sm.pengeluaran)) + kv('Laba bersih', rpS_(sm.labaBersih), true) +
    kv('Transaksi dibatalkan', sm.voidCount + ' (' + rpS_(sm.voidTotal) + ')') + '</table>' +
    hd('Laporan Laba Rugi') + '<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">' + kv('Penjualan kotor', rpS_(lr.penjualanKotor)) + kv('Diskon promo', '-' + rpS_(lr.diskonPromo), false, true) + kv('Diskon voucher', '-' + rpS_(lr.diskonVoucher), false, true) + kv('Diskon manual', '-' + rpS_(lr.diskonManual), false, true) + kv('Tukar poin', '-' + rpS_(lr.diskonPoin), false, true) +
    kv('Penjualan bersih', rpS_(lr.penjualanBersih), true) + kv('Harga pokok penjualan (HPP)', '-' + rpS_(lr.hpp)) + kv('Laba kotor', rpS_(lr.labaKotor), true) +
    lr.biaya.map(b => kv(b.k, '-' + rpS_(b.v), false, true)).join('') + kv('Total pengeluaran', '-' + rpS_(lr.totalBiaya)) + kv('Laba bersih', rpS_(lr.labaBersih), true) + kv('Catatan: pajak yang dipungut (tidak termasuk omzet bersih)', rpS_(lr.pajak)) + '</table>' +
    hd(title) + table([{ l: 'Periode', f: x => h_(groupLabel_(group, x.k, r.from, r.to)) }, { l: 'Trx', r: 1, f: x => x.trx }, { l: 'Omzet', r: 1, f: x => rpS_(x.omzet) }, { l: 'HPP', r: 1, f: x => rpS_(x.hpp) }, { l: 'Laba Kotor', r: 1, f: x => rpS_(x.labaKotor) }, { l: 'Pengeluaran', r: 1, f: x => rpS_(x.pengeluaran) }, { l: 'Laba Bersih', r: 1, f: x => rpS_(x.labaBersih) }], r.rekap[group], foot) +
    (group === 'mingguan' ? '<div style="font-size:8px;color:#667a73;margin-top:-8px;margin-bottom:8px;">* minggu sebagian berada di luar rentang laporan</div>' : '') +
    hd('Metode Pembayaran') + table([{ l: 'Metode', f: x => h_(x.k) }, { l: 'Transaksi', r: 1, f: x => x.trx }, { l: 'Total', r: 1, f: x => rpS_(x.total) }], r.metode) +
    hd('Penjualan per Kategori') + table([{ l: 'Kategori', f: x => h_(x.k) }, { l: 'Qty', r: 1, f: x => x.qty }, { l: 'Omzet', r: 1, f: x => rpS_(x.omzet) }, { l: 'Laba', r: 1, f: x => rpS_(x.laba) }], r.kategori) +
    hd('Penjualan per Kasir') + table([{ l: 'Kasir', f: x => h_(x.k) }, { l: 'Transaksi', r: 1, f: x => x.trx }, { l: 'Total', r: 1, f: x => rpS_(x.total) }], r.kasir) +
    hd('20 Produk Terlaris') + table([{ l: 'Produk', f: x => h_(x.nama) }, { l: 'SKU', f: x => h_(x.sku) }, { l: 'Qty', r: 1, f: x => x.qty }, { l: 'Omzet', r: 1, f: x => rpS_(x.omzet) }, { l: 'Laba', r: 1, f: x => rpS_(x.laba) }], r.produk.slice(0, 20)) +
    hd('Rincian Pengeluaran') + table([{ l: 'Tanggal', f: x => tgl_(x.tanggal) }, { l: 'Kategori', f: x => h_(x.kategori) }, { l: 'Keterangan', f: x => h_(x.keterangan) }, { l: 'Jumlah', r: 1, f: x => rpS_(x.jumlah) }], r.pengeluaranRows.slice(0, 60)) +
    '<div style="font-size:8px;color:#667a73;border-top:1px solid #dfe7e4;padding-top:4px;margin-top:10px;">Dicetak oleh ' + h_(user.nama) + ' pada ' + tgl_(today_()) + ' ' + now_().slice(11, 16) + ' WIB | Toko POS v' + VERSION + '</div></body></html>';
  return html;
}
function reportFolder_() {
  const it = DriveApp.getFoldersByName('TokoPOS Laporan');
  return it.hasNext() ? it.next() : DriveApp.createFolder('TokoPOS Laporan');
}
function actReportPdf_(u, p) {
  const group = ['harian', 'mingguan', 'bulanan'].indexOf(p.group) >= 0 ? p.group : 'harian';
  const r = reportData_(String(p.from || ''), String(p.to || ''));
  const html = reportHtml_(r, group, settings_(), u);
  const name = 'Laporan_' + group + '_' + r.from + '_' + r.to + '.pdf';
  const blob = Utilities.newBlob(html, 'text/html', 'laporan.html').getAs('application/pdf').setName(name);
  let url = '';
  try {
    const folder = reportFolder_();
    url = folder.createFile(blob).getUrl();
    const files = [], it = folder.getFiles();
    while (it.hasNext()) { const f = it.next(); files.push({ f: f, t: f.getDateCreated().getTime() }); }
    files.sort((a, b) => b.t - a.t).slice(40).forEach(x => { try { x.f.setTrashed(true); } catch (e) { /* abaikan */ } });
  } catch (e) { /* PDF tetap dikembalikan walau gagal disimpan di Drive */ }
  audit_(u, 'EKSPOR_PDF', name);
  return { name: name, url: url, b64: Utilities.base64Encode(blob.getBytes()) };
}

/* ============================ PENGATURAN & ASET ============================ */
function actSettingsSave_(u, p) {
  const inp = p.settings || {}, out = {}, changed = [];
  const cur = settings_();
  SETSPEC.forEach(f => {
    if (!(f.k in inp)) return;
    let v = inp[f.k];
    if (f.t === 'switch') v = (v === 'Ya' || v === true) ? 'Ya' : 'Tidak';
    else if (f.t === 'num') {
      const n = Number(v);
      if (!isFinite(n)) throw E_(f.l + ' harus berupa angka');
      if (f.min !== undefined && n < f.min) throw E_(f.l + ' minimal ' + f.min);
      if (f.max !== undefined && n > f.max) throw E_(f.l + ' maksimal ' + f.max);
      v = String(n);
    } else if (f.t === 'select') { v = String(v); if (f.opts.indexOf(v) < 0) throw E_(f.l + ' tidak valid'); }
    else { v = String(v == null ? '' : v).trim().slice(0, f.t === 'textarea' ? 400 : 120); if (f.req && !v) throw E_(f.l + ' wajib diisi'); }
    if (String(cur[f.k]) !== v) changed.push(f.k);
    out[f.k] = v;
  });
  saveSettings_(out);
  audit_(u, 'UBAH_PENGATURAN', changed.join(', '));
  return pubSettings_();
}
function assetFolder_() {
  const it = DriveApp.getFoldersByName('TokoPOS Assets');
  return it.hasNext() ? it.next() : DriveApp.createFolder('TokoPOS Assets');
}
function actUploadAsset_(u, p) {
  const kind = p.kind;
  if (['logo', 'qris'].indexOf(kind) < 0) throw E_('Jenis berkas tidak valid');
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+\/=]+)$/.exec(String(p.dataUrl || ''));
  if (!m) throw E_('Format gambar tidak didukung. Gunakan PNG, JPG, atau WEBP.');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 1.5 * 1024 * 1024) throw E_('Ukuran gambar maksimal 1,5 MB');
  const ext = m[1] === 'image/png' ? 'png' : (m[1] === 'image/webp' ? 'webp' : 'jpg');
  const file = assetFolder_().createFile(Utilities.newBlob(bytes, m[1], kind + '_' + Date.now() + '.' + ext));
  const key = kind === 'logo' ? 'logoFile' : 'qrisFile', old = settings_()[key];
  if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (e) { /* abaikan */ } }
  saveSettings_({ [key]: file.getId() });
  audit_(u, 'UNGGAH_' + kind.toUpperCase(), file.getName());
  return actAssets_();
}
function actRemoveAsset_(u, p) {
  const key = p.kind === 'logo' ? 'logoFile' : (p.kind === 'qris' ? 'qrisFile' : '');
  if (!key) throw E_('Jenis berkas tidak valid');
  const old = settings_()[key];
  if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (e) { /* abaikan */ } }
  saveSettings_({ [key]: '' });
  audit_(u, 'HAPUS_' + p.kind.toUpperCase(), '');
  return actAssets_();
}

/* ============================ LOG, SISTEM, BACKUP ============================ */
function actAudit_(u, p) {
  let rows = readTail_('AuditLog', 800).reverse();
  if (p.q) { const q = String(p.q).toLowerCase(); rows = rows.filter(r => (r.user + ' ' + r.aksi + ' ' + r.detail).toLowerCase().indexOf(q) >= 0); }
  return { rows: rows.slice(0, 400).map(strip_) };
}
function backupFolder_() {
  const it = DriveApp.getFoldersByName('TokoPOS Backup');
  return it.hasNext() ? it.next() : DriveApp.createFolder('TokoPOS Backup');
}
function backup_() {
  const folder = backupFolder_();
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HHmm');
  const copy = DriveApp.getFileById(ss_().getId()).makeCopy('Backup POS ' + stamp, folder);
  saveSettings_({ lastBackup: now_() });
  const files = [], it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); files.push({ f: f, t: f.getDateCreated().getTime() }); }
  files.sort((a, b) => b.t - a.t).slice(KEEP_BACKUPS).forEach(x => { try { x.f.setTrashed(true); } catch (e) { /* abaikan */ } });
  return copy;
}
function trgDailyBackup_() { backup_(); }
function actBackup_(u) { const f = backup_(); audit_(u, 'BACKUP', f.getName()); return { name: f.getName(), at: now_() }; }
function actAutoBackup_(u, p) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'trgDailyBackup_') ScriptApp.deleteTrigger(t); });
  const on = p.on === true || p.on === 'Ya';
  if (on) ScriptApp.newTrigger('trgDailyBackup_').timeBased().everyDays(1).atHour(1).create();
  saveSettings_({ autoBackup: on ? 'Ya' : 'Tidak' });
  audit_(u, 'AUTO_BACKUP', on ? 'Aktif' : 'Nonaktif');
  return { autoBackup: on ? 'Ya' : 'Tidak' };
}
function actSystem_() {
  const S = settings_(), counts = {};
  ['Products', 'Sales', 'SaleItems', 'Customers', 'Users', 'AuditLog'].forEach(n => { counts[n] = Math.max(0, sh_(n).getLastRow() - 1); });
  const backups = [];
  try {
    const it = backupFolder_().getFiles();
    while (it.hasNext()) { const f = it.next(); backups.push({ name: f.getName(), t: Utilities.formatDate(f.getDateCreated(), TZ, 'yyyy-MM-dd HH:mm:ss') }); }
    backups.sort((a, b) => b.t.localeCompare(a.t));
  } catch (e) { /* abaikan */ }
  return { version: VERSION, lastBackup: S.lastBackup, autoBackup: S.autoBackup, counts: counts, backups: backups.slice(0, 8), ssUrl: ss_().getUrl() };
}
