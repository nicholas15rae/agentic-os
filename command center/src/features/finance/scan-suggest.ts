/**
 * After a scan: SUGGEST where it goes (area, category, agent) from simple name rules — the payer /
 * vendor against your Acting agencies, your business profiles' names and a short keyword list.
 * It only ever pre-fills the review form; you confirm with one tap. The scanned text is data:
 * it is matched against fixed words here, never followed. Pure.
 */
import type { Agency, ProfilesDoc } from "@/features/business/profiles";

export type ScanKind = "receipt" | "invoice" | "check" | "etransfer" | "paystub";

export const SCAN_KINDS: { id: ScanKind; label: string }[] = [
  { id: "receipt", label: "Receipt" },
  { id: "invoice", label: "Bill / invoice" },
  { id: "check", label: "Cheque" },
  { id: "etransfer", label: "e-Transfer" },
  { id: "paystub", label: "Pay stub" },
];

/** Where a confirmed scan is saved: money in → income (or the cheque vault), money out → receipts. */
export const scanTarget = (k: ScanKind): "receipts" | "checks" | "income" => (k === "check" ? "checks" : k === "etransfer" || k === "paystub" ? "income" : "receipts");

export interface ScanSuggestion {
  area: string | null;
  category: string | null;
  agentId: string | null;
  union: boolean | null;
  /** Why, in plain words ("payer matches ML Talent"). */
  reasons: string[];
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const has = (hay: string, words: readonly string[]) => words.find((w) => hay.includes(` ${w} `));

const ACTING_WORDS = ["actra", "sag aftra", "casting", "productions", "production", "pictures", "films", "film", "studios", "entertainment", "talent", "residuals", "background"];
const CONTRACTING_WORDS = ["home depot", "rona", "lowes", "lowe s", "home hardware", "masonry", "brick", "bricks", "stone", "mortar", "concrete", "ready mix", "lumber", "sunbelt", "united rentals", "tool rental", "rentals", "scaffold", "scaffolding", "contracting"];
const SUPPLEMENT_WORDS = ["supplement", "supplements", "nutrition", "shopify", "stripe", "amazon seller", "canada post", "purolator", "ups", "fedex", "bf supplements"];
const CATEGORY_WORDS: [string, string[]][] = [
  ["fuel", ["petro canada", "esso", "shell", "pioneer", "ultramar", "husky", "costco gas", "gas bar", "fuel"]],
  ["materials", ["home depot", "rona", "lowes", "home hardware", "brick", "stone", "mortar", "concrete", "lumber", "masonry"]],
  ["tools", ["tool", "tools", "sunbelt", "united rentals", "tool rental", "scaffold"]],
  ["meals", ["restaurant", "cafe", "coffee", "tim hortons", "starbucks", "mcdonald s", "subway", "pizza", "grill", "bar"]],
  ["software", ["adobe", "google", "microsoft", "apple com", "openai", "shopify"]],
  ["shipping", ["canada post", "purolator", "ups", "fedex", "dhl"]],
  ["phone", ["rogers", "bell", "telus", "fido", "koodo", "freedom mobile", "virgin"]],
  ["training", ["workshop", "acting class", "course", "school"]],
  ["wardrobe", ["winners", "h m", "zara", "uniqlo", "costume"]],
];

export function suggestFromScan(
  kind: ScanKind,
  f: { vendor?: string | null; payer?: string | null; memo?: string | null; category?: string | null },
  ctx: { agencies?: readonly Agency[]; profiles?: ProfilesDoc | null } = {},
): ScanSuggestion {
  const who = norm([f.payer, f.vendor].filter(Boolean).join(" "));
  const all = norm([f.payer, f.vendor, f.memo].filter(Boolean).join(" "));
  const s: ScanSuggestion = { area: null, category: null, agentId: null, union: null, reasons: [] };
  const moneyIn = scanTarget(kind) !== "receipts";

  // 1. An Acting agency by name (most specific first: a sub-agent beats its principal).
  const agencies = [...(ctx.agencies ?? [])].sort((a, b) => Number(!!b.parentId) - Number(!!a.parentId));
  for (const a of agencies) {
    const n = norm(a.name.replace(/\b(inc|ltd|corp|agency|management)\.?\b/gi, ""));
    if (n.trim().length >= 3 && all.includes(n)) {
      s.area = "acting";
      s.agentId = a.id;
      s.reasons.push(`${moneyIn ? "Payer" : "Name"} matches your agency ${a.name}`);
      break;
    }
  }
  if (/\b(actra|sag aftra|union)\b/.test(all)) {
    s.union = true;
    s.reasons.push("Mentions ACTRA / union");
  }

  // 2. One of your business names (an e-transfer TO "BF Supplements" is that business's money).
  if (!s.area) {
    for (const [id, p] of Object.entries(ctx.profiles?.profiles ?? {})) {
      const names = [p.name, p.label].filter((x): x is string => !!x && x.trim().length >= 3).map(norm);
      if (names.some((n) => all.includes(n))) {
        s.area = id;
        s.reasons.push(`Mentions your business name ${p.label || p.name}`);
        break;
      }
    }
  }

  // 3. Keywords.
  if (!s.area) {
    const a = has(who, ACTING_WORDS) ?? (kind === "paystub" ? has(all, ACTING_WORDS) : undefined);
    const c = has(who, CONTRACTING_WORDS);
    const b = has(who, SUPPLEMENT_WORDS);
    const hit: [string, string, string] | null = a ? ["acting", a, "Acting"] : c ? ["trades_contracting", c, "Contracting"] : b ? ["supplements_ecom", b, "BF Supplements"] : null;
    if (hit) {
      s.area = hit[0];
      s.reasons.push(`"${hit[1]}" sounds like ${hit[2]}`);
    }
  }

  if (!moneyIn) {
    for (const [cat, words] of CATEGORY_WORDS) {
      const w = has(who, words);
      if (w) {
        s.category = cat;
        s.reasons.push(`"${w}" → ${cat}`);
        break;
      }
    }
    if (!s.category && f.category) s.category = f.category;
  }
  return s;
}
