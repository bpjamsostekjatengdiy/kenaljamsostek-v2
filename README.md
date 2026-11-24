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
- `batas_keluar_layar`: keluar layar sebanyak ini atau lebih = tidak masuk peringkat (hanya saat ENABLE). Kosong = 2.
- Ekstensi yang terdeteksi dicatat di kolom `deteksi_ekstensi` (sheet `jawaban`) dan status `log_mulai`. Elemen yang cocok dengan pola di sheet `pengecualian_ekstensi` (kolom `pola`) diabaikan.
- Versi Apps Script yang aktif terlihat di `?action=themes` (field `version`).
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

Tab `sesi_aktif` (selalu tepat 2 baris; dirapikan otomatis oleh Apps Script):

| sesi | status | buka | tutup | anti_curang | maks_percobaan | tampil_pembahasan | batas_keluar_layar |
|---|---|---|---|---|---|---|---|
| Absensi | AKTIF | | | ENABLE | 1 | YA | 2 |
| Feedback | AKTIF | 10:00 | | ENABLE | 1 | TIDAK | 2 |

- **Tanggal sesi diambil dari sheet `episode`** (kolom `Tanggal`). Sesi hanya terbuka bila hari ini tercantum di sana. Tambah baris episode = tambah hari sesi.
- `sesi`: `Absensi` = pretest, `Feedback` = posttest. Tidak bisa ditambah baris.
- `status`: `AKTIF` membuka sesi, selain itu tertutup.
- `buka`, `tutup`: opsional, jam per 30 menit.
- `anti_curang`: `ENABLE` atau `DISABLE`.
- `maks_percobaan`, `batas_keluar_layar`: `1`–`5`, `10`, atau `TANPA BATAS`.
- `tampil_pembahasan`: `YA` atau `TIDAK`.

Tab `jawaban`, `log_mulai`, dan `pesan` dibuat otomatis oleh Apps Script.

## Apps Script

1. Buka spreadsheet, lalu `Extensions > Apps Script`.
2. Tempel isi `apps-script-jawaban.gs`.
3. `Project Settings`: Time zone `Asia/Jakarta`.
4. `Deploy > Manage deployments > Edit > New version`. Execute as: Me. Who has access: Anyone.
5. Bila URL Web App berubah, ganti `RESPONSE_ENDPOINT_URL` di `app.js`, dan URL endpoint di `hasil.js`, `leaderboard.js`, `sertifikat.js`.

Pengaturan di bagian atas skrip: `MAX_ACTIVE_QUESTIONS`, `MIN_SECONDS_PER_QUESTION`, `MAX_FOCUS_LOST`, `DEFAULT_MAX_ATTEMPTS`.

## Sertifikat

Diatur di sheet `pengaturan_sertifikat` (`pengaturan | nilai | keterangan`), dibuat otomatis:
`status`, `buka_halaman`, `tutup_halaman`, `batas_waktu_feedback`, `maks_unduh`, `skor_minimal`, `wajib_tanpa_pelanggaran`, `wajib_episode_hari_ini`.
Kelayakan dicek Apps Script (`certificate_check`) dari Feedback pertama peserta hari ini.

## Pengecualian ekstensi

Sheet `pengecualian_ekstensi` berisi pilihan ekstensi umum (`pola | nama_ekstensi | kategori | aktif | keterangan`). Ubah `aktif` menjadi `YA` untuk mengecualikan. Baris kategori Asisten AI jangan diaktifkan.

## Aturan Rilis

- Absensi dapat dibuka tanpa pembatasan jam.
- Absensi dan Feedback dibuka/ditutup dari sheet `sesi_aktif`.
- Aturan sertifikat diatur di sheet `pengaturan_sertifikat`.
- Leaderboard menampilkan periode episode terbaru (tanggal episode terakhir yang sudah berjalan).
- Saat `anti_curang` ENABLE, peserta wajib mencentang persetujuan aturan sebelum mulai (dicatat di `log_mulai.setuju_aturan`).

## Menjalankan Lokal

```bash
python -m http.server 5173
```

Lalu buka `http://localhost:5173`.

## Batasan

Halaman web tidak bisa mencegah peserta memotret soal dengan HP kedua. Penangkal utama: soal kontekstual dari isi sesi.
Penjagaan jam dan login dashboard berjalan di browser dan bukan pengganti autentikasi server.
