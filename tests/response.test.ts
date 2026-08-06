import { describe, expect, it } from "vitest";
import { SapResponseError, unwrapSapResponse } from "../src/sap/response.js";

describe("unwrapSapResponse", () => {
  it.each([
    [[{ id: 1 }]],
    [{ value: [{ id: 1 }] }],
    [{ results: [{ id: 1 }] }],
    [{ d: { value: [{ id: 1 }] } }],
    [{ d: { results: [{ id: 1 }] } }],
  ])("menerima bentuk wrapper SAP", (payload) => {
    expect(unwrapSapResponse(payload)).toEqual([{ id: 1 }]);
  });

  it("menerima single record", () => {
    expect(unwrapSapResponse({ id: 1 })).toEqual([{ id: 1 }]);
  });

  it("menolak scalar", () => {
    expect(() => unwrapSapResponse("invalid")).toThrow(SapResponseError);
  });
});
