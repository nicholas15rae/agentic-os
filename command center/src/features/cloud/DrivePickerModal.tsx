import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Cloud, X } from "lucide-react";
import type { AssetRole } from "@/features/director/contract";
import { useCloud } from "./cloud-store";
import { DriveBrowser } from "./DriveBrowser";
import { DriveGate } from "./DriveGate";
import { PullBar } from "./PullBar";
import { TransferList } from "./TransferList";

/**
 * "From Google Drive…" in the staging bin: the Drive browser as a modal, importing into the open
 * project with the bin's role. Imported files land in the bin when their transfer finishes.
 */
export function DrivePickerModal({ slug, projectTitle, role, onRole, onClose }: { slug: string; projectTitle: string; role: AssetRole; onRole: (r: AssetRole) => void; onClose: () => void }) {
  const inbox = useCloud((s) => s.status?.inboxFolder?.id ?? null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/45 p-4 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Import from Google Drive" className="glass flex h-[min(640px,90vh)] w-[min(720px,100%)] flex-col gap-3 r-22 p-4">
        <header className="flex items-center gap-2">
          <Cloud size={15} className="text-amber-soft" />
          <h2 className="label-caps text-amber-soft">From Google Drive</h2>
          <span className="truncate fs-12 text-ink-3">→ {projectTitle}</span>
          <button onClick={onClose} className="pill-glass ml-auto !h-8 !w-8 !p-0" aria-label="Close">
            <X size={13} />
          </button>
        </header>
        <DriveGate>
          <DriveBrowser startFolderId={inbox} showOutbox={false} />
          <PullBar project={slug} lockProject role={role} onRole={onRole} />
          <TransferList project={slug} direction="pull" limit={5} />
        </DriveGate>
      </div>
    </div>,
    document.body,
  );
}
