/**
 * Communications → Phone book. Contacts grouped by area (Acting, Contracting, BF Supplements,
 * Personal, your areas) or a group you name; every field editable on screen. Numbers call or text
 * through the phone bridge — always behind the confirmation card — and emails open your mail app
 * or (desktop) a Gmail draft you review first. Nothing is ever sent without a confirmation.
 *
 * Import: the phone bridge (Tasker / MacroDroid pushing to the gateway) has no way to hand over
 * the phone's address book today, so contacts come in from a vCard (.vcf) file exported from the
 * phone's Contacts app. You pick which to import; ones already here (same number or email) are
 * left unticked.
 */
import { useMemo, useRef, useState } from "react";
import { BookUser, ChevronDown, ChevronRight, Loader2, Mail, MessageSquare, Pencil, Phone, PhoneCall, Plus, RefreshCw, Search, Send, ShieldCheck, Trash2, Upload, UserPlus, X } from "lucide-react";
import { Card, Empty, Field, Input, Select } from "@/components/ui";
import { gateway } from "@/lib/gateway";
import { cmd, isTauri } from "@/lib/platform";
import { confirmThen } from "@/features/bridge/gate";
import { useToasts } from "@/features/reminders/notify";
import { useAreas } from "@/features/finance/filter-store";
import { useProfiles } from "@/features/business/profiles-store";
import { SelectOther } from "@/sections/finance/fields";
import {
  EMAIL_LABELS,
  PHONE_LABELS,
  ROLE_OPTIONS,
  contactLabel,
  draftProblem,
  emptyDraft,
  groupContacts,
  groupLabel,
  groupOptions,
  importCandidates,
  mailtoHref,
  matchesQuery,
  parseVcf,
  telHref,
  toDraft,
  type Contact,
  type ContactDraft,
  type ImportCandidate,
} from "./phonebook";
import { usePhoneBook, usePhoneBookLoaded } from "./phonebook-store";

const small = "!h-9 !py-1 fs-13";
const toastErr = (title: string, e: unknown) => useToasts.getState().push({ title, body: e instanceof Error ? e.message : String(e), tone: "error" });

/** Ask the phone bridge to dial — behind the confirmation card. */
export function callViaBridge(number: string, label: string) {
  return confirmThen(
    { action: "comms-call", summary: `Call ${label}`, readBack: `Place a call to ${label} (${number}) from your phone?`, detail: { to: number } },
    () => gateway("/api/comms/call", { method: "POST", body: JSON.stringify({ address: number, contact: label, confirmed: true }) }),
    () => "Your phone is dialing.",
  ).catch((e) => toastErr("Call failed", e));
}

