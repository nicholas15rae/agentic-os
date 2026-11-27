import { describe, expect, it } from "vitest";
import {
  cleanDraft,
  contactLabel,
  draftProblem,
  emailKey,
  emptyDraft,
  findContact,
  groupContacts,
  groupOptions,
  importCandidates,
  mailtoHref,
  matchesQuery,
  parseVcf,
  phoneKey,
  telHref,
  type Contact,
} from "./phonebook";

const c = (id: string, x: Partial<Contact> = {}): Contact => ({ id, name: id, company: "", role: "", phones: [], emails: [], notes: "", group: "", agencyId: null, source: "manual", ...x });

describe("keys (same rules as os_api.pb_phone_key / pb_email_key)", () => {
  it("normalises phones to the last 10 digits and emails to lower case", () => {
    expect(phoneKey("+1 (416) 555-0100")).toBe("4165550100");
    expect(phoneKey("416.555.0100")).toBe("4165550100");
    expect(phoneKey("555-0100")).toBe("5550100");
    expect(phoneKey("12")).toBe("");
    expect(emailKey(" Sam@Northside.CA ")).toBe("sam@northside.ca");
    expect(emailKey("nope")).toBe("");
    expect(telHref("+1 (416) 555-0100")).toBe("tel:+14165550100");
    expect(mailtoHref("a b@x.ca", "Hi there")).toBe("mailto:a%20b%40x.ca?subject=Hi%20there");
  });
});

describe("vCard import", () => {
  it("reads 3.0 cards with folding, groups, escapes and types", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Sam Carter",
      "N:Carter;Sam;;;",
      "ORG:Northside Casting;Toronto",
      "TITLE:Casting director",
      "item1.TEL;TYPE=CELL:+1 416 555 0100",
      "TEL;TYPE=WORK,VOICE:(416) 555-0100", // same number again → dropped
      "TEL;TYPE=WORK:905-555-0111",
      "EMAIL;TYPE=INTERNET,WORK:sam@northside.ca",
      "NOTE:Prefers texts\\, not calls\\nOffice M–F",
      "  (long note continued)",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Lee;Pat;;;",
      "EMAIL:pat@example.com",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "END:VCARD",
    ].join("\r\n");
    const out = parseVcf(vcf, "acting");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: "Sam Carter",
      company: "Northside Casting",
      role: "Casting director",
      group: "acting",
      phones: [
        { label: "mobile", number: "+1 416 555 0100" },
        { label: "work", number: "905-555-0111" },
      ],
      emails: [{ label: "work", address: "sam@northside.ca" }],
      notes: "Prefers texts, not calls\nOffice M–F (long note continued)",
    });
    expect(out[1]).toMatchObject({ name: "Pat Lee", phones: [], emails: [{ address: "pat@example.com" }] });
  });

  it("reads 2.1 quoted-printable values and never throws on junk", () => {
    const vcf = "BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ren=C3=A9e =\nTremblay\nTEL;CELL:6475550123\nEND:VCARD\n";
    expect(parseVcf(vcf)).toEqual([expect.objectContaining({ name: "Renée Tremblay", phones: [{ label: "mobile", number: "6475550123" }] })]);
    expect(parseVcf("hello\nworld")).toEqual([]);
    expect(parseVcf("")).toEqual([]);
  });

  it("marks contacts already here (normalised) and repeats within the file", () => {
    const existing = [c("Sam", { phones: [{ label: "mobile", number: "(416) 555-0100" }] }), c("Lee", { emails: [{ label: "", address: "lee@x.ca" }] })];
    const got = importCandidates(
      [
        { ...emptyDraft(), name: "Sam 2", phones: [{ label: "", number: "+14165550100" }] },
        { ...emptyDraft(), name: "Lee 2", phones: [], emails: [{ label: "", address: "LEE@X.CA" }] },
        { ...emptyDraft(), name: "Pat", phones: [{ label: "", number: "647 555 0123" }] },
        { ...emptyDraft(), name: "Pat again", phones: [{ label: "", number: "6475550123" }] },
        { ...emptyDraft(), name: "Nobody", phones: [] },
      ],
      existing,
    );
    expect(got.map((g) => g.duplicate)).toEqual([{ kind: "existing", name: "Sam" }, { kind: "existing", name: "Lee" }, null, { kind: "repeat" }, { kind: "empty" }]);
  });
});

describe("groups", () => {
  const areas = [
    { id: "acting", label: "Acting" },
    { id: "trades_contracting", label: "Contracting" },
    { id: "supplements_ecom", label: "BF Supplements" },
    { id: "personal", label: "Personal" },
    { id: "rentals", label: "Rentals" },
  ];
  it("areas first in order, then custom groups, then no group; empty groups left out", () => {
    const book = [c("zed", { group: "personal" }), c("amy", { group: "acting" }), c("bob", { group: "Gym" }), c("cat", { group: "" }), c("al", { group: "acting" }), c("rae", { group: "rentals" })];
    const g = groupContacts(book, areas);
    expect(g.map((x) => [x.label, x.contacts.map((y) => y.name)])).toEqual([
      ["Acting", ["al", "amy"]],
      ["Personal", ["zed"]],
      ["Rentals", ["rae"]],
      ["Gym", ["bob"]],
      ["No group", ["cat"]],
    ]);
    expect(groupOptions(book, areas).map((o) => o.id)).toEqual(["acting", "trades_contracting", "supplements_ecom", "personal", "rentals", "Gym"]);
    // Without the profiles loaded the built-in areas still label right.
    expect(groupContacts([c("x", { group: "supplements_ecom" })])[0].label).toBe("BF Supplements");
  });
});

describe("lookup, search, drafts", () => {
  const book = [c("Sam Carter", { company: "Northside", phones: [{ label: "", number: "416-555-0100" }], emails: [{ label: "", address: "sam@n.ca" }] }), c("Dana", { notes: "deck builder" })];
  it("finds by number, then email, then exact name", () => {
    expect(findContact(book, { phone: "+1 416 555 0100" })?.name).toBe("Sam Carter");
    expect(findContact(book, { email: "SAM@N.CA" })?.name).toBe("Sam Carter");
    expect(findContact(book, { name: " dana " })?.name).toBe("Dana");
    expect(findContact(book, { phone: "905 555 0000", name: "Dana" })).toBeNull(); // a different number is someone else
    expect(contactLabel(book[0])).toBe("Sam Carter · Northside");
  });
  it("searches every field and digits inside numbers", () => {
    expect(matchesQuery(book[0], "north")).toBe(true);
    expect(matchesQuery(book[0], "5550")).toBe(true);
    expect(matchesQuery(book[1], "deck")).toBe(true);
    expect(matchesQuery(book[1], "north")).toBe(false);
  });
  it("cleans and checks drafts", () => {
    const d = { ...emptyDraft("acting"), name: " Sam ", phones: [{ label: "mobile", number: " " }, { label: "work", number: "416 555 0100" }], emails: [{ label: "work", address: "" }] };
    expect(cleanDraft(d)).toEqual({ name: "Sam", company: "", role: "", phones: [{ label: "work", number: "416 555 0100" }], emails: [], notes: "", group: "acting", agencyId: null });
    expect(draftProblem(d)).toBeNull();
    expect(draftProblem(emptyDraft())).toMatch(/name/);
    expect(draftProblem({ ...d, phones: [{ label: "", number: "12" }] })).toMatch(/phone/);
    expect(draftProblem({ ...d, emails: [{ label: "", address: "x@" }] })).toMatch(/email/);
  });
});
