/**
 * Client for the gateway's shared local store (command_center_api.py, /api/cc).
 *
 * Phone and desktop both read/write here, so a note dictated on the phone over
 * NetBird shows up on the desktop within one sync tick (and vice versa).
 * Writes are optimistic; reads poll with `?since=` so only changed rows move.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { gateway, GatewayError, authHeader } from "@/lib/gateway";
import type { MapPlace } from "@/lib/platform";
import { useSettings } from "@/stores/settings";

export type Collection =
  | "cues"
  | "ideas"
  | "playplace"
  | "notes"
  | "reminders"
  | "pipeline"
  | "projects"
  | "income"
  | "goals"
  | "invoices"
  | "checks"
  | "receipts"
  | "documents"
  | "widgets"
  | "commissions"
  | "mileage"
  | "pending"
  | "statement_lines"
  | "routes";

/** Finance records: Nic's screens only, never an agent's context. Mirrors FINANCE_COLLECTIONS in command_center_api.py. */
export const FINANCE_COLLECTIONS: readonly Collection[] = ["receipts", "invoices", "checks", "income", "commissions", "mileage", "pending", "statement_lines"];
export const isFinanceCollection = (c: string): boolean => (FINANCE_COLLECTIONS as readonly string[]).includes(c);

/**
 * Never embedded and never in any vault search (addresses stay out of the AI index and agent
 * context). They still sync phone <-> desktop. Mirrors PRIVATE_COLLECTIONS in command_center_api.py.
 */
export const PRIVATE_COLLECTIONS: readonly Collection[] = ["routes"];
export const isPrivateCollection = (c: string): boolean => (PRIVATE_COLLECTIONS as readonly string[]).includes(c);

export interface Meta {
  id: string;
  _created: number;
  _updated: number;
  _deleted?: boolean;
}

