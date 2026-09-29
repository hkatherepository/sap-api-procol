import { describe, expect, it } from "vitest";
import { latestScheduleSlot, previousScheduleSlot } from "../src/scheduler.js";

const hours = ["11", "15"];

describe("latestScheduleSlot Asia/Jakarta", () => {
  it("memilih slot 15.00 kemarin sebelum pukul 11.00 WIB", () => {
    expect(latestScheduleSlot(hours, new Date("2026-08-05T03:59:00Z"))).toBe("20260804-15");
  });

  it("memilih slot 11.00 setelah jadwal siang", () => {
    expect(latestScheduleSlot(hours, new Date("2026-08-05T04:00:00Z"))).toBe("20260805-11");
  });

  it("memilih slot 15.00 setelah jadwal sore", () => {
    expect(latestScheduleSlot(hours, new Date("2026-08-05T08:00:00Z"))).toBe("20260805-15");
  });

  it("menghitung slot pendahulu untuk monitoring missed run", () => {
    expect(previousScheduleSlot("20260805-15", hours)).toBe("20260805-11");
    expect(previousScheduleSlot("20260805-11", hours)).toBe("20260804-15");
  });
});
