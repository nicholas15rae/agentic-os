import { lazy } from "react";
import { SlidersHorizontal } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "tony-mode",
  title: "Tony Mode",
  description: "Switch Tony's mode (Solo, Brainstorming, Builder, Executive, Coach, your own), nudge the Curiosity Dial and the dispatch gate, and toggle the novelty sound mode.",
  icon: SlidersHorizontal,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  maxSize: { w: 6, h: 4 },
  compactOrder: 1,
  // Never the novelty word: "add gabagool" must not add this panel.
  keywords: ["tony mode", "modes", "mode panel", "curiosity", "dispatch", "brainstorm", "builder", "executive", "coach", "solo"],
  defaultConfig: {},
  component: lazy(() => import("./ModePanel")),
});
