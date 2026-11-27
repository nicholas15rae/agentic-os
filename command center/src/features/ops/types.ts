/**
 * Operations Manager / review-queue contract: mirrors of the Rust structs (camelCase via serde)
 * in business_registry.rs, finance_handoff.rs, quarantine.rs, review_queue.rs, ops_audit.rs and
 * integrity.rs. Keep in sync.
 */

export type BusinessStatus = "provisioning" | "active" | "archived";

export interface ProvisionState {
  memoryDir: boolean;
  workspace: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface Business {
  businessId: string;
  displayName: string;
  category: string;
  description: string;
  aliases: string[];
  /** Derived in Rust from the id; never sent by the UI. */
  workspaceSlug: string;
  ragNamespace: string;
  memoryPath: string;
  librarianScope: string;
  financeLedgerTag: string;
  crossDomainBlocklist: string[];
  status: BusinessStatus;
  provision: ProvisionState;
  createdAt: number;
  /** Mailboxes linked to this business (Rust `BusinessEmail`); absent / empty = the main account. */
  emails?: BusinessEmail[];
}

export interface BusinessEmail {
  label: string;
  address: string;
}

/** What "Add Business" sends (Rust `NewBusiness`, deny_unknown_fields). */
export interface NewBusiness {
  businessId: string;
  displayName: string;
  category: string;
  description: string;
  aliases: string[];
  crossDomainBlocklist: string[];
}

export type BusinessPatch = Partial<Pick<NewBusiness, "displayName" | "category" | "description" | "aliases" | "crossDomainBlocklist">> & { emails?: BusinessEmail[] };

export type TransactionType = "invoice" | "receipt" | "expense" | "quote" | "subcontractor_payout" | "ecom_order";

/** Ops → Finance (Rust `FinanceHandoff`). `amountCents` is positive; the type sets the sign. */
export interface FinanceHandoff {
  businessId: string;
  financeLedgerTag: string;
  transactionType: TransactionType;
  amountCents: number;
  currency: string;
  date: string;
  counterparty: string;
  category: string;
  attachmentRef: string | null;
  memo: string;
}

export type QKind = "note" | "blocked_write";
export type QStatus = "pending" | "purged" | "restored";
export type ReasonCode = "cross_domain" | "empty_file" | "temp_leftover" | "flagged";

export interface QItem {
  itemId: string;
  businessId: string;
  sourceAgent: string;
  reasonCode: ReasonCode | string;
  reason: string;
  timestamp: number;
  backupPath: string;
  sha256: string;
  bytes: number;
  kind: QKind;
  rel: string;
  status: QStatus;
  resolvedAt: number | null;
}

export interface ReviewGroup {
  businessId: string;
  displayName: string;
  count: number;
  reasons: { reasonCode: string; items: QItem[] }[];
}

export interface ReviewList {
  pending: number;
  groups: ReviewGroup[];
  recentlyResolved: QItem[];
  /** Set when the rules integrity check latched fail-closed. */
  integrity: string | null;
}

export interface BatchResult {
  results: { itemId: string; ok: boolean; status?: QStatus; error?: string }[];
}

export interface ReviewConfig {
  digestHour: number;
  threshold: number;
  webhookEnabled: boolean;
}

export interface ReviewSettings {
  config: ReviewConfig;
  webhookConfigured: boolean;
  webhookHost: string | null;
}

export interface AuditRow {
  seq: number;
  at: number;
  actor: string;
  action: string;
  businessId: string;
  itemId: string;
  detail: string;
}

export interface AuditView {
  rows: AuditRow[];
  chain: { ok: boolean; rows?: number; error?: string };
}

export interface IntegrityStatus {
  dir?: string;
  failClosed: string | null;
  files: { file: string; sha256: string }[];
}

export interface ReviewDigestEvent {
  trigger: "threshold" | "daily";
  pending: number;
  groups: ReviewGroup[];
}
