# PRD — Aplikasi Integrasi Data SAP ke Si Procol

## 1. Ringkasan Produk

### 1.1 Latar belakang

Server staging Si Procol tidak dapat langsung mengakses jaringan VPN SAP. Menaruh
integrasi pada server development yang sama juga dapat memengaruhi konfigurasi IP
dan konektivitas aplikasi lain. Oleh karena itu, integrasi akan dibuat sebagai
aplikasi backend terpisah yang pada tahap awal dijalankan di perangkat pribadi,
kemudian dipindahkan ke VM khusus yang mempunyai akses ke VPN SAP dan database
Si Procol.

Aplikasi ini mengambil data dari tiga API SAP:

1. Purchase Requisition (PR).
2. Purchase Order (PO).
3. Master Vendor.

Data yang diterima akan divalidasi, dinormalisasi, direkonsiliasi, lalu dimasukkan
ke PostgreSQL Si Procol secara aman dan idempotent.

### 1.2 Tujuan

- Menyediakan proses sinkronisasi otomatis SAP ke Si Procol dua kali sehari.
- Memasukkan Vendor, PR, dan PO tanpa membuat duplikasi ketika proses diulang.
- Menjaga data lokal Si Procol agar tidak tertimpa tanpa aturan yang jelas.
- Menyediakan audit run, issue per record, retry, health check, dan rekonsiliasi.
- Mendukung pengujian awal dengan rentang data 1 Juni 2026 sampai 5 Agustus 2026.
- Menyediakan fondasi untuk fitur manual refresh dari Si Procol pada fase berikutnya.

### 1.3 Bukan bagian versi pertama

- Tombol atau endpoint manual refresh yang dipanggil dari aplikasi Si Procol.
- Frontend/dashboard baru untuk aplikasi integrasi.
- Pengiriman atau perubahan data dari Si Procol ke SAP.
- Sinkronisasi real-time berbasis event.
- Penghapusan fisik data bisnis akibat `LOEKZ` atau data yang tidak lagi muncul.
- Pemetaan otomatis Plant ke Project, WBS, atau ARP tanpa master mapping resmi.
- Pembuatan akun login untuk vendor yang berasal dari SAP.

Manual refresh dari Si Procol dicatat sebagai fase lanjutan. Versi pertama tetap
memiliki command operasional lokal untuk connection test, dry-run, diagnosis, dan
retry oleh administrator server, tetapi belum mengekspos aksi refresh ke user Si
Procol.

## 2. Pengguna dan Kriteria Keberhasilan

### 2.1 Pengguna

- Administrator infrastruktur yang memasang aplikasi pada laptop atau VM.
- Backend engineer yang memelihara mapping SAP dan schema Si Procol.
- Tim procurement/data owner yang memeriksa hasil rekonsiliasi.
- Tim SAP/network yang menyediakan akses VPN, credential, dan CA certificate.

### 2.2 Kriteria keberhasilan

- Ketiga API dapat diakses dari perangkat uji dan VM melalui koneksi yang aman.
- Rentang testing 1 Juni–5 Agustus 2026 dapat diproses lengkap dalam tiga window
  tanggal dan hasilnya dapat direkonsiliasi.
- Menjalankan window yang sama dua kali tidak membuat Vendor, PR, PO, atau item
  ganda.
- Dry-run tidak mengubah tabel bisnis Si Procol.
- Data lokal dengan nomor PR/PO yang sama tidak ditimpa otomatis.
- Sync production berjalan setiap pukul 08.00 dan 16.00 zona `Asia/Jakarta`.
- Run yang gagal tidak memajukan checkpoint dan dapat diproses kembali.
- Credential, authorization header, payload mentah, NPWP, email, dan telepon tidak
  muncul pada application log.
- Untuk volume production yang disepakati, satu run selesai sebelum jadwal
  berikutnya. Load test memakai sedikitnya dua kali volume terbesar hasil observasi.

## 3. Sumber Data SAP

### 3.1 Endpoint

| Resource | Endpoint dokumentasi | Field tanggal filter |
|---|---|---|
| PO | `https://10.30.68.21:9935/zapi_hka/zhka_int0001?sap-client=310` | `AEDAT` |
| PR | `https://10.30.68.21:9935/zapi_hka/zhka_int0002?sap-client=310` | `ERDAT` |
| Vendor | `https://10.30.68.21:9935/zapi_hka/zhka_int0003?sap-client=310` | `AEDAT` |

