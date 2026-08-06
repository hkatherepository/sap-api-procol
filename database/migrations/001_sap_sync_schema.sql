-- REVIEW GATE: migration ini dijalankan oleh pemilik schema Si Procol, bukan oleh service.
-- Asumsi tabel bisnis aktual: vendor_registrations, purchase_requests, purchase_orders.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sap_integration_schema_versions (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sap_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type text NOT NULL CHECK (trigger_type IN ('cli', 'scheduler', 'retry')),
  trigger_key text,
  retry_of uuid REFERENCES sap_sync_runs(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'skipped_locked')),
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sap_sync_runs ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sap_sync_runs_trigger_key_uidx ON sap_sync_runs(trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sap_sync_runs_status_created_idx ON sap_sync_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS sap_sync_run_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES sap_sync_runs(id) ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource IN ('vendor', 'pr', 'po')),
  filter_low char(8) NOT NULL,
  filter_high char(8) NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed')),
  checkpoint_before char(8),
  payload_checksum char(64),
  received integer NOT NULL DEFAULT 0,
  valid integer NOT NULL DEFAULT 0,
  invalid integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  unchanged integer NOT NULL DEFAULT 0,
  conflict integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  UNIQUE (run_id, resource, filter_low, filter_high)
);
ALTER TABLE sap_sync_run_resources ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS sap_sync_run_resources_run_idx ON sap_sync_run_resources(run_id, resource);

CREATE TABLE IF NOT EXISTS sap_sync_record_results (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_resource_id uuid NOT NULL REFERENCES sap_sync_run_resources(id) ON DELETE CASCADE,
  business_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('inserted', 'updated', 'unchanged', 'conflict', 'invalid', 'failed')),
  source_hash char(64),
  issue_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_resource_id, business_key)
);
CREATE INDEX IF NOT EXISTS sap_sync_record_results_action_idx ON sap_sync_record_results(action, created_at DESC);

CREATE TABLE IF NOT EXISTS sap_sync_checkpoints (
  resource text PRIMARY KEY CHECK (resource IN ('vendor', 'pr', 'po')),
  checkpoint_high char(8) NOT NULL,
  successful_run_resource_id uuid NOT NULL REFERENCES sap_sync_run_resources(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sap_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id uuid NOT NULL REFERENCES purchase_requests(id),
  pr_number text NOT NULL,
  pr_item_number text NOT NULL,
  po_id uuid NOT NULL REFERENCES purchase_orders(id),
  po_number text NOT NULL,
  po_item_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pr_number, pr_item_number, po_number, po_item_number)
);
ALTER TABLE sap_document_links ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS sap_document_links_pr_idx ON sap_document_links(pr_id);
CREATE INDEX IF NOT EXISTS sap_document_links_po_idx ON sap_document_links(po_id);

-- Schema Vendor final: LIFNR memakai vendor_code, BPEXT memakai circle_number,
-- dan AEDAT memakai vendor_created_at. Rename/konsolidasi identifier dikelola migration Vendor di repository Si Procol.
ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS circle_number text;
ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS vendor_created_at date;
ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS data_source text;
ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS source_checksum char(64);
ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS data_source text;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS source_checksum char(64);
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS source_date date;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS source_created_by text;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE purchase_requests ALTER COLUMN items SET DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS purchase_requests_source_idx ON purchase_requests(data_source, source_key);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS data_source text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_checksum char(64);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_date date;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_created_by text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_name_snapshot text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS pr_id uuid REFERENCES purchase_requests(id);
ALTER TABLE purchase_orders ALTER COLUMN items SET DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS purchase_orders_source_idx ON purchase_orders(data_source, source_key);

INSERT INTO sap_integration_schema_versions(version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION sap_purge_audit(retention_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF retention_days < 7 THEN
    RAISE EXCEPTION 'retention_days minimal 7';
  END IF;
  DELETE FROM sap_sync_runs WHERE created_at < now() - (retention_days * interval '1 day');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION sap_purge_audit(integer) FROM PUBLIC;
COMMIT;

-- Least-privilege grant template (ganti nama role bila perlu):
-- GRANT USAGE ON SCHEMA public TO sap_integration;
-- GRANT SELECT, INSERT, UPDATE ON sap_sync_runs, sap_sync_run_resources,
--   sap_sync_record_results, sap_sync_checkpoints, sap_document_links,
--   vendor_registrations, purchase_requests, purchase_orders TO sap_integration;
-- GRANT USAGE, SELECT ON SEQUENCE sap_sync_record_results_id_seq TO sap_integration;
-- GRANT EXECUTE ON FUNCTION sap_purge_audit(integer) TO sap_integration;
