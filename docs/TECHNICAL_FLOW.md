# Flow Teknis SAP → Si Procol

## 1. Trigger dan single-run gate

```text
CLI / Cron 08.00 & 16.00 WIB / Startup catch-up
                    |
                    v
          create sap_sync_runs
                    |
                    v
       pg_try_advisory_lock(global)
            |               |
          gagal           berhasil
            |               |
   skipped_locked      status running
                            |
                            v
                  Bentuk task per window
```

Trigger scheduler mempunyai `trigger_key` unik berdasarkan slot WIB. Restart atau dua proses yang melihat slot sama tidak membuat duplicate run. Catch-up hanya membuat satu run; rentang tertinggal dihitung dari checkpoint dan dipecah per bulan.

Cron dan startup catch-up hanya aktif jika `DRY_RUN_ONLY=false` serta `SYNC_SCHEDULER_ENABLED=true`. Selama controlled manual apply, scheduler harus tetap `false` agar restart tidak memicu write otomatis.

## 2. Pembentukan window

Untuk range eksplisit, `20260601–20260805` menjadi:

1. `20260601–20260630`
2. `20260701–20260731`
3. `20260801–20260805`

Pada setiap window, urutannya PR → PO → GR (Vendor dimatikan sementara, hanya lewat `--resource vendor`). `low`/`high` dikirim ke SAP untuk semua resource: PR = `ERDAT`, PO = `AEDAT`, GR = `BUDAT`. Scheduler punya dua jadwal (`Asia/Jakarta`): slot 11.00 dan 15.00 menarik PR, PO, GR dari tanggal 1 bulan lalu s.d. hari ini (2 bulan); sync malam 23.00 menarik PR dan PO dari tanggal 1 sebelas bulan lalu s.d. hari ini (12 bulan) untuk menangkap release dan tambahan item yang terlambat. Bila `checkpoint_high` lebih tua dari awal window, `low` mundur ke checkpoint agar run yang terlewat tersusul. Checkpoint hanya maju, sehingga backfill rentang lama lewat CLI tidak memundurkannya.

```text
Window N
  ├─ PR
  ├─ PO
  └─ GR
       |
       v
Window N+1
```

## 3. Request SAP

```text
URL runtime config
  + Basic Auth
  + CA internal tetap dimuat
  + rejectUnauthorized dari SAP_TLS_REJECT_UNAUTHORIZED
  + filter low/high (query atau POST JSON)
  + timeout 30 detik
  + response limit 50 MB
          |
          v
HTTP request
  ├─ 2xx             → parse JSON
  ├─ network/408/429/5xx → retry max 3, exponential backoff + jitter
  └─ 401/403/schema   → fail tanpa retry
```

GET + JSON body ditolak saat validasi config. Payload mentah tidak disimpan dan tidak dikirim ke logger.

Untuk kompatibilitas sementara, `SAP_TLS_REJECT_UNAUTHORIZED=false`: koneksi tetap memakai HTTPS, tetapi identitas certificate server belum diverifikasi. Service menulis warning tanpa credential saat client dibuat. Target perbaikannya adalah certificate pinning atau hostname resmi; lihat `docs/SAP_TLS_IMPROVEMENT.md`.

## 4. Parse, validasi, dan normalisasi

```text
single / array / value / results / d.value / d.results
                            |
                            v
                    object records
                            |
       trim ─ date ─ email/NPWP ─ decimal id-ID/fixed-scale SAP
                            |
                   natural key + KEY check
                            |
            exact duplicate? ── yes → abaikan
                            |
       key sama, isi beda? ── yes → invalid/conflict
                            |
              group header + sort item
                            |
                canonical SHA-256 hash
```

Fatal issue seperti missing required field, invalid date/number, `KEY_MISMATCH`, duplicate key berbeda, serta inconsistent PO company/vendor/currency tidak diteruskan ke tabel bisnis. Issue rekonsiliasi seperti `ALL_ITEMS_DELETED`, PR multi-currency, atau `VENDOR_NOT_FOUND` tetap dicatat bersama hasil record.

## 5. Rekonsiliasi per resource

### Vendor

```text
lookup vendor_registrations.vendor_code = LIFNR
  ├─ belum ada             → insert Vendor VERIFIED
  └─ sudah ada
       ├─ source hash sama → unchanged
       └─ hash berubah     → isi hanya field Vendor yang masih kosong
```

`BPEXT`, NPWP, email, dan nama perusahaan tidak ikut menentukan identitas. Karena itu dua LIFNR berbeda tetap menghasilkan dua Vendor meskipun atribut tersebut sama. Update Vendor tidak menyentuh `status`, sehingga `SUSPENDED`, `BLACKLISTED`, dan `REJECTED` tetap terlindungi.

### Purchase Requisition

```text
lookup pr_number
  ├─ tidak ada               → insert SAP
  ├─ data_source != SAP      → LOCAL_RECORD_CONFLICT
  ├─ checksum sama           → unchanged
  └─ checksum berubah        → update field SAP + items
```

