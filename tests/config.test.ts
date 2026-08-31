import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/procol",
  SAP_VENDOR_API_URL: "https://sap.test/vendor",
  SAP_PR_API_URL: "https://sap.test/pr",
  SAP_PO_API_URL: "https://sap.test/po",
  SAP_API_USERNAME: "user",
  SAP_API_PASSWORD: "secret",
  SAP_FILTER_TRANSPORT: "query_parameter",
};

describe("loadConfig", () => {
  it("memakai pengecualian TLS sementara secara eksplisit sebagai default", () => {
    expect(loadConfig(base).sap.rejectUnauthorized).toBe(false);
  });

  it("dapat mengaktifkan kembali verifikasi certificate TLS", () => {
    expect(loadConfig({ ...base, SAP_TLS_REJECT_UNAUTHORIZED: "true" }).sap.rejectUnauthorized).toBe(true);
  });

  it("menonaktifkan scheduler secara default meskipun mode write dibuka", () => {
    const config = loadConfig({ ...base, DRY_RUN_ONLY: "false" });
    expect(config.sync.dryRunOnly).toBe(false);
    expect(config.sync.schedulerEnabled).toBe(false);
  });

  it("memerlukan flag scheduler eksplisit untuk aktivasi", () => {
    expect(loadConfig({ ...base, SYNC_SCHEDULER_ENABLED: "true" }).sync.schedulerEnabled).toBe(true);
  });

  it("menerima dua cron terpisah", () => {
    expect(loadConfig({ ...base, SYNC_SCHEDULES: "0 7 * * *,0 12 * * *,0 19 * * *" }).sync.schedules).toEqual(["0 7 * * *", "0 12 * * *", "0 19 * * *"]);
  });

  it("menerima cron gabungan", () => {
    expect(loadConfig({ ...base, SYNC_SCHEDULES: "0 7,12,19 * * *" }).sync.schedules).toEqual(["0 7,12,19 * * *"]);
  });

  it("menolak jadwal di luar 07.00, 12.00, dan 19.00", () => {
    expect(() => loadConfig({ ...base, SYNC_SCHEDULES: "0 * * * *" })).toThrow(/hanya boleh/);
  });

  it("menolak GET dengan JSON body", () => {
    expect(() => loadConfig({ ...base, SAP_HTTP_METHOD: "GET", SAP_FILTER_TRANSPORT: "json_body" })).toThrow(/GET/);
  });
});
