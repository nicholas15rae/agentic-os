import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Card } from "@/components/ui";
import type { SidesFile } from "./contract";
import { hasFiles } from "./dnd";
import { useDirector } from "./director-store";
import { addSides, loadSides, makeSlate, useAudition, type SlateFields } from "./audition-store";

/** Part 4: an audition project's sides (dropped PDF / text, kept read-only) and its slate still. */

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export interface AuditionCardProps {
  sides: SidesFile[];
  sidesBusy: boolean;
  slateBusy: boolean;
  onDropFiles: (files: File[]) => void;
  onSlate: (f: SlateFields) => void;
}

/** Props only. */
export function AuditionCardView(p: AuditionCardProps) {
  const [over, setOver] = useState(false);
  const [f, setF] = useState<SlateFields>({ name: "", role: "", contact: "" });
  const field = (k: keyof SlateFields, label: string, placeholder: string) => (
    <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={placeholder} maxLength={80} aria-label={label} className="field !h-9 !py-0 fs-13" />
  );
  return (
    <Card title="Audition" hint="Sides and a slate for the self-tape. The import sets the Self-tape output: 16:9, −18 LUFS, up to 100 MB.">
      <div data-testid="audition-card" className="space-y-4">
        <div
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(false);
            p.onDropFiles(Array.from(e.dataTransfer.files));
          }}
          className={`r-14 border border-dashed p-3 text-center text-xs transition-colors ${over ? "border-amber/60 bg-amber/10 text-ink" : "border-white/15 text-ink-3"}`}
          aria-label="Drop sides here"
        >
          {p.sidesBusy ? <Loader2 size={14} className="mx-auto animate-spin" /> : "Drop sides here (PDF or text)"}
        </div>
        {p.sides.length > 0 && (
          <ul className="space-y-1" aria-label="Sides">
            {p.sides.map((s) => (
              <li key={s.path} className="flex items-center gap-2 fs-13 text-ink-2">
                <FileText size={12} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="fs-11 text-ink-3">{kb(s.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim()) p.onSlate(f);
          }}
        >
          <p className="fs-12 text-ink-2">Slate</p>
          {field("name", "Slate name", "Name")}
          {field("role", "Slate role", "Role")}
          {field("contact", "Slate contact", "Agency or contact")}
          <button type="submit" disabled={!f.name.trim() || p.slateBusy} className="pill-glass !h-9 !px-3 text-xs disabled:opacity-50">
            {p.slateBusy ? <Loader2 size={12} className="animate-spin" /> : "Make slate"}
          </button>
        </form>
      </div>
    </Card>
  );
}

/** Store wrapper: only for an audition project (made from Scene Reader). */
export function AuditionCard() {
  const slug = useDirector((s) => s.slug);
  const from = useDirector((s) => s.project?.source.from);
  const { sides, sidesSlug, sidesBusy, slateBusy } = useAudition();
  const audition = from === "scene_reader";
  useEffect(() => {
    if (slug && audition) void loadSides(slug);
  }, [slug, audition]);
  if (!slug || !audition) return null;
  return (
    <AuditionCardView
      sides={sidesSlug === slug ? sides : []}
      sidesBusy={sidesBusy}
      slateBusy={slateBusy}
      onDropFiles={(files) => void addSides(slug, files)}
      onSlate={(f) => void makeSlate(slug, f)}
    />
  );
}
