import type { LayoutPage } from "@/core/widgets/pages";
import { pageWithWidget } from "@/core/widgets/pages";

/**
 * "Add to board" shortcut for an integration's widget (Maps first, plan Section 5 step 1).
 *
 * CONTRACT — LOCKED 2026-11-26 (plan decision 41, user accepted the recommended defaults).
 *
 * Component: `<AddToBoardButton widgetId label />` in IntegrationSettings.tsx.
 *   Props:  { widgetId: string; label: string }            // label = widget title for the notice
 *   State:  onBoard: string | null                         // page id already holding the widget,
 *                                                          // read with a primitive zustand selector
 *   Render: onBoard ? "Show on board" : "Add to board"      (one pill-glass button)
 *   Click:  sendToBoard(widgetId, deps), then a toast of boardNotice(outcome, label) — ends on the
 *           Command section with the widget's page active. Never silently lands on a new page:
 *           the notice names the page, and says when the board was full and a page was made.
 *   IPC:    none (layout + nav stores only).
 *
 * Pure logic lives here; the stores are passed in, so it is unit-tested without React.
 */

export interface BoardShortcutProps {
  widgetId: string;
  label: string;
}

export interface BoardAddResult {
  ok: boolean;
  reason?: string;
  pageId?: string;
  created?: boolean;
}

export interface BoardDeps {
  pages: () => LayoutPage[];
  /** Place on the first page with room, scanning from the first page (`useLayout.add` with `pageId` = first page). */
  add: (widgetId: string) => BoardAddResult;
  setActivePage: (id: string) => void;
  /** Go to the Command section (the board). */
  showBoard: () => void;
}

export type BoardOutcome =
  | { kind: "shown"; pageId: string; pageName: string }
  | { kind: "added"; pageId: string; pageName: string; created: boolean }
  | { kind: "failed"; reason: string };

export interface BoardNotice {
  title: string;
  body: string;
  tone: "info" | "error";
}

const pageName = (pages: LayoutPage[], id: string) => pages.find((p) => p.id === id)?.name ?? "a new page";

/** Show the widget if it is already on a page, else add it (first page with room, else a new page) and go there. */
export function sendToBoard(widgetId: string, deps: BoardDeps): BoardOutcome {
  const existing = pageWithWidget(deps.pages(), widgetId);
  if (existing) {
    deps.setActivePage(existing.id);
    deps.showBoard();
    return { kind: "shown", pageId: existing.id, pageName: existing.name };
  }
  const r = deps.add(widgetId);
  if (!r.ok || !r.pageId) return { kind: "failed", reason: r.reason ?? "Couldn't add it" };
  // add() already made the landing page active; set it again in case that changes.
  deps.setActivePage(r.pageId);
  deps.showBoard();
  return { kind: "added", pageId: r.pageId, pageName: pageName(deps.pages(), r.pageId), created: !!r.created };
}

export function boardNotice(o: BoardOutcome, label: string): BoardNotice {
  if (o.kind === "failed") return { title: `Couldn't add ${label}`, body: o.reason, tone: "error" };
  if (o.kind === "shown") return { title: `${label} is on ${o.pageName}`, body: `Showing ${o.pageName}.`, tone: "info" };
  return o.created
    ? { title: `${label} added on ${o.pageName}`, body: `Every page was full, so it went on a new page, ${o.pageName}. Showing it now.`, tone: "info" }
    : { title: `${label} added on ${o.pageName}`, body: `Showing ${o.pageName}.`, tone: "info" };
}
