# Toko POS

Dua cara menjalankan: (A) langsung dari Apps Script, atau (B) **front-end di GitHub Pages + backend Apps Script** (disarankan: kamera & layar penuh bekerja penuh karena halaman tidak di dalam bingkai Google, dan tidak ada banner Google).

## Struktur repo

```
apps-script/     Code.gs, Index.html, Style.html, Script.html, appsscript.json  (sumber, tempel ke Apps Script)
tools/build.js   menggabungkan sumber -> docs/index.html (situs statis)
config.json      {"apiUrl": "URL web app /exec"}
docs/            hasil build (dibuat otomatis oleh GitHub Actions)
.github/workflows/pages.yml
```

## Deploy ke GitHub Pages

1. **Backend**: salin isi folder `apps-script/` ke proyek Apps Script (lihat "Cara Pasang" di bawah), lalu **Deploy → Kelola deployment → Edit → Versi baru** (URL `/exec` tetap sama). Versi baru ini memuat `doPost` yang dibutuhkan GitHub Pages. Akses harus **Siapa saja**, dijalankan sebagai **Saya**.
2. Pastikan `config.json` berisi URL `/exec` Anda.
3. Push ke GitHub (branch `main`). Di repo: **Settings → Pages → Source: GitHub Actions**.
4. Workflow membangun dan menerbitkan; alamat: `https://<user>.github.io/<repo>/`.
5. Ubah kode Apps Script → deploy versi baru di Google. Ubah tampilan → cukup push ke GitHub. Ganti URL backend → edit `config.json` lalu push.

Uji lokal: `node tools/build.js` lalu buka `docs/index.html`.

Keamanan: URL web app bersifat publik, tetapi semua data dilindungi login, token sesi, dan pemeriksaan hak akses di server; tidak ada rahasia di front-end. Repo boleh publik. Jangan memasukkan password atau ID spreadsheet ke repo.

## Mode A: langsung Apps Script

Aplikasi kasir (Point of Sale) untuk toko kelontong. Seluruh data tersimpan di Google Sheets, tetapi **semua pengelolaan dilakukan dari aplikasi** (tanpa membuka Sheets atau mengubah kode).

## Cara Pasang (± 5 menit)

1. Buka <https://sheets.new>, beri nama mis. **Database Toko POS**.
2. Menu **Ekstensi → Apps Script**.
3. Di editor, aktifkan **Setelan Proyek → "Tampilkan file manifes appsscript.json"**, lalu isi `appsscript.json` dengan file yang disertakan.
4. Buat file sesuai nama berikut dan salin isinya:
   - `Code.gs` (Script) — ganti isi `Kode.gs` bawaan
   - `Index.html`, `Style.html`, `Script.html` (HTML) — pakai **File → + → HTML**, nama persis tanpa `.html`
5. Pilih fungsi **`izinkanAkses`** → **Jalankan** → setujui izin (Sheets & Drive). Semua tab database dibuat otomatis.
6. **Deploy → Deployment baru → Aplikasi web**
   - *Jalankan sebagai*: **Saya**
   - *Yang memiliki akses*: **Siapa saja** (aplikasi punya login sendiri)
7. Buka URL web app. Pada kunjungan pertama, buat akun **Super Admin** lewat layar *Pengaturan Awal*.
8. Masuk, lalu buka **Pengaturan** untuk mengisi profil toko, mengunggah **logo** dan **kode QRIS**. Rekening BCA 0332289347 a.n. BAHRUDDIN sudah terisi sebagai bawaan.

> Setiap kali kode diubah, gunakan **Deploy → Kelola deployment → Edit → Versi baru**.

## Peran & Akses

| Fitur | Penjaga Toko | Admin | Super Admin |
|---|:--:|:--:|:--:|
| Kasir (transaksi), riwayat milik sendiri, buka/tutup shift | ✔ | ✔ | ✔ |
| Produk, stok, supplier, pelanggan, voucher, promo, pengeluaran, laporan, pengaturan, log | – | ✔ | ✔ |
| Kelola pengguna | – | ✔ (kecuali akun Super Admin) | ✔ (semua) |
| Void transaksi | – | ✔ | ✔ |
| Backup & sistem | – | – | ✔ |

Hak akses diperiksa **di server** pada setiap permintaan, bukan hanya disembunyikan di tampilan.

## Fitur Utama