Endpoint dan credential harus menjadi konfigurasi runtime, bukan hard-coded di
source code. Implementasi menggunakan Basic Authentication seperti integrasi
Vendor yang sudah tersedia.

### 3.2 Kontrak filter tanggal

Filter menggunakan tanggal kalender dalam format `YYYYMMDD`, dengan batas bawah
dan batas atas inklusif:

```json
{
  "low": "20260601",
  "high": "20260630"
}
```

Adapter SAP harus mendukung transport filter yang dapat dikonfigurasi sebagai
`json_body` atau `query_parameter`. Nilai final ditetapkan melalui connection test
karena dokumentasi saat ini belum memastikan HTTP method dan lokasi filter.
Implementasi tidak boleh mengirim request body pada HTTP GET sebelum dipastikan
SAP mendukungnya.

Validasi filter:

- `low` dan `high` wajib berupa delapan digit dan tanggal kalender yang valid.
- `low` tidak boleh melewati `high`.
- Interpretasi tanggal menggunakan `Asia/Jakarta` dan tidak melakukan konversi UTC.
- Batas tanggal bersifat inklusif.
- Window maksimum default satu bulan agar payload, timeout, dan retry terkendali.

### 3.3 Window pengujian awal

Data testing diambil mulai 1 Juni 2026 sampai tanggal acuan 5 Agustus 2026.
Backfill dibagi menjadi tiga request untuk setiap resource:

| Urutan | `low` | `high` |
|---:|---|---|
| 1 | `20260601` | `20260630` |
| 2 | `20260701` | `20260731` |
| 3 | `20260801` | `20260805` |

Urutan resource pada setiap window adalah Vendor → PR → PO. Setiap kombinasi
resource dan window mempunyai status, checksum, jumlah record, dan issue terpisah.
Apply baru boleh dijalankan setelah dry-run untuk ketiga window selesai direview.

### 3.4 Window sinkronisasi rutin

- Checkpoint disimpan per resource berdasarkan `high` dari run terakhir yang
  berhasil.
- `low` run berikutnya menggunakan satu hari overlap dari checkpoint terakhir.
- `high` menggunakan tanggal saat run dimulai di zona `Asia/Jakarta`.
- Overlap sengaja diproses kembali dan aman karena upsert/checksum idempotent.
- Jika sebuah run gagal, checkpoint resource tersebut tidak berubah.
- Jika service tidak aktif beberapa hari, run berikutnya membagi rentang tertinggal
  menjadi window bulanan dan memprosesnya berurutan.
- Semantik filter wajib dikonfirmasi: apakah tanggal berarti tanggal dibuat atau
  tanggal terakhir berubah. Bila hanya tanggal dibuat, perubahan terhadap dokumen
  lama membutuhkan mekanisme rekonsiliasi tambahan pada fase berikutnya.

## 4. Arsitektur Target

```text
SAP API melalui VPN
        |
        v
SAP Connector -> Validator/Normalizer -> Reconciliation Engine
                                              |
                                              v
                                    PostgreSQL Si Procol
                                              |
                             Audit, issue, checksum, checkpoint
```

### 4.1 Komponen

- Aplikasi berdiri di repository dan deployment terpisah dari Procurement Online.
- Stack: Node.js 20+, TypeScript, Zod, PostgreSQL driver/Prisma, Pino, Vitest,
  dan Docker.
- Scheduler menggunakan timezone eksplisit `Asia/Jakarta`.
- PostgreSQL advisory lock memastikan hanya satu sync berjalan pada satu waktu.
- Pemrosesan dilakukan berurutan Vendor → PR → PO.
- Checksum mencegah update database terhadap record yang tidak berubah.
- Apply dilakukan atomik per dokumen dalam batch default 200 dokumen.
- Service berjalan sebagai non-root user dengan read-only filesystem.

### 4.2 Jadwal otomatis

Scheduler production hanya berjalan dua kali sehari:

| Jadwal | Timezone | Cron |
|---|---|---|
| Pagi | 08.00 | `0 8 * * *` |
| Sore | 16.00 | `0 16 * * *` |

Konfigurasi scheduler harus menyimpan kedua ekspresi atau ekspresi gabungan
`0 8,16 * * *`, selalu dengan `SYNC_TIMEZONE=Asia/Jakarta`. Aplikasi tidak boleh
mengandalkan timezone default OS/container.

