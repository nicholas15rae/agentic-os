/**
 * The phone book, loaded from / saved to the local gateway (/api/comms/phonebook). Shared by the
 * Phone book tab and every contact picker (Finance pending, invoice bill-to, acting agencies, the
 * audition pipeline, message threads), so one load serves them all.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { gateway } from "@/lib/gateway";
import { cleanDraft, findContact, type Contact, type ContactDraft, type UnfiledNumber } from "./phonebook";

const PATH = "/api/comms/phonebook";

interface PhoneBookState {
  contacts: Contact[];
  unfiled: UnfiledNumber[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (d: ContactDraft) => Promise<Contact>;
  remove: (id: string) => Promise<void>;
  importMany: (drafts: ContactDraft[], source: "vcard" | "phone") => Promise<{ added: number; skipped: number; skippedNames: string[] }>;
}

let inflight: Promise<void> | null = null;

export const usePhoneBook = create<PhoneBookState>()((set, get) => ({
  contacts: [],
  unfiled: [],
  loaded: false,
  loading: false,
  error: null,
  load: () => {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = gateway<{ contacts: Contact[]; unfiled: UnfiledNumber[] }>(PATH)
      .then((r) => set({ contacts: r.contacts, unfiled: r.unfiled, loaded: true, error: null }))
      .catch((e) => set({ error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        inflight = null;
        set({ loading: false });
      });
    return inflight;
  },
  save: async (d) => {
    const saved = await gateway<Contact>(PATH, { method: "POST", body: JSON.stringify(cleanDraft(d)) });
    const others = get().contacts.filter((c) => c.id !== saved.id);
    set({ contacts: [...others, { ...saved, trusted: get().contacts.find((c) => c.id === saved.id)?.trusted }] });
    void get().load(); // numbers moved between "unfiled" and the entry
    return saved;
  },
  remove: async (id) => {
    await gateway(`${PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
    set({ contacts: get().contacts.filter((c) => c.id !== id) });
    void get().load();
  },
  importMany: async (drafts, source) => {
    const r = await gateway<{ added: number; skipped: number; skippedNames: string[] }>(`${PATH}/import`, {
      method: "POST",
      body: JSON.stringify({ source, contacts: drafts.map((d) => cleanDraft({ ...d, id: undefined, source: undefined })) }),
      timeoutMs: 60_000,
    });
    await get().load();
    return r;
  },
}));

/** Load the phone book once for a component that shows or picks contacts. */
export function usePhoneBookLoaded() {
  const contacts = usePhoneBook((s) => s.contacts);
  const loaded = usePhoneBook((s) => s.loaded);
  useEffect(() => {
    if (!usePhoneBook.getState().loaded) void usePhoneBook.getState().load();
  }, []);
  return { contacts, loaded };
}

/** One contact by id (null while loading, or once it's been deleted — the link stays on the record). */
export function useContact(id: string | null | undefined): Contact | null {
  const { contacts } = usePhoneBookLoaded();
  return id ? (contacts.find((c) => c.id === id) ?? null) : null;
}

/**
 * The phone-book entry for this person, made if there's none yet ("Save contact" on a pending
 * payment, "Add to phone book" on a message thread). Matches by number, then email, then exact name.
 */
export async function linkOrCreate(p: { name: string; phone?: string; email?: string; company?: string; group?: string; source?: string }): Promise<Contact> {
  const st = usePhoneBook.getState();
  if (!st.loaded) await st.load();
  const hit = findContact(usePhoneBook.getState().contacts, { phone: p.phone, email: p.email, name: p.name });
  if (hit) {
    // Fill in a number / email the entry doesn't have yet; never overwrite what's there.
    const addPhone = p.phone && !hit.phones.some((x) => x.number.replace(/\D/g, "").endsWith(p.phone!.replace(/\D/g, "").slice(-10)));
    const addEmail = p.email && !hit.emails.some((x) => x.address.toLowerCase() === p.email!.trim().toLowerCase());
    if (!addPhone && !addEmail) return hit;
    return usePhoneBook.getState().save({
      ...hit,
      phones: addPhone && hit.phones.length < 10 ? [...hit.phones, { label: "mobile", number: p.phone! }] : hit.phones,
      emails: addEmail && hit.emails.length < 10 ? [...hit.emails, { label: "work", address: p.email! }] : hit.emails,
    });
  }
  return usePhoneBook.getState().save({
    name: p.name,
    company: p.company ?? "",
    role: "",
    phones: p.phone ? [{ label: "mobile", number: p.phone }] : [],
    emails: p.email ? [{ label: "work", address: p.email }] : [],
    notes: "",
    group: p.group ?? "",
    agencyId: null,
    source: p.source,
  });
}
