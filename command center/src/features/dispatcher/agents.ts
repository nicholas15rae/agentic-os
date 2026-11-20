import type { LucideIcon } from "lucide-react";
import { BookOpen, Bot, CalendarCheck, Code2, ListTree, Palette, Radar, Sparkles } from "lucide-react";
import type { Priority } from "@/lib/platform";
import { osName } from "@/features/os/os-store";
import { TONY_INTRO, TONY_ROLE, TONY_STYLE } from "@/features/voice/persona";
import { modeBlock } from "@/features/modes/modes";
import { useModes } from "@/features/modes/modes-store";

/**
 * Sub-agent catalogue. The dispatcher picks one per request, prepends its
 * system prompt, and hands the request to the Rust routing policy, which picks
 * the *provider* (local GGUF via LM Studio / AnythingLLM, or the cloud droplet).
 *
 * Add an agent: append an entry to `AGENT_DEFS`. Nothing else needs to change. An id that is in the
 * routing registry (os.json `routing.agents`) but not here — a future read-only specialist such as
 * Security Patrol or Finance (Phase 2 §4, prep only) — still resolves: `agentFor` / `SUB_AGENTS[id]`
 * give it a generic read-only agent that reports to Tony, labelled from its id.
 */
export type KnownRole = "librarian" | "coder" | "booking" | "ops" | "prompter" | "designer" | "general";
/** A known role, or any later registry id (validated `^[a-z][a-z0-9_-]{0,31}$` in Rust). */
export type AgentRole = KnownRole | (string & {});

export interface SubAgent {
  role: AgentRole;
  label: string;
  icon: LucideIcon;
  /** Agentic OS backend agent to use when running as a PWA via the gateway. */
  gatewayAgent: "opencode" | "agy";
  priority: Priority;
  keywords: string[];
  systemPrompt: string;
}

const GUARDRAIL =
  "Never send messages, make purchases, book, pay, delete, or change accounts yourself. " +
  "Propose the exact action and wait for the user's explicit confirmation.";

const AGENT_DEFS: SubAgent[] = [
  {
    role: "prompter",
    label: "Prompter",
    icon: ListTree,
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: ["break down", "breakdown", "spec", "requirements", "user stories", "prompt for", "write a prompt", "task list", "roadmap"],
    get systemPrompt() {
      return `You are Prompter, the planning agent of ${osName()}. Turn goals into precise specs, task lists and prompts for the other agents. ${GUARDRAIL}`;
    },
  },
  {
    role: "designer",
    label: "Designer",
    icon: Palette,
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: ["design", "ui", "ux", "mockup", "wireframe", "layout", "palette", "typography", "landing page", "screen", "component", "brand", "logo", "aesthetic"],
    get systemPrompt() {
      return `You are Designer, the UI/UX agent of ${osName()}. Answer with design tokens, component hierarchies, wireframes and self-contained HTML/Tailwind prototypes — never generic advice. ${GUARDRAIL}`;
    },
  },
  {
    role: "librarian",
    label: "Librarian",
    icon: BookOpen,
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: ["find", "search", "summar", "email", "gmail", "doc", "note", "remember", "research", "what did", "file"],
    get systemPrompt() {
      return `You are Librarian, the knowledge and retrieval agent of ${osName()}. You search the user's files, notes, email digests and memory, cite where each fact came from, and say plainly when something is not found. ${GUARDRAIL}`;
    },
  },
  {
    role: "coder",
    label: "Coder",
    icon: Code2,
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: ["code", "bug", "build", "deploy", "refactor", "test", "repo", "git", "function", "error", "compile"],
    get systemPrompt() {
      return `You are Coder, the software agent of ${osName()}. Be precise and terse; prefer diffs and runnable commands. ${GUARDRAIL}`;
    },
  },
  {
    role: "booking",
    label: "Booking Desk",
    icon: CalendarCheck,
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: [
      "book", "reserve", "reservation", "schedule", "meeting", "calendar", "event", "appointment", "remind",
      "flight", "hotel", "dinner", "lunch", "breakfast", "table", "rsvp", "invite",
    ],
    get systemPrompt() {
      return `You are Booking Desk, the scheduling agent of ${osName()}. Gather date, time, place and party size, then present one clear proposal. ${GUARDRAIL}`;
    },
  },
  {
    role: "ops",
    label: "Ops",
    icon: Radar,
    gatewayAgent: "opencode",
    priority: "background",
    keywords: ["docker", "container", "netbird", "n8n", "workflow", "webhook", "droplet", "server", "uptime", "gpu", "vram"],
    get systemPrompt() {
      return `You are Ops, the infrastructure agent of ${osName()}. Report status as short telemetry lines; flag anything degraded first. ${GUARDRAIL}`;
    },
  },
  {
    role: "general",
    get label() {
      return osName();
    },
    icon: Sparkles,
    // opencode is the CLI actually installed; it's the only gateway executor every
    // role can rely on being there (see execute.ts's online-agent guard).
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: [],
    get systemPrompt() {
      // Phase 2 Part C: the gateway fallback carries Tony's MODE block too (Rust adds it on desktop).
      return `${TONY_INTRO.replace("{name}", osName())} ${TONY_ROLE} ${TONY_STYLE} ${GUARDRAIL}${modeBlock(useModes.getState().effective)}`;
    },
  },
];