Ketentuan scheduler:

- Run otomatis production memakai mode `apply` setelah approval go-live.
- Lokal, testing, dan pre-go-live memakai `DRY_RUN_ONLY=true`.
- Jika advisory lock masih aktif, trigger berikutnya tidak membuka run paralel dan
  dicatat sebagai `skipped_locked`.
- Restart service tidak boleh langsung membuat duplicate run untuk slot jadwal
  yang sudah berhasil.
- Missed run tidak dijalankan berkali-kali; satu catch-up run menggunakan checkpoint
  untuk mengambil seluruh rentang yang tertinggal.

### 4.3 Command operasional versi pertama

- `sap-sync test`
- `sap-sync dry-run --resource all --low YYYYMMDD --high YYYYMMDD`
- `sap-sync run --resource all --low YYYYMMDD --high YYYYMMDD --confirm-write`
- `sap-sync status <run-id>`
- `sap-sync retry <run-id>`

Command ini hanya untuk operator backend. Endpoint/button manual refresh dari Si
Procol belum dibuat pada versi pertama.

### 4.4 Konfigurasi

- `DATABASE_URL`
- `SAP_VENDOR_API_URL`, `SAP_PR_API_URL`, `SAP_PO_API_URL`
- `SAP_API_USERNAME`, `SAP_API_PASSWORD`
- `SAP_FILTER_TRANSPORT`
- `SAP_CA_CERT_PATH`, `SAP_API_TIMEOUT_MS`
- `SAP_MAX_RESPONSE_MB`, `SAP_NUMBER_FORMAT`
- `SYNC_SCHEDULES=0 8 * * *,0 16 * * *`
- `SYNC_TIMEZONE=Asia/Jakarta`
- `SYNC_BATCH_SIZE`, `DRY_RUN_ONLY`
- `AUDIT_RETENTION_DAYS`, `LOG_LEVEL`

Nilai credential disimpan melalui secret manager atau secret file milik runtime.
TLS wajib diverifikasi dengan CA internal. Production tidak boleh memakai
`rejectUnauthorized=false`.

## 5. Perubahan Database Procol

Schema tetap dimiliki dan diterapkan melalui migration Prisma Procurement Online
setelah review. Aplikasi integrasi tidak menjalankan DDL otomatis saat startup.

Perubahan yang dibutuhkan:

- Metadata source, currency, source date, source creator, checksum, dan waktu sync
  pada PR/PO.
- `sap_sync_runs` untuk trigger, mode, jadwal, status, dan waktu keseluruhan run.
- `sap_sync_run_resources` untuk resource, filter `low/high`, checkpoint, jumlah
  received/valid/invalid/inserted/updated/unchanged/conflict/failed.
- `sap_sync_record_results` untuk business key, action, source hash, dan issue code
  tanpa menyimpan payload mentah.
- `sap_sync_checkpoints` untuk checkpoint terakhir per resource.
- `sap_document_links` untuk relasi item PR ke item PO.
- Index pada source type, source key, status run, waktu sync, filter date, dan
  foreign key terkait.
- Retensi audit default 90 hari melalui housekeeping terjadwal.

Migration Vendor yang sudah disiapkan menjadi dependency dan harus lolos
pemeriksaan duplikasi sebelum sync pertama. Database role integrasi hanya mendapat
`SELECT`, `INSERT`, dan `UPDATE` pada tabel yang dibutuhkan; tidak mendapat
`DELETE`, DDL, superuser, atau akses ke database lain.

## 6. Pipeline Sinkronisasi

1. Membentuk window filter dan mencatat run berstatus `pending`.
2. Mengambil payload dengan Basic Authentication, timeout default 30 detik, dan
   batas respons default 50 MB.
3. Retry maksimal tiga kali dengan exponential backoff dan jitter untuk network
   error, HTTP 408, 429, dan 5xx. HTTP 401/403 dan schema error tidak di-retry.
4. Menerima record tunggal, array, atau wrapper SAP `value`, `results`, `d.value`,
   dan `d.results`.
5. Melakukan trim string, validasi tanggal, natural key, email, NPWP, dan angka.
6. Memvalidasi `KEY` terhadap nomor dokumen dan nomor item.
7. Exact duplicate diabaikan; natural key sama dengan isi berbeda menjadi konflik.
8. Mengelompokkan item menjadi satu header PR/PO dengan item JSON terurut.
9. Menjalankan dry-run/reconciliation atau upsert atomik per dokumen.
10. Memperbarui audit dan checkpoint hanya setelah resource berhasil.

