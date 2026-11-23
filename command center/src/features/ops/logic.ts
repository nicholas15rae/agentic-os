/** Pure helpers for the Operations UI (mirrors of the Rust validation, so the form explains a
 * refusal before the round-trip; Rust stays the authority). */
import type { Business, NewBusiness, ReviewGroup } from "./types";

/** Rust `validate_business_id` (the agent-id list included). */
const ROLE_IDS = ["general", "tony", "librarian", "coder", "booking", "ops", "bizops", "prompter", "designer", "director", "finance", "finance_librarian", "security", "observer"];
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function businessIdError(id: string): string | null {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(id) || id.endsWith("_") || id.includes("__")) return "2–32 of a-z, 0-9 and single inner underscores, starting with a letter";
  if (DEVICE.test(id)) return "that's a reserved Windows name";
  if (ROLE_IDS.includes(id)) return "that's an agent id";
  return null;
}

/** A suggested id from a display name: "Corner Bakery & Café" → "corner_bakery_cafe". */
export function suggestId(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  return base.length >= 2 ? base : "";
}

/** One term per line or comma; trimmed, de-duplicated (case-insensitive), 3+ characters. */
export function parseTerms(s: string): string[] {
  const out: string[] = [];
  for (const t of s.split(/[\n,]/).map((x) => x.trim())) {
    if (t.replace(/[^\p{L}\p{N}&]/gu, "").length >= 3 && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function newBusinessFrom(form: { displayName: string; businessId: string; category: string; description: string; aliases: string; blocklist: string }): NewBusiness {
  return {
    businessId: form.businessId.trim(),
    displayName: form.displayName.trim(),
    category: form.category.trim(),
    description: form.description.trim(),
    aliases: parseTerms(form.aliases),
    crossDomainBlocklist: parseTerms(form.blocklist),
  };
}

/** The active business to keep selected: the saved one if still active, else none. */
export function keepActive(saved: string | null, businesses: Business[]): string | null {
  return saved && businesses.some((b) => b.businessId === saved && b.status === "active") ? saved : null;
}

export const REASON_LABEL: Record<string, string> = {
  cross_domain: "Mentions another business",
  empty_file: "Empty note",
  temp_leftover: "Interrupted write",
  flagged: "Flagged for review",
};

export const reasonLabel = (code: string) => REASON_LABEL[code] ?? code.replace(/_/g, " ");

/** Every pending item id in one group (or all groups). */
export function idsOf(groups: ReviewGroup[], businessId?: string): string[] {
  return groups.filter((g) => !businessId || g.businessId === businessId).flatMap((g) => g.reasons.flatMap((r) => r.items.map((i) => i.itemId)));
}

/** "3 items · 2 businesses". */
export function digestLine(groups: ReviewGroup[]): string {
  const n = groups.reduce((s, g) => s + g.count, 0);
  if (!n) return "Nothing waiting for review";
  return `${n} item${n === 1 ? "" : "s"} · ${groups.length} business${groups.length === 1 ? "" : "es"}`;
}

export function provisionLabel(b: Business): string {
  if (b.status === "archived") return "Archived";
  if (b.status === "active") return "Active";
  if (b.provision.lastError) return "Needs attention";
  return !b.provision.memoryDir ? "Creating memory folder" : "Creating workspace";
}
