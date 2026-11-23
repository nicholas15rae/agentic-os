/**
 * "Send to Director Suite" from Brainstorm / Play Place: create a project carrying the source's
 * brief, open it in the Director store and switch the nav to the Director Suite. Any asset paths
 * are ingested as clips (copied into raw/; originals untouched).
 */
import { useNav } from "@/stores/nav";
import { useToasts } from "@/features/reminders/notify";
import type { Item } from "@/lib/cc-api";
import type { PlayCard } from "@/lib/platform";
import type { BrainstormNote } from "@/features/brainstorm/capture";
import { noteToIntake } from "@/features/buildhub/notes";
import type { DirectorHandoff, MediaProject } from "./contract";
import { api } from "./api";
import { addAssets, loadProjects, openProject } from "./director-store";

export const HANDOFF_BRIEF_MAX = 4000;

export async function sendToDirector(h: DirectorHandoff): Promise<MediaProject | null> {
  try {
    const title = h.title.trim().slice(0, 120) || "Untitled project";
    const project = await api.projectCreate({ title, source: { from: h.from, refId: h.refId || null, brief: h.brief.trim().slice(0, HANDOFF_BRIEF_MAX) || null } });
    await openProject(project.slug);
    if (h.assetPaths.length) addAssets(await api.ingestPaths({ slug: project.slug, paths: h.assetPaths, role: "clip" }));
    void loadProjects();
    useNav.getState().go("director");
    return project;
  } catch (e) {
    useToasts.getState().push({ title: "Couldn't open the Director Suite", body: e instanceof Error ? e.message : String(e), tone: "error" });
    return null;
  }
}

/** Picked Brainstorm notes → handoff: title from the first note, brief = each note's summary + raw words. */
export function brainstormHandoff(notes: Item<BrainstormNote>[]): DirectorHandoff {
  const first = notes[0];
  const brief = notes
    .map(noteToIntake)
    .map((n) => (notes.length > 1 ? `## ${n.title}\n${n.text}` : n.text))
    .join("\n\n")
    .slice(0, HANDOFF_BRIEF_MAX);
  return { from: "brainstorm", refId: first?.id ?? "", title: first ? first.organized?.title || first.title || "Untitled brainstorm" : "Untitled brainstorm", brief, assetPaths: [] };
}

/** A Play Place card → handoff: its title and brief / summary / notes. */
export function playCardHandoff(card: PlayCard): DirectorHandoff {
  const parts = [card.brief || card.summary || "", card.idea && card.idea !== card.brief ? `Notes: ${card.idea}` : ""].filter(Boolean);
  return { from: "playplace", refId: card.id, title: card.title, brief: parts.join("\n\n").slice(0, HANDOFF_BRIEF_MAX), assetPaths: [] };
}