export type Item<T> = T & Meta;

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const cc = {
  health: () =>
    gateway<{
      ok: boolean;
      llm: { ok: boolean; models?: string[]; error?: string };
      counts: Record<string, number>;
      vault: { items: number; embedded: number };
      lastBackup: BackupInfo | null;
    }>("/api/cc/health", { timeoutMs: 6000 }),
  list: <T>(c: Collection, since = 0) => gateway<{ items: Item<T>[]; now: number }>(`/api/cc/c/${c}?since=${since}`),
  create: <T>(c: Collection, data: Partial<T> & { id?: string }) => gateway<Item<T>>(`/api/cc/c/${c}`, { method: "POST", ...json(data) }),
  update: <T>(c: Collection, id: string, patch: Partial<T>) => gateway<Item<T>>(`/api/cc/c/${c}/${id}`, { method: "PATCH", ...json(patch) }),
  remove: (c: Collection, id: string) => gateway<{ ok: boolean }>(`/api/cc/c/${c}/${id}`, { method: "DELETE" }),
  kvGet: <T>(key: string) => gateway<{ value: T | null }>(`/api/cc/kv/${key}`),
  kvSet: (key: string, value: unknown) => gateway(`/api/cc/kv/${key}`, { method: "PUT", ...json({ value }) }),
  config: () => gateway<CcConfig>("/api/cc/config"),
  setConfig: (patch: DeepPartial<CcConfig>) => gateway<CcConfig>("/api/cc/config", { method: "PUT", ...json(patch) }),
  ocr: (fileId: string, kind: "receipt" | "invoice" | "check" | "etransfer" | "paystub") =>
    gateway<OcrResult>("/api/cc/ocr", { method: "POST", ...json({ fileId, kind }), timeoutMs: 180_000 }),
  /** A bank / card statement (already parsed in the app) stored read-only; re-imported lines are skipped. */
  statementImport: (body: { importId: string; account: string; lines: { date: string; description: string; amount: number }[] }) =>
    gateway<{ added: number; skipped: number; importId: string }>("/api/cc/finance/statement-import", { method: "POST", ...json(body), timeoutMs: 60_000 }),
  organize: (id: string) => gateway<Item<unknown>>("/api/cc/brainstorm/organize", { method: "POST", ...json({ id }), timeoutMs: 180_000 }),
  llmJson: <T>(system: string, prompt: string) => gateway<T>("/api/cc/llm/json", { method: "POST", ...json({ system, prompt }), timeoutMs: 120_000 }),
  /** Nic's own vault search. With no collections, finance is included only when `includeFinance` is set. */
  search: (q: string, collections: Collection[] = [], k = 8, opts: { includeFinance?: boolean } = {}) =>
    gateway<VaultResults>(
      `/api/cc/vault/search?q=${encodeURIComponent(q)}&collections=${collections.join(",")}&k=${k}${opts.includeFinance ? "&include_finance=true" : ""}`,
    ),
  /** Vault matches for an agent's context: never finance records (receipts, invoices, cheques, income). */
  agentSearch: async (q: string, k = 5) => {
    const res = await cc.search(q, [], k);
    // The gateway already leaves finance and private collections out of an unscoped search; filter
    // again so an older gateway can't leak them.
    return { ...res, results: res.results.filter((r) => !isFinanceCollection(r.collection) && !isPrivateCollection(r.collection)) };
  },
  reindex: () => gateway<{ queued: number }>("/api/cc/vault/reindex", { method: "POST" }),
  backupNow: () => gateway<BackupInfo>("/api/cc/backup", { method: "POST", timeoutMs: 120_000 }),
  backups: () => gateway<BackupList>("/api/cc/backups"),
  /** A failed backup is right after all (you really removed that much): make it good + the new baseline. */
  acceptBackup: (name: string) => gateway<BackupInfo>("/api/cc/backup/accept", { method: "POST", body: JSON.stringify({ name }) }),
  candles: (symbol: string, interval: string, range: string) =>
    gateway<MarketData>(`/api/cc/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`, { timeoutMs: 20_000 }),
  fileUrl: (id: string) => `${useSettings.getState().gatewayUrl.replace(/\/+$/, "")}/api/cc/files/${id}`,
  /** Multipart upload (images from the camera, PDFs). */
  upload: async (blob: Blob, name: string): Promise<{ id: string; name: string; mime: string; size: number }> => {
    const fd = new FormData();
    fd.append("file", blob, name);
    const base = useSettings.getState().gatewayUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/cc/files`, { method: "POST", body: fd, headers: authHeader(useSettings.getState().gatewayToken) });
    if (!res.ok) throw new GatewayError((await res.json().catch(() => ({}))).detail ?? `Upload failed (${res.status})`, res.status);
    return res.json();
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface CcConfig {
  llm: { baseUrl: string; model: string; visionModel: string; embeddingModel: string; timeoutSecs: number };
  backup: { enabled: boolean; intervalHours: number; keep: number; dir: string };
}

export interface BackupInfo {
  file: string;
  size: number;
  at: number;
  reason: string;
  /** false = it failed its self-check (kept aside as failed-cc-*.zip). Absent on older gateways. */
  ok?: boolean;
  verified?: { ok: boolean; problems: string[]; entries?: number; files?: number; note?: string };
}

export interface BackupList {
  dir: string;
  last: BackupInfo | null;
  lastGood?: BackupInfo | null;
  /** Set while the most recent backup failed its self-check. */
  failure?: BackupInfo | null;
  backups: { name: string; size: number; at: number }[];
  failed?: { name: string; size: number; at: number }[];
}

/** One line for a backup result: where it went and whether it checked out. */
export function backupSummary(b: BackupInfo): string {
  if (b.ok === false) return `Backup FAILED its check (kept aside as ${b.file}): ${b.verified?.problems.join("; ") ?? "unknown problem"}`;
  const v = b.verified;
  return `Backed up to ${b.file}${v?.ok ? ` · verified (${v.entries ?? 0} entries, ${v.files ?? 0} files)` : ""}`;
}

export interface OcrFields {
  vendor?: string | null;
  date?: string | null;
  subtotal?: number | null;
  gst?: number | null;
  hst?: number | null;
  pst?: number | null;
  qst?: number | null;
  tip?: number | null;
  total?: number | null;
  currency?: string | null;
  invoiceNumber?: string | null;
  payer?: string | null;
  chequeNumber?: string | null;
  memo?: string | null;
  category?: string | null;
  items?: { desc: string; amount: number }[];
  confidence?: number;
}

export interface OcrResult {
  fields: OcrFields;
  check: { regime: string | null; flags: string[]; taxTotal: number };
  engine: string;
  raw: string;
}

export interface VaultResults {
  mode: "hybrid" | "lexical" | "empty";
  results: { score: number; collection: Collection; id: string; snippet: string; item: Item<Record<string, unknown>> | null }[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MarketData {
  symbol: string;
  currency: string | null;
  exchange: string | null;
  price: number | null;
  candles: Candle[];
  fetchedAt: number;
  source: string;
}

// ── useCollection: synced, optimistic, shared across components ─────────────

interface CollState {
  items: Map<string, Item<unknown>>;
  since: number;
  error: string | null;
  loaded: boolean;
  subscribers: Set<() => void>;
  snapshot: Item<unknown>[];
  timer?: ReturnType<typeof setTimeout>;
}

const stores = new Map<Collection, CollState>();
const SYNC_MS = 6000;

function storeFor(c: Collection): CollState {
  let s = stores.get(c);
  if (!s) {
    s = { items: new Map(), since: 0, error: null, loaded: false, subscribers: new Set(), snapshot: [] };
    stores.set(c, s);
  }
  return s;
}

function emit(s: CollState) {
  s.snapshot = [...s.items.values()].filter((i) => !i._deleted).sort((a, b) => b._created - a._created);
  s.subscribers.forEach((f) => f());
}

async function sync(c: Collection) {
  const s = storeFor(c);
  try {
    const { items, now } = await cc.list<unknown>(c, s.since);
    for (const it of items) s.items.set(it.id, it);
    s.since = Math.max(s.since, now - 2); // small overlap for clock skew between writes
    s.error = null;
    s.loaded = true;
    if (items.length || !s.loaded) emit(s);
    else s.subscribers.forEach((f) => f());
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    s.loaded = true;
    s.subscribers.forEach((f) => f());
  }
}

/**
 * Hard Refresh (Phase 1): drop every cached collection and pull it fresh from the gateway
 * (`since` = 0). Views stay subscribed, so they re-render with the server's state. Returns how
 * many collections were re-synced. Touches no audio / Spotify / TTS state.
 */
export async function resyncCollections(): Promise<number> {
  const live = [...stores.entries()].filter(([, s]) => s.subscribers.size > 0);
  for (const [, s] of stores) {
    s.since = 0;
    s.items.clear();
    s.loaded = false;
  }
  await Promise.all(live.map(([c]) => sync(c)));
  for (const [, s] of live) emit(s);
  return live.length;
}

function startPolling(c: Collection) {
  const s = storeFor(c);
  if (s.timer) return;
  const loop = async () => {
    if (!document.hidden) await sync(c);
    s.timer = setTimeout(loop, SYNC_MS);
  };
  void loop();
  window.addEventListener("focus", () => void sync(c));
}

function stopPolling(c: Collection) {
  const s = storeFor(c);
  if (s.subscribers.size === 0 && s.timer) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
}

/** Live view of one shared collection, plus optimistic mutators. */
export function useCollection<T>(c: Collection) {
  const s = storeFor(c);
  const subscribe = useCallback(
    (f: () => void) => {
      s.subscribers.add(f);
      startPolling(c);
      return () => {
        s.subscribers.delete(f);
        stopPolling(c);
      };
    },
    [c, s],
  );
  const items = useSyncExternalStore(subscribe, () => s.snapshot) as Item<T>[];
  const status = useSyncExternalStore(subscribe, () => `${s.loaded}|${s.error ?? ""}`);
  const [loaded, error] = status.split("|");

  const create = useCallback(
    async (data: Partial<T>) => {
      const id = crypto.randomUUID();
      const now = Date.now() / 1000;
      s.items.set(id, { ...(data as object), id, _created: now, _updated: now } as Item<unknown>);
      emit(s);
      try {
        const saved = await cc.create<T>(c, { ...data, id });
        s.items.set(id, saved as Item<unknown>);
        emit(s);
        return saved;
      } catch (e) {
        s.items.delete(id);
        emit(s);
        throw e;
      }
    },
    [c, s],
  );

  const update = useCallback(
    async (id: string, patch: Partial<T>) => {
      const prev = s.items.get(id);
      if (prev) s.items.set(id, { ...prev, ...(patch as object) });
      emit(s);
      try {
        const saved = await cc.update<T>(c, id, patch);
        s.items.set(id, saved as Item<unknown>);
        emit(s);
        return saved;
      } catch (e) {
        if (prev) s.items.set(id, prev);
        emit(s);
        throw e;
      }
    },
    [c, s],
  );

  const remove = useCallback(
    async (id: string) => {
      const prev = s.items.get(id);
      s.items.delete(id);
      emit(s);
      try {
        await cc.remove(c, id);
      } catch (e) {
        if (prev) s.items.set(id, prev);
        emit(s);
        throw e;
      }
    },
    [c, s],
  );

  return { items, loaded: loaded === "true", error: error || null, create, update, remove, refresh: () => sync(c) };
}

/** Non-hook access (voice intents, schedulers). */
export const collections = {
  create: async <T>(c: Collection, data: Partial<T>) => {
    const saved = await cc.create<T>(c, data);
    const s = storeFor(c);
    s.items.set(saved.id, saved as Item<unknown>);
    emit(s);
    return saved;
  },
  update: async <T>(c: Collection, id: string, patch: Partial<T>) => {
    const saved = await cc.update<T>(c, id, patch);
    const s = storeFor(c);
    s.items.set(id, saved as Item<unknown>);
    emit(s);
    return saved;
  },
  remove: async (c: Collection, id: string) => {
    await cc.remove(c, id);
    const s = storeFor(c);
    const prev = s.items.get(id);
    if (prev) s.items.set(id, { ...prev, _deleted: true });
    emit(s);
  },
  snapshot: <T>(c: Collection) => storeFor(c).snapshot as Item<T>[],
  sync: (c: Collection) => sync(c),
};

// ── saved routes (Maps): collection "routes", synced, never in the vault ─────

/** Where a saved route starts: a stored place, or resolved when it is used ("here" = the device fix, "home" = MAP_HOME). */
export type RouteOrigin = MapPlace | "here" | "home";
/** One saved route. Coordinates are stored, so opening it never geocodes again. Mirrors _check_route in command_center_api.py. */
export interface SavedRoute {
  name: string;
  origin: RouteOrigin;
  destination: MapPlace;
  stops: MapPlace[];
  pinned?: boolean;
}

export const ROUTE_NAME_MAX = 80;
export const ROUTE_LABEL_MAX = 200;
/** Google Maps directions URLs take at most 9 waypoints. */
export const ROUTE_STOPS_MAX = 9;

/** A saved route the gateway would refuse (400), caught before the request. */
export class SavedRouteError extends Error {}

// Control, bidi and zero-width characters: the same set the gateway strips.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

function routeText(v: unknown, what: string, cap: number, required: boolean): string {
  if (v == null && !required) return "";
  if (typeof v !== "string") throw new SavedRouteError(`${what} must be text`);
  const s = v.replace(UNSAFE_TEXT, " ").split(/\s+/).filter(Boolean).join(" ");
  if (required && !s) throw new SavedRouteError(`${what} is required`);
  if (s.length > cap) throw new SavedRouteError(`${what} is longer than ${cap} characters`);
  return s;
}

function routePlace(v: unknown, what: string): MapPlace {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SavedRouteError(`${what} must be a place {lat, lng, label}`);
  const p = v as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => k !== "lat" && k !== "lng" && k !== "label");
  if (extra.length) throw new SavedRouteError(`${what} has unknown fields: ${extra.sort().join(", ")}`);
  const coord = (k: "lat" | "lng", lim: number) => {
    const n = p[k];
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > lim) throw new SavedRouteError(`${what}.${k} must be a number from -${lim} to ${lim}`);
    return n;
  };
  return { lat: coord("lat", 90), lng: coord("lng", 180), label: routeText(p.label, `${what}.label`, ROUTE_LABEL_MAX, false) };
}

function routeOrigin(v: unknown): RouteOrigin {
  if (typeof v === "string") {
    if (v === "here" || v === "home") return v;
    throw new SavedRouteError("origin must be a place, 'here' or 'home'");
  }
  return routePlace(v, "origin");
}

function routeStops(v: unknown): MapPlace[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new SavedRouteError("stops must be a list of places");
  if (v.length > ROUTE_STOPS_MAX) throw new SavedRouteError(`At most ${ROUTE_STOPS_MAX} stops`);
  return v.map((s, i) => routePlace(s, `stops[${i}]`));
}

const ROUTE_FIELDS = new Set(["name", "origin", "destination", "stops", "pinned"]);

function noExtraRouteFields(r: object) {
  const extra = Object.keys(r).filter((k) => !ROUTE_FIELDS.has(k));
  if (extra.length) throw new SavedRouteError(`Unknown saved-route fields: ${extra.sort().join(", ")}`);
}

function routePinned(v: unknown): boolean {
  if (typeof v !== "boolean") throw new SavedRouteError("pinned must be true or false");
  return v;
}

/** A whole route, normalised the way the gateway stores it. Throws SavedRouteError. */
export function toSavedRoute(r: SavedRoute): SavedRoute {
  noExtraRouteFields(r);
  const out: SavedRoute = {
    name: routeText(r.name, "name", ROUTE_NAME_MAX, true),
    origin: routeOrigin(r.origin),
    destination: routePlace(r.destination, "destination"),
    stops: routeStops(r.stops),
  };
  if (r.pinned !== undefined) out.pinned = routePinned(r.pinned);
  return out;
}

/** Only the fields a patch carries, each checked (the gateway re-checks the merged row). Throws SavedRouteError. */
export function toSavedRoutePatch(p: Partial<SavedRoute>): Partial<SavedRoute> {
  noExtraRouteFields(p);
  const out: Partial<SavedRoute> = {};
  if ("name" in p) out.name = routeText(p.name, "name", ROUTE_NAME_MAX, true);
  if ("origin" in p) out.origin = routeOrigin(p.origin);
  if ("destination" in p) out.destination = routePlace(p.destination, "destination");
  if ("stops" in p) out.stops = routeStops(p.stops);
  if ("pinned" in p) out.pinned = routePinned(p.pinned);
  return out;
}

/** Pinned first, then newest. */
export const sortSavedRoutes = <T extends SavedRoute & Meta>(rs: readonly T[]): T[] =>
  [...rs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b._created - a._created);

/** Non-hook access to saved routes (the trip list's "Save as route", tests). */
export const savedRoutes = {
  list: async () => sortSavedRoutes((await cc.list<SavedRoute>("routes")).items.filter((i) => !i._deleted)),
  save: async (r: SavedRoute) => collections.create<SavedRoute>("routes", toSavedRoute(r)),
  update: async (id: string, patch: Partial<SavedRoute>) => collections.update<SavedRoute>("routes", id, toSavedRoutePatch(patch)),
  remove: (id: string) => collections.remove("routes", id),
  snapshot: () => sortSavedRoutes(collections.snapshot<SavedRoute>("routes")),
};

/** Live, synced saved routes (pinned first) with checked mutators. */
export function useSavedRoutes() {
  const c = useCollection<SavedRoute>("routes");
  const { create: rawCreate, update: rawUpdate } = c;
  const create = useCallback(async (r: SavedRoute) => rawCreate(toSavedRoute(r)), [rawCreate]);
  const update = useCallback(async (id: string, patch: Partial<SavedRoute>) => rawUpdate(id, toSavedRoutePatch(patch)), [rawUpdate]);
  const items = useMemo(() => sortSavedRoutes(c.items), [c.items]);
  return { ...c, items, create, update };
}

/** Re-render on an interval (countdowns). */
export function useNow(ms = 1000) {
  const ref = useRef(Date.now());
  const subscribe = useCallback(
    (f: () => void) => {
      const t = setInterval(() => {
        ref.current = Date.now();
        f();
      }, ms);
      return () => clearInterval(t);
    },
    [ms],
  );
  return useSyncExternalStore(subscribe, () => ref.current);
}

export function useEffectOnce(fn: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fn, []);
}