/** `security-patrol` → "Security Patrol" (mirrors Rust `agents::role_label`'s fallback). */
export function titleCaseId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const generic = new Map<string, SubAgent>();

/**
 * A registry id with no entry in `AGENT_DEFS`: a read-only specialist that reports only to Tony
 * (Rust `roles::policy_for` gives any such id `RolePolicy::READ_ONLY`). No keywords, so the local
 * classifier never picks it; the routing matrix can still name it.
 */
function genericAgent(id: string): SubAgent {
  let a = generic.get(id);
  if (!a) {
    const label = titleCaseId(id) || id;
    a = {
      role: id,
      label,
      icon: Bot,
      gatewayAgent: "opencode",
      priority: "background",
      keywords: [],
      get systemPrompt() {
        return `You are ${label}, a read-only specialist agent of ${osName()}. You report only to ${osName()}: answer with findings, never act. ${GUARDRAIL}`;
      },
    };
    generic.set(id, a);
  }
  return a;
}

const KNOWN: Record<string, SubAgent> = Object.fromEntries(AGENT_DEFS.map((a) => [a.role, a]));

/** The agent for a role id: a known agent, else the generic read-only one (any valid id), else Tony. */
export function agentFor(role: string): SubAgent {
  return KNOWN[role] ?? (AGENT_ID_RE.test(role) ? genericAgent(role) : KNOWN.general);
}

/**
 * Every known agent by role id. Built from `AGENT_DEFS`; a lookup of any other valid registry id
 * (`SUB_AGENTS["security-patrol"]`) returns its generic read-only agent instead of undefined, so no
 * caller needs a refactor when a specialist is added to `routing.agents`. Enumeration
 * (`Object.values`) lists the known agents only.
 */
export const SUB_AGENTS: Readonly<Record<KnownRole, SubAgent>> & Readonly<Record<string, SubAgent>> = new Proxy(KNOWN, {
  get(target, key, receiver) {
    if (typeof key !== "string" || key in target || key === "then" || key === "toJSON" || !AGENT_ID_RE.test(key)) return Reflect.get(target, key, receiver);
    return genericAgent(key);
  },
}) as Readonly<Record<KnownRole, SubAgent>> & Readonly<Record<string, SubAgent>>;

/**
 * Cheap keyword classifier — instant and offline. TODO(cline): replace with a
 * tiny local model call (e.g. Llama 3.2 1B via LM Studio, JSON-mode) once the
 * dispatcher model is chosen; keep this as the fallback.
 */
export function classify(text: string): AgentRole {
  const t = text.toLowerCase();
  let best: AgentRole = "general";
  let bestScore = 0;
  for (const agent of Object.values(SUB_AGENTS)) {
    const score = agent.keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (score > bestScore) {
      best = agent.role;
      bestScore = score;
    }
  }
  return best;
}
