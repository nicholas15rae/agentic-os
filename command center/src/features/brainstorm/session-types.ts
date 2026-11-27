/**
 * Brainstorm "Talk it through": the locked contract (Section 9, Brainstorm step 1). Types only, no
 * runtime code, so any module can import it without pulling in the voice engines.
 *
 * The wrap-up shapes mirror the gateway endpoint in command_center_api.py
 * (`POST /api/cc/brainstorm/wrapup`, WRAPUP_* constants and `_wrap_*` helpers) field for field.
 * If you change one side, change the other and the tests in tests/test_command_center_llm.py.
 */

// ── session and transcript ──────────────────────────────────────────────────

export type SessionMode = "listen" | "talk";

export type Speaker = "nic" | "tony";

/**
 * Which device wrote a line or holds the live session. It comes from `isAndroidApp()` /
 * `isDesktopApp()` (stores/settings.ts), never from `platform` in lib/platform.ts: that one says
 * "desktop" inside the Android app too. A legacy segment's "desktop" may really be the S22.
 */
export type DeviceKind = "desktop" | "android" | "pwa";

/** One transcript line in `BrainstormNote.segments`. */
export interface NoteSegment {
  /** Epoch ms when the line was spoken (a Tony reply: when its request started). Lines are kept sorted by `t`. */
  t: number;
  text: string;
  /** `string` only for legacy segments written before DeviceKind existed. */
  device: DeviceKind | string;
  /** Absent = Nic (every Listen Mode line before Talk existed). */
  speaker?: Speaker;
  mode?: SessionMode;
  /** A Tony reply that was never voiced (yielded to Listen), or cut off part-way by barge-in. */
  unspoken?: true | "partial";
}

/** The session lock on a note: one device runs the mic at a time. Stale after ~60 s without a beat. */
export interface LiveSession {
  device: DeviceKind;
  mode: SessionMode;
  startedAt: number;
  beatAt: number;
}

/**
 * Fields BrainstormNote (capture.ts) gains. `segments` becomes `NoteSegment[]`; `source` gains "talk".
 * Talk turns run on their own voice thread, `talk:<noteId>`.
 */
export interface BrainstormSessionFields {
  segments: NoteSegment[];
  wrapup?: WrapUp;
  live?: LiveSession | null;
  source?: "listen" | "tony" | "talk";
}

// ── wrap-up (gateway shapes) ────────────────────────────────────────────────

/** WRAPUP_DESTINATIONS. "ledger" is the Ideas & Tasks ledger (collection "ideas"), never Finance. */
export type Destination = "play_place" | "director" | "ledger" | "memory";

/** WRAPUP_KINDS. */
export type WrapKind = "idea" | "decision" | "next_step";

/**
 * WRAPUP_STATUSES. The gateway only ever writes "pending"; the client writes the rest. A re-run
 * never resets an item that is not "pending", and keeps it even when the new run doesn't find it.
 * Only an explicit "no" (CancelReason "declined") makes an item "skipped".
 */
export type WrapItemStatus = "pending" | "sending" | "sent" | "skipped" | "failed";

/** WRAPUP_MEMORY_CATEGORIES (mirrors learning.rs CATEGORIES). */
export type LearnCategory = "preference" | "workflow" | "rule" | "persona" | "domain_knowledge" | "correction";

export interface WrapItem {
  /** Gateway-assigned and stable across re-runs ("w" + 12 hex). The model's own ids are not used. */
  id: string;
  kind: WrapKind;
  /** At most 300 characters. Replaced by `quote` when the model's wording drifted from the transcript. Editable. */
  text: string;
  /** The transcript words the item comes from, found verbatim (case and punctuation aside). Never edited. */
  quote: string;
  /** Who said the quoted words. A memory suggestion is only ever made from Nic's own words. */
  speaker: Speaker;
  /** `t` of the first transcript segment the quote is in; null for a legacy rawText-only note. */
  t: number | null;
  /** The model's suggestion; null in the fallback or when nothing fit. */
  suggested: Destination | null;
  /** Where Send will put it: starts as `suggested`, changed by tap only. A re-run keeps a hand-picked one. */
  dest: Destination | null;
  /** Only on items suggested for memory (an unknown category from the model becomes "rule"). */
  memoryCategory?: LearnCategory;
  status: WrapItemStatus;
  /** Written by the client after the destination write succeeds. */
  sentTo?: { dest: Destination; refId: string; at: number; via: "tap" | "voice" };
  error?: string;
}

