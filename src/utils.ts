import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { DateWindow } from "./domain.js";

export function cleanString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result.length > 0 ? result : null;
}

export function digitsOnly(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const digits = cleaned.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function normalizeEmail(value: unknown): string | null {
  const cleaned = cleanString(value)?.toLowerCase() ?? null;
  if (!cleaned) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : null;
}

export function parseSapDate(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(cleaned);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function validateWindow(low: string, high: string): DateWindow {
  const lowDate = parseSapDate(low);
  const highDate = parseSapDate(high);
  if (!/^\d{8}$/.test(low) || !/^\d{8}$/.test(high) || !lowDate || !highDate) {
    throw new Error("Filter low/high wajib berupa tanggal valid YYYYMMDD");
  }
  if (low > high) throw new Error("Filter low tidak boleh melewati high");
  return { low, high };
}

function compactDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function utcDate(compact: string): Date {
  return new Date(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00Z`);
}

export function addCalendarDays(compact: string, days: number): string {
  const date = utcDate(compact);
  date.setUTCDate(date.getUTCDate() + days);
  return compactDate(date);
}

export function splitMonthlyWindows(low: string, high: string): DateWindow[] {
  validateWindow(low, high);
  const windows: DateWindow[] = [];
  let cursor = low;
  while (cursor <= high) {
    const start = utcDate(cursor);
    const endOfMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const windowHigh = compactDate(endOfMonth) < high ? compactDate(endOfMonth) : high;
    windows.push({ low: cursor, high: windowHigh });
    cursor = addCalendarDays(windowHigh, 1);
  }
  return windows;
}

export function jakartaToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

export function parseSapDecimal(value: unknown): Decimal {
  const raw = cleanString(value);
  if (!raw) throw new Error("angka kosong");
  const normalized = raw.replaceAll(" ", "");
  if (/^-?\d+$/.test(normalized)) return new Decimal(normalized);
  const fixedScale = /^(-?)(\d+(?:\.\d{3})*)\.(\d{4,})$/.exec(normalized);
  if (fixedScale) {
    const [, sign, integerPart, fractionPart] = fixedScale;
    return new Decimal(`${sign}${integerPart!.replaceAll(".", "")}.${fractionPart}`);
  }
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(normalized)) {
    return new Decimal(normalized.replaceAll(".", "").replace(",", "."));
  }
  if (/^-?\d+,\d+$/.test(normalized)) return new Decimal(normalized.replace(",", "."));
  throw new Error(`format angka ambigu/tidak valid: ${raw}`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
