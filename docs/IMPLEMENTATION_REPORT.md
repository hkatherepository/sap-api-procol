# Report Implementasi SAP → Si Procol

Tanggal implementasi: 5 Agustus 2026  
Status kode: selesai dan terverifikasi lokal  
Status koneksi live SAP/Si Procol: menunggu akses VPN, credential, CA, schema aktual, dan approval data owner

## Ringkasan hasil

Aplikasi backend Node.js/TypeScript telah dibuat sebagai service terpisah. Implementasi mengikuti alur Vendor → PR → PO, memiliki mode dry-run dan apply, serta tidak menyediakan UI maupun endpoint manual refresh sesuai scope v1.

Komponen yang selesai:

- konfigurasi runtime tervalidasi dengan Zod;
- SAP HTTPS client dengan Basic Auth, CA yang tetap disiapkan, flag verification sementara, timeout, response limit, dan retry policy;
- parser semua bentuk wrapper yang disebut PRD;
- validator/normalizer Vendor, PR, dan PO;
- exact duplicate handling dan natural-key conflict quarantine;
- grouping PR/PO per header dengan item terurut dan checksum stabil;
- kalkulasi decimal, `LOEKZ`, status awal, multi-currency, dan vendor lookup;
- repository PostgreSQL, transaksi per dokumen, advisory lock, checkpoint, audit, dan retensi;
- linkage item PR–PO serta pengisian `purchase_orders.pr_id` hanya untuk satu header PR;
- CLI operator, scheduler dua slot WIB, catch-up, health check, graceful shutdown;
- Docker multi-stage non-root dan hardening runtime;
- migration proposal dan least-privilege grant template;
- unit test dan integration test PostgreSQL nyata.

## Struktur implementasi

| Area | Lokasi | Tanggung jawab |
|---|---|---|
| Bootstrap/config | `src/bootstrap.ts`, `src/config.ts` | Validasi environment dan dependency wiring |
| SAP adapter | `src/sap/client.ts`, `src/sap/response.ts` | HTTPS, auth, filter transport, retry, response wrapper |
| Domain mapping | `src/sap/normalize.ts`, `src/utils.ts` | Mapping, validation, decimal, date, grouping, checksum |
| Orkestrasi | `src/sync-engine.ts` | Window, urutan resource, mode, counter, checkpoint |
| Persistence | `src/repository.ts`, `src/database.ts` | Audit, reconciliation, conflict policy, transaksi, lock |
| Operasional | `src/cli.ts`, `src/scheduler.ts`, `src/health.ts`, `src/main.ts` | CLI, cron, catch-up, liveness/readiness, shutdown |
| Database | `database/migrations/001_sap_sync_schema.sql` | Metadata, audit, checkpoint, linkage, retention function |
| Deployment | `Dockerfile`, `compose.yaml`, `.env.example` | Image/runtime configuration dan hardening |
| Test | `tests/` | Unit, scheduler, config, migration/repository, E2E domain-to-DB |

## Hasil verifikasi

| Verifikasi | Hasil |
|---|---|
| TypeScript strict typecheck | Lulus |
| Production build | Lulus |
| Unit + PostgreSQL integration test | 46 test terverifikasi, 6 file test |
| Migration pada PostgreSQL kosong dengan fixture schema Si Procol | Lulus |
| E2E mock Vendor → PR → PO → linkage | Lulus |
| Apply kedua pada payload identik | 0 insert, 0 update; seluruh record unchanged |
| Advisory lock paralel | Trigger kedua ditolak |
| Dry-run terhadap tabel bisnis | Tidak ada row bisnis dibuat |
| Konflik nomor PR lokal | Dikarantina sebagai `LOCAL_RECORD_CONFLICT` |
| Dependency production audit | 0 vulnerability diketahui |

Verifikasi PostgreSQL dijalankan pada instance sementara lokal. Instance dan datanya telah dihentikan serta dihapus setelah test.

## Coverage terhadap acceptance PRD

