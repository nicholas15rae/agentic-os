import { lazy } from "react";
import { FlaskConical } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

/**
 * A Play Place build promoted to the live dashboard (Thought-to-Product Path A). Added by
 * "Promote to Live Dashboard" after the smoke test passes; renders the frozen promoted copy in a
 * sandboxed iframe inside an Error Boundary, so a broken widget can't take the grid down.
 */
export default defineWidget<{ buildId: string; title: string }>({
  id: "staged-build",
  title: "Promoted Build",
  description: "A widget you built in the Play Place and promoted after its smoke test passed.",
  icon: FlaskConical,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  platforms: ["desktop"],
  keywords: ["promoted build", "play place widget"],
  defaultConfig: { buildId: "", title: "Promoted build" },
  component: lazy(() => import("./StagedBuildWidget")),
});