export function PhoneBook() {
  const { contacts, loaded } = usePhoneBookLoaded();
  const error = usePhoneBook((s) => s.error);
  const unfiled = usePhoneBook((s) => s.unfiled);
  const { areas } = useAreas();
  const areaInfos = useMemo(() => areas.map((a) => ({ id: a.id, label: a.label })), [areas]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<ContactDraft | null>(null);
  const [importing, setImporting] = useState<ImportCandidate[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showUnfiled, setShowUnfiled] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const shown = contacts.filter((c) => matchesQuery(c, q));
  const groups = groupContacts(shown, areaInfos);
  const unfiledShown = unfiled.filter((u) => !q || `${u.name ?? ""} ${u.address}`.toLowerCase().includes(q.toLowerCase()));

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toastErr("Import", "That file is over 5 MB.");
    const drafts = parseVcf(await f.text());
    if (!drafts.length) return toastErr("Import", "No contacts found in that file (expected a .vcf vCard export).");
    setImporting(importCandidates(drafts, contacts));
  };

  return (
    <div className="space-y-3">
      <Card
        title="Phone book"
        hint="Grouped by area. Numbers call or text through your phone (a confirmation card shows first); emails open your mail app or a Gmail draft you review."
        action={
          <button onClick={() => void usePhoneBook.getState().load()} aria-label="Refresh" className="text-ink-3 hover:text-ink">
            <RefreshCw size={13} />
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search size={13} className="absolute left-3 top-3 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, role, number, email" className="!pl-8" aria-label="Search the phone book" />
          </div>
          <button className="pill-primary !h-9 text-xs" onClick={() => setEditing(emptyDraft())}>
            <Plus size={13} /> New contact
          </button>
          <button className="pill-glass !h-9 text-xs" onClick={() => file.current?.click()} title="Import a .vcf file exported from your phone's Contacts app">
            <Upload size={13} /> Import vCard (.vcf)
          </button>
          <input
            ref={file}
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <p className="mt-2 fs-11 text-ink-3">
          Importing straight from the phone isn&apos;t possible yet: the phone bridge only pushes texts and calls. On the phone, open Contacts → Share / Export → .vcf, then import that file here.
        </p>
        {error && <p className="mt-2 text-xs text-alert">{error}</p>}
      </Card>

      {editing && <ContactEditor initial={editing} contacts={contacts} onClose={() => setEditing(null)} />}
      {importing && <ImportPicker candidates={importing} onClose={() => setImporting(null)} />}

      {!loaded && !error && <Loader2 size={14} className="animate-spin text-ink-3" />}
      {loaded && !contacts.length && !editing && <Card><Empty>No contacts yet. Add one, import a .vcf, or file the numbers your phone bridge already knows (below).</Empty></Card>}
      {loaded && contacts.length > 0 && !shown.length && <Card><Empty>Nobody matches “{q}”.</Empty></Card>}

      {groups.map((g) => (
        <Card
          key={g.id || "_none"}
          title={`${g.label} · ${g.contacts.length}`}
          action={
            <button onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} aria-label={collapsed[g.id] ? `Show ${g.label}` : `Hide ${g.label}`} className="text-ink-3 hover:text-ink">
              {collapsed[g.id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          }
        >
          {!collapsed[g.id] && (
            <ul className="divide-y divide-white/5">
              {g.contacts.map((c) => (
                <ContactRow key={c.id} c={c} onEdit={() => setEditing(toDraft(c))} />
              ))}
            </ul>
          )}
        </Card>
      ))}

      {unfiledShown.length > 0 && (
        <Card
          title={`From the phone bridge · ${unfiledShown.length} not filed`}
          hint="Numbers that texted or called you (named by your phone) that aren't in the phone book yet. File one to give it a group, company and notes."
          action={
            <button onClick={() => setShowUnfiled((s) => !s)} aria-label={showUnfiled ? "Hide unfiled numbers" : "Show unfiled numbers"} className="text-ink-3 hover:text-ink">
              {showUnfiled ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          }
        >
          {showUnfiled && (
            <ul className="divide-y divide-white/5">
              {unfiledShown.map((u) => (
                <li key={u.address} className="flex items-center gap-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{u.name || u.address}</span>
                  {u.trusted && <ShieldCheck size={11} className="text-teal" aria-label="Instant Send" />}
                  <span className="font-mono fs-11 text-ink-3">{u.address}</span>
                  <button className="pill-glass !h-8 text-xs" onClick={() => setEditing({ ...emptyDraft(), name: u.name && u.name !== u.address ? u.name : "", phones: [{ label: "mobile", number: u.address }], source: "bridge" })}>
                    <UserPlus size={12} /> File
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

// ── One contact ─────────────────────────────────────────────────────────────

function ContactRow({ c, onEdit }: { c: Contact; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [texting, setTexting] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const agencies = useProfiles((s) => s.doc.profiles.acting?.agencies);
  const agency = c.agencyId ? agencies?.find((a) => a.id === c.agencyId) : null;
  const desktop = isTauri();
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <BookUser size={14} className="shrink-0 text-ink-3" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">
              {c.name}
              {c.trusted && <ShieldCheck size={11} className="ml-1 inline text-teal" aria-label="Instant Send" />}
            </span>
            <span className="block truncate fs-11 text-ink-3">{[c.company, c.role, agency ? `agency: ${agency.name}` : ""].filter(Boolean).join(" · ") || " "}</span>
          </span>
        </button>
        {c.phones[0] && (
          <a href={telHref(c.phones[0].number)} className="pill-glass !h-8 !w-8 !p-0" aria-label={`Call ${c.name}`} title={`Call ${c.phones[0].number}`}>
            <Phone size={13} />
          </a>
        )}
        {c.emails[0] && (
          <a href={mailtoHref(c.emails[0].address)} className="pill-glass !h-8 !w-8 !p-0" aria-label={`Email ${c.name}`} title={`Email ${c.emails[0].address}`}>
            <Mail size={13} />
          </a>
        )}
        <button onClick={onEdit} className="pill-glass !h-8 !w-8 !p-0" aria-label={`Edit ${c.name}`} title="Edit">
          <Pencil size={12} />
        </button>
        {confirmDel ? (
          <span className="flex items-center gap-1 fs-11">
            Delete? Linked records keep their link.
            <button className="pill-glass !h-7 fs-11 !text-alert" onClick={() => void usePhoneBook.getState().remove(c.id).catch((e) => toastErr("Not deleted", e))}>
              Delete
            </button>
            <button className="pill-glass !h-7 fs-11" onClick={() => setConfirmDel(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="text-ink-3 hover:text-alert" aria-label={`Delete ${c.name}`}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-1.5 pl-6 fs-13">
          {c.phones.map((p) => (
            <div key={p.number} className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 fs-11 text-ink-3">{p.label || "phone"}</span>
              <a href={telHref(p.number)} className="font-mono text-ink hover:text-teal">
                {p.number}
              </a>
              {desktop && (
                <button className="pill-glass !h-7 fs-11" onClick={() => void callViaBridge(p.number, c.name)} title="Ask the phone bridge to dial (confirmation first)">
                  <PhoneCall size={11} /> via phone
                </button>
              )}
              <button className="pill-glass !h-7 fs-11" onClick={() => setTexting(texting === p.number ? null : p.number)} title="Text through the phone bridge (confirmation first)">
                <MessageSquare size={11} /> Text
              </button>
            </div>
          ))}
          {texting && <TextComposer to={texting} contact={c} onDone={() => setTexting(null)} />}
          {c.emails.map((e) => (
            <div key={e.address} className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 fs-11 text-ink-3">{e.label || "email"}</span>
              <a href={mailtoHref(e.address)} className="break-all text-ink hover:text-teal">
                {e.address}
              </a>
              {desktop && (
                <button className="pill-glass !h-7 fs-11" onClick={() => setDrafting(drafting === e.address ? null : e.address)} title="Write a Gmail draft (you review it; nothing is sent)">
                  <Mail size={11} /> Gmail draft
                </button>
              )}
            </div>
          ))}
          {drafting && <GmailDraft to={drafting} contact={c} onDone={() => setDrafting(null)} />}
          {c.notes && <p className="whitespace-pre-wrap break-words fs-12 text-ink-2">{c.notes}</p>}
          {!c.phones.length && !c.emails.length && <p className="fs-12 text-ink-3">No number or email yet.</p>}
        </div>
      )}
    </li>
  );
}

/** A text to one number, queued for the phone bridge only after the confirmation card. */
function TextComposer({ to, contact, onDone }: { to: string; contact: Contact; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = body.trim();
        if (!text) return;
        setBusy(true);
        try {
          const r = await confirmThen(
            { action: "comms-send", summary: `Text ${contact.name}: “${text.slice(0, 80)}”`, readBack: `Send this text to ${contact.name}: ${text.slice(0, 140)}. Send it?`, detail: { to, channel: "sms" } },
            () => gateway("/api/comms/send", { method: "POST", body: JSON.stringify({ address: to, contact: contact.name, body: text, channel: "sms", confirmed: true }) }),
            () => "Queued — your phone sends it.",
          );
          if (r !== null) onDone();
        } catch (err) {
          toastErr("Not sent", err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Text ${to} — confirmed before sending…`} aria-label={`Text to ${contact.name}`} autoFocus />
      <button className="pill-primary !h-10 !w-10 shrink-0 !p-0" disabled={!body.trim() || busy} aria-label="Send text">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
      </button>
    </form>
  );
}

/** A Gmail DRAFT (never a send): shows exactly what goes in and creates it only on "Create draft". */
function GmailDraft({ to, contact, onDone }: { to: string; contact: Contact; onDone: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(`Hi ${contact.name.split(" ")[0] || contact.name},\n\n`);
  const [state, setState] = useState<"idle" | "working">("idle");
  return (
    <div className="well space-y-2 r-12 p-2">
      <p className="fs-11 text-ink-3">Gmail draft to {to}. Nothing is sent: open Gmail and press Send yourself.</p>
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="field w-full fs-13" aria-label="Message" />
      <div className="flex gap-2">
        <button
          className="pill-primary !h-9 text-xs"
          disabled={state === "working" || !subject.trim()}
          onClick={async () => {
            setState("working");
            try {
              await cmd("gmail_create_draft", { to, subject: subject.trim(), body, approved: true });
              useToasts.getState().push({ title: "Draft created in Gmail", body: "Not sent — review and send it from Gmail.", tone: "info" });
              onDone();
            } catch (e) {
              toastErr("No draft", e);
              setState("idle");
            }
          }}
        >
          {state === "working" ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />} Create draft
        </button>
        <button className="pill-glass !h-9 text-xs" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

function ContactEditor({ initial, contacts, onClose }: { initial: ContactDraft; contacts: readonly Contact[]; onClose: () => void }) {
  const [d, setD] = useState<ContactDraft>(initial);
  const [saving, setSaving] = useState(false);
  const { areas } = useAreas();
  const agencies = useProfiles((s) => s.doc.profiles.acting?.agencies) ?? [];
  const groups = groupOptions(contacts, areas.map((a) => ({ id: a.id, label: a.label })));
  if (d.group && !groups.some((g) => g.id === d.group)) groups.push({ id: d.group, label: groupLabel(d.group) });
  const problem = draftProblem(d);
  const setPhone = (i: number, x: Partial<ContactDraft["phones"][number]>) => setD({ ...d, phones: d.phones.map((p, j) => (j === i ? { ...p, ...x } : p)) });
  const setEmail = (i: number, x: Partial<ContactDraft["emails"][number]>) => setD({ ...d, emails: d.emails.map((p, j) => (j === i ? { ...p, ...x } : p)) });

  return (
    <Card
      title={d.id ? `Edit ${initial.name || "contact"}` : "New contact"}
      action={
        <button onClick={onClose} aria-label="Close editor" className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <X size={15} />
        </button>
      }
    >
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (problem) return;
          setSaving(true);
          try {
            await usePhoneBook.getState().save(d);
            onClose();
          } catch (err) {
            toastErr("Not saved", err);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Name">
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Company / agency">
            <Input value={d.company} onChange={(e) => setD({ ...d, company: e.target.value })} />
          </Field>
          <Field label="Role">
            <SelectOther label="Role" value={d.role} options={ROLE_OPTIONS} onChange={(role) => setD({ ...d, role })} className="" placeholder="Type a role" />
          </Field>
          <Field label="Group / area">
            <SelectOther label="Group" value={d.group} options={[{ value: "", label: "No group" }, ...groups.map((g) => ({ value: g.id, label: g.label }))]} onChange={(group) => setD({ ...d, group })} className="" placeholder="New group name" />
          </Field>
          {(d.group === "acting" || d.agencyId) && (
            <Field label="Acting agency (Settings → Business → Acting)">
              <Select value={d.agencyId ?? ""} onChange={(e) => setD({ ...d, agencyId: e.target.value || null })}>
                <option value="">— not an agency contact —</option>
                {d.agencyId && !agencies.some((a) => a.id === d.agencyId) && <option value={d.agencyId}>(agency removed)</option>}
                {agencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="label-caps text-ink-3">Phones</p>
          {d.phones.map((p, i) => (
            <div key={i} className="flex gap-1.5">
              <SelectOther label="Phone label" value={p.label} options={PHONE_LABELS} onChange={(label) => setPhone(i, { label })} className={`${small} !w-28`} placeholder="Label" />
              <Input type="tel" value={p.number} onChange={(e) => setPhone(i, { number: e.target.value })} placeholder="416-555-0100" className={`${small} min-w-0 flex-1 font-mono`} aria-label="Phone number" />
              <button type="button" aria-label="Remove number" onClick={() => setD({ ...d, phones: d.phones.filter((_, j) => j !== i) })} className="text-ink-3 hover:text-alert">
                <X size={13} />
              </button>
            </div>
          ))}
          {d.phones.length < 10 && (
            <button type="button" className="pill-glass !h-8 fs-11" onClick={() => setD({ ...d, phones: [...d.phones, { label: "mobile", number: "" }] })}>
              <Plus size={11} /> Phone
            </button>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="label-caps text-ink-3">Emails</p>
          {d.emails.map((m, i) => (
            <div key={i} className="flex gap-1.5">
              <SelectOther label="Email label" value={m.label} options={EMAIL_LABELS} onChange={(label) => setEmail(i, { label })} className={`${small} !w-28`} placeholder="Label" />
              <Input type="email" value={m.address} onChange={(e) => setEmail(i, { address: e.target.value })} placeholder="name@example.com" className={`${small} min-w-0 flex-1`} aria-label="Email address" />
              <button type="button" aria-label="Remove email" onClick={() => setD({ ...d, emails: d.emails.filter((_, j) => j !== i) })} className="text-ink-3 hover:text-alert">
                <X size={13} />
              </button>
            </div>
          ))}
          {d.emails.length < 10 && (
            <button type="button" className="pill-glass !h-8 fs-11" onClick={() => setD({ ...d, emails: [...d.emails, { label: "work", address: "" }] })}>
              <Plus size={11} /> Email
            </button>
          )}
        </div>

        <Field label="Notes">
          <textarea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} rows={3} className="field w-full fs-13" />
        </Field>
        {problem && <p className="text-xs text-amber-light">{problem}</p>}
        <div className="flex gap-2">
          <button className="pill-primary" disabled={!!problem || saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <BookUser size={14} />} Save contact
          </button>
          <button type="button" className="pill-glass" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

// ── Import picker ───────────────────────────────────────────────────────────

function ImportPicker({ candidates, onClose }: { candidates: ImportCandidate[]; onClose: () => void }) {
  const [picked, setPicked] = useState<boolean[]>(() => candidates.map((c) => !c.duplicate));
  const [busy, setBusy] = useState(false);
  const n = picked.filter(Boolean).length;
  const why = (c: ImportCandidate) => (c.duplicate?.kind === "existing" ? `already here as ${c.duplicate.name}` : c.duplicate?.kind === "repeat" ? "repeat in this file" : c.duplicate?.kind === "empty" ? "no number or email" : "");
  return (
    <Card
      title={`Import ${candidates.length} contact${candidates.length === 1 ? "" : "s"} from vCard`}
      hint="Pick who to add. Ones already in the phone book (same number or email) are unticked and skipped anyway. Set a group on each afterwards."
      action={
        <button onClick={onClose} aria-label="Close import" className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <X size={15} />
        </button>
      }
    >
      <div className="mb-2 flex gap-2 fs-11">
        <button className="pill-glass !h-7 fs-11" onClick={() => setPicked(candidates.map((c) => !c.duplicate))}>
          All new
        </button>
        <button className="pill-glass !h-7 fs-11" onClick={() => setPicked(candidates.map(() => false))}>
          None
        </button>
      </div>
      <ul className="max-h-[50vh] divide-y divide-white/5 overflow-y-auto">
        {candidates.map((c, i) => (
          <li key={i} className="flex items-center gap-2 py-1.5 fs-13">
            <input type="checkbox" className="accent-teal" checked={picked[i]} disabled={c.duplicate?.kind === "empty"} onChange={(e) => setPicked(picked.map((p, j) => (j === i ? e.target.checked : p)))} aria-label={`Import ${c.draft.name}`} />
            <span className="min-w-0 flex-1 truncate text-ink">{contactLabel(c.draft)}</span>
            <span className="truncate font-mono fs-11 text-ink-3">{c.draft.phones[0]?.number ?? c.draft.emails[0]?.address ?? ""}</span>
            {c.duplicate && <span className="shrink-0 fs-11 text-amber-light">{why(c)}</span>}
          </li>
        ))}
      </ul>
      <button
        className="pill-primary mt-3"
        disabled={!n || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await usePhoneBook.getState().importMany(candidates.filter((_, i) => picked[i]).map((c) => c.draft), "vcard");
            useToasts.getState().push({ title: `Imported ${r.added}`, body: r.skipped ? `${r.skipped} skipped (already in the phone book).` : "All added.", tone: "info" });
            onClose();
          } catch (e) {
            toastErr("Import failed", e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import {n}
      </button>
    </Card>
  );
}