| Acceptance | Implementasi | Status |
|---|---|---|
| Window testing Juni–5 Agustus | Split bulanan otomatis | Siap diuji live |
| Idempotensi Vendor/PR/PO/item | Natural key + checksum + upsert policy | Lulus lokal |
| Dry-run tidak mengubah tabel bisnis | Reconciliation dalam transaksi tanpa mutation | Lulus lokal |
| Record PR/PO lokal tidak tertimpa | `data_source` conflict gate | Lulus lokal |
| Scheduler hanya 08.00/16.00 WIB | Hanya dua pola cron yang diterima config | Lulus unit test |
| Checkpoint tidak maju saat kegagalan teknis | Advance setelah seluruh task resource sukses teknis | Terimplementasi |
| Secret/payload/PII tidak masuk log | Tidak log payload; Pino redaction list | Terimplementasi |
| Retry dan audit issue per record | CLI retry + tabel audit tanpa raw payload | Terimplementasi |
| Lock mencegah run paralel | PostgreSQL advisory lock | Lulus integration test |
| TLS SAP | CA tetap dipasang; verification sementara OFF karena certificate/IP mismatch | Exception sementara; improvement terdokumentasi |

## Keputusan teknis penting

- PostgreSQL driver `pg` dipilih agar service tidak memiliki perilaku auto-migration. Ownership schema tetap pada Procurement Online.
- Verifikasi certificate SAP sementara dikontrol oleh `SAP_TLS_REJECT_UNAUTHORIZED=false`. Ini adalah exception sadar untuk menyamai pengujian Postman, menghasilkan warning saat runtime, dan bukan target keamanan production final. CA serta mount secret tetap dipertahankan untuk migrasi ke pinning/hostname resmi.
- Controlled apply manual dipisahkan dari scheduler melalui `SYNC_SCHEDULER_ENABLED=false`. Scheduler dan startup catch-up hanya aktif setelah flag tersebut diubah eksplisit menjadi `true` bersama `DRY_RUN_ONLY=false`.
- Identitas Vendor hanya memakai LIFNR yang disimpan sebagai `vendor_registrations.vendor_code` unique. LIFNR berbeda menghasilkan Vendor berbeda walaupun BPEXT, NPWP, nama, atau atribut lain sama. PO me-resolve `vendor_id` langsung melalui LIFNR tersebut.
- Dry-run tetap menulis audit, tetapi tidak mengubah tabel Vendor/PR/PO/linkage/checkpoint.
- Record invalid atau conflict dicatat dan dikarantina. Kegagalan teknis mencegah checkpoint resource maju; issue data menghasilkan status partial tetapi window tetap dapat diaudit/retry.
- Vendor existing hanya dilengkapi pada field kosong. Status protected tidak disentuh karena query update tidak pernah mengubah status.
- PR/PO SAP boleh di-update berdasarkan checksum, sedangkan record dengan nomor sama dan `data_source` bukan SAP tidak diubah.
- Housekeeping memakai security-definer function; runtime role tidak membutuhkan hak `DELETE` langsung.
- Alert awal disediakan sebagai structured log event untuk conflict, dua kegagalan berturut-turut, dan housekeeping failure. Routing ke Slack/email/Sentry mengikuti monitoring VM yang dipilih tim infrastruktur.

## Gate eksternal sebelum live apply

Poin berikut sengaja belum dieksekusi karena membutuhkan sistem/approval di luar repository:

1. Konfirmasi method HTTP final dan `SAP_FILTER_TRANSPORT` lewat connection test VPN.
2. Konfirmasi arti field tanggal SAP (created vs last changed), inclusive boundary, wrapper, volume, dan timeout.
3. Cocokkan migration dengan schema Si Procol aktual dan migration Vendor yang sudah disiapkan.
4. Jalankan duplicate preflight Vendor serta review unique constraint/index.
5. Siapkan role database minimum, CA internal, secret, VPN route, firewall, backup, dan monitoring VM.
6. Jalankan live `sap-sync test`, lalu dry-run tiga window tanpa apply.
7. Review counter, issue, total, sample record, serta linkage bersama data owner.
8. Jalankan load test minimal dua kali volume terbesar yang diamati.
9. Setelah approval, ubah `DRY_RUN_ONLY=false`, apply backfill, rekonsiliasi, observasi 24 jam, lalu aktifkan scheduler.

Tidak ada migration atau write yang dijalankan terhadap database Si Procol aktual dalam implementasi ini.