/** Why a wrap-up came from the fallback: model busy, unreachable, or no valid JSON after one retry. */
export type WrapUpFailureReason = "busy" | "unavailable" | "invalid";

export interface WrapUp {
  /** Epoch seconds (gateway clock). */
  at: number;
  title: string;
  summary: string;
  items: WrapItem[];
  /** "fallback": Nic's own lines as candidate items, kind "idea", no destination, plus a Retry. */
  engine: "llm" | "fallback";
  /** Set when engine is "fallback". */
  fallbackReason?: WrapUpFailureReason;
  /** How many transcript segments the model saw (the last ~24,000 characters). */
  coveredSegments: number;
  /** Model items thrown away because their quote wasn't in the transcript (or they were past 20). */
  dropped: number;
}

/** `POST /api/cc/brainstorm/wrapup` body. */
export interface WrapUpRequest {
  id: string;
}

/**
 * 200: the updated note, `Item<BrainstormNote>` with `wrapup` (engine "llm"), `organized`
 * rebuilt from the items, and `title` unless `titleLocked`.
 * 503 (also sends a Retry-After header): the body below. `note.wrapup` is the merged fallback,
 * or the earlier model wrap-up when there was one (a fallback never replaces it).
 * 400 nothing to wrap up, 404 note missing or deleted, 409 a wrap-up for this note is already running.
 */
export interface WrapUpUnavailable<N = unknown> {
  detail: string;
  reason: WrapUpFailureReason;
  /** Seconds. For "busy", when the desktop's GPU lease ends (5–120). */
  retryAfter: number;
  note: N;
}

// ── approvals ───────────────────────────────────────────────────────────────

/** Why a confirm card closed without a yes (gate.ts onCancel). Only "declined" skips a wrap-up item. */
export type CancelReason = "declined" | "timed out" | "superseded" | "dismissed" | "cut" | "stopped";

/** Phone → desktop memory save (inbox command `memoryCommit`): a reference only, never free text. */
export interface MemoryCommitRef {
  noteId: string;
  itemId: string;
}

// ── session store (features/brainstorm/session.ts) ──────────────────────────

export interface BrainSessionState {
  noteId: string | null;
  mode: SessionMode | "idle";
  switching: boolean;
  wrapping: boolean;
  walking: boolean;
  error: string | null;
  start(mode: SessionMode, noteId?: string): Promise<void>;
  /** No-op if already in `mode`; serialised by `switching` (a double tap is ignored). */
  switchTo(mode: SessionMode): Promise<void>;
  wrapUp(o?: { via: "tap" | "voice" }): Promise<WrapUp | null>;
  /** Stop without a wrap-up; the transcript is kept. */
  end(): Promise<void>;
  approveItem(itemId: string, dest: Destination, via: "tap" | "voice"): Promise<void>;
  skipItem(itemId: string): Promise<void>;
  /** Voice walk-through: one card per pending item (yes / no / stop). There is no approve-all. */
  walkItems(): Promise<void>;
}

// ── voice side ──────────────────────────────────────────────────────────────

/** Talk listen limits: ~1.3 s end-of-speech pause, 90 s per thought (Tony's own are 0.7 s / 15 s). */
export interface TalkListenLimits {
  endSilenceMs: number;
  maxUtteranceMs: number;
}

/** What a talk turn adds to the turn request (Rust OsTurnRequest.talk, gateway Tony payload.talk). */
export interface TalkTurn {
  /** Nic's earlier lines in this session, neutralised, at most 1500 characters. */
  digest: string;
}

/** UI props. */
export interface WrapUpCardProps {
  noteId: string;
  wrapup: WrapUp;
  /** Under Tony's wrap-up reply in the voice thread. */
  compact?: boolean;
}

export interface SessionModeSwitchProps {
  mode: SessionMode | "idle";
  disabled?: boolean;
  /** e.g. "Live on phone" when another device holds the session. */
  liveElsewhere?: string | null;
  onSwitch: (m: SessionMode) => void;
}
