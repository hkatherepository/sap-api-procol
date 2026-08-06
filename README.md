# SAP → Si Procol Integration Service

Backend terpisah untuk mengambil Vendor, Purchase Requisition (PR), dan Purchase Order (PO) dari SAP melalui jaringan VPN, lalu merekonsiliasi dan menyimpannya secara idempotent ke PostgreSQL Si Procol.

## Kemampuan utama

- Urutan sinkronisasi selalu Vendor → PR → PO pada setiap window tanggal.
- Backfill panjang otomatis dipecah per bulan; filter `low/high` bersifat inklusif.
- Mendukung SAP response berupa single object, array, `value`, `results`, `d.value`, dan `d.results`.
- Basic Authentication, CA internal yang tetap disiapkan, flag verifikasi TLS, timeout, batas response, serta retry 3 kali untuk network error/408/429/5xx.
- Normalisasi angka Indonesia dan fixed-scale SAP memakai decimal arithmetic, bukan floating point JavaScript.
- Dry-run, apply dengan konfirmasi eksplisit, status, dan retry.
- Audit per run/resource/record tanpa menyimpan payload mentah.
- Checksum, checkpoint overlap satu hari, transaksi per dokumen, dan PostgreSQL advisory lock.
- Scheduler pukul 08.00 dan 16.00 `Asia/Jakarta`, catch-up tunggal saat restart, dan deduplikasi slot jadwal.
- Health check `GET /health/live` dan `GET /health/ready`; tidak ada endpoint manual refresh pada v1.
- Container non-root, read-only filesystem, dropped capabilities, dan logger dengan redaksi data sensitif.

## Menjalankan lokal

Prasyarat: Node.js 20+, PostgreSQL, akses VPN SAP, credential SAP, serta CA internal. Verifikasi certificate SAP sementara dinonaktifkan karena endpoint memakai IP yang tidak cocok dengan identitas certificate; keputusan, risiko, dan rencana perbaikannya dicatat di `docs/SAP_TLS_IMPROVEMENT.md`.

```bash
cp .env.example .env
npm install
npm run build
```

Migration [001_sap_sync_schema.sql](database/migrations/001_sap_sync_schema.sql) harus direview terhadap schema Si Procol dan dijalankan oleh pemilik schema. Service tidak pernah menjalankan DDL otomatis. Identitas Vendor memakai constraint unique existing pada `vendor_registrations.vendor_code`; tidak diperlukan tabel alias Vendor.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/001_sap_sync_schema.sql
```

Sebelum go-live, pertahankan `DRY_RUN_ONLY=true`.

## Command operator

```bash
npm run sap-sync -- test
npm run sap-sync -- dry-run --resource all --low 20260601 --high 20260805
npm run sap-sync -- status <run-id>
```

Command dry-run di atas otomatis menjadi tiga window: Juni, Juli, dan 1–5 Agustus 2026.

Apply hanya setelah review data dan approval migration. Untuk controlled apply manual, ubah `DRY_RUN_ONLY=false` tetapi pertahankan `SYNC_SCHEDULER_ENABLED=false`, kemudian:

```bash
npm run sap-sync -- run --resource all --low 20260601 --high 20260805 --confirm-write
npm run sap-sync -- retry <run-id> --confirm-write
```

`--confirm-write` pada retry hanya wajib bila run asal adalah apply.

## Menjalankan service

```bash
npm start
```

Scheduler apply hanya diaktifkan bila `DRY_RUN_ONLY=false` dan `SYNC_SCHEDULER_ENABLED=true`. Pertahankan scheduler `false` selama controlled backfill agar restart container tidak memicu catch-up write. Untuk container:

```bash
docker compose up --build -d
```

Port health check pada compose hanya di-bind ke loopback host (`127.0.0.1`). Credential tidak boleh dimasukkan ke image atau source; gunakan runtime secret. File CA dipasang read-only melalui `/run/secrets/sap-ca.crt`.

## Verifikasi

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Integration test PostgreSQL otomatis aktif jika `TEST_DATABASE_URL` tersedia:

```bash
TEST_DATABASE_URL=postgresql://localhost:5432/sap_procol_test npm test
```

## Dokumen handoff

- [Report implementasi](docs/IMPLEMENTATION_REPORT.md)
- [Flow teknis](docs/TECHNICAL_FLOW.md)
- [Kontrak database](database/README.md)
- [Setup SSH tunnel sidecar](docs/SSH_TUNNEL_SETUP.md)
