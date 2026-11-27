import { lazy } from "react";
import { CloudSun } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "weather",
  title: "Living Weather",
  description: "Live conditions and a 7-day forecast (Open-Meteo, no key), with the Live/Manual atmosphere picker that drives the particle layer.",
  icon: CloudSun,
  // 3x3 for new placements (room for the forecast); saved layouts keep their size.
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./Weather")),
});
