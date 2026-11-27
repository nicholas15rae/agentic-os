// Contract: features/maps/contract.ts (DRAFT). The Saved tab's delete flow, kept pure so the
// "only Yes deletes" rule is tested without a DOM: the trash button only ASKS; `remove` runs only
// from Yes, only for the row that is asking, and never twice at once.
import type { SavedDeleteState, SavedRowDeleteProps } from "@/features/maps/contract";

export const SAVED_DELETE_IDLE: SavedDeleteState = { confirmId: null, busyId: null, error: null };

/** Deletes in flight, so a double-click on Yes before the re-render can't call `remove` twice. */
const inFlight = new Set<string>();

type SetState = (f: (s: SavedDeleteState) => SavedDeleteState) => void;

/** The delete props for one row. `state` is this render's state; `setState` takes updaters. */
export function savedDeleteHandlers(id: string, state: SavedDeleteState, setState: SetState, remove: (id: string) => Promise<unknown>): SavedRowDeleteProps {
  return {
    confirming: state.confirmId === id,
    busy: state.busyId === id,
    onAskDelete: () => setState((s) => (s.busyId ? s : { ...s, confirmId: id, error: null })),
    onCancelDelete: () => setState((s) => (s.confirmId === id && s.busyId !== id ? { ...s, confirmId: null } : s)),
    onConfirmDelete: () => {
      if (state.confirmId !== id || state.busyId || inFlight.has(id)) return;
      inFlight.add(id);
      setState((s) => ({ ...s, busyId: id, error: null }));
      void (async () => {
        try {
          await remove(id);
          setState((s) => ({ ...s, busyId: null, confirmId: s.confirmId === id ? null : s.confirmId }));
        } catch (e) {
          setState((s) => ({ ...s, busyId: null, error: `Couldn't delete: ${e instanceof Error ? e.message : String(e)}` }));
        } finally {
          inFlight.delete(id);
        }
      })();
    },
  };
}
