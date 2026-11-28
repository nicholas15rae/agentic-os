/**
 * UI fixes 4: Play Place steers back (pure). From a rough idea it works out which kind of build it
 * is, pitches that (and a better fit when there is one), asks a few sharp questions, and writes the
 * brief the pipeline builds from. Nothing is built until Nic says yes on the confirmation card.
 *
 *   novelty    — a live character in the overlay layer (features/characters)
 *   functional — a widget on a page
 *   standalone — its own app outside Gabagoul
 */
export type BuildKind = "novelty" | "functional" | "standalone";
export const KINDS: readonly BuildKind[] = ["novelty", "functional", "standalone"];

export const KIND_LABEL: Record<BuildKind, string> = { novelty: "Live character", functional: "Widget", standalone: "Its own app" };
export const KIND_BLURB: Record<BuildKind, string> = {
  novelty: "A little character over the app: tucked in a corner, pops up when something happens, reacts, tucks away.",
  functional: "A panel on a page that does one job at a glance.",
  standalone: "A separate app or project outside Gabagoul, with its own folder.",
};

/** Words that point at each kind (weight per hit). */
const SIGNALS: Record<BuildKind, [RegExp, number][]> = {
  novelty: [
    [/\b(character|mascot|creature|critter|buddy|companion|sidekick|pet|little guy|gremlin)\b/, 3],
    [/\b(pops? up|pop-up|peeks?|wanders?|dances?|wiggles?|reacts?|celebrates?|cheers?)\b/, 2],
    [/\b(cute|funny|silly|cheeky|easter egg|confetti|emoji|sticker|toy|fun|delight)\b/, 1],
    [/\b(cat|dog|ghost|robot|frog|duck|bird|slime|blob)\b/, 1],
  ],
  functional: [
    [/\b(widget|panel|tile|card)\b/, 2],
    [/\b(track(er|s|ing)?|timer|countdown|calendar|chart|graph|stats?|list|checklist|reminders?|notes?|log|summary|budget|calculator|convert(er)?|inbox|weather|progress|habit)\b/, 2],
    [/\b(show|shows|see|glance|today|my|button|quick)\b/, 1],
  ],
  standalone: [
    [/\b(app|application|game|website|site|web ?page|portfolio|platform|extension|bot|cli|script|tool)\b/, 2],
    [/\b(standalone|separate|its own|own app|outside|export|repo|project|launch|publish|sell|clients?|customers?|share (it )?with)\b/, 3],
    [/\b(mobile|ios|android|multi-?page|login|accounts?|database|backend)\b/, 1],
  ],
};

export interface Classification {
  kind: BuildKind;
  scores: Record<BuildKind, number>;
  /** 0-1: how clearly the words point at `kind`. */
  confidence: number;
  /** The words that decided it. */
  reasons: string[];
}

/** Which kind of build an idea is. A tie (or no signal) is a widget. Pure. */
export function classifyIdea(text: string): Classification {
  const t = ` ${text.toLowerCase()} `;
  const scores: Record<BuildKind, number> = { novelty: 0, functional: 0, standalone: 0 };
  const reasons: Record<BuildKind, string[]> = { novelty: [], functional: [], standalone: [] };
  for (const k of KINDS)
    for (const [re, w] of SIGNALS[k]) {
      const g = new RegExp(re.source, "g");
      for (const m of t.matchAll(g)) {
        scores[k] += w;
        if (!reasons[k].includes(m[0].trim())) reasons[k].push(m[0].trim());
      }
    }
  const order = [...KINDS].sort((a, b) => scores[b] - scores[a] || (a === "functional" ? -1 : b === "functional" ? 1 : 0));
  const kind = scores[order[0]] > 0 ? order[0] : "functional";
  const total = scores.novelty + scores.functional + scores.standalone;
  return { kind, scores, confidence: total ? scores[kind] / total : 0, reasons: reasons[kind].slice(0, 4) };
}

/** The kind that would fit nearly as well (scores within reach of the top), if any. Pure. */
export function runnerUp(c: Classification): BuildKind | null {
  const rest = KINDS.filter((k) => k !== c.kind).sort((a, b) => c.scores[b] - c.scores[a]);
  const r = rest[0];
  return c.scores[r] > 0 && c.scores[r] >= c.scores[c.kind] * 0.5 ? r : null;
}

export interface SteerOption {
  label: string;
  /** Taste traits a pick says something about. */
  tags?: string[];
}
export interface SteerQuestion {
  id: string;
  question: string;
  options: SteerOption[];
  /** "Or say it your way". */
  freeText?: boolean;
}

const Q: Record<BuildKind, SteerQuestion[]> = {
  novelty: [
    { id: "trigger", question: "What makes it pop up?", options: [{ label: "When I finish something" }, { label: "Now and then, on its own" }, { label: "Only when I tap it" }, { label: "When Tony talks" }], freeText: true },
    {
      id: "personality",
      question: "What's its personality?",
      options: [
        { label: "Cheeky", tags: ["playful"] },
        { label: "Calm and cute", tags: ["cute", "calm"] },
        { label: "Hype-man", tags: ["bold", "animated"] },
        { label: "Deadpan", tags: ["minimal"] },
      ],
    },
    { id: "where", question: "Where does it hang out?", options: [{ label: "A bottom corner" }, { label: "A top corner" }, { label: "Wherever there's room" }] },
  ],
  functional: [
    { id: "where", question: "Where does it go?", options: [{ label: "Home page" }, { label: "A section's page" }, { label: "A pop-up window" }] },
    { id: "glance", question: "What's the one thing it shows at a glance?", options: [{ label: "A number" }, { label: "A short list" }, { label: "A chart" }, { label: "One big button" }], freeText: true },
    {
      id: "look",
      question: "How should it feel?",
      options: [
        { label: "Glass, like the rest", tags: ["glass", "dark"] },
        { label: "Bold and colourful", tags: ["bold", "colourful"] },
        { label: "Minimal, just text", tags: ["minimal"] },
        { label: "Lively, a bit animated", tags: ["animated", "playful"] },
      ],
    },
  ],
  standalone: [
    { id: "who", question: "Who is it for?", options: [{ label: "Just me" }, { label: "Clients or castings" }, { label: "Friends and family" }, { label: "Anyone" }], freeText: true },
    { id: "runs", question: "Where does it run?", options: [{ label: "Desktop" }, { label: "Phone" }, { label: "A web page" }, { label: "Command line" }] },
    { id: "scope", question: "How big is the first version?", options: [{ label: "One screen that works", tags: ["minimal"] }, { label: "A few screens" }, { label: "A clickable mock-up first" }] },
  ],
};

