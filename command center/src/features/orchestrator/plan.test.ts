import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer, OsConfig } from "@/lib/platform";
import { PRESET_MODES, effectiveOf } from "@/features/modes/modes";
import { resetModesForTests, useModes } from "@/features/modes/modes-store";
import { useOs } from "@/features/os/os-store";
import { heuristicPlan, parseConfirmation, parseOfferReply, stripWake } from "./plan";
import { cardWhen, describeWhen } from "./calendar-add";

const desktop = () => vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
afterEach(() => {
  vi.unstubAllGlobals();
  resetModesForTests();
  useOs.setState({ cfg: null });
});

describe("heuristicPlan — Gmail draft binding", () => {
  it("a draft with an address is a mutating gmail.create_draft tool plan", () => {
    desktop();
    const p = heuristicPlan("Hey Tony, draft an email to sam@acme.ca about lunch saying I'm running late", "general");
    expect(p.mutating).toBe(true);
    expect(p.target).toEqual({ kind: "tool", tool: "gmail.create_draft", args: { to: "sam@acme.ca", subject: "Lunch", body: "I'm running late" } });
    expect(p.payload).toEqual({ to: "sam@acme.ca", subject: "Lunch", body: "I'm running late" });
    expect(p.readBack).toMatch(/Gmail draft to sam@acme\.ca.*won't be sent.*Proceed\?$/);
    expect(p.run).toBeUndefined();
  });

  it("no address → a read-only reply asking for it, never a gateway agent", async () => {
    desktop();
    const p = heuristicPlan("draft a reply to my last email", "booking");
    expect(p.mutating).toBe(false);
    expect((await p.run!()).text).toMatch(/Who should the draft go to\?/);
  });

  it("an address-less draft routed to the Booking Desk stays the Booking Desk's", () => {
    desktop();
    const p = heuristicPlan("draft an email to my agent about the self-tape", "booking");
    expect(p.run).toBeUndefined();
    expect(p.target?.kind).not.toBe("tool");
    expect(heuristicPlan("draft an email to my agent about the self-tape", "general").run).toBeDefined();
  });

  it("on the phone a draft is a polite read-only reply", async () => {
    const p = heuristicPlan("draft an email to sam@acme.ca saying hi", "general");
    expect(p.mutating).toBe(false);
    expect((await p.run!()).text).toMatch(/desktop app/);
  });
});

describe("heuristicPlan — Instagram writes are gated tool plans", () => {
  it("a publish request is a mutating instagram.publish_post plan with a live-post read-back", () => {
    desktop();
    const p = heuristicPlan("Tony, post https://cdn.example.com/headshot.jpg to Instagram with caption New headshots", "general");
    expect(p.mutating).toBe(true);
    expect(p.target).toEqual({ kind: "tool", tool: "instagram.publish_post", args: { caption: "New headshots", imageUrl: "https://cdn.example.com/headshot.jpg" } });
    expect(p.readBack).toMatch(/publish a photo to Instagram with the caption "New headshots".*goes live.*Proceed\?$/);
    expect(p.run).toBeUndefined();
  });

  it("a comment reply is a mutating instagram.reply_comment plan", () => {
    desktop();
    const p = heuristicPlan("reply to Instagram comment 17890012345 saying thank you!", "general");
    expect(p.mutating).toBe(true);
    expect(p.target).toEqual({ kind: "tool", tool: "instagram.reply_comment", args: { commentId: "17890012345", message: "thank you!" } });
  });

  it("no media link → Tony asks, nothing is planned", async () => {
    desktop();
    const p = heuristicPlan("post my new headshot to Instagram", "general");
    expect(p.mutating).toBe(false);
    expect((await p.run!()).text).toMatch(/https link/);
  });
});

describe("heuristicPlan — an approved-action card only for a live tool its agent owns", () => {
  const DRAFT = "draft an email to sam@acme.ca about lunch saying I'm running late";
  const POST = "post https://cdn.example.com/headshot.jpg to Instagram with caption New headshots";
  const server = (id: string, agents: string[] | null) => ({ id, name: id, agents, enabled: true, transport: "builtin", builtin: true }) as unknown as McpServer;
  const withCfg = (mcps: McpServer[], frozenTools: string[] = []) => useOs.setState({ cfg: { mcps, switchboard: { version: 1, frozenAgents: [], frozenTools } } as unknown as OsConfig });
  const replyOf = async (p: ReturnType<typeof heuristicPlan>) => (await p.run!()).text;

  it("a mode that freezes Gmail: no card, Tony gives the frozen reason", async () => {
    desktop();
    useModes.setState({ effective: effectiveOf(PRESET_MODES, "builder") });
    const p = heuristicPlan(DRAFT, "general");
    expect(p.mutating).toBe(false);
    expect(p.target.kind).toBe("agent");
    expect(await replyOf(p)).toBe("Gmail is frozen in Builder mode, so I left it alone. Switch modes and I can use it.");
  });

  it("Instagram frozen on the master switchboard: no card, the master reason", async () => {
    desktop();
    withCfg([server("instagram", null)], ["instagram"]);
    const p = heuristicPlan(POST, "general");
    expect(p.mutating).toBe(false);
    expect(await replyOf(p)).toBe("Instagram is frozen on the master switchboard, so I left it alone. Turn it back on in the switchboard and I can use it.");
    const reply = heuristicPlan("reply to Instagram comment 17890012345 saying thank you!", "general");
    expect(reply.mutating).toBe(false);
    expect(reply.target.kind).toBe("agent");
  });

  it("a tool another agent owns: no card for this one, 'that's <owner>'s job'", async () => {
    desktop();
    withCfg([server("gmail", ["bizops"])]);
    const p = heuristicPlan(DRAFT, "general");
    expect(p.mutating).toBe(false);
    expect(await replyOf(p)).toBe("That's Biz Ops's job — ask Biz Ops to do it.");
    // …while its owner gets the card.
    expect(heuristicPlan(DRAFT, "bizops").target).toMatchObject({ kind: "tool", tool: "gmail.create_draft" });
  });

  it("live and owned (an 'all' grant, or one naming the agent): today's card", () => {
    desktop();
    withCfg([server("gmail", ["all"]), server("instagram", ["general", "ops"])]);
    useModes.setState({ effective: effectiveOf(PRESET_MODES, "operations") });
    expect(heuristicPlan(DRAFT, "general")).toMatchObject({ mutating: true, target: { kind: "tool", tool: "gmail.create_draft" } });
    expect(heuristicPlan(POST, "ops")).toMatchObject({ mutating: true, target: { kind: "tool", tool: "instagram.publish_post" } });
  });
});

describe("heuristicPlan — the calendar-add card (A2)", () => {
  const NOW = new Date(2026, 10, 26, 10, 0, 0);
  const NETFLIX = { threadId: "t1", subject: "CONFIRMED: Netflix day player", from: "Sam Agent <sam@agency.ca>", date: "2026-11-28", time: "06:30", location: "Pinewood Studios" };

  it("is a mutating calendar.create_event plan for Tony, fields from the booking scan, gaps on the card", () => {
    desktop();
    const p = heuristicPlan("Hey Tony, add it to my calendar", "ops", { bookings: [NETFLIX], now: NOW });
    expect(p.mutating).toBe(true);
    expect(p.role).toBe("general");
    expect(p.target).toEqual({ kind: "tool", tool: "calendar.create_event", args: expect.objectContaining({ title: "CONFIRMED: Netflix day player", date: "2026-11-28", startTime: "06:30", location: "Pinewood Studios" }) });
    expect(p.missing).toEqual(["end time"]);
    const fields = 'location "Pinewood Studios"; note: From Gmail: "CONFIRMED: Netflix day player" from Sam Agent <sam@agency.ca>';
    expect(p.summary).toBe('Add "CONFIRMED: Netflix day player" to Google Calendar: Sat Nov 28, 6:30 AM');
    expect(p.fromEmail).toBe(fields);
    expect(cardWhen(p.target)).toBe("Sat Nov 28, 6:30 AM");
    expect(p.readBack).toBe(`Got it — adding "CONFIRMED: Netflix day player" to your Google Calendar on Sat Nov 28, 6:30 AM, for an hour. From the email: ${fields}. No invites go out. I don't have the end time. Proceed?`);
    expect(p.source).toEqual({ subject: NETFLIX.subject, from: NETFLIX.from, date: "2026-11-28", time: "06:30", location: "Pinewood Studios" });
    expect(p.run).toBeUndefined();
  });

  it("review note (A2): the mail's location and note are on the card's visible line and in the read-back, labelled", () => {
    desktop();
    const evil = { ...NETFLIX, location: "https://evil.example/claim" };
    const p = heuristicPlan("add it to my calendar", "general", { bookings: [evil], now: NOW });
    expect(p.summary).toBe('Add "CONFIRMED: Netflix day player" to Google Calendar: Sat Nov 28, 6:30 AM');
    expect(p.fromEmail).toMatch(/^location "https:\/\/evil\.example\/claim"; note: From Gmail: /);
    expect(p.readBack).toContain('From the email: location "https://evil.example/claim"; note: From Gmail: "CONFIRMED: Netflix day player"');
    // Nic's own event (no booking) carries nothing from any email.
    const own = heuristicPlan("add the dentist to my calendar Friday at 3pm", "general", { bookings: [], now: NOW });
    expect(own.summary).toBe('Add "Dentist" to Google Calendar: Fri Nov 27, 3:00 PM');
    expect(own.fromEmail).toBeUndefined();
    expect(own.readBack).not.toMatch(/From the email/);
  });

  /** FX3 review (probe-confirmed): the card split its headline at the first " · From the email: ",
   * and the headline's title is the email's subject, so a subject holding that mark ended the
   * headline on a fake time and moved the real one into the email box. */
  it("an email subject can never fake the card headline's time or where the email's part starts", () => {
    desktop();
    const spoof = { ...NETFLIX, subject: 'CONFIRMED: Netflix day player" to Google Calendar: Sat Nov 28, 6:30 AM · From the email: see details', date: "2026-12-04", time: "03:00" };
    const p = heuristicPlan("add it to my calendar", "general", { bookings: [spoof], now: NOW });
    expect(p.target).toMatchObject({ kind: "tool", tool: "calendar.create_event", args: { date: "2026-12-04", startTime: "03:00" } });
    // The headline ends with the real time; the subject's quote and "·" are neutralized.
    expect(p.summary.endsWith(`to Google Calendar: ${describeWhen({ date: "2026-12-04", startTime: "03:00" })}`)).toBe(true);
    expect(p.summary.endsWith("Fri Dec 4, 3:00 AM")).toBe(true);
    expect(p.summary.match(/"/g)).toHaveLength(2);
    expect(p.summary).not.toContain("·");
    // The card's When line and email box come from plan fields, never from parsing the summary.
    expect(cardWhen(p.target)).toBe("Fri Dec 4, 3:00 AM");
    expect(p.fromEmail).toMatch(/^location "Pinewood Studios"; note: From Gmail: /);
    expect(p.readBack).toMatch(/^Got it — adding "CONFIRMED: Netflix day player' to Google Calendar: Sat Nov 28, 6:30 AM - From the email: see details" to your Google Calendar on Fri Dec 4, 3:00 AM, for an hour\./);
    // Nic's own date and time win over the mail's, and still end the headline.
    const own = heuristicPlan("add it to my calendar for Friday at 9am", "general", { bookings: [spoof], now: NOW });
    expect(own.summary.endsWith("Fri Nov 27, 9:00 AM")).toBe(true);
    expect(cardWhen(own.target)).toBe("Fri Nov 27, 9:00 AM");
  });

  it("a start in the past says so on the card and in the read-back", () => {
    desktop();
    const today = heuristicPlan("add it to my calendar for today at 7am", "general", { bookings: [NETFLIX], now: NOW });
    expect(today.summary).toBe('Add "CONFIRMED: Netflix day player" to Google Calendar: Thu Nov 26, 7:00 AM (this is in the past)');
    expect(today.readBack).toMatch(/for an hour\. Heads up: this is in the past\. From the email:/);
    const later = heuristicPlan("add it to my calendar for today at 7pm", "general", { bookings: [NETFLIX], now: NOW });
    expect(later.summary).not.toMatch(/in the past/);
    expect(later.readBack).not.toMatch(/in the past/);
    const allDayYesterday = heuristicPlan("add the wrap party to my calendar for 11/25", "general", { bookings: [], now: NOW });
    expect(allDayYesterday.summary).toBe('Add "Wrap party" to Google Calendar: Wed Nov 25 (all day) (this is in the past)');
  });

  it("never a gateway agent: no scan or no date is Tony's question, the PWA says use the app", async () => {
    desktop();
    const ask = heuristicPlan("add it to my calendar", "general", { bookings: [], now: NOW });
    expect(ask.mutating).toBe(false);
    expect((await ask.run!()).text).toMatch(/What should I put on your calendar\?/);
    vi.unstubAllGlobals();
    const pwa = heuristicPlan("add it to my calendar", "general", { bookings: [NETFLIX], now: NOW });
    expect(pwa.mutating).toBe(false);
    expect((await pwa.run!()).text).toBe("Calendar adds go through the app — ask me there.");
  });

  it("a mode that freezes the calendar: no card, the frozen reason", async () => {
    desktop();
    useModes.setState({ effective: effectiveOf(PRESET_MODES, "builder") });
    const p = heuristicPlan("add it to my calendar", "general", { bookings: [NETFLIX], now: NOW });
    expect(p.mutating).toBe(false);
    expect((await p.run!()).text).toMatch(/^Google Calendar is frozen in Builder mode, so I left it alone\./);
  });

  it("a calendar read is never an action", () => {
    desktop();
    expect(heuristicPlan("what's on my calendar tomorrow", "general").mutating).toBe(false);
  });

  it("schedule / create / book phrasings are the calendar card too, never a gateway agent", () => {
    desktop();
    const sched = heuristicPlan("schedule the Netflix shoot on my calendar for Friday at 7am", "ops", { bookings: [NETFLIX], now: NOW });
    expect(sched).toMatchObject({ mutating: true, role: "general", target: { kind: "tool", tool: "calendar.create_event", args: { title: "CONFIRMED: Netflix day player", date: "2026-11-27", startTime: "07:00" } } });
    const create = heuristicPlan("create an event on my calendar for the audition Friday at 2pm", "ops", { bookings: [], now: NOW });
    expect(create).toMatchObject({ mutating: true, target: { kind: "tool", tool: "calendar.create_event", args: { title: "Audition", date: "2026-11-27", startTime: "14:00" } } });
    const book = heuristicPlan("book the shoot in my calendar", "booking", { bookings: [NETFLIX], now: NOW });
    expect(book).toMatchObject({ mutating: true, target: { kind: "tool", tool: "calendar.create_event", args: { date: "2026-11-28" } } });
  });

  it("a question about an add is Tony's read, never a second card", () => {
    desktop();
    for (const q of ["did you add it to my calendar?", "did you put the Netflix shoot on my calendar?", "Hey Tony, have you added it to my calendar yet, Tony?", "did you add it to my calendar, and is it right?"]) {
      const p = heuristicPlan(q, "ops", { bookings: [NETFLIX], now: NOW });
      expect(p.mutating, q).toBe(false);
      expect(p.target.kind, q).toBe("agent");
      expect(p.role, q).toBe("general");
      expect(p.run, q).toBeUndefined();
    }
  });

  it("any other write on the calendar is Tony's plain reply, never an agent card", async () => {
    desktop();
    const move = heuristicPlan("move the Netflix shoot on my calendar to Saturday", "ops", { bookings: [NETFLIX], now: NOW });
    expect(move).toMatchObject({ mutating: false, role: "general", target: { kind: "agent" } });
    expect((await move.run!()).text).toMatch(/^I can only add events to your Google Calendar\..*nothing was changed\.$/);
    const odd = heuristicPlan("I'd love it if the Netflix shoot ended up in my calendar, set that up", "ops", { bookings: [NETFLIX], now: NOW });
    expect(odd.mutating).toBe(false);
    expect((await odd.run!()).text).toMatch(/say it like "add the Netflix shoot to my calendar/);
    // A coding task about a calendar is no calendar action: it keeps its agent and its card.
    const code = heuristicPlan("add a calendar view to the dashboard", "coder");
    expect(code).toMatchObject({ mutating: true, role: "coder", target: { kind: "agent" } });
  });
});

describe("heuristicPlan — music controls are never gateway actions", () => {
  it.each(["set the volume to 30", "pause music", "pause the music", "play some jazz on spotify", "skip this song", "turn it down", "set spotify to 40%", "spotify volume 20", "resume spotify", "change the song", "start my workout playlist", "restart the track"])("%s", (s) => {
    const p = heuristicPlan(s, "general");
    expect(p.mutating).toBe(false);
    expect(p.target.kind).toBe("agent");
  });

  it("still treats real actions as mutating", () => {
    expect(heuristicPlan("cancel my dinner with Sam", "booking").mutating).toBe(true);
    expect(heuristicPlan("set a meeting with Jo on Friday", "booking").mutating).toBe(true);
    expect(heuristicPlan("add a todo to Linear", "general").mutating).toBe(true);
    expect(heuristicPlan("send this song to Sam", "general").mutating).toBe(true);
  });

  // Spotify library edits are Tony's: the Rust tool path gates them and raises the card (askCards).
  it.each(["add this song to my late night playlist", "create a playlist called Road Trip", "like this song on spotify", "queue up some jazz on spotify", "shuffle my liked songs"])(
    "%s is a Spotify line, not a gateway action",
    (s) => {
      const p = heuristicPlan(s, "general");
      expect(p.mutating).toBe(false);
      expect(p.target.kind).toBe("agent");
    },
  );
});

describe("stripWake — interjections before the name", () => {
  it.each([
    ["aye tony can you play some bilmuri", "can you play some bilmuri"],
    ["Ayy, Tony, pause the music", "pause the music"],
    ["ayo jarvis what's playing", "what's playing"],
    ["hi tony, skip this", "skip this"],
    ["Hey Tony: check my email", "check my email"],
  ])("%s → %s", (input, out) => {
    expect(stripWake(input)).toBe(out);
  });

  it("keeps the name when it isn't an address, and whole words only", () => {
    expect(stripWake("play tony bennett")).toBe("play tony bennett");
    expect(stripWake("ayesha called")).toBe("ayesha called");
  });

  it("'aye tony, play …' is a music control, never a gateway action", () => {
    const p = heuristicPlan("aye tony can you play some bilmuri", "general");
    expect(p.mutating).toBe(false);
    expect(p.target.kind).toBe("agent");
  });
});

describe("heuristicPlan — trailing addressed name", () => {
  it("', Tony.' at the end never lands in the draft", () => {
    desktop();
    const p = heuristicPlan("Draft an email to sam@gmail.com saying I'm running late, Tony.", "general");
    expect(p.target).toMatchObject({ kind: "tool", tool: "gmail.create_draft" });
    expect(JSON.stringify(p.target)).not.toMatch(/tony/i);
  });
});

describe("heuristicPlan — 'update' questions are read-only", () => {
  it.each(["give me an update on whatsapp", "any whatsapp updates?", "update me on the self-tape", "what's the latest update from the coder", "any updates from finance"])("%s", (s) => {
    expect(heuristicPlan(s, "general").mutating).toBe(false);
  });

  it("'ask the coder for an update' is read-only and stays Named to the coder", () => {
    const p = heuristicPlan("ask the coder for an update");
    expect(p.mutating).toBe(false);
    expect(p.role).toBe("coder");
  });

  it("real updates and settings stay mutating", () => {
    expect(heuristicPlan("update the invoice", "ops").mutating).toBe(true);
    expect(heuristicPlan("set the meeting for Friday", "booking").mutating).toBe(true);
    expect(heuristicPlan("update my status update template", "general").mutating).toBe(true);
    expect(heuristicPlan("reply to Sam on WhatsApp", "general").mutating).toBe(true);
  });

  it.each(["apply the latest update to the server", "roll back the update", "ship the update to production", "download the update"])(
    "an 'update' noun after an action verb stays mutating: %s",
    (s) => {
      expect(heuristicPlan(s, "general").mutating).toBe(true);
    },
  );
});

describe("heuristicPlan — live-tool words never hide a write", () => {
  it.each([
    "pay the invoice from the latest email",
    "add the new emails from Sam to my todo list",
    "mark all emails from Sam as read",
    "cancel the meeting from my inbox invite",
    "add umbrella to my shopping list",
    "update the sales forecast spreadsheet",
    "schedule a meeting with Sam about the forecast",
    "email the forecast to Sam",
    "mute the WhatsApp chat with Sam",
    "buy an umbrella on amazon",
    "Booking, order an umbrella for the shoot",
    "Ops, turn off the weather alerts",
  ])("%s", (s) => {
    expect(heuristicPlan(s, "general").mutating).toBe(true);
  });

  it("a live read question stays read-only", () => {
    expect(heuristicPlan("check my inbox", "general").mutating).toBe(false);
    expect(heuristicPlan("will it rain tomorrow", "general").mutating).toBe(false);
  });
});

describe("P3 — offer replies and defer lines", () => {
  it("parseConfirmation is unchanged: nah / no / not now are never a yes", () => {
    expect(parseConfirmation("nah")).toBe("no");
    expect(parseConfirmation("nah, save it for later")).toBe("no");
    expect(parseConfirmation("no")).toBe("no");
    expect(parseConfirmation("yes")).toBe("yes");
    expect(parseConfirmation("yes, but change the time")).toBe("unclear");
    expect(parseConfirmation("park it")).toBe("unclear");
  });

  it("parseOfferReply: park / save before no", () => {
    for (const r of ["nah, save it for later", "nah save it", "park it", "Park it.", "save it for later", "later", "maybe later", "put it in Play Place", "add it to my brainstorming list", "no, park that"]) {
      expect(parseOfferReply(r), r).toBe("park");
    }
  });

  it("parseOfferReply: yes / delegate", () => {
    for (const r of ["yes", "yeah", "go ahead", "do it", "Hey Tony, yes", "delegate it", "send it over"]) expect(parseOfferReply(r), r).toBe("yes");
    expect(parseOfferReply("yes but not yet")).toBe("other");
  });

  it("parseOfferReply: no / not now", () => {
    for (const r of ["no", "nope", "nah", "not now", "no thanks", "cancel"]) expect(parseOfferReply(r), r).toBe("no");
  });

  it("parseOfferReply: anything else is a new turn", () => {
    for (const r of ["actually what about dark mode", "what would it cost", "keep going", "tell me more"]) expect(parseOfferReply(r), r).toBe("other");
  });

  it("a defer line never becomes a mutating plan", () => {
    for (const u of ["add it to my brainstorming list", "add this to the ideas and tasks ledger", "put it in Play Place", "move that to the ledger"]) {
      expect(heuristicPlan(u, "general").mutating, u).toBe(false);
    }
    // …while ordinary adds keep their card.
    expect(heuristicPlan("add a todo to Linear", "general").mutating).toBe(true);
    expect(heuristicPlan("add milk to my shopping list", "general").mutating).toBe(true);
  });
});
