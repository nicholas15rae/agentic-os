import { create } from "zustand";
import type { LucideIcon } from "lucide-react";
import { Briefcase, CandlestickChart, Clapperboard, Cpu, FlaskConical, Gauge, Image, Languages, Lightbulb, MessagesSquare, Phone, Receipt, Search, Settings2 } from "lucide-react";

/** "app" is a mounted MY APPS page (`#/app/<id>`), not one of the fixed SECTIONS. */
export type Section = "command" | "agents" | "playplace" | "director" | "comms" | "brainstorm" | "finance" | "operations" | "trading" | "language" | "vault" | "wallpapers" | "memorymap" | "settings" | "app";
export type FixedSection = Exclude<Section, "app">;

export const SECTIONS: { id: FixedSection; label: string; icon: LucideIcon; mobile: boolean }[] = [
  { id: "command", label: "Command", icon: Gauge, mobile: true },
  { id: "agents", label: "Agents", icon: MessagesSquare, mobile: true },
  { id: "playplace", label: "Play Place", icon: FlaskConical, mobile: false },
  { id: "director", label: "Director Suite", icon: Clapperboard, mobile: false },
  { id: "comms", label: "Comms", icon: Phone, mobile: true },
  { id: "brainstorm", label: "Brainstorm", icon: Lightbulb, mobile: true },
  { id: "finance", label: "Finance", icon: Receipt, mobile: true },
  { id: "operations", label: "Operations", icon: Briefcase, mobile: false },
  { id: "trading", label: "Trading", icon: CandlestickChart, mobile: false },
  { id: "language", label: "Language Hub", icon: Languages, mobile: false },
  { id: "vault", label: "Vault", icon: Search, mobile: false },
  { id: "wallpapers", label: "Wallpapers", icon: Image, mobile: false },
  { id: "memorymap", label: "System Map", icon: Cpu, mobile: false },
  { id: "settings", label: "Settings", icon: Settings2, mobile: false },
];

/** Section (and mounted app id) from a hash like `#/playplace` or `#/app/build-b-123`. Pure. */
export function parseHash(hash: string): { section: Section; appId: string | null } {
  const [head, ...rest] = hash.replace(/^#\/?/, "").split("/");
  if (head === "app" && rest[0]) return { section: "app", appId: decodeURIComponent(rest.join("/")) };
  return { section: SECTIONS.some((s) => s.id === head) ? (head as FixedSection) : "command", appId: null };
}

interface NavState {
  section: Section;
  /** The mounted app shown when `section` is "app". */
  appId: string | null;
  go: (s: FixedSection) => void;
  openApp: (id: string) => void;
}

export const useNav = create<NavState>((set) => ({
  ...parseHash(location.hash),
  go: (section) => {
    history.replaceState(null, "", `#/${section}`);
    set({ section, appId: null });
  },
  openApp: (id) => {
    history.replaceState(null, "", `#/app/${encodeURIComponent(id)}`);
    set({ section: "app", appId: id });
  },
}));

window.addEventListener("hashchange", () => useNav.setState(parseHash(location.hash)));
