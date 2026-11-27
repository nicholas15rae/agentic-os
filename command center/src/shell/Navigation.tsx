import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { SECTIONS, useNav } from "@/stores/nav";
import { usePipelines } from "@/features/os/pipeline-store";
import { useOps } from "@/features/ops/ops-store";
import { LifecycleRail } from "@/features/lifecycle/LifecycleRail";
import { MyAppsRail, MyAppsSheet } from "@/features/myapps/MyAppsRail";

/** Slim icon rail on desktop/tablet. */
export function SideRail() {
  const { section, go } = useNav();
  const unseen = usePipelines((s) => s.unseen);
  const review = useOps((s) => s.review?.pending ?? 0);
  const digest = useOps((s) => s.digestUnseen);
  return (
    <nav aria-label="Sections" className="hidden w-[72px] shrink-0 flex-col items-center gap-2.5 overflow-y-auto border-r border-white/[0.06] bg-[rgba(11,13,17,0.35)] py-4 backdrop-blur-md [scrollbar-width:none] md:flex">
      <img src={import.meta.env.BASE_URL + "icon.svg"} alt="" className="mb-3 size-9 r-10" />
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => go(id)}
          aria-current={section === id ? "page" : undefined}
          aria-label={label}
          title={label}
          className={`relative grid size-11 place-items-center r-14 transition-all duration-200 ${
            section === id ? "border border-amber/50 bg-amber/10 text-amber-light glow-amber" : "text-ink-2 hover:bg-white/5 hover:text-ink"
          }`}
        >
          <Icon size={19} />
          {id === "playplace" && unseen > 0 && <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-amber font-mono fs-9 font-bold text-canvas">{unseen}</span>}
          {id === "operations" && review > 0 && (
            <span aria-label={`${review} waiting for review`} className={`absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full font-mono fs-9 font-bold text-canvas ${digest ? "bg-amber" : "bg-ink-3"}`}>
              {review > 9 ? "9+" : review}
            </span>
          )}
        </button>
      ))}
      <MyAppsRail />
      <LifecycleRail />
    </nav>
  );
}

/** Bottom tab bar on phones: four primary tabs + "More". */
export function MobileTabs() {
  const { section, go } = useNav();
  const [more, setMore] = useState(false);
  const primary = SECTIONS.filter((s) => s.mobile);
  const rest = SECTIONS.filter((s) => !s.mobile);
  const inRest = section === "app" || rest.some((s) => s.id === section);
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMore(false)}>
          <div
            className="glass absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] grid grid-cols-4 gap-2 r-20 p-3"
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            {rest.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="menuitem"
                onClick={() => {
                  go(id);
                  setMore(false);
                }}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 r-14 ${section === id ? "bg-amber/15 text-amber-light" : "text-ink-2"}`}
              >
                <Icon size={20} />
                <span className="fs-11">{label}</span>
              </button>
            ))}
            <MyAppsSheet onPick={() => setMore(false)} />
          </div>
        </div>
      )}
      <nav aria-label="Sections" className="glass-thin fixed inset-x-0 bottom-0 z-40 flex justify-around border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] md:hidden">
        {primary.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => go(id)}
            aria-current={section === id ? "page" : undefined}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 ${section === id ? "text-amber-light" : "text-ink-3"}`}
          >
            <Icon size={19} />
            <span className="fs-10 font-medium">{label}</span>
          </button>
        ))}
        <button
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          aria-haspopup="menu"
          className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 ${inRest || more ? "text-amber-light" : "text-ink-3"}`}
        >
          <MoreHorizontal size={19} />
          <span className="fs-10 font-medium">More</span>
        </button>
      </nav>
    </>
  );
}
