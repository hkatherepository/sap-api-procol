import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/procol",
  SAP_VENDOR_API_URL: "https://sap.test/vendor",
  SAP_PR_API_URL: "https://sap.test/pr",
  SAP_PO_API_URL: "https://sap.test/po",
  SAP_GR_API_URL: "https://sap.test/po",
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

  it("memakai jadwal default 11.00, 15.00, dan sync malam 23.00", () => {
    const { sync } = loadConfig(base);
    expect(sync).toMatchObject({ schedules: ["0 11 * * *", "0 15 * * *"], slotHours: ["11", "15"], deepSchedule: "0 23 * * *" });
  });

  it("menurunkan jam slot terurut dari SYNC_SCHEDULES", () => {
    const { sync } = loadConfig({ ...base, SYNC_SCHEDULES: "0 15 * * *, 0 9 * * *", SYNC_DEEP_SCHEDULE: "30 22 * * *" });
    expect(sync).toMatchObject({ slotHours: ["09", "15"], deepSchedule: "30 22 * * *" });
  });

  it.each(["0 * * * *", "30 11 * * *", "0 25 * * *", "0 11 * * *,0 11 * * *", ""])("menolak SYNC_SCHEDULES %j", (value) => {
    expect(() => loadConfig({ ...base, SYNC_SCHEDULES: value })).toThrow(/SYNC_SCHEDULES/);
  });

  it("menolak SYNC_DEEP_SCHEDULE yang bukan cron", () => {
    expect(() => loadConfig({ ...base, SYNC_DEEP_SCHEDULE: "setiap malam" })).toThrow(/SYNC_DEEP_SCHEDULE/);
  });

  it("menolak GET dengan JSON body", () => {
    expect(() => loadConfig({ ...base, SAP_HTTP_METHOD: "GET", SAP_FILTER_TRANSPORT: "json_body" })).toThrow(/GET/);
  });
});