Run dapat berstatus `completed`, `partial`, `failed`, atau `skipped_locked`.
Absennya record dari window berikutnya tidak dianggap sebagai penghapusan.

## 7. Mapping dan Aturan Data

### 7.1 Vendor

| SAP | Si Procol |
|---|---|
| `LIFNR` | `vendor_registrations.vendor_code` |
| `BPEXT` | `vendor_registrations.circle_number` |
| `NAME1` | `company_name` |
| `STCD1` | `npwp`, hanya digit |
| `STRAS` | `address` |
| `ORT01` | `city` |
| `AEDAT` | `vendor_created_at`, initial `approved_at` |
| `TELP` | `phone` |
| `EMAIL` | `email`, lowercase |
| Konstanta | `data_source = SAP`, `approver_name = SAP Integration` |

Aturan Vendor:

- `LIFNR` dan `NAME1` wajib.
- `LIFNR` adalah satu-satunya identity threshold dan disimpan sebagai `vendor_code` yang unique.
- LIFNR yang sama selalu menunjuk Vendor yang sama; LIFNR berbeda selalu dianggap Vendor berbeda.
- BPEXT/circle number, NPWP, email, dan nama perusahaan hanya atribut dan tidak dipakai untuk menyatukan Vendor.
- Vendor baru menjadi `verified`, `user_id = null`, dan tidak mendapat akun login.
- Vendor lama hanya dilengkapi pada field kosong.
- Status `SUSPENDED`, `BLACKLISTED`, dan `REJECTED` tidak diubah.
- Duplikasi LIFNR dengan payload berbeda dalam satu response dikarantina untuk review.

### 7.2 Purchase Requisition

Satu header dibuat per `BANFN`; natural key item adalah `BANFN + BNFPO`.

| SAP | Target |
|---|---|
| `KEY` | `items[].sap_key` dan validasi natural key |
| `BANFN` | `purchase_requests.pr_number` |
| `BNFPO` | `items[].item_number` |
| `BSART` | `items[].document_type` |
| `LOEKZ` | `items[].delete_indicator`, `items[].is_deleted` |
| `ERDAT` | source created date |
| `ERNAM` | source created by/requester name |
| `EKORG` | `items[].purchasing_organization` |
| `WERKS` | `items[].plant` |
| `MATKL` | `items[].material_group` |
| `TXZ01` | `items[].description` |
| `MENGE` | `items[].quantity` |
| `MEINS` | `items[].unit` |
| `PREIS` | `items[].price` |
| `PEINH` | `items[].price_unit` |
| `PSTYP` | `items[].item_category` |
| `WAERS` | header currency dan `items[].currency` |
| `EBELN` | `items[].po_number` |
| `EBELP` | `items[].po_item_number` |

Aturan PR:

- Total item aktif adalah `quantity × price ÷ price_unit`.
- `price_unit <= 0` menjadi invalid.
- Item dengan `LOEKZ` tidak kosong tetap disimpan tetapi dikeluarkan dari total.
- PR baru menjadi `CONVERTED` jika seluruh item aktif memiliki PO; selain itu
  `SUBMITTED`.
- Semua item terhapus menghasilkan `SUBMITTED` dan issue `ALL_ITEMS_DELETED`.
- Project, WBS, ARP, needed date, dan user UUID tetap `null` sampai ada mapping.
- PR lokal dengan nomor sama menjadi `LOCAL_RECORD_CONFLICT` dan tidak diubah.
- Status bisnis record SAP yang sudah lebih maju tidak diregresikan.
- Multi-currency membuat total header `null` dan issue rekonsiliasi.

### 7.3 Purchase Order

Satu header dibuat per `EBELN`; natural key item adalah `EBELN + EBELP`.

| SAP | Target |
|---|---|
| `KEY` | `items[].sap_key` dan validasi natural key |
| `EBELN` | `purchase_orders.po_number` |
| `EBELP` | `items[].item_number` |
| `LOEKZ` | `items[].delete_indicator`, `items[].is_deleted` |
| `AEDAT` | source created date dan initial `issued_at` |
| `AENAM` | source created by |
| `LIFNR` | pencarian `vendor_id` melalui `vendor_registrations.vendor_code` |
| `NAME_VEND` | snapshot nama vendor SAP |
| `BUKRS` | `items[].company_code` |
| `WERKS` | `items[].plant` |
| `TXZ01` | `items[].description` |
| `MENGE` | `items[].quantity` |
| `MEINS` | `items[].unit` |
| `NETPR` | `items[].net_price` |
| `WAERS` | header currency dan `items[].currency` |

