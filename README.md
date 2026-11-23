# Kenal Jamsostek v2 - Quiz Sesi DIJAMIN

Aplikasi web statis untuk pretest (`index.html`, sesi `Absensi`) dan posttest (`feedback.html`, sesi `Feedback`).

## Pengamanan

- Bank soal tetap di Google Spreadsheet, tetapi spreadsheet **tidak dipublish** dan aksesnya *Restricted*.
- Soal disajikan oleh Apps Script **satu per satu**. Kunci jawaban tidak pernah dikirim ke browser.
- Tidak ada batas waktu per soal. Layar menampilkan hitung maju total lama pengerjaan; durasi resmi dihitung server.
- Tidak ada tombol kembali atau mulai ulang.
- Skor dan durasi dihitung di server. Hasil hanya menampilkan skor, tanpa kunci dan pembahasan.
- Mode `anti_curang` per sesi (sheet `sesi_aktif`):
  - `ENABLE`: teks soal digambar di `<canvas>`, salin/klik kanan diblokir dengan peringatan (dicatat di `percobaan_salin`), keluar layar dicatat di `keluar_layar`, dan ekstensi browser dideteksi **selama pengerjaan**. Halaman registrasi tidak diblokir, supaya data peserta tetap masuk. Ekstensi terdeteksi = pengerjaan dihentikan dan hasil ditandai `EKSTENSI`.
  - `DISABLE`: teks soal biasa, bisa disalin, ekstensi tidak dideteksi.
- Jumlah kesempatan per nomor WA per hari per tema diatur di kolom `maks_percobaan`. Jatah terpakai sejak klik mulai dan dihitung dari sheet `log_mulai`. Hapus baris peserta di `log_mulai` untuk mengembalikan jatahnya.
- `tampil_pembahasan` (YA/TIDAK): pembahasan tiap butir tampil setelah selesai. Kosong = YA untuk Absensi, TIDAK untuk Feedback.
- Semua pesan ke peserta diambil dari sheet `pesan` (kode | pesan | keterangan). Ubah kolom `pesan`, jangan ubah `kode`. `{sesi}`, `{terpakai}`, `{maks}`, `{jumlah}`, `{batas}` diganti otomatis.
- Baris dengan `catatan` (`KELUAR_LAYAR`, `EKSTENSI`, `TERLALU_CEPAT`) tidak masuk leaderboard.

## Spreadsheet

Tab `bank_soal` (nama bisa diubah di `BANK_SHEET_NAME`):

```csv
id_soal,nama_modul,program,sesi,pertanyaan,opsi_a,opsi_b,opsi_c,opsi_d,kunci,status
```

- `sesi`: `PRE`, `POST`, atau `SEMUA`.
- `status`: hanya baris `AKTIF` yang dipakai.
- `opsi_e` dan `pembahasan` opsional.

Tab `sesi_aktif` (satu-satunya pengendali sesi; semua kolom memakai dropdown):

| sesi | status | tanggal | buka | tutup | anti_curang | maks_percobaan |
|---|---|---|---|---|---|---|
| Absensi | AKTIF | | | | ENABLE | 1 |
| Feedback | AKTIF | | 10:00 | | ENABLE | 1 |

- `sesi`: `Absensi` = pretest, `Feedback` = posttest.
- `status`: `AKTIF` membuka sesi, selain itu tertutup.
- `tanggal` (`yyyy-mm-dd`), `buka`, `tutup`: opsional. Bila diisi, ikut membatasi.
- `anti_curang`: `ENABLE` atau `DISABLE`. Kosong = `ENABLE`.
- `maks_percobaan`: `1`, `2`, `3`, `4`, `5`, `10`, atau `TANPA BATAS`. Kosong = `1`.
- Kolom `anti_curang` dan `maks_percobaan` beserta dropdown-nya dibuat otomatis oleh Apps Script bila belum ada.

Tab `jawaban`, `log_mulai`, dan `pesan` dibuat otomatis oleh Apps Script.

## Apps Script

1. Buka spreadsheet, lalu `Extensions > Apps Script`.
2. Tempel isi `apps-script-jawaban.gs`.
3. `Project Settings`: Time zone `Asia/Jakarta`.
4. `Deploy > Manage deployments > Edit > New version`. Execute as: Me. Who has access: Anyone.
5. Bila URL Web App berubah, ganti `RESPONSE_ENDPOINT_URL` di `app.js`, dan URL endpoint di `hasil.js`, `leaderboard.js`, `sertifikat.js`.

Pengaturan di bagian atas skrip: `MAX_ACTIVE_QUESTIONS`, `MIN_SECONDS_PER_QUESTION`, `MAX_FOCUS_LOST`, `DEFAULT_MAX_ATTEMPTS`.

## Aturan Rilis

- Absensi dapat dibuka tanpa pembatasan jam.
- Absensi dan Feedback dibuka/ditutup dari sheet `sesi_aktif`.
- Halaman sertifikat dapat dibuka mulai pukul 10.30 sampai sebelum pukul 24.00 WIB.
- Sertifikat hanya untuk peserta yang mengisi Feedback sebelum pukul 12.00 WIB pada hari kegiatan yang sama.

## Menjalankan Lokal

```bash
python -m http.server 5173
```

Lalu buka `http://localhost:5173`.

## Batasan

Halaman web tidak bisa mencegah peserta memotret soal dengan HP kedua. Penangkal utama: soal kontekstual dari isi sesi.
Penjagaan jam dan login dashboard berjalan di browser dan bukan pengganti autentikasi server.
