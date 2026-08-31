import { describe, expect, it } from "vitest";
import { normalizePoDocuments, normalizePrDocuments, normalizeVendors } from "../src/sap/normalize.js";

const prSample = {
  KEY: "131001005700010",
  BANFN: "1310010057",
  BNFPO: 10,
  BSART: "ZNA1",
  LOEKZ: "",
  ERDAT: "2026-06-03",
  ERNAM: "3007P001",
  EKORG: "HKA",
  WERKS: "3000",
  MATKL: "OVERH16",
  TXZ01: "Laptop Asus Vivobook N6506CU",
  MENGE: "1",
  MEINS: "UN",
  PREIS: "1",
  PEINH: "        1",
  PSTYP: "0",
  WAERS: "IDR",
  EBELN: "",
  EBELP: 0,
};

const poSample = {
  KEY: "435000612700010",
  EBELN: "4350006127",
  EBELP: 10,
  LOEKZ: "",
  AEDAT: "2026-07-26",
  AENAM: "3112LOG",
  LIFNR: "2020015489",
  NAME_VEND: "HIDAYAH KARYA INFRASTRUKTUR",
  BUKRS: "HK03",
  WERKS: "3919",
  TXZ01: "PEKERJAAN POTONG RUMPUT ROW & AKSES 36KM",
  MENGE: "1",
  MEINS: "AU",
  NETPR: "187.200.000",
  WAERS: "IDR",
  FRGKE: "G",
};

describe("normalisasi Vendor", () => {
  it("membersihkan NPWP/email dan menghapus exact duplicate", () => {
    const raw = { LIFNR: " 2020016433 ", NAME1: "DWIARTA", STCD1: "84.474.848.3-017.000", EMAIL: "ADMIN@DWIARTA.COM" };
    const records = normalizeVendors([raw, raw]);
    expect(records).toHaveLength(1);
    expect(records[0]?.value).toMatchObject({ vendorCode: "2020016433", npwp: "844748483017000", email: "admin@dwiarta.com" });
  });

  it("menandai natural key sama dengan isi berbeda", () => {
    const records = normalizeVendors([
      { LIFNR: "1", NAME1: "A" },
      { LIFNR: "1", NAME1: "B" },
    ]);
    expect(records[0]?.issues.map((issue) => issue.code)).toContain("DUPLICATE_KEY_CONFLICT");
  });
});

describe("normalisasi PR", () => {
  it("memetakan sample dokumentasi dan menghitung total", () => {
    const [record] = normalizePrDocuments([prSample]);
    expect(record?.issues).toEqual([]);
    expect(record?.value).toMatchObject({ prNumber: "1310010057", status: "SUBMITTED", currency: "IDR", total: "1" });
    expect(record?.value?.items[0]).toMatchObject({ itemNumber: "00010", lineTotal: "1", isDeleted: false, releaseIndicator: null });
  });

  it("menjadi APPROVED bila seluruh item aktif memiliki FRGKZ 2", () => {
    const [record] = normalizePrDocuments([{ ...prSample, FRGKZ: " 2 " }]);
    expect(record?.value?.status).toBe("APPROVED");
    expect(record?.value?.items[0]?.releaseIndicator).toBe("2");
  });

  it("menjadi CONVERTED bila seluruh item aktif punya PO", () => {
    const [record] = normalizePrDocuments([{ ...prSample, FRGKZ: "2", EBELN: "4350006127", EBELP: 10 }]);
    expect(record?.value?.status).toBe("CONVERTED");
  });

  it("tetap SUBMITTED bila release item aktif kosong, bukan 2, atau campuran", () => {
    expect(normalizePrDocuments([prSample])[0]?.value?.status).toBe("SUBMITTED");
    expect(normalizePrDocuments([{ ...prSample, FRGKZ: "X" }])[0]?.value?.status).toBe("SUBMITTED");
    const [mixed] = normalizePrDocuments([
      { ...prSample, FRGKZ: "2" },
      { ...prSample, KEY: "131001005700020", BNFPO: 20, FRGKZ: "X" },
    ]);
    expect(mixed?.value?.status).toBe("SUBMITTED");
  });

  it("mengabaikan item terhapus saat menentukan full release", () => {
    const [record] = normalizePrDocuments([
      { ...prSample, FRGKZ: "2" },
      { ...prSample, KEY: "131001005700020", BNFPO: 20, FRGKZ: "X", LOEKZ: "X" },
    ]);
    expect(record?.value?.status).toBe("APPROVED");
  });

  it("memasukkan release indicator ke checksum", () => {
    const [withoutRelease] = normalizePrDocuments([prSample]);
    const [withRelease] = normalizePrDocuments([{ ...prSample, FRGKZ: "X" }]);
    expect(withoutRelease?.value?.status).toBe(withRelease?.value?.status);
    expect(withoutRelease?.hash).not.toBe(withRelease?.hash);
  });

  it("menyimpan LOEKZ tetapi mengecualikannya dari total", () => {
    const [record] = normalizePrDocuments([{ ...prSample, LOEKZ: "X" }]);
    expect(record?.value?.total).toBe("0");
    expect(record?.value?.items[0]?.isDeleted).toBe(true);
    expect(record?.issues.map((issue) => issue.code)).toContain("ALL_ITEMS_DELETED");
  });

  it("menolak KEY yang tidak konsisten", () => {
    const [record] = normalizePrDocuments([{ ...prSample, KEY: "wrong" }]);
    expect(record?.issues.map((issue) => issue.code)).toContain("KEY_MISMATCH");
  });
});

describe("normalisasi PO", () => {
  it("memetakan sample dokumentasi dan angka Indonesia", () => {
    const [record] = normalizePoDocuments([poSample]);
    expect(record?.issues).toEqual([]);
    expect(record?.value).toMatchObject({ poNumber: "4350006127", vendorCode: "2020015489", total: "187200000", status: "ISSUED" });
    expect(record?.value?.items[0]?.releaseIndicator).toBe("G");
  });

  it("menjadi DRAFT bila release item aktif kosong atau campuran", () => {
    const [withoutRelease] = normalizePoDocuments([{ ...poSample, FRGKE: undefined }]);
    expect(withoutRelease?.value?.status).toBe("DRAFT");
    expect(withoutRelease?.value?.items[0]?.releaseIndicator).toBeNull();
    expect(withoutRelease?.hash).not.toBe(normalizePoDocuments([poSample])[0]?.hash);
    expect(normalizePoDocuments([{ ...poSample, FRGKE: "g" }])[0]?.value?.status).toBe("DRAFT");
    const [mixed] = normalizePoDocuments([
      poSample,
      { ...poSample, KEY: "435000612700020", EBELP: 20, FRGKE: "X" },
    ]);
    expect(mixed?.value?.status).toBe("DRAFT");
  });

  it("mengabaikan item PO terhapus saat menentukan full release", () => {
    const [record] = normalizePoDocuments([
      poSample,
      { ...poSample, KEY: "435000612700020", EBELP: 20, FRGKE: "X", LOEKZ: "X" },
    ]);
    expect(record?.value?.status).toBe("ISSUED");
    expect(normalizePoDocuments([{ ...poSample, LOEKZ: "X" }])[0]?.value?.status).toBe("DRAFT");
  });

  it("mengarantina company yang berbeda pada satu PO", () => {
    const records = normalizePoDocuments([
      poSample,
      { ...poSample, KEY: "435000612700020", EBELP: 20, BUKRS: "HK04" },
    ]);
    expect(records[0]?.issues.map((issue) => issue.code)).toContain("INCONSISTENT_COMPANY");
  });
});
