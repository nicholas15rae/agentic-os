/**
 * The phone book (Communications → Phone book): one entry per person or company, with any number
 * of phones and emails, grouped by area (Acting, Contracting, BF Supplements, Personal, your own
 * areas) or a group you name. Stored on the local gateway (os_api.py, table comms_phonebook);
 * every number an entry has is linked to the phone bridge's per-number row, so texts and calls
 * show the entry's name and the Instant Send flag keeps working.
 *
 * Other records link to an entry by id only (`contactId` on a pending payment, an invoice, an
 * audition; `agencyId` on the entry for an acting agency). Deleting an entry never deletes them.
 * Contact text is data: it is shown and searched, never read as instructions. Pure (no I/O).
 */
import { PROFILE_IDS, PROFILE_LABEL, type KnownProfileId } from "@/features/business/profiles";

export interface PhoneEntry {
  label: string;
  number: string;
}
export interface EmailEntry {
  label: string;
  address: string;
}

export interface Contact {
  id: string;
  name: string;
  company: string;
  role: string;
  phones: PhoneEntry[];
  emails: EmailEntry[];
  notes: string;
  /** An area id (acting, trades_contracting, supplements_ecom, personal, or one you added) or a group name you typed. "" = no group. */
  group: string;
  /** The acting agency (business profile Acting → Agencies) this contact is for, if any. */
  agencyId: string | null;
  source: string;
  created?: number;
  updated?: number;
  /** One of its numbers is on Instant Send. */
  trusted?: boolean;
}

/** What gets saved: an entry without the gateway's bookkeeping. No id = a new entry. */
export type ContactDraft = Omit<Contact, "id" | "created" | "updated" | "trusted" | "source"> & { id?: string; source?: string };

/** A number the phone bridge knows (from a text or call) that isn't filed in the phone book. */
export interface UnfiledNumber {
  address: string;
  name: string | null;
  trusted: boolean;
}

export const NO_GROUP = "";

export const ROLE_OPTIONS = [
  "Agent",
  "Casting director",
  "Casting associate",
  "Producer",
  "Director",
  "Client",
  "Customer",
  "Supplier",
  "Subcontractor",
  "Accountant",
  "Family",
  "Friend",
] as const;

export const PHONE_LABELS = ["mobile", "work", "home", "other"] as const;
export const EMAIL_LABELS = ["work", "personal", "other"] as const;

// ── Keys (the gateway uses the same rules: os_api.pb_phone_key / pb_email_key) ──