Aturan PO:

- Total PO dihitung dari item aktif sebagai `quantity × net_price`.
- `ppn` dan `grand_total` tidak direkayasa karena tidak tersedia pada API.
- PO baru menjadi `ISSUED`; lifecycle lokal selanjutnya tidak diregresikan.
- Vendor dicari melalui `LIFNR`. Vendor yang belum ditemukan menghasilkan
  `vendor_id = null` dan issue `VENDOR_NOT_FOUND`, lalu direkonsiliasi ulang.
- Vendor, company, atau currency yang berbeda dalam satu PO mengarantina dokumen.
- Item `LOEKZ` tidak dihapus secara fisik.
- PO lokal dengan nomor sama dikarantina; hanya record berlabel SAP yang boleh
  diperbarui otomatis.

### 7.4 Relasi PR–PO

- `EBELN + EBELP` pada item PR dicocokkan ke item PO.
- Relasi item disimpan di `sap_document_links`.
- `purchase_orders.pr_id` hanya diisi bila seluruh linkage menunjuk satu header PR.
- Jika satu PO berasal dari beberapa PR, `pr_id` tetap `null` dan relasi lengkap
  disimpan di tabel linkage.

### 7.5 Normalisasi angka dan tanggal

- Format angka default mengikuti contoh Indonesia: titik sebagai pemisah ribuan
  dan koma sebagai desimal.
- Format fixed-scale SAP yang teramati juga didukung secara deterministik: titik
  terakhir dengan minimal empat digit pecahan diperlakukan sebagai separator
  desimal, sedangkan titik sebelumnya tetap separator ribuan. Contoh
  `153.90000` menjadi `153.9` dan `5.000.00000` menjadi `5000`.
- Nilai dengan tepat tiga digit setelah titik tetap mengikuti format Indonesia;
  contoh `1.430` menjadi `1430`.
- Format ambigu ditolak dan dicatat, tidak ditebak.
- Seluruh kalkulasi uang memakai decimal, bukan floating point JavaScript.
- Tanggal SAP disimpan sebagai date-only jika kolom target mendukungnya.
- Timestamp turunan menggunakan tengah malam `Asia/Jakarta` dengan konversi offset
  yang eksplisit.

## 8. Keamanan dan Operasional

- Firewall VM hanya mengizinkan egress yang diperlukan ke SAP dan database Procol.
- Port database dan service integrasi tidak dipublikasikan ke jaringan umum.
- CA internal dipasang sebagai secret/read-only mount.
- Logger meredaksi authorization, cookie, token, password, URL bercredential, dan
  data identitas vendor.
- Audit menyimpan identifier, checksum, action, dan issue code; bukan payload mentah.
- Container menjalankan non-root user, `no-new-privileges`, read-only filesystem,
  dan temporary filesystem terbatas.
- Graceful shutdown menyelesaikan atau membatalkan transaksi dan melepaskan lock.
- Alert dibuat ketika dua run berturut-turut gagal, tidak ada run sukses setelah
  slot jadwal berikutnya, conflict muncul, atau housekeeping audit gagal.

## 9. Tahapan Pembangunan dan Rollout

1. **Contract discovery:** konfirmasi HTTP method, lokasi filter, batas inklusif,
   wrapper respons, format angka, volume, timeout, CA, dan semantik tanggal.
2. **Fondasi aplikasi:** bootstrap TypeScript, config validation, logger, SAP
   client, scheduler 08.00/16.00 WIB, advisory lock, CLI, dan graceful shutdown.
3. **Data layer:** siapkan migration Procol, role minimum, audit, checkpoint,
   checksum, repository, transaksi, dan schema-version check.
4. **Domain sync:** implementasikan parser, mapper, grouping, conflict policy,
   dry-run, apply, retry, serta linkage Vendor–PO dan PR–PO.
5. **Uji lokal:** gunakan mock SAP dan database test terpisah dari Procol staging.
6. **Uji VPN read-only:** jalankan connection test dan dry-run tiga window testing
   dari perangkat pribadi.
