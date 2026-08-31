import { Decimal } from "decimal.js";
import type { Issue, NormalizedRecord, PoDocument, PoItem, PrDocument, PrItem, VendorRecord } from "../domain.js";
import { cleanString, digitsOnly, hashJson, normalizeEmail, parseSapDate, parseSapDecimal } from "../utils.js";

type Raw = Record<string, unknown>;

function asObject(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

function invalid<T>(key: string, issues: Issue[]): NormalizedRecord<T> {
  return { key, hash: hashJson({ key, issues }), issues };
}

function itemNumber(value: unknown): string | null {
  const string = cleanString(value);
  if (!string || !/^\d+$/.test(string)) return null;
  return String(Number(string)).padStart(5, "0");
}

function required(raw: Raw, field: string, issues: Issue[]): string | null {
  const value = cleanString(raw[field]);
  if (!value) issues.push({ code: "REQUIRED_FIELD", field, message: `${field} wajib diisi` });
  return value;
}

function dateField(raw: Raw, field: string, issues: Issue[]): string | null {
  const value = parseSapDate(raw[field]);
  if (!value) issues.push({ code: "INVALID_DATE", field, message: `${field} bukan tanggal SAP valid` });
  return value;
}

export function normalizeVendors(rows: unknown[]): NormalizedRecord<VendorRecord>[] {
  const seen = new Map<string, NormalizedRecord<VendorRecord>>();
  const output: NormalizedRecord<VendorRecord>[] = [];
  rows.forEach((row, index) => {
    const raw = asObject(row);
    if (!raw) {
      output.push(invalid(`row:${index}`, [{ code: "NON_OBJECT_RECORD", message: "Record vendor bukan object" }]));
      return;
    }
    const issues: Issue[] = [];
    const vendorCode = required(raw, "LIFNR", issues) ?? `row:${index}`;
    const companyName = required(raw, "NAME1", issues) ?? "";
    const sourceDateRaw = cleanString(raw.AEDAT);
    const sourceDate = sourceDateRaw ? parseSapDate(sourceDateRaw) : null;
    if (sourceDateRaw && !sourceDate) issues.push({ code: "INVALID_DATE", field: "AEDAT", message: "AEDAT bukan tanggal valid" });
    const emailRaw = cleanString(raw.EMAIL);
    const email = normalizeEmail(emailRaw);
    if (emailRaw && !email) issues.push({ code: "INVALID_EMAIL", field: "EMAIL", message: "EMAIL tidak valid" });
    const value: VendorRecord = {
      vendorCode,
      circleNumber: cleanString(raw.BPEXT),
      companyName,
      npwp: digitsOnly(raw.STCD1),
      address: cleanString(raw.STRAS),
      city: cleanString(raw.ORT01),
      sourceDate,
      phone: cleanString(raw.TELP),
      email,
    };
    const record: NormalizedRecord<VendorRecord> = { key: vendorCode, hash: hashJson(value), value, issues };
    const previous = seen.get(vendorCode);
    if (!previous) {
      seen.set(vendorCode, record);
      output.push(record);
    } else if (previous.hash !== record.hash) {
      previous.issues.push({ code: "DUPLICATE_KEY_CONFLICT", message: `LIFNR ${vendorCode} memiliki isi berbeda` });
    }
  });
  return output;
}

function normalizePrItem(raw: Raw, index: number): NormalizedRecord<{ prNumber: string; sourceDate: string; sourceCreatedBy: string | null; item: PrItem }> {
  const issues: Issue[] = [];
  const prNumber = required(raw, "BANFN", issues) ?? `row:${index}`;
  const number = itemNumber(raw.BNFPO);
  if (!number) issues.push({ code: "INVALID_ITEM_NUMBER", field: "BNFPO", message: "BNFPO wajib berupa angka" });
  const sourceDate = dateField(raw, "ERDAT", issues) ?? "";
  const sapKey = required(raw, "KEY", issues) ?? "";
  if (number && sapKey && sapKey !== `${prNumber}${number}`) {
    issues.push({ code: "KEY_MISMATCH", field: "KEY", message: "KEY tidak sama dengan BANFN + BNFPO(5 digit)" });
  }
  let quantity = new Decimal(0);
  let price = new Decimal(0);
  let priceUnit = new Decimal(0);
  for (const [field, assign] of [
    ["MENGE", (value: Decimal) => (quantity = value)],
    ["PREIS", (value: Decimal) => (price = value)],
    ["PEINH", (value: Decimal) => (priceUnit = value)],
  ] as const) {
    try {
      assign(parseSapDecimal(raw[field]));
    } catch (error) {
      issues.push({ code: "INVALID_NUMBER", field, message: error instanceof Error ? error.message : "angka tidak valid" });
    }
  }
  if (priceUnit.lte(0)) issues.push({ code: "INVALID_PRICE_UNIT", field: "PEINH", message: "PEINH harus lebih dari nol" });
  const deleteIndicator = cleanString(raw.LOEKZ) ?? "";
  const poNumber = cleanString(raw.EBELN);
  const poItem = poNumber ? itemNumber(raw.EBELP) : null;
  if (poNumber && !poItem) issues.push({ code: "INVALID_PO_ITEM", field: "EBELP", message: "EBELP tidak valid saat EBELN terisi" });
  const item: PrItem = {
    sapKey,
    itemNumber: number ?? "",
    documentType: cleanString(raw.BSART),
    deleteIndicator,
    isDeleted: deleteIndicator.length > 0,
    purchasingOrganization: cleanString(raw.EKORG),
    plant: cleanString(raw.WERKS),
    materialGroup: cleanString(raw.MATKL),
    description: cleanString(raw.TXZ01),
    quantity: quantity.toFixed(),
    unit: cleanString(raw.MEINS),
    price: price.toFixed(),
    priceUnit: priceUnit.toFixed(),
    itemCategory: cleanString(raw.PSTYP),
    releaseIndicator: cleanString(raw.FRGKZ),
    currency: cleanString(raw.WAERS),
    poNumber,
    poItemNumber: poItem,
    lineTotal: !deleteIndicator && priceUnit.gt(0) ? quantity.mul(price).div(priceUnit).toFixed() : null,
  };
  const value = { prNumber, sourceDate, sourceCreatedBy: cleanString(raw.ERNAM), item };
  return issues.length > 0 ? { ...invalid(`${prNumber}:${number ?? index}`, issues), value } : { key: `${prNumber}:${number}`, hash: hashJson(value), value, issues };
}

export function normalizePrDocuments(rows: unknown[]): NormalizedRecord<PrDocument>[] {
  const items = rows.map((row, index) => {
    const raw = asObject(row);
    return raw ? normalizePrItem(raw, index) : invalid<{ prNumber: string; sourceDate: string; sourceCreatedBy: string | null; item: PrItem }>(`row:${index}`, [{ code: "NON_OBJECT_RECORD", message: "Record PR bukan object" }]);
  });
  return groupPr(items);
}

function groupPr(items: NormalizedRecord<{ prNumber: string; sourceDate: string; sourceCreatedBy: string | null; item: PrItem }>[]): NormalizedRecord<PrDocument>[] {
  const groups = new Map<string, typeof items>();
  const invalidRows: NormalizedRecord<PrDocument>[] = [];
  for (const record of items) {
    if (!record.value) {
      invalidRows.push(invalid(record.key, record.issues));
      continue;
    }
    const list = groups.get(record.value.prNumber) ?? [];
    list.push(record);
    groups.set(record.value.prNumber, list);
  }
  const documents: NormalizedRecord<PrDocument>[] = [];
  for (const [prNumber, group] of groups) {
    const issues = group.flatMap((record) => record.issues);
    const uniqueItems = new Map<string, (typeof group)[number]>();
    for (const record of group) {
      const previous = uniqueItems.get(record.value!.item.itemNumber);
      if (!previous) uniqueItems.set(record.value!.item.itemNumber, record);
      else if (previous.hash !== record.hash) issues.push({ code: "DUPLICATE_KEY_CONFLICT", message: `Item PR ${record.key} berbeda` });
    }
    const sorted = [...uniqueItems.values()].map((record) => record.value!.item).sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
    const currencies = new Set(sorted.map((item) => item.currency).filter(Boolean));
    if (currencies.size > 1) issues.push({ code: "MULTI_CURRENCY", message: `PR ${prNumber} memiliki lebih dari satu currency` });
    const active = sorted.filter((item) => !item.isDeleted);
    if (active.length === 0) issues.push({ code: "ALL_ITEMS_DELETED", message: `Seluruh item PR ${prNumber} bertanda hapus` });
    const first = group[0]!.value!;
    const document: PrDocument = {
      prNumber,
      sourceDate: first.sourceDate,
      sourceCreatedBy: first.sourceCreatedBy,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      total: currencies.size <= 1 ? active.reduce((sum, item) => sum.add(item.lineTotal ?? 0), new Decimal(0)).toFixed() : null,
      status: active.length > 0 && active.every((item) => item.poNumber)
        ? "CONVERTED"
        : active.length > 0 && active.every((item) => item.releaseIndicator === "2")
          ? "APPROVED"
          : "SUBMITTED",
      items: sorted,
      issues,
    };
    documents.push({ key: prNumber, hash: hashJson({ ...document, issues: undefined }), value: document, issues });
  }
  return [...documents, ...invalidRows];
}

function normalizePoItem(raw: Raw, index: number): NormalizedRecord<{ poNumber: string; sourceDate: string; sourceCreatedBy: string | null; vendorCode: string; vendorName: string | null; item: PoItem }> {
  const issues: Issue[] = [];
  const poNumber = required(raw, "EBELN", issues) ?? `row:${index}`;
  const number = itemNumber(raw.EBELP);
  if (!number) issues.push({ code: "INVALID_ITEM_NUMBER", field: "EBELP", message: "EBELP wajib berupa angka" });
  const sourceDate = dateField(raw, "AEDAT", issues) ?? "";
  const vendorCode = required(raw, "LIFNR", issues) ?? "";
  const sapKey = required(raw, "KEY", issues) ?? "";
  if (number && sapKey && sapKey !== `${poNumber}${number}`) issues.push({ code: "KEY_MISMATCH", field: "KEY", message: "KEY tidak sama dengan EBELN + EBELP(5 digit)" });
  let quantity = new Decimal(0);
  let netPrice = new Decimal(0);
  for (const [field, assign] of [
    ["MENGE", (value: Decimal) => (quantity = value)],
    ["NETPR", (value: Decimal) => (netPrice = value)],
  ] as const) {
    try {
      assign(parseSapDecimal(raw[field]));
    } catch (error) {
      issues.push({ code: "INVALID_NUMBER", field, message: error instanceof Error ? error.message : "angka tidak valid" });
    }
  }
  const deleteIndicator = cleanString(raw.LOEKZ) ?? "";
  const item: PoItem = {
    sapKey,
    itemNumber: number ?? "",
    deleteIndicator,
    isDeleted: deleteIndicator.length > 0,
    companyCode: cleanString(raw.BUKRS),
    plant: cleanString(raw.WERKS),
    description: cleanString(raw.TXZ01),
    quantity: quantity.toFixed(),
    unit: cleanString(raw.MEINS),
    netPrice: netPrice.toFixed(),
    releaseIndicator: cleanString(raw.FRGKE),
    currency: cleanString(raw.WAERS),
    lineTotal: deleteIndicator ? null : quantity.mul(netPrice).toFixed(),
  };
  const value = { poNumber, sourceDate, sourceCreatedBy: cleanString(raw.AENAM), vendorCode, vendorName: cleanString(raw.NAME_VEND), item };
  return issues.length > 0 ? { ...invalid(`${poNumber}:${number ?? index}`, issues), value } : { key: `${poNumber}:${number}`, hash: hashJson(value), value, issues };
}

export function normalizePoDocuments(rows: unknown[]): NormalizedRecord<PoDocument>[] {
  const items = rows.map((row, index) => {
    const raw = asObject(row);
    return raw ? normalizePoItem(raw, index) : invalid<{ poNumber: string; sourceDate: string; sourceCreatedBy: string | null; vendorCode: string; vendorName: string | null; item: PoItem }>(`row:${index}`, [{ code: "NON_OBJECT_RECORD", message: "Record PO bukan object" }]);
  });
  const groups = new Map<string, typeof items>();
  const invalidRows: NormalizedRecord<PoDocument>[] = [];
  for (const record of items) {
    if (!record.value) {
      invalidRows.push(invalid(record.key, record.issues));
      continue;
    }
    const list = groups.get(record.value.poNumber) ?? [];
    list.push(record);
    groups.set(record.value.poNumber, list);
  }
  const documents: NormalizedRecord<PoDocument>[] = [];
  for (const [poNumber, group] of groups) {
    const issues = group.flatMap((record) => record.issues);
    const uniqueItems = new Map<string, (typeof group)[number]>();
    for (const record of group) {
      const previous = uniqueItems.get(record.value!.item.itemNumber);
      if (!previous) uniqueItems.set(record.value!.item.itemNumber, record);
      else if (previous.hash !== record.hash) issues.push({ code: "DUPLICATE_KEY_CONFLICT", message: `Item PO ${record.key} berbeda` });
    }
    const sorted = [...uniqueItems.values()].map((record) => record.value!.item).sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
    const currencies = new Set(sorted.map((item) => item.currency).filter(Boolean));
    const companies = new Set(sorted.map((item) => item.companyCode).filter(Boolean));
    const vendorCodes = new Set(group.map((record) => record.value!.vendorCode));
    if (currencies.size > 1) issues.push({ code: "INCONSISTENT_CURRENCY", message: `PO ${poNumber} memiliki currency berbeda` });
    if (companies.size > 1) issues.push({ code: "INCONSISTENT_COMPANY", message: `PO ${poNumber} memiliki company berbeda` });
    if (vendorCodes.size > 1) issues.push({ code: "INCONSISTENT_VENDOR", message: `PO ${poNumber} memiliki vendor berbeda` });
    const first = group[0]!.value!;
    const active = sorted.filter((item) => !item.isDeleted);
    const document: PoDocument = {
      poNumber,
      sourceDate: first.sourceDate,
      sourceCreatedBy: first.sourceCreatedBy,
      vendorCode: first.vendorCode,
      vendorNameSnapshot: first.vendorName,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      total: currencies.size <= 1 ? active.reduce((sum, item) => sum.add(item.lineTotal ?? 0), new Decimal(0)).toFixed() : null,
      status: active.length > 0 && active.every((item) => item.releaseIndicator === "G") ? "ISSUED" : "DRAFT",
      items: sorted,
      issues,
    };
    documents.push({ key: poNumber, hash: hashJson({ ...document, issues: undefined }), value: document, issues });
  }
  return [...documents, ...invalidRows];
}