/** A phone number's dedupe / lookup key: its last 10 digits ("" for fewer than 7 digits). */
export function phoneKey(n: string | null | undefined): string {
  const d = (n ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : "";
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function emailKey(e: string | null | undefined): string {
  const s = (e ?? "").trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : "";
}
export const validEmail = (e: string) => !!emailKey(e);
export const validPhone = (n: string) => !!phoneKey(n);

export const telHref = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;
export const smsHref = (n: string) => `sms:${n.replace(/[^\d+]/g, "")}`;
export const mailtoHref = (e: string, subject?: string) => `mailto:${encodeURIComponent(e.trim())}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;

export function emptyDraft(group: string = NO_GROUP): ContactDraft {
  return { name: "", company: "", role: "", phones: [{ label: "mobile", number: "" }], emails: [], notes: "", group, agencyId: null };
}

export function toDraft(c: Contact): ContactDraft {
  return { id: c.id, name: c.name, company: c.company, role: c.role, phones: c.phones.map((p) => ({ ...p })), emails: c.emails.map((e) => ({ ...e })), notes: c.notes, group: c.group, agencyId: c.agencyId, source: c.source };
}

/** The draft as the gateway takes it: blanks dropped, text trimmed. */
export function cleanDraft(d: ContactDraft): ContactDraft {
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    company: d.company.trim(),
    role: d.role.trim(),
    phones: d.phones.map((p) => ({ label: p.label.trim(), number: p.number.trim() })).filter((p) => p.number),
    emails: d.emails.map((e) => ({ label: e.label.trim(), address: e.address.trim() })).filter((e) => e.address),
    notes: d.notes.trim(),
    group: d.group.trim(),
    agencyId: d.agencyId || null,
    ...(d.source ? { source: d.source } : {}),
  };
}

/** Why a draft can't be saved yet, or null. */
export function draftProblem(d: ContactDraft): string | null {
  const c = cleanDraft(d);
  if (!c.name && !c.company && !c.phones.length && !c.emails.length) return "Give it a name, company, phone or email.";
  const badPhone = c.phones.find((p) => !validPhone(p.number));
  if (badPhone) return `“${badPhone.number}” doesn't look like a phone number.`;
  const badEmail = c.emails.find((e) => !validEmail(e.address));
  if (badEmail) return `“${badEmail.address}” doesn't look like an email.`;
  return null;
}

/** "Sam Carter · Northside Casting" (or just one of them). */
export function contactLabel(c: Pick<Contact, "name" | "company"> | null | undefined): string {
  if (!c) return "";
  return c.company && c.company !== c.name ? `${c.name} · ${c.company}` : c.name;
}

/** The phone-book entry a number / email / name belongs to (number, then email, then exact name). */
export function findContact(contacts: readonly Contact[], q: { phone?: string | null; email?: string | null; name?: string | null }): Contact | null {
  const pk = phoneKey(q.phone);
  if (pk) {
    const hit = contacts.find((c) => c.phones.some((p) => phoneKey(p.number) === pk));
    if (hit) return hit;
  }
  const ek = emailKey(q.email);
  if (ek) {
    const hit = contacts.find((c) => c.emails.some((e) => emailKey(e.address) === ek));
    if (hit) return hit;
  }
  const n = (q.name ?? "").trim().toLowerCase();
  if (n && !pk && !ek) return contacts.find((c) => c.name.trim().toLowerCase() === n) ?? null;
  return null;
}

export function matchesQuery(c: Contact, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const digits = s.replace(/\D/g, "");
  const hay = [c.name, c.company, c.role, c.notes, ...c.emails.map((e) => e.address)].join(" ").toLowerCase();
  if (hay.includes(s)) return true;
  return digits.length >= 3 && c.phones.some((p) => p.number.replace(/\D/g, "").includes(digits));
}

// ── Groups ───────────────────────────────────────────────────────────────────

export interface GroupInfo {
  id: string;
  label: string;
}

export interface ContactGroup extends GroupInfo {
  contacts: Contact[];
}

/** A group's label: an area's label (built-in or yours), else the name you typed. */
export function groupLabel(group: string, areaLabels: Readonly<Record<string, string>> = {}): string {
  if (!group) return "No group";
  return areaLabels[group] ?? PROFILE_LABEL[group as KnownProfileId] ?? group;
}

/**
 * Every group to offer in a picker: the built-in areas, your areas, then the custom group names
 * already in use (alphabetical). `areas` = listAreas(profilesDoc) (or just the built-ins).
 */
export function groupOptions(contacts: readonly Contact[], areas: readonly GroupInfo[] = PROFILE_IDS.map((id) => ({ id, label: PROFILE_LABEL[id] }))): GroupInfo[] {
  const ids = new Set(areas.map((a) => a.id));
  const custom = [...new Set(contacts.map((c) => c.group).filter((g) => g && !ids.has(g)))].sort((a, b) => a.localeCompare(b));
  return [...areas, ...custom.map((g) => ({ id: g, label: g }))];
}

/** Contacts grouped for the phone book: areas first (in their order), then custom groups, then "No group". Empty groups are left out. */
export function groupContacts(contacts: readonly Contact[], areas?: readonly GroupInfo[]): ContactGroup[] {
  const opts = groupOptions(contacts, areas);
  const labels = Object.fromEntries(opts.map((o) => [o.id, o.label]));
  const by = new Map<string, Contact[]>();
  for (const c of contacts) {
    const g = c.group && labels[c.group] !== undefined ? c.group : NO_GROUP;
    by.set(g, [...(by.get(g) ?? []), c]);
  }
  const sort = (l: Contact[]) => [...l].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const out: ContactGroup[] = opts.filter((o) => by.has(o.id)).map((o) => ({ ...o, contacts: sort(by.get(o.id)!) }));
  if (by.has(NO_GROUP)) out.push({ id: NO_GROUP, label: groupLabel(NO_GROUP), contacts: sort(by.get(NO_GROUP)!) });
  return out;
}

/** The contacts linked to an acting agency. */
export const agencyContacts = (contacts: readonly Contact[], agencyId: string) => contacts.filter((c) => c.agencyId === agencyId);

// ── vCard (.vcf) import ─────────────────────────────────────────────────────

/** Undo vCard text escaping (\n, \, , \; , \\). */
function unescape(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/** Quoted-printable (vCard 2.1, ENCODING=QUOTED-PRINTABLE) → text, as UTF-8. */
function decodeQp(v: string): string {
  const bytes: number[] = [];
  const s = v.replace(/=\r?\n/g, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(s[i]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function labelFrom(params: string[], allowed: readonly string[], fallback: string): string {
  const types = params
    .flatMap((p) => {
      const [k, v] = p.includes("=") ? p.split("=", 2) : ["TYPE", p];
      return k.toUpperCase() === "TYPE" ? v.split(",") : [];
    })
    .map((t) => t.replace(/"/g, "").toLowerCase());
  if (types.includes("cell") || types.includes("mobile") || types.includes("iphone")) return allowed.includes("mobile") ? "mobile" : fallback;
  if (types.includes("work")) return "work";
  if (types.includes("home")) return allowed.includes("home") ? "home" : "personal";
  return fallback;
}

/**
 * Parse a .vcf file (vCard 2.1 / 3.0 / 4.0, one or many cards) into drafts. Reads FN (or N),
 * ORG, TITLE / ROLE, TEL, EMAIL and NOTE; everything else is ignored. Never throws on odd input.
 */
export function parseVcf(text: string, group: string = NO_GROUP): ContactDraft[] {
  // Unfold: a line starting with a space or tab continues the previous one (QP soft breaks too).
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const out: ContactDraft[] = [];
  let cur: (ContactDraft & { _n?: string }) | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // QP values can continue on the next line with a trailing "=".
    while (/ENCODING=QUOTED-PRINTABLE/i.test(line.split(":")[0] ?? "") && line.endsWith("=") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    const [nameWithGroup, ...params] = head.split(";");
    const prop = nameWithGroup.replace(/^[^.]*\./, "").toUpperCase(); // item1.TEL → TEL
    if (prop === "BEGIN" && rawValue.trim().toUpperCase() === "VCARD") {
      cur = { ...emptyDraft(group), phones: [] };
      continue;
    }
    if (!cur) continue;
    if (prop === "END" && rawValue.trim().toUpperCase() === "VCARD") {
      const name = cur.name || cur._n || "";
      const { _n, ...d } = cur;
      void _n;
      const c = cleanDraft({ ...d, name: name || d.company });
      if (c.name || c.phones.length || c.emails.length) out.push(c);
      cur = null;
      continue;
    }
    const value = (params.some((p) => /ENCODING=QUOTED-PRINTABLE/i.test(p)) ? decodeQp(rawValue) : rawValue).trim();
    switch (prop) {
      case "FN":
        cur.name = unescape(value);
        break;
      case "N": {
        const [family = "", given = "", middle = "", prefix = "", suffix = ""] = value.split(/(?<!\\);/).map(unescape);
        cur._n = [prefix, given, middle, family, suffix].map((s) => s.trim()).filter(Boolean).join(" ");
        break;
      }
      case "ORG":
        cur.company = unescape(value.split(/(?<!\\);/)[0] ?? "");
        break;
      case "TITLE":
      case "ROLE":
        if (!cur.role) cur.role = unescape(value);
        break;
      case "TEL": {
        const num = value.replace(/^tel:/i, "");
        if (validPhone(num) && cur.phones.length < 10 && !cur.phones.some((p) => phoneKey(p.number) === phoneKey(num))) cur.phones.push({ label: labelFrom(params, PHONE_LABELS, "mobile"), number: num });
        break;
      }
      case "EMAIL": {
        const addr = value.replace(/^mailto:/i, "");
        if (validEmail(addr) && cur.emails.length < 10 && !cur.emails.some((e) => emailKey(e.address) === emailKey(addr))) cur.emails.push({ label: labelFrom(params, EMAIL_LABELS, "other"), address: addr });
        break;
      }
      case "NOTE":
        cur.notes = unescape(value).slice(0, 4000);
        break;
    }
  }
  return out;
}

export interface ImportCandidate {
  draft: ContactDraft;
  /** Why it's not picked by default: already in the phone book (that entry's name), a repeat in this file, or nothing to call / email. */
  duplicate: { kind: "existing"; name: string } | { kind: "repeat" } | { kind: "empty" } | null;
}

/** Mark which imported contacts are already in the phone book (normalised phone / email) or repeat within the file. */
export function importCandidates(drafts: readonly ContactDraft[], existing: readonly Contact[]): ImportCandidate[] {
  const seenP = new Set<string>();
  const seenE = new Set<string>();
  return drafts.map((draft) => {
    const pk = draft.phones.map((p) => phoneKey(p.number)).filter(Boolean);
    const ek = draft.emails.map((e) => emailKey(e.address)).filter(Boolean);
    let duplicate: ImportCandidate["duplicate"] = null;
    if (!pk.length && !ek.length) duplicate = { kind: "empty" };
    else {
      const hit = existing.find((c) => c.phones.some((p) => pk.includes(phoneKey(p.number))) || c.emails.some((e) => ek.includes(emailKey(e.address))));
      if (hit) duplicate = { kind: "existing", name: hit.name };
      else if (pk.some((k) => seenP.has(k)) || ek.some((k) => seenE.has(k))) duplicate = { kind: "repeat" };
    }
    pk.forEach((k) => seenP.add(k));
    ek.forEach((k) => seenE.add(k));
    return { draft, duplicate };
  });
}