- **Kasir**: scan barcode (`3*barcode` untuk jumlah), pencarian, kategori, keranjang, harga grosir otomatis, tahan/lanjutkan transaksi, pelanggan & poin, voucher, diskon manual (bisa dibatasi), pajak, pembulatan. Pintasan: `F2` cari, `F4` bayar, `F8` tahan.
- **Pembayaran**: Tunai (kembalian & uang pas), Transfer (BCA + tombol salin + konfirmasi dana masuk), QRIS (gambar QRIS + konfirmasi).
- **Struk**: cetak 58/80 mm, kirim via WhatsApp, cetak ulang.
- **Stok**: stok otomatis berkurang, stok masuk dari supplier, opname, mutasi stok, peringatan stok menipis, impor produk CSV.
- **Voucher & Promo**: persen/nominal, minimal belanja, batas potongan, kuota, masa berlaku; promo otomatis per produk/kategori.
- **Shift**: modal awal, tutup shift dengan hitung selisih kas.
- **Laporan keuangan**: periode cepat (hari ini, minggu ini/lalu, bulan ini/lalu, tahun ini) atau tanggal bebas (maks. 400 hari); kartu omzet/laba dengan perbandingan **% terhadap periode sebelumnya**; **rekap Harian / Mingguan (Senin–Minggu) / Bulanan** dengan grafik; **laporan Laba Rugi** (penjualan kotor → diskon → HPP → biaya per kategori → laba bersih); per kategori/kasir/produk; daftar pengeluaran; ekspor CSV per tabel.
- **Ekspor PDF**: tombol *Unduh PDF* membuat laporan (ringkasan, laba rugi, rekap sesuai tab yang dipilih, metode bayar, kategori, kasir, 20 produk terlaris, pengeluaran) dan menyimpannya di Google Drive folder **TokoPOS Laporan** (40 file terakhir disimpan). Pertama kali dipakai, Google meminta izin Drive — jalankan ulang `izinkanAkses` bila perlu.
- **Scan barcode kamera**: tombol *Scan* di Kasir (mode beruntun, bunyi bip + getar) dan tombol *Scan dengan kamera* pada form Produk. Bila kamera langsung diblokir browser (sering terjadi di dalam bingkai Apps Script), gunakan **Ambil Foto Barcode** — kamera bawaan HP dipakai dan barcode dibaca dari fotonya. Pembaca memakai `BarcodeDetector` bawaan browser, atau pustaka ZXing yang dimuat dari CDN jsDelivr (butuh internet). Scanner USB/Bluetooth tetap bekerja seperti biasa lewat kolom pencarian.
- **Dashboard terpisah** untuk Penjaga Toko, Admin, dan Super Admin.
- **Keamanan**: hash password + salt, kunci akun setelah 5× gagal (15 menit), sesi + auto-logout karena tidak aktif, wajib ganti password sementara, total & stok dihitung ulang di server, pencegahan transaksi ganda, kunci konkurensi antar-kasir, log audit, perlindungan formula-injection di Sheets, escape HTML di seluruh tampilan.
- **Keandalan**: backup manual & harian otomatis ke Google Drive (14 salinan), log aktivitas, pesan error ramah.

## Sesi & Auto Refresh

- **Auto refresh 15 detik**: data halaman yang sedang dibuka (dashboard, riwayat, shift, produk, stok, log, daftar kasir) diperbarui otomatis tanpa memuat ulang layar. Penyegaran ditunda saat ada dialog terbuka atau Anda sedang mengetik. Indikator **Live** di bilah atas bisa diklik untuk menjeda. Pengaturan toko dan hak akses juga disinkronkan tiap ±1 menit.
- **Auto refresh tidak memperpanjang sesi**: batas auto-logout karena tidak aktif tetap dihitung dari aktivitas nyata pengguna.
- **1 akun = 1 perangkat**: Penjaga Toko dan Admin hanya bisa login di satu perangkat. Login kedua ditolak selama sesi pertama masih aktif. Sesi dianggap berakhir bila perangkat lama logout, atau tidak ada detak lebih dari ±2,5 menit (mis. tab ditutup), atau melewati batas tidak-aktif.
- **Super Admin** boleh login bersamaan di banyak perangkat.
- Admin/Super Admin bisa memutus sesi akun lain lewat menu **Pengguna** (ikon keluar pada akun berstatus *Online*).
- Aturan satu perangkat berlaku per browser tab: membuka tab baru di perangkat yang sama dianggap perangkat lain. Muat ulang (refresh) tab yang sama tetap aman.
- Auto refresh menambah jumlah eksekusi Apps Script (± 4 per menit per perangkat). Untuk banyak kasir, perhatikan kuota harian akun Google Anda.

## Catatan

- Fitur PDF dan kamera bergantung pada layanan Google/browser; bila kamera tidak mau menyala, pastikan akses kamera diizinkan untuk situs `script.googleusercontent.com` dan buka aplikasi lewat HTTPS (URL web app /exec).
- Banner abu-abu "Aplikasi ini dibuat oleh pengguna Google Apps Script" di atas halaman ditambahkan Google dan tidak dapat dihapus dari dalam kode. Dialog bawaan browser (`alert/confirm/prompt`) tidak dipakai sama sekali; semuanya memakai dialog kustom.
- Tombol layar penuh memakai Fullscreen API. Bila browser memblokirnya di dalam bingkai Apps Script, aplikasi beralih ke *mode fokus* (sidebar disembunyikan); gunakan `F11` untuk layar penuh penuh.
- Untuk toko dengan puluhan ribu transaksi, pertimbangkan mengarsipkan salinan database tiap tahun agar tetap cepat.
