import { describe, expect, it } from "vitest";
import { normalizePoDocuments, normalizePrDocuments, normalizeReceiptDocuments, normalizeVendors } from "../src/sap/normalize.js";

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

  it("memetakan KOSTL, MATNR, dan MAKTX", () => {
    const [record] = normalizePrDocuments([{ ...prSample, KOSTL: " 3301IN02 ", MATNR: "11000329", MAKTX: "Stang Konektor OHC" }]);
    expect(record?.value?.items[0]).toMatchObject({ costCenter: "3301IN02", materialNumber: "11000329", materialDescription: "Stang Konektor OHC" });
    expect(normalizePrDocuments([prSample])[0]?.value?.items[0]).toMatchObject({ costCenter: null, materialNumber: null, materialDescription: null });
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

const grSample = {
  MBLNR: "5300105965", MJAHR: 2026, BKTXT: "", BLDAT: "2026-05-20",
  BUDAT: "2026-06-02", TCODE2: "MIGO_GR", LINE_ID: 1, SGTXT: "",
  MATNR: "10030033", WERKS: "3103", DMBTR: 433433, WAERS: "IDR",
  ERFMG: 30310, ERFME: "KG", LFBJA: 2026, LFBNR: "5300105965",
  LFPOS: 1, EBELN: "4310011653", EBELP: 10,
  LIFNR: "2020003052", KUNNR: "", BANFN: "1310009377", BNFPO: 10,
};

const sesSample = {
  MBLNR: "5300105119", MJAHR: 2026, BKTXT: "Jasa Asuransi All Risk",
  BLDAT: "2026-05-13", BUDAT: "2026-06-02", TCODE2: "ML81N", LINE_ID: 1,
  SGTXT: "", MATNR: "", WERKS: "3909", DMBTR: 863024.97, WAERS: "IDR",
  ERFMG: 1, ERFME: "LS", LFBJA: 2026, LFBNR: "1000355698", LFPOS: 1,
  EBELN: "4350005854", EBELP: 10,
  LIFNR: "2020015724", KUNNR: "", BANFN: "1310009441", BNFPO: 10,
};

describe("normalizeReceiptDocuments", () => {
  it("hanya menerima MIGO_GR dan ML81N sebagai penerimaan", () => {
    const records = normalizeReceiptDocuments([
      grSample,
      sesSample,
      { ...grSample, MBLNR: "4900000001", TCODE2: "MIGO_GI" },
      { ...grSample, MBLNR: "4900000002", TCODE2: "VL02N" },
      { ...grSample, MBLNR: "4900000003", TCODE2: "MIGO_GO" },
      { ...grSample, MBLNR: "4900000004", TCODE2: "MIGO_TR" },
    ]);
    expect(records.filter((record) => record.value)).toHaveLength(2);
    expect(records.map((record) => record.value?.sapDocNumber)).toEqual(["5300105965", "5300105119"]);
  });

  it("mencatat UNKNOWN_RECEIPT_TCODE untuk t-code di luar daftar", () => {
    const records = normalizeReceiptDocuments([{ ...grSample, TCODE2: "MB1A" }]);
    expect(records[0]?.value).toBeUndefined();
    expect(records[0]?.issues.map((issue) => issue.code)).toContain("UNKNOWN_RECEIPT_TCODE");
  });

  it("memadankan nomor item PO/PR menjadi lima digit", () => {
    const [record] = normalizeReceiptDocuments([grSample]);
    expect(record?.value?.items[0]?.poItemNumber).toBe("00010");
    expect(record?.value?.items[0]?.poSapKey).toBe("431001165300010");
    expect(record?.value?.items[0]?.prItemNumber).toBe("00010");
  });

  it("mengelompokkan baris datar menjadi header dan item", () => {
    const [record] = normalizeReceiptDocuments([
      grSample,
      { ...grSample, LINE_ID: 2, ERFMG: 10, DMBTR: 100 },
    ]);
    expect(record?.value?.items).toHaveLength(2);
    expect(record?.value?.totalQty).toBe("30320");
    expect(record?.value?.totalValue).toBe("433533");
    expect(record?.value?.poNumber).toBe("4310011653");
  });

  it("mengosongkan po_number header bila satu dokumen menunjuk beberapa PO", () => {
    const [record] = normalizeReceiptDocuments([
      grSample,
      { ...grSample, LINE_ID: 2, EBELN: "4310011999", EBELP: 20 },
    ]);
    expect(record?.value?.poNumber).toBeNull();
    expect(record?.value?.items[1]?.poSapKey).toBe("431001199900020");
  });

  it("mendeteksi pembatalan lewat header text meski kuantitas positif", () => {
    const [record] = normalizeReceiptDocuments([{ ...grSample, MBLNR: "5300105994", BKTXT: "CANCEL" }]);
    expect(record?.value?.isReversal).toBe(true);
    expect(normalizeReceiptDocuments([grSample])[0]?.value?.isReversal).toBe(false);
    expect(normalizeReceiptDocuments([{ ...grSample, ERFMG: -5 }])[0]?.value?.isReversal).toBe(true);
  });

  it("tidak mengubah nilai desimal DMBTR", () => {
    const [record] = normalizeReceiptDocuments([sesSample]);
    expect(record?.value?.totalValue).toBe("863024.97");
    expect(record?.value?.items[0]?.amount).toBe("863024.97");
  });

  it("menolak angka berformat ribuan Indonesia pada DMBTR", () => {
    const [record] = normalizeReceiptDocuments([{ ...grSample, DMBTR: "5.760.000" }]);
    expect(record?.issues.map((issue) => issue.code)).toContain("INVALID_NUMBER");
  });

  it("memakai nomor SES sebagai receipt_number untuk dokumen jasa", () => {
    const [ses] = normalizeReceiptDocuments([sesSample]);
    expect(ses?.value?.receiptType).toBe("jasa");
    expect(ses?.value?.receiptNumber).toBe("1000355698");
    const [gr] = normalizeReceiptDocuments([grSample]);
    expect(gr?.value?.receiptType).toBe("barang");
    expect(gr?.value?.receiptNumber).toBe("5300105965");
  });

  it("mengarantina dokumen dengan vendor atau currency berbeda antar baris", () => {
    const [vendor] = normalizeReceiptDocuments([grSample, { ...grSample, LINE_ID: 2, LIFNR: "2020009999" }]);
    expect(vendor?.issues.map((issue) => issue.code)).toContain("INCONSISTENT_VENDOR");
    const [currency] = normalizeReceiptDocuments([grSample, { ...grSample, LINE_ID: 2, WAERS: "USD" }]);
    expect(currency?.issues.map((issue) => issue.code)).toContain("INCONSISTENT_CURRENCY");
  });
});
