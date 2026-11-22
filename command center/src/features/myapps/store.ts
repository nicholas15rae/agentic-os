import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LucideIcon } from "lucide-react";
import { useHub } from "@/features/buildhub/hub-store";
import { AppWindow, Calculator, CalendarDays, Camera, Gamepad2, Globe, Heart, LayoutDashboard, Map, Music, NotebookPen, Palette, Rocket, Sparkles, Timer, Wallet, Wrench } from "lucide-react";

/**
 * MY APPS: Play Place builds mounted as pages in the left rail. Only metadata lives here (which
 * build or prototype, the rail label, icon and order); the app's files stay where the hub or the
 * Play Place keeps them, so unpinning never deletes anything. Persisted in this device's storage
 * (and mirrored to the gateway with the rest of the UI config), so mounts survive restarts.
 */

/** "build": a staging-hub build (rendered from its output folder); "card": a Play Place prototype. */
export type MountKind = "build" | "card";

export const APP_ICONS = {
  app: AppWindow,
  dashboard: LayoutDashboard,
  sparkles: Sparkles,
  rocket: Rocket,
  game: Gamepad2,
  calculator: Calculator,
  calendar: CalendarDays,
  timer: Timer,
  notes: NotebookPen,
  music: Music,
  palette: Palette,
  camera: Camera,
  wallet: Wallet,
  map: Map,
  globe: Globe,
  heart: Heart,
  tool: Wrench,
} satisfies Record<string, LucideIcon>;
export type AppIcon = keyof typeof APP_ICONS;
export const iconOf = (name: string): LucideIcon => APP_ICONS[name as AppIcon] ?? AppWindow;

export interface MountedApp {
  id: string;
  kind: MountKind;
  /** The build id or Play Place card id. */
  ref: string;
  label: string;
  icon: AppIcon;
  mountedAt: number;
}

export interface MountTarget {
  kind: MountKind;
  ref: string;
  title: string;
}

export const LABEL_MAX = 40;
export const mountId = (kind: MountKind, ref: string) => `${kind}-${ref}`;
const cleanLabel = (s: string, fallback: string) => (s.replace(/\s+/g, " ").trim() || fallback.trim() || "App").slice(0, LABEL_MAX);

/** A build mounted from the intake (before it has an id the rail can open) waits here by slug. */
export interface PendingMount {
  slug: string;
  label: string;
  icon: AppIcon;
  at: number;
}

interface MyAppsState {
  apps: MountedApp[];
  pending: PendingMount[];
  /** "Edit in Play Place" → the build card to scroll to and focus (its Steer box). */
  focusBuild: { id: string; at: number } | null;
  mount: (t: MountTarget, opts?: { label?: string; icon?: AppIcon }) => MountedApp;
  unmount: (id: string) => void;
  update: (id: string, patch: Partial<Pick<MountedApp, "label" | "icon">>) => void;
  move: (id: string, dir: -1 | 1) => void;
  addPending: (p: Omit<PendingMount, "at">) => void;
  /** Mount a pending build once the hub shows it (matched by its project slug). */
  resolvePending: (builds: { id: string; slug: string }[]) => void;
  requestFocus: (buildId: string) => void;
  clearFocus: () => void;
}

/** Move `id` one place up (-1) or down (+1). Pure. */
export function moved<T extends { id: string }>(list: T[], id: string, dir: -1 | 1): T[] {
  const i = list.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export const useMyApps = create<MyAppsState>()(
  persist(
    (set, get) => ({
      apps: [],
      pending: [],
      focusBuild: null,
      mount: (t, opts) => {
        const id = mountId(t.kind, t.ref);
        const prev = get().apps.find((a) => a.id === id);
        const app: MountedApp = {
          id,
          kind: t.kind,
          ref: t.ref,
          label: cleanLabel(opts?.label ?? prev?.label ?? t.title, t.title),
          icon: opts?.icon ?? prev?.icon ?? "app",
          mountedAt: prev?.mountedAt ?? Date.now(),
        };
        set((s) => ({ apps: prev ? s.apps.map((a) => (a.id === id ? app : a)) : [...s.apps, app] }));
        return app;
      },
      unmount: (id) => set((s) => ({ apps: s.apps.filter((a) => a.id !== id) })),
      update: (id, patch) =>
        set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, ...patch, label: patch.label !== undefined ? cleanLabel(patch.label, a.label) : a.label } : a)) })),
      move: (id, dir) => set((s) => ({ apps: moved(s.apps, id, dir) })),
      addPending: (p) => set((s) => ({ pending: [...s.pending.filter((x) => x.slug !== p.slug), { ...p, at: Date.now() }] })),
      resolvePending: (builds) => {
        const { pending, mount } = get();
        if (!pending.length) return;
        const left: PendingMount[] = [];
        for (const p of pending) {
          const b = builds.find((x) => x.slug === p.slug);
          if (b) mount({ kind: "build", ref: b.id, title: p.label }, { label: p.label, icon: p.icon });
          // A dispatch that never reached the hub (declined card) is forgotten after a day.
          else if (Date.now() - p.at < 86_400_000) left.push(p);
        }
        set({ pending: left });
      },
      requestFocus: (id) => set({ focusBuild: { id, at: Date.now() } }),
      clearFocus: () => set({ focusBuild: null }),
    }),
    { name: "cc.myapps", version: 1, partialize: (s) => ({ apps: s.apps, pending: s.pending }) },
  ),
);

// A build pinned from the intake gets mounted as soon as the hub shows it.
useHub.subscribe((s) => {
  const builds = s.view?.builds;
  if (builds && useMyApps.getState().pending.length) useMyApps.getState().resolvePending(builds.map((b) => ({ id: b.envelope.build_id, slug: b.envelope.project_slug })));
});
