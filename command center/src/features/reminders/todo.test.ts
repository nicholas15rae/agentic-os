import { describe, expect, it, vi } from "vitest";
import { createTodoFlow, parseTodoAdd, TODO_CONFIRM_TTL_MS } from "./todo";

describe("parseTodoAdd: Nic's exact item", () => {
  it("takes the item word for word, in every common phrasing", () => {
    const cases: [string, string][] = [
      ["add Melissa Lee invoice to my to-do list", "Melissa Lee invoice"],
      ["Hey Tony, add Melissa Lee invoice to my to-do list.", "Melissa Lee invoice"],
      ["can you put Melissa Lee invoice on my todo list", "Melissa Lee invoice"],
      ["add “Melissa Lee invoice” to the to do list", "Melissa Lee invoice"],
      ["put call Sam back on my to-dos", "call Sam back"],
      ["add to my to-do list: Melissa Lee invoice", "Melissa Lee invoice"],
      ["add a to-do: Melissa Lee invoice", "Melissa Lee invoice"],
      ["add a to-do for Melissa Lee invoice", "Melissa Lee invoice"],
      ["new todo, Melissa Lee invoice", "Melissa Lee invoice"],
      ["add Melissa Lee invoice to my to-do list please", "Melissa Lee invoice"],
      ["put Melissa Lee invoice on my to-do list for tomorrow", "Melissa Lee invoice"],
      ["to-do: renew the Instagram token", "renew the Instagram token"],
      ["make a to-do to chase the Melissa Lee invoice", "chase the Melissa Lee invoice"],
    ];
    for (const [line, item] of cases) expect(parseTodoAdd(line), line).toBe(item);
  });

  it("a pointer ('that', 'it') is never guessed: it asks for the words", () => {
    expect(parseTodoAdd("add that to my to-do list")).toBe("");
    expect(parseTodoAdd("put it on my todo list")).toBe("");
  });

  it("ignores lines that aren't a to-do add", () => {
    for (const t of ["what's on my to-do list?", "check my primary inbox", "add Sam to the group chat", "remind me to call Sam in 20 minutes", "I need to do laundry", "to do list is getting long", "todo app keeps crashing", "to do that I need the invoice", "new todo list looks great"]) {
      expect(parseTodoAdd(t), t).toBeNull();
    }
  });
});

describe("to-do adds are confirmed before saving (live test 11-27)", () => {
  const flow = () => {
    const save = vi.fn(async () => undefined);
    let t = 1_000;
    const f = createTodoFlow(save, () => t);
    return { f, save, tick: (ms: number) => (t += ms) };
  };

  it("asks with the exact text, saves it only after yes", async () => {
    const { f, save } = flow();
    const q = await f.handle("add Melissa Lee invoice to my to-do list");
    expect(q?.reply).toBe("Add “Melissa Lee invoice” to your to-do list? Say yes, or tell me the exact words.");
    expect(save).not.toHaveBeenCalled();
    expect(f.pending()).toEqual({ item: "Melissa Lee invoice" });
    const done = await f.handle("yes");
    expect(save).toHaveBeenCalledExactlyOnceWith("Melissa Lee invoice");
    expect(done?.reply).toBe("Added “Melissa Lee invoice” to your to-do list.");
    expect(f.pending()).toBeNull();
    // A later yes saves nothing.
    expect(await f.handle("yes")).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a correction replaces the words and asks again; never the old text", async () => {
    const { f, save } = flow();
    await f.handle("add check primary inbox to my to-do list");
    const again = await f.handle("no, Melissa Lee invoice");
    expect(again?.reply).toContain("“Melissa Lee invoice”");
    expect(save).not.toHaveBeenCalled();
    await f.handle("make it Melissa Lee invoice 114");
    await f.handle("yeah add it");
    expect(save).toHaveBeenCalledExactlyOnceWith("Melissa Lee invoice 114");
  });

  it("no saves nothing", async () => {
    const { f, save } = flow();
    await f.handle("add Melissa Lee invoice to my to-do list");
    expect((await f.handle("no"))?.reply).toBe("Okay, I didn't add it.");
    expect(save).not.toHaveBeenCalled();
  });

  it("'add that' asks for the words, then confirms them", async () => {
    const { f, save } = flow();
    expect((await f.handle("add that to my to-do list"))?.reply).toBe("What exactly should the to-do say?");
    expect((await f.handle("Melissa Lee invoice."))?.reply).toContain("“Melissa Lee invoice”");
    await f.handle("yes");
    expect(save).toHaveBeenCalledExactlyOnceWith("Melissa Lee invoice");
  });

  it("answers with the wake word or courtesy words still count; 'no, don't add it' cancels", async () => {
    const { f, save } = flow();
    await f.handle("add Melissa Lee invoice to my to-do list");
    expect((await f.handle("Tony, yes please"))?.reply).toBe("Added “Melissa Lee invoice” to your to-do list.");
    expect(save).toHaveBeenCalledExactlyOnceWith("Melissa Lee invoice");
    await f.handle("add call Sam to my to-do list");
    expect((await f.handle("No, don't add it"))?.reply).toBe("Okay, I didn't add it.");
    await f.handle("add call Sam to my to-do list");
    expect((await f.handle("no, never mind"))?.reply).toBe("Okay, I didn't add it.");
    await f.handle("add call Sam to my to-do list");
    expect((await f.handle("hey Tony, no thanks"))?.reply).toBe("Okay, I didn't add it.");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("an unrelated line or an expired question saves nothing and falls through", async () => {
    const { f, save, tick } = flow();
    await f.handle("add Melissa Lee invoice to my to-do list");
    expect(await f.handle("what's the weather")).toBeNull();
    expect(await f.handle("yes")).toBeNull();
    await f.handle("add Melissa Lee invoice to my to-do list");
    tick(TODO_CONFIRM_TTL_MS + 1);
    expect(await f.handle("yes")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
