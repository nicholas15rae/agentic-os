import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "./phonebook";

const calls: { path: string; method: string; body?: unknown }[] = [];
let book: Contact[] = [];

vi.mock("@/lib/gateway", () => ({
  gateway: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/comms/phonebook" && method === "GET") return { contacts: book, unfiled: [] };
    if (path === "/api/comms/phonebook" && method === "POST") {
      const saved = { source: "manual", ...body, id: body.id ?? `id${book.length + 1}`, created: 1, updated: 2 } as Contact;
      book = [...book.filter((c) => c.id !== saved.id), saved];
      return saved;
    }
    throw new Error(`unexpected ${method} ${path}`);
  },
}));

const { linkOrCreate, usePhoneBook } = await import("./phonebook-store");

const sam: Contact = { id: "sam", name: "Sam", company: "Northside", role: "Agent", phones: [{ label: "mobile", number: "416-555-0100" }], emails: [], notes: "", group: "acting", agencyId: null, source: "manual", created: 1, updated: 1, trusted: true };

describe("linkOrCreate (Finance “Save contact”, Messages “Phone book”)", () => {
  beforeEach(() => {
    calls.length = 0;
    book = [sam];
    usePhoneBook.setState({ contacts: [], unfiled: [], loaded: false, loading: false, error: null });
  });

  it("links an existing entry by number without saving anything", async () => {
    const got = await linkOrCreate({ name: "Sammy", phone: "+1 (416) 555-0100" });
    expect(got.id).toBe("sam");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("creates a new entry with only the fields the gateway accepts", async () => {
    const got = await linkOrCreate({ name: "Pat", phone: "647-555-0123", group: "trades_contracting", source: "finance" });
    expect(got.id).toBe("id2");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "Pat", company: "", role: "", phones: [{ label: "mobile", number: "647-555-0123" }], emails: [], notes: "", group: "trades_contracting", agencyId: null, source: "finance" });
  });

  it("adds a missing email to the entry matched by number and never sends bookkeeping fields back", async () => {
    await linkOrCreate({ name: "Sam", phone: "4165550100", email: "sam@northside.ca" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(Object.keys(post.body as object).sort()).toEqual(["agencyId", "company", "emails", "group", "id", "name", "notes", "phones", "role", "source"]);
    expect((post.body as Contact).emails).toEqual([{ label: "work", address: "sam@northside.ca" }]);
    expect((post.body as Contact).phones).toEqual(sam.phones);
  });
});
