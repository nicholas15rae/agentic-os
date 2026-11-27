/**
 * Pick a phone-book contact (Finance pending, invoice bill-to, acting agencies, auditions), and a
 * small chip showing a linked one. Links are ids: a deleted contact shows as "contact removed"
 * and the record itself is untouched.
 */
import { BookUser, Phone } from "lucide-react";
import { Select } from "@/components/ui";
import { useAreas } from "@/features/finance/filter-store";
import { contactLabel, groupContacts, telHref, type Contact } from "./phonebook";
import { useContact, usePhoneBookLoaded } from "./phonebook-store";

export function ContactSelect({
  value,
  onChange,
  label = "Phone-book contact",
  className = "!h-9 !py-1 fs-13",
  none = "— no contact —",
}: {
  value: string | null | undefined;
  onChange: (c: Contact | null) => void;
  label?: string;
  className?: string;
  none?: string;
}) {
  const { contacts, loaded } = usePhoneBookLoaded();
  const { areas } = useAreas();
  const groups = groupContacts(contacts, areas.map((a) => ({ id: a.id, label: a.label })));
  const missing = !!value && loaded && !contacts.some((c) => c.id === value);
  return (
    <Select value={value ?? ""} aria-label={label} title={label} className={className} onChange={(e) => onChange(contacts.find((c) => c.id === e.target.value) ?? null)}>
      <option value="">{loaded ? none : "Loading phone book…"}</option>
      {missing && <option value={value!}>(contact removed)</option>}
      {groups.map((g) => (
        <optgroup key={g.id || "_none"} label={g.label}>
          {g.contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {contactLabel(c)}
              {c.role ? ` (${c.role})` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** "📇 Sam Carter · Northside" + a call link, for a record that keeps a contactId. */
export function ContactChip({ id, className = "" }: { id: string | null | undefined; className?: string }) {
  const c = useContact(id);
  const { loaded } = usePhoneBookLoaded();
  if (!id) return null;
  if (!c) return loaded ? <span className={`fs-11 text-ink-3 ${className}`}>(contact removed)</span> : null;
  const phone = c.phones[0]?.number;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 fs-11 text-teal ${className}`} title={`Phone book: ${contactLabel(c)}${c.role ? ` — ${c.role}` : ""}`}>
      <BookUser size={11} className="shrink-0" />
      <span className="truncate">{contactLabel(c)}</span>
      {phone && (
        <a href={telHref(phone)} aria-label={`Call ${c.name}`} className="shrink-0 text-ink-3 hover:text-teal">
          <Phone size={10} />
        </a>
      )}
    </span>
  );
}
