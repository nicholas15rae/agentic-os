import type { OsConfig, OsConfigPatch } from "@/lib/platform";

/**
 * Settings → Comms: which Gmail inbox Tony reads (os.json `gmail.inboxScope`, Rust
 * `gmail::scoped_query`). Primary only is the default: Promotions, Social, Updates and Forums stay
 * out unless Nic names one ("check my promotions"). Pure, so Vitest covers it without React.
 */
export type GmailInboxScope = "primary" | "all";

export const GMAIL_SCOPES: { id: GmailInboxScope; label: string; hint: string }[] = [
  { id: "primary", label: "Primary only (default)", hint: "Tony reads and searches category:primary in:inbox. Promotions, Social, Updates and Forums only when you name one." },
  { id: "all", label: "All inboxes", hint: "Every tab. A search also sees archived mail." },
];

/** The scope in effect. A missing or unknown value is Primary, the same as Rust. */
export function gmailInboxScope(cfg: { gmail?: Partial<OsConfig["gmail"]> } | null | undefined): GmailInboxScope {
  return cfg?.gmail?.inboxScope?.trim().toLowerCase() === "all" ? "all" : "primary";
}

/** The os.json patch that saves `scope` (keeps the booking instruction path as it is). */
export function gmailScopePatch(scope: GmailInboxScope): OsConfigPatch {
  return { gmail: { inboxScope: scope } };
}
