import { lazy } from "react";
import { Map as MapIcon } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";
import { listenForRoutes } from "@/features/maps/map-store";

// Registered eagerly (widget registry glob), so routes Tony plans are kept even before
// the widget is on a page; no-op outside the desktop app.
listenForRoutes();

export default defineWidget({
  id: "route-map",
  title: "Route Map",
  description: "OpenStreetMap (OpenFreeMap tiles, no key). Shows the routes Tony plans — pins, the road-following line, ETA — plus your own route search and an Open in Maps hand-off to your phone. Desktop app.",
  icon: MapIcon,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 3, h: 3 },
  keywords: ["map", "maps", "route", "directions", "eta", "drive", "navigation", "openstreetmap", "osm"],
  defaultConfig: {},
  component: lazy(() => import("./RouteMap")),
});
