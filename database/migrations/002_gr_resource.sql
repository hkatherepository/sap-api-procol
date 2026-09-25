-- Menambahkan resource 'gr' (GR/SES) ke audit sync.
-- Idempotent: aman dijalankan pada database yang sudah menerima perubahan ini.

ALTER TABLE sap_sync_run_resources DROP CONSTRAINT IF EXISTS sap_sync_run_resources_resource_check;
ALTER TABLE sap_sync_run_resources
  ADD CONSTRAINT sap_sync_run_resources_resource_check CHECK (resource IN ('vendor', 'pr', 'po', 'gr'));

ALTER TABLE sap_sync_checkpoints DROP CONSTRAINT IF EXISTS sap_sync_checkpoints_resource_check;
ALTER TABLE sap_sync_checkpoints
  ADD CONSTRAINT sap_sync_checkpoints_resource_check CHECK (resource IN ('vendor', 'pr', 'po', 'gr'));
