/**
 * Part 4 auditions (scene_reader.rs): Scene Reader detection, its takes, the read-only import into a
 * new audition project, sides files and the slate still. Scene Reader is a separate app: it is only
 * probed (its Studio /health) and read through Rust's temp copy, and only from a click.
 */
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import type { MediaAsset, SceneReaderStatus, SidesFile, SrProject, SrTake } from "./contract";
import { api } from "./api";
import { addAssets, loadProjects, openProject } from "./director-store";

export interface AuditionState {
  /** null = not probed yet. */
  status: SceneReaderStatus | null;
  projects: SrProject[] | null;
  listing: boolean;
  listError: string | null;
  /** The Scene Reader project whose takes are showing. */
  openId: string | null;
  /** Picked take ids per Scene Reader project (absent = the best take). */
  picks: Record<string, string[]>;
  importing: boolean;
  sidesSlug: string | null;
  sides: SidesFile[];
  sidesBusy: boolean;
  slateBusy: boolean;
}

const initial: AuditionState = { status: null, projects: null, listing: false, listError: null, openId: null, picks: {}, importing: false, sidesSlug: null, sides: [], sidesBusy: false, slateBusy: false };

export const useAudition = create<AuditionState>(() => ({ ...initial }));
const get = useAudition.getState;
const set = useAudition.setState;

export const resetAuditionStore = () => set({ ...initial });

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (title: string, body?: string, tone: "info" | "warn" | "error" = "info") => useToasts.getState().push({ title, body, tone });

/** The Scene Reader entry shows only while its Studio answers. Pure. */
export const sceneReaderVisible = (s: Pick<AuditionState, "status">): boolean => s.status?.up === true;

/** Probe Scene Reader. Any failure (no bridge, refused, timeout) reads as down: the entry hides. */
export async function probeSceneReader(): Promise<SceneReaderStatus> {
  let status: SceneReaderStatus;
  try {
    status = await api.sceneReaderStatus();
  } catch {
    status = { up: false, url: "", projectsRoot: null };
  }
  set({ status });
  if (!status.up) set({ projects: null, openId: null });
  return status;
}

/** Nic's "Show takes" click: read Scene Reader's projects (a copy; nothing there changes). */
export async function listSceneReader(): Promise<void> {
  set({ listing: true, listError: null });
  try {
    const projects = await api.sceneReaderList();
    set({ projects, listing: false, openId: get().openId ?? projects[0]?.id ?? null });
  } catch (e) {
    set({ listing: false, listError: errText(e) });
  }
}

export const openSceneReaderProject = (id: string | null) => set({ openId: id });

/** The take ids an import sends: the picks, else the importable best take. Pure. */
export function picksFor(p: Pick<SrProject, "id" | "takes">, picks: Record<string, string[]>): string[] {
  const avail = new Set(p.takes.filter((t) => t.available).map((t) => t.id));
  const chosen = picks[p.id] ?? p.takes.filter((t) => t.best).map((t) => t.id);
  return chosen.filter((id) => avail.has(id));
}

export function toggleTake(p: SrProject, take: SrTake) {
  if (!take.available) return;
  const cur = picksFor(p, get().picks);
  const next = cur.includes(take.id) ? cur.filter((x) => x !== take.id) : [...cur, take.id];
  set({ picks: { ...get().picks, [p.id]: next } });
}

/** Nic's Import click: a new audition project with copies of the picked takes, then open it. */
export async function importSceneReader(projectId: string): Promise<boolean> {
  const p = get().projects?.find((x) => x.id === projectId);
  if (!p || get().importing) return false;
  const takeIds = picksFor(p, get().picks);
  if (!takeIds.length) {
    toast("Pick a take first", "No take is picked or marked best.", "warn");
    return false;
  }
  set({ importing: true });
  try {
    const r = await api.sceneReaderImport({ project: projectId, takeIds });
    const n = r.assets.length;
    toast("Audition project made", `${n} take${n === 1 ? "" : "s"} copied in. Scene Reader's files are untouched.`);
    if (r.skipped.length) toast(`${r.skipped.length} take${r.skipped.length === 1 ? "" : "s"} skipped`, r.skipped.slice(0, 3).join("; "), "warn");
    await openProject(r.project.slug);
    void loadProjects();
    return true;
  } catch (e) {
    toast("Couldn't import from Scene Reader", errText(e), "error");
    return false;
  } finally {
    set({ importing: false });
  }
}

// ── Sides ────────────────────────────────────────────────────────────────────

export const SIDES_EXT = ["pdf", "txt", "md", "rtf", "fdx"];
export const isSidesFile = (name: string) => SIDES_EXT.includes(name.split(".").pop()?.toLowerCase() ?? "");

export async function loadSides(slug: string): Promise<void> {
  try {
    const sides = await api.sidesList({ slug });
    set({ sidesSlug: slug, sides });
  } catch {
    set({ sidesSlug: slug, sides: [] });
  }
}

/** Dropped sides files → read-only copies in raw/sides/. Other files are skipped with a note. */
export async function addSides(slug: string, files: File[]): Promise<SidesFile[]> {
  const out: SidesFile[] = [];
  set({ sidesBusy: true });
  try {
    for (const f of files) {
      if (!isSidesFile(f.name)) {
        toast("Skipped", `${f.name} isn't a PDF or text file.`, "warn");
        continue;
      }
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        out.push(await api.sidesSave({ slug, name: f.name, bytes }));
      } catch (e) {
        toast(`Couldn't keep ${f.name}`, errText(e), "error");
      }
    }
  } finally {
    set({ sidesBusy: false });
  }
  if (out.length && get().sidesSlug === slug) set({ sides: [...get().sides, ...out].sort((a, b) => a.name.localeCompare(b.name)) });
  return out;
}

// ── Slate ────────────────────────────────────────────────────────────────────

export interface SlateFields {
  name: string;
  role: string;
  contact: string;
}

/** A slate still into the bin (role slate). Placing it at the start stays a manual step. */
export async function makeSlate(slug: string, f: SlateFields): Promise<MediaAsset | null> {
  if (!f.name.trim() || get().slateBusy) return null;
  set({ slateBusy: true });
  try {
    const a = await api.slateCard({ slug, name: f.name.trim(), role: f.role.trim() || undefined, contact: f.contact.trim() || undefined });
    addAssets([a]);
    toast("Slate added to the bin", "Drag it to the start of the timeline to use it.");
    return a;
  } catch (e) {
    toast("Couldn't make the slate", errText(e), "error");
    return null;
  } finally {
    set({ slateBusy: false });
  }
}
