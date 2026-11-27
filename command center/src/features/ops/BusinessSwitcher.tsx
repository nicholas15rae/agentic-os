import { useEffect, useRef, useState } from "react";
import { Briefcase, Check, ChevronDown } from "lucide-react";
import { useNav } from "@/stores/nav";
import { useOps } from "./ops-store";

/**
 * Top-bar pill: which business Operations-Manager and Finance turns are locked to. "Ask each
 * time" leaves it to the request's wording (Tony asks when that isn't exactly one business).
 */
export function BusinessSwitcher() {
  const businesses = useOps((s) => s.businesses);
  const activeId = useOps((s) => s.activeBusinessId);
  const setActive = useOps((s) => s.setActive);
  const go = useNav((s) => s.go);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = businesses.filter((b) => b.status === "active");
  const current = active.find((b) => b.businessId === activeId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!businesses.length) return null;
  const pick = (id: string | null) => {
    setActive(id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Business the Operations Manager and Finance work on"
        className={`glass-thin flex h-9 max-w-[220px] items-center gap-2 rounded-full px-3 text-[12px] transition-colors ${current ? "text-ink" : "text-ink-2 hover:text-ink"}`}
      >
        <Briefcase size={13} className={current ? "text-teal" : ""} />
        <span className="truncate">{current ? current.displayName : "Any business"}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div role="listbox" aria-label="Active business" className="glass absolute right-0 top-11 z-[60] w-64 rounded-[16px] p-1.5">
          <Option selected={!current} onClick={() => pick(null)} label="Ask each time" sub="Tony works it out from what you say" />
          {active.map((b) => (
            <Option key={b.businessId} selected={b.businessId === activeId} onClick={() => pick(b.businessId)} label={b.displayName} sub={b.category || b.businessId} />
          ))}
          {active.length < businesses.length && <p className="px-3 py-1.5 text-[11px] text-ink-3">{businesses.length - active.length} not active yet</p>}
          <button
            onClick={() => {
              setOpen(false);
              go("operations");
            }}
            className="mt-1 w-full rounded-[10px] px-3 py-2 text-left text-[12px] text-amber-light hover:bg-white/5"
          >
            Manage businesses →
          </button>
        </div>
      )}
    </div>
  );
}

function Option({ selected, onClick, label, sub }: { selected: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button role="option" aria-selected={selected} onClick={onClick} className={`flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left hover:bg-white/5 ${selected ? "bg-white/[0.04]" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{label}</span>
        <span className="block truncate text-[11px] text-ink-3">{sub}</span>
      </span>
      {selected && <Check size={14} className="shrink-0 text-teal" />}
    </button>
  );
}