Total aktif = `quantity × price ÷ priceUnit`. Item `LOEKZ` tetap ada di JSON tetapi tidak masuk total maupun evaluasi release. `FRGKZ` disimpan sebagai `releaseIndicator`. Status menjadi `CONVERTED` bila seluruh item aktif memiliki PO; jika belum, menjadi `APPROVED` bila seluruh item aktif memiliki `FRGKZ=2`, atau `SUBMITTED` selain itu. Sinkronisasi dapat mengubah status di antara ketiga status SAP tersebut, sedangkan `REJECTED` dipertahankan. PR **baru** yang belum full release (`SUBMITTED`) tidak di-insert dan tidak dicatat di audit; PR yang sudah ada tetap di-update. `PEINH` 0 atau kosong dihitung sebagai 1 dengan catatan non-fatal `PRICE_UNIT_DEFAULTED`.

### Purchase Order

```text
lookup po_number + LIFNR pada vendor_registrations.vendor_code
  ├─ PO lokal nomor sama     → LOCAL_RECORD_CONFLICT
  ├─ vendor tidak ditemukan  → vendor_id=null + VENDOR_NOT_FOUND
  ├─ checksum sama           → unchanged
  └─ baru/berubah            → insert/update SAP
                                  |
                                  v
                         reconcile PR item links
```

Total aktif = `quantity × (netPrice ÷ priceUnit)`; `PEINH` 0 atau kosong dihitung sebagai 1 (`PRICE_UNIT_DEFAULTED`, non-fatal), teks non-angka tetap fatal; `ppn` dan `grand_total` tidak direkayasa. `FRGKE` disimpan sebagai `releaseIndicator`: seluruh item aktif harus bernilai `G` atau `2` agar PO menjadi `ISSUED`, jika tidak statusnya `DRAFT`. SAP dapat mengubah status di antara `DRAFT` dan `ISSUED`, tetapi lifecycle lokal mulai `ACKNOWLEDGED` hingga `CANCELLED` dipertahankan. `issued_at` mengikuti `AEDAT` untuk `ISSUED` dan dikosongkan saat kembali `DRAFT`. Setelah PO ditulis, item PR dengan `poNumber + poItemNumber` yang sama dimasukkan ke `sap_document_links`. `purchase_orders.pr_id` hanya diisi jika semua link PO menunjuk tepat satu header PR. PO **baru** yang belum full release (`DRAFT`) tidak di-insert dan tidak dicatat di audit; PO yang sudah ada tetap di-update.

### Penggabungan item PR/PO

Filter tanggal SAP (`ERDAT`/`AEDAT`) bekerja per item, sehingga satu window bisa membawa sebagian item sebuah dokumen. Saat reconcile, item yang datang digabung dengan item tersimpan berdasarkan nomor item: item bernomor sama ditimpa, item baru ditambahkan, item yang tidak ikut terkirim tetap disimpan. Total, currency, dan status dihitung ulang dari seluruh item gabungan; `source_date` memakai tanggal paling awal. Item yang dihapus di SAP tetap terkirim dengan `LOEKZ` dan dikeluarkan dari total.

## 6. Batas transaksi, audit, dan checkpoint

```text
setiap dokumen
    BEGIN
      SELECT ... FOR UPDATE
      reconcile / upsert / linkage
    COMMIT
      |
      v
record action + hash + issue_codes
```

Batch size mengatur ukuran iterasi (default 200), tetapi transaction boundary tetap per dokumen agar satu record rusak tidak menggagalkan dokumen lain.

Counter per resource/window:

`received`, `valid`, `invalid`, `inserted`, `updated`, `unchanged`, `conflict`, `failed`.

Checkpoint apply baru diperbarui setelah seluruh window untuk resource tersebut bebas dari kegagalan teknis. Dry-run tidak mengubah checkpoint. Run berakhir sebagai `completed`, `partial`, `failed`, atau `skipped_locked`.

## 7. Recovery

- Transport/database failure: checkpoint tidak maju; gunakan `sap-sync retry <run-id>`.
- Invalid/conflict: record dikarantina lewat audit issue code dan direview data owner.
- Duplicate execution: checksum menghasilkan `unchanged`; slot scheduler dan advisory lock mencegah parallel duplicate.
- Initial backfill salah: hentikan scheduler, rollback image aplikasi, dan pulihkan database dari backup sesuai approval gate.
- Tidak ada hard delete data bisnis dan tidak ada auto-rollback destructive.

## 8. Observability dan keamanan

- `/health/live`: proses hidup.
- `/health/ready`: database dapat menerima query.
- Structured alert log: conflict, dua run gagal berturut-turut, housekeeping failure.
- Audit retention default 90 hari melalui stored function terbatas.
- Logger meredaksi authorization/cookie/password/token serta field email/phone/NPWP.
- Container berjalan sebagai UID 10001, read-only, tanpa Linux capabilities, `no-new-privileges`, dan tmpfs terbatas.
