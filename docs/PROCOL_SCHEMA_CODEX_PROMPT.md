# Prompt Codex — Schema SAP Integration di Project Si Procol

Salin prompt di bawah ini ke Codex yang sedang membuka repository Si Procol:

```text
Saya sedang menambahkan service terpisah yang mengambil Vendor, Purchase Requisition (PR), dan Purchase Order (PO) dari SAP lalu menyinkronkannya ke PostgreSQL Si Procol.

Tolong implementasikan migration schema untuk mendukung integrasi ini di repository Si Procol. Sebelum mengedit, audit dulu framework, pola migration, schema, enum, trigger, RLS/policy, dan test yang sudah dipakai repository. Gunakan mekanisme migration native project; jangan membuat script ad-hoc jika project sudah memakai Prisma, Supabase, Knex, Drizzle, atau tool migration lain.

Kondisi schema aktual yang sudah dikonfirmasi:

- Tabel Vendor adalah public.vendor_registrations, BUKAN vendors.
- vendor_registrations.id bertipe uuid tanpa default.
- vendor_registrations.vendor_code text NOT NULL UNIQUE dan menjadi identifier tunggal untuk SAP LIFNR.
- registration_code sudah di-rename menjadi vendor_code; source_vendor_id sudah dikonsolidasikan ke vendor_code lalu dihapus.
- vendor_registrations.circle_number dan vendor_created_at sudah ditambahkan oleh migration Vendor.
- Constraint/index aktual hanya mewajibkan uniqueness pada id, user_id, dan vendor_code; NPWP/email bukan identity threshold.
- vendor_registrations.status memakai enum vendor_status lowercase: draft, submitted, under_review, pending, verified, rejected, suspended, blacklisted.
- vendor_registrations.updated_at NOT NULL tanpa default.
- purchase_requests dan purchase_orders sudah ada.
- Keduanya memiliki id uuid tanpa default, items jsonb nullable, total_amount numeric, dan updated_at NOT NULL tanpa default.
- pr_status memakai lowercase: draft, submitted, approved, rejected, converted.
- po_status memakai lowercase: draft, issued, acknowledged, partial, delivered, closed, cancelled.
- purchase_orders.vendor_id sudah FK ke vendor_registrations(id).
- Jangan membuat tabel vendors.
- Jangan membuat kolom total baru; integrasi memakai total_amount yang sudah ada.

Tujuan migration:

1. Tambahkan metadata SAP ke tabel bisnis secara additive dan idempotent:

   public.vendor_registrations:
   - data_source text NULL
   - source_checksum char(64) NULL
   - last_synced_at timestamptz NULL
   - pertahankan vendor_code sebagai identifier tunggal dan unique
   - SAP LIFNR dipetakan ke vendor_code, BPEXT ke circle_number, dan AEDAT ke vendor_created_at

   public.purchase_requests:
   - data_source text NULL
   - source_key text NULL
   - source_checksum char(64) NULL
   - source_date date NULL
   - source_created_by text NULL
   - currency text NULL
   - last_synced_at timestamptz NULL
   - pertahankan items dan total_amount existing
   - boleh set DEFAULT items menjadi '[]'::jsonb, tetapi jangan backfill atau SET NOT NULL tanpa analisis dampak dan approval
   - index pada (data_source, source_key)

   public.purchase_orders:
   - data_source text NULL
   - source_key text NULL
   - source_checksum char(64) NULL
   - source_date date NULL
   - source_created_by text NULL
   - currency text NULL
   - vendor_name_snapshot text NULL
   - last_synced_at timestamptz NULL
   - pastikan pr_id uuid NULL FK ke purchase_requests(id); jangan duplikasi bila sudah ada
   - pertahankan items dan total_amount existing
   - boleh set DEFAULT items menjadi '[]'::jsonb, tetapi jangan backfill atau SET NOT NULL tanpa analisis dampak dan approval
   - index pada (data_source, source_key)

2. Buat tabel metadata integrasi berikut. Gunakan pgcrypto/gen_random_uuid hanya jika sesuai konvensi project atau sudah tersedia.

   sap_integration_schema_versions:
   - version integer PRIMARY KEY
   - applied_at timestamptz NOT NULL DEFAULT now()

   sap_sync_runs:
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - trigger_type text NOT NULL, hanya cli/scheduler/retry
   - trigger_key text NULL
   - retry_of uuid NULL FK ke sap_sync_runs(id) ON DELETE SET NULL
   - mode text NOT NULL, hanya dry_run/apply
   - status text NOT NULL, hanya pending/running/completed/partial/failed/skipped_locked
   - scheduled_for, started_at, finished_at timestamptz NULL
   - error_code text NULL
   - created_at timestamptz NOT NULL DEFAULT now()
   - unique partial index trigger_key WHERE trigger_key IS NOT NULL
   - index (status, created_at DESC)

   sap_sync_run_resources:
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - run_id uuid NOT NULL FK sap_sync_runs(id) ON DELETE CASCADE
   - resource text NOT NULL, hanya vendor/pr/po
   - filter_low char(8) NOT NULL
   - filter_high char(8) NOT NULL
   - status text NOT NULL, hanya pending/running/completed/partial/failed
   - checkpoint_before char(8) NULL
   - payload_checksum char(64) NULL
   - counter integer NOT NULL DEFAULT 0: received, valid, invalid, inserted, updated, unchanged, conflict, failed
   - started_at, finished_at timestamptz NULL
   - error_code text NULL
   - UNIQUE(run_id, resource, filter_low, filter_high)
   - index (run_id, resource)

   sap_sync_record_results:
   - id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
   - run_resource_id uuid NOT NULL FK sap_sync_run_resources(id) ON DELETE CASCADE
   - business_key text NOT NULL
   - action text NOT NULL, hanya inserted/updated/unchanged/conflict/invalid/failed
   - source_hash char(64) NULL
   - issue_codes text[] NOT NULL DEFAULT '{}'
   - created_at timestamptz NOT NULL DEFAULT now()
   - UNIQUE(run_resource_id, business_key)
   - index (action, created_at DESC)

   sap_sync_checkpoints:
   - resource text PRIMARY KEY, hanya vendor/pr/po
   - checkpoint_high char(8) NOT NULL
   - successful_run_resource_id uuid NOT NULL FK sap_sync_run_resources(id)
   - updated_at timestamptz NOT NULL DEFAULT now()

   sap_document_links:
   - id uuid PRIMARY KEY DEFAULT gen_random_uuid()
   - pr_id uuid NOT NULL FK purchase_requests(id)
   - pr_number text NOT NULL
   - pr_item_number text NOT NULL
   - po_id uuid NOT NULL FK purchase_orders(id)
   - po_number text NOT NULL
   - po_item_number text NOT NULL
   - created_at dan updated_at timestamptz NOT NULL DEFAULT now()
   - UNIQUE(pr_number, pr_item_number, po_number, po_item_number)
   - index pr_id dan po_id

3. Insert schema version 1 secara idempotent ke sap_integration_schema_versions.

4. Pertahankan identitas Vendor SAP yang sederhana:
   - LIFNR disimpan langsung pada vendor_registrations.vendor_code;
   - vendor_code harus tetap mempunyai constraint atau unique index;
   - LIFNR adalah satu-satunya matching identity Vendor;
   - dua LIFNR berbeda menghasilkan dua Vendor berbeda walaupun BPEXT/circle_number, NPWP, email, atau nama sama;
   - PO mencari vendor_id langsung melalui vendor_registrations.vendor_code;
   - jangan membuat tabel alias atau constraint unique untuk BPEXT/circle_number, NPWP, email, atau nama perusahaan.

5. Tambahkan fungsi retensi audit sap_purge_audit(retention_days integer):
   - tolak retention_days < 7
   - hapus sap_sync_runs yang lebih lama dari retention_days; cascade membersihkan resource dan record result
   - return jumlah run yang terhapus
   - SECURITY DEFINER dengan search_path public, pg_temp
   - REVOKE ALL FROM PUBLIC
   - ikuti pola security/function ownership repository bila ada

6. Tambahkan preflight/read-only check atau test migration:
   - pastikan tidak ada duplicate vendor_code non-null dan constraint unique vendor_code tetap aktif
   - pastikan migration dapat berjalan pada schema existing tanpa drop/rename tabel atau kehilangan data
   - pastikan rerun migration aman sesuai kemampuan migration framework
   - pastikan semua FK dan check constraint terbentuk
   - pastikan view/policy/RLS existing tidak rusak
   - jangan mengubah nilai enum bisnis existing

7. Bila project mempunyai role runtime khusus, siapkan grant least-privilege untuk SELECT/INSERT/UPDATE pada tabel integrasi dan tiga tabel bisnis, USAGE/SELECT sequence identity, serta EXECUTE fungsi purge. Jangan memberi DELETE langsung, DDL, superuser, atau akses database lain. Jangan membuat role baru tanpa konfirmasi.

Batas keamanan:

- Jangan menjalankan migration ke production atau staging live secara otomatis.
- Jangan drop, rename, truncate, atau menghapus data bisnis.
- Jangan mengubah credential, RLS, atau firewall di luar kebutuhan migration.
- Jangan membuat tabel vendors.
- Jika schema repository berbeda dari fakta di atas, hentikan implementasi pada bagian yang konflik dan laporkan bukti file/migration yang ditemukan.

Setelah implementasi, jalankan test/typecheck/lint migration yang tersedia. Berikan ringkasan file yang berubah, SQL/ORM migration yang dibuat, hasil test, potensi lock saat ALTER TABLE/CREATE INDEX, rollback/fix-forward plan, dan command yang harus dijalankan oleh pemilik database setelah review.
```