7. **Review data:** validasi jumlah, identifier, mapping, issue, total PR/PO, dan
   relasi bersama data owner.
8. **Persiapan VM:** siapkan VPN route, firewall, CA, secret, Docker, log rotation,
   backup, monitoring, dan sinkronisasi waktu.
9. **Backfill terkontrol:** apply migration, dry-run ulang, lalu apply window Juni,
   Juli, dan 1–5 Agustus secara berurutan Vendor → PR → PO.
10. **Rekonsiliasi:** bandingkan source/valid/invalid/inserted/updated/unchanged/
    conflict/failed dan sampling data pada Si Procol.
11. **Aktivasi scheduler:** observasi minimal 24 jam, lalu aktifkan pukul 08.00 dan
    16.00 `Asia/Jakarta`.
12. **Fase lanjutan:** rancang manual refresh dari Si Procol menggunakan internal
    authenticated endpoint tanpa memberikan browser akses ke credential SAP/DB.

## 10. Test Plan dan Acceptance

- Unit test seluruh field Vendor, PR, dan PO dari sample dokumentasi.
- Filter test untuk format, tanggal invalid, batas inklusif, lintas bulan, tiga
  window backfill, overlap satu hari, dan checkpoint setelah failure.
- Scheduler test dengan fake clock untuk tepat pukul 08.00 dan 16.00 WIB, DST
  independence, restart, missed slot, dan lock aktif.
- Parser test untuk record tunggal, array, wrapper SAP, malformed JSON, item
  non-object, dan response terlalu besar.
- Client test untuk Basic Auth, TLS/CA, timeout, retryable/non-retryable status,
  transport filter, abort, dan redaksi credential.
- Numeric test untuk separator ribuan, desimal, whitespace `PEINH`, nol, overflow,
  angka negatif, dan format ambigu.
- Grouping test untuk multi-item, urutan, duplicate key, inconsistent header,
  multi-currency, dan checksum.
- Vendor test untuk uniqueness LIFNR/vendor_code, BPEXT/NPWP/email sebagai atribut,
  protected status, field kosong, dan duplicate payload.
- PR test untuk kalkulasi harga, `LOEKZ`, submitted/converted, local conflict, dan
  linkage ke PO.
- PO test untuk total, vendor hilang, multiple PR linkage, dan status lokal yang
  tidak boleh diregresikan.
- Integration test memakai PostgreSQL nyata untuk constraint, transaksi, advisory
  lock, batch partial failure, retention, dan idempotensi.
- End-to-end test memakai mock SAP → service → test DB → reconciliation report.
- Live smoke test hanya menjalankan connection test dan dry-run sebelum approval.
- Acceptance membuktikan apply identik kedua menghasilkan nol insert/update,
  dry-run tidak mengubah tabel bisnis, konflik lokal tidak tertimpa, jadwal hanya
  dua kali sehari, dan log bebas secret/payload sensitif.

## 11. Approval Gate dan Recovery

Sebelum approval database dan data owner, yang diperbolehkan hanya development,
test, connection test, dan dry-run. Dilarang:

- menerapkan migration ke database target;
- menjalankan mode apply;
- mengubah atau menghapus data lama;
- mengaktifkan scheduler production.

Tidak ada hard delete atau auto-rollback data. Rollback aplikasi menggunakan image
sebelumnya. Kegagalan initial backfill dipulihkan dari backup database, sedangkan
kegagalan sync reguler menggunakan fix-forward berdasarkan audit run dan checksum.

## 12. Asumsi yang Dikunci

- Service menulis langsung ke database menggunakan role terbatas.
- Konflik dengan data lokal dikarantina, bukan ditimpa.
- Scheduler otomatis hanya pukul 08.00 dan 16.00 `Asia/Jakarta`.
- Manual refresh dari UI/backend Si Procol ditunda ke fase berikutnya.
- Rentang testing awal bersifat tetap: 1 Juni 2026–5 Agustus 2026.
- Audit disimpan 90 hari tanpa payload SAP mentah.
- Aplikasi versi pertama tidak mempunyai UI.
- Basic Authentication digunakan bersama konfigurasi credential SAP.
- Transport filter dan semantik tanggal harus dikonfirmasi saat contract discovery.
- Semua perubahan schema memerlukan approval; service tidak melakukan migration
  otomatis.
