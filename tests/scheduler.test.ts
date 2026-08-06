import { describe, expect, it } from "vitest";
import { latestScheduleSlot, previousScheduleSlot } from "../src/scheduler.js";

describe("latestScheduleSlot Asia/Jakarta", () => {
  it("memilih slot sebelumnya sebelum pukul 08.00 WIB", () => {
    expect(latestScheduleSlot(new Date("2026-08-05T00:59:00Z"))).toBe("20260804-16");
  });

  it("memilih slot 08.00 di antara dua jadwal", () => {
    expect(latestScheduleSlot(new Date("2026-08-05T01:00:00Z"))).toBe("20260805-08");
  });

  it("memilih slot 16.00 setelah jadwal sore", () => {
    expect(latestScheduleSlot(new Date("2026-08-05T09:00:00Z"))).toBe("20260805-16");
  });

  it("menghitung slot pendahulu untuk monitoring missed run", () => {
    expect(previousScheduleSlot("20260805-16")).toBe("20260805-08");
    expect(previousScheduleSlot("20260805-08")).toBe("20260804-16");
  });
});
