import { describe, expect, it } from "vitest";
import { addCalendarDays, parseSapDate, parseSapDecimal, splitMonthlyWindows, validateWindow } from "../src/utils.js";

describe("date filter", () => {
  it("memvalidasi kalender dan batas inklusif", () => {
    expect(validateWindow("20260601", "20260630")).toEqual({ low: "20260601", high: "20260630" });
    expect(() => validateWindow("20260230", "20260301")).toThrow(/tanggal valid/);
    expect(() => validateWindow("20260806", "20260805")).toThrow(/melewati/);
  });

  it("memecah backfill per bulan", () => {
    expect(splitMonthlyWindows("20260601", "20260805")).toEqual([
      { low: "20260601", high: "20260630" },
      { low: "20260701", high: "20260731" },
      { low: "20260801", high: "20260805" },
    ]);
  });

  it("mendukung overlap dan leap day", () => {
    expect(addCalendarDays("20240228", 1)).toBe("20240229");
    expect(parseSapDate("2026-08-05")).toBe("2026-08-05");
  });
});

describe("angka SAP id-ID", () => {
  it.each([
    ["187.200.000", "187200000"],
    ["1.234,50", "1234.5"],
    ["  1 ", "1"],
    ["-2,5", "-2.5"],
    ["100.00000", "100"],
    ["153.90000", "153.9"],
    ["580.00000", "580"],
    ["5.000.00000", "5000"],
    ["1.430", "1430"],
  ])("mengubah %s menjadi %s", (raw, expected) => {
    expect(parseSapDecimal(raw).toFixed()).toBe(expected);
  });

  it("menolak format ambigu", () => {
    expect(() => parseSapDecimal("1.25")).toThrow(/ambigu/);
    expect(() => parseSapDecimal("1,234.56")).toThrow(/ambigu/);
  });
});
