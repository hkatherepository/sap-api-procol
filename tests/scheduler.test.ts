import { describe, expect, it } from "vitest";
import { latestScheduleSlot, previousScheduleSlot } from "../src/scheduler.js";

describe("latestScheduleSlot Asia/Jakarta", () => {
  it("memilih slot sebelumnya sebelum pukul 07.00 WIB", () => {
    expect(latestScheduleSlot(new Date("2026-08-04T23:59:00Z"))).toBe("20260804-19");
  });

  it("memilih slot 07.00 setelah jadwal pagi", () => {
    expect(latestScheduleSlot(new Date("2026-08-05T00:00:00Z"))).toBe("20260805-07");
  });

  it("memilih slot 12.00 di antara jadwal", () => {
    expect(latestScheduleSlot(new Date("2026-08-05T05:00:00Z"))).toBe("20260805-12");
  });

  it("memilih slot 19.00 setelah jadwal malam", () => {
    expect(latestScheduleSlot(new Date("2026-08-05T12:00:00Z"))).toBe("20260805-19");
  });

  it("menghitung slot pendahulu untuk monitoring missed run", () => {
    expect(previousScheduleSlot("20260805-19")).toBe("20260805-12");
    expect(previousScheduleSlot("20260805-12")).toBe("20260805-07");
    expect(previousScheduleSlot("20260805-07")).toBe("20260804-19");
  });
});
