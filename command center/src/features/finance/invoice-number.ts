/**
 * Invoice numbers that never collide: PREFIX-YEAR-NNN, one sequence per area and year, always the
 * highest number used so far + 1 (deleting an invoice never frees its number for reuse). Pure.
 */

export const AREA_PREFIX: Record<string, string> = {
  acting: "ACT",
  trades_contracting: "CON",
  supplements_ecom: "BFS",
  personal: "PER",
};

/** The prefix for an area: the profile's own, else the built-in one, else from the area id. */
export function prefixFor(area: string | undefined, custom?: string): string {
  const own = (custom ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (own) return own;
  if (area && AREA_PREFIX[area]) return AREA_PREFIX[area];
  const fromId = (area ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return fromId || "INV";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The next number for `prefix` in `year`, given every invoice number in use (deleted ones included if you have them). */
export function nextInvoiceNumber(existing: readonly string[], prefix: string, year: number): string {
  const re = new RegExp(`^${esc(prefix)}-${year}-(\\d+)$`, "i");
  let max = 0;
  for (const n of existing) {
    const m = re.exec((n ?? "").trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${year}-${String(max + 1).padStart(3, "0")}`;
}

/** Another invoice (not `selfId`) already uses this number. */
export const numberTaken = (rows: readonly { id?: string; number: string }[], number: string, selfId?: string): boolean =>
  rows.some((r) => r.id !== selfId && r.number.trim().toLowerCase() === number.trim().toLowerCase());
