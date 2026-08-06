export class SapResponseError extends Error {}

export function unwrapSapResponse(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new SapResponseError("Respons SAP harus berupa object atau array");
  }
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.value)) return object.value;
  if (Array.isArray(object.results)) return object.results;
  if (object.d && typeof object.d === "object") {
    const d = object.d as Record<string, unknown>;
    if (Array.isArray(d.value)) return d.value;
    if (Array.isArray(d.results)) return d.results;
  }
  return [object];
}