/** The feeling question for ideas too short to say much. */
const FEELING: SteerQuestion = {
  id: "feeling",
  question: "What should it feel like when you see it?",
  options: [
    { label: "A little laugh", tags: ["playful"] },
    { label: "Calm and on top of things", tags: ["calm", "minimal"] },
    { label: "Fired up", tags: ["bold", "animated"] },
    { label: "Cosy", tags: ["cute", "rounded"] },
  ],
};

/** A few sharp questions for this kind (plus the feeling one for a very short idea). Pure. */
export function questionsFor(kind: BuildKind, idea: string): SteerQuestion[] {
  const short = idea.trim().split(/\s+/).filter(Boolean).length < 6;
  return short ? [...Q[kind], FEELING] : Q[kind];
}

export interface Pitch {
  kind: BuildKind;
  text: string;
}

/** What Play Place says back: its pick, a better fit when there is one, in plain words. Pure. */
export function pitchesFor(idea: string, c: Classification, tasteLine: string | null): Pitch[] {
  void idea;
  const out: Pitch[] = [];
  const say: Record<BuildKind, string> = {
    novelty: `I'd make this a live character: tucked in a corner, it pops up when something happens and tucks away again. Want that?`,
    functional: `I'd make this a widget: one glance, one tap, on the page you choose. Want that?`,
    standalone: `This sounds bigger than a widget. I'd build it as its own app outside Gabagoul, with its own folder. Want that?`,
  };
  out.push({ kind: c.kind, text: say[c.kind] });
  const alt = runnerUp(c);
  // The spec's own example: a widget idea with character in it.
  if (c.kind === "functional" && c.scores.novelty > 0) out.push({ kind: "novelty", text: `This would work better as a pop-up character than a box. Want that instead?` });
  else if (alt) out.push({ kind: alt, text: alt === "standalone" ? `Or it could grow into its own app later.` : alt === "novelty" ? `Or a cheeky character that does it for you.` : `Or keep it simple: a widget first.` });
  if (tasteLine) out.push({ kind: c.kind, text: `${tasteLine} I'll start there.` });
  return out;
}

export type SteerAnswers = Record<string, { choice?: string; text?: string }>;

/** The first few words, tidied: what the build is called. Pure. */
export function shortName(idea: string): string {
  let s = idea.trim();
  // Drop the lead-in ("I want a…", "can you make me a…"), one word group at a time.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^(i want|i'd like|i would like|can you|could you|please|make|build|create|give|a|an|me|some)\b[\s,]*/i, "");
  }
  const words = s
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.join(" ").toLowerCase();
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The build's title. Pure. */
export const titleFor = (idea: string): string => cap(shortName(idea)).slice(0, 60) || "New idea";

/** The house rules each kind is built to (the pipeline's checklist reads these). */
const RULES: Record<BuildKind, string> = {
  novelty:
    "Build it as a live character for the overlay layer: an original design, tiny idle animation in short bursts (no endless loops), tucked in a corner at rest, pops up and reacts when its trigger happens or when tapped, then tucks away. It must never block clicks (only its own small body takes them), never cover a safety control, honour reduced motion, and be easy to mute or hide.",
  functional:
    "Build it as a dashboard widget on the shared layout system: uses the style kit (--cc-* variables, live cc-theme), reads well small, every point of the brief works in a real browser.",
  standalone:
    "Build it as its own app outside Gabagoul: its own folder with the brief, assets and code so far, a README saying how to run it, and nothing wired into the Command Center.",
};

/** The brief the pipeline builds from: idea, kind and its rules, the answers, the taste. Pure. */
export function steerBrief(idea: string, kind: BuildKind, qs: SteerQuestion[], answers: SteerAnswers, tasteLine: string | null): string {
  const lines = [titleFor(idea), "", `Idea (Nic's words): ${idea.trim()}`, `Kind: ${KIND_LABEL[kind]}. ${RULES[kind]}`];
  const said = qs
    .map((q) => {
      const a = answers[q.id];
      const v = [a?.choice, a?.text?.trim()].filter(Boolean).join(": ");
      return v ? `- ${q.question} ${v}` : null;
    })
    .filter(Boolean);
  if (said.length) lines.push("", "Nic's answers:", ...(said as string[]));
  if (tasteLine) lines.push("", `Taste: ${tasteLine}`);
  return lines.join("\n");
}

/** The taste tags behind the answers given. Pure. */
export function tagsFromAnswers(qs: SteerQuestion[], answers: SteerAnswers): string[] {
  const out: string[] = [];
  for (const q of qs) {
    const o = q.options.find((x) => x.label === answers[q.id]?.choice);
    for (const t of o?.tags ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}
