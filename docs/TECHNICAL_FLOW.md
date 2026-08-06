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

Pada setiap window, urutannya Vendor → PR → PO. Untuk run rutin, `low` sama dengan `checkpoint_high` terakhir sehingga satu tanggal diproses ulang sebagai overlap; `high` adalah tanggal run dimulai di `Asia/Jakarta`.

```text
Window N
  ├─ Vendor
  ├─ PR
  └─ PO
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

Total aktif = `quantity × price ÷ priceUnit`. Item `LOEKZ` tetap ada di JSON tetapi tidak masuk total. Status hanya boleh maju dari `SUBMITTED` ke `CONVERTED`; lifecycle lokal lain dipertahankan.

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

Total aktif = `quantity × netPrice`; `ppn` dan `grand_total` tidak direkayasa. Setelah PO ditulis, item PR dengan `poNumber + poItemNumber` yang sama dimasukkan ke `sap_document_links`. `purchase_orders.pr_id` hanya diisi jika semua link PO menunjuk tepat satu header PR.

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
