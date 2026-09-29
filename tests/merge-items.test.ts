import { describe, expect, it } from "vitest";
import { mergeItems } from "../src/repository.js";

describe("mergeItems", () => {
  it("menambah item dari window lain tanpa menghapus item yang sudah tersimpan", () => {
    const stored = [{ itemNumber: "00010", qty: 1 }, { itemNumber: "00020", qty: 2 }];
    const incoming = [{ itemNumber: "00040", qty: 4 }, { itemNumber: "00030", qty: 3 }];
    expect(mergeItems(stored, incoming).map((item) => item.itemNumber)).toEqual(["00010", "00020", "00030", "00040"]);
  });

  it("menimpa item dengan nomor yang sama", () => {
    const merged = mergeItems([{ itemNumber: "00010", qty: 1 }], [{ itemNumber: "00010", qty: 9 }]);
    expect(merged).toEqual([{ itemNumber: "00010", qty: 9 }]);
  });

  it("dokumen baru memakai item yang datang saja", () => {
    expect(mergeItems(null, [{ itemNumber: "00010", qty: 1 }])).toEqual([{ itemNumber: "00010", qty: 1 }]);
  });
});
