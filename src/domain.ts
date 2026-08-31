export const RESOURCES = ["vendor", "pr", "po"] as const;
export type Resource = (typeof RESOURCES)[number];
export type SyncMode = "dry_run" | "apply";
export type Trigger = "cli" | "scheduler" | "retry";
export type RunStatus = "pending" | "running" | "completed" | "partial" | "failed" | "skipped_locked";
export type RecordAction = "inserted" | "updated" | "unchanged" | "conflict" | "invalid" | "failed";

export interface DateWindow {
  low: string;
  high: string;
}

export interface Issue {
  code: string;
  message: string;
  field?: string;
}

export interface NormalizedRecord<T> {
  key: string;
  hash: string;
  value?: T;
  issues: Issue[];
}

export interface ResourceCounters {
  received: number;
  valid: number;
  invalid: number;
  inserted: number;
  updated: number;
  unchanged: number;
  conflict: number;
  failed: number;
}

export const emptyCounters = (): ResourceCounters => ({
  received: 0,
  valid: 0,
  invalid: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  conflict: 0,
  failed: 0,
});

export interface VendorRecord {
  vendorCode: string;
  circleNumber: string | null;
  companyName: string;
  npwp: string | null;
  address: string | null;
  city: string | null;
  sourceDate: string | null;
  phone: string | null;
  email: string | null;
}

export interface PrItem {
  sapKey: string;
  itemNumber: string;
  documentType: string | null;
  deleteIndicator: string;
  isDeleted: boolean;
  purchasingOrganization: string | null;
  plant: string | null;
  materialGroup: string | null;
  description: string | null;
  quantity: string;
  unit: string | null;
  price: string;
  priceUnit: string;
  itemCategory: string | null;
  releaseIndicator: string | null;
  currency: string | null;
  poNumber: string | null;
  poItemNumber: string | null;
  lineTotal: string | null;
}

export interface PrDocument {
  prNumber: string;
  sourceDate: string;
  sourceCreatedBy: string | null;
  currency: string | null;
  total: string | null;
  status: "SUBMITTED" | "APPROVED" | "CONVERTED";
  items: PrItem[];
  issues: Issue[];
}

export interface PoItem {
  sapKey: string;
  itemNumber: string;
  deleteIndicator: string;
  isDeleted: boolean;
  companyCode: string | null;
  plant: string | null;
  description: string | null;
  quantity: string;
  unit: string | null;
  netPrice: string;
  releaseIndicator: string | null;
  currency: string | null;
  lineTotal: string | null;
}

export interface PoDocument {
  poNumber: string;
  sourceDate: string;
  sourceCreatedBy: string | null;
  vendorCode: string;
  vendorNameSnapshot: string | null;
  currency: string | null;
  total: string | null;
  status: "DRAFT" | "ISSUED";
  items: PoItem[];
  issues: Issue[];
}
