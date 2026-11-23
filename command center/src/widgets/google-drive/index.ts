import { lazy } from "react";
import { Cloud } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";
import type { DriveWidgetConfig } from "@/features/cloud/contract";

/** The contract's interface as a plain object type (interfaces don't satisfy `Record<string, unknown>`). */
export type DriveConfig = { [K in keyof DriveWidgetConfig]: DriveWidgetConfig[K] };

export default defineWidget<DriveConfig>({
  id: "google-drive",
  title: "Google Drive",
  description: "Browse your Drive folders and import footage into a Director project, then upload verified renders and share a link. Every upload and link asks first. Desktop app.",
  icon: Cloud,
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  maxSize: { w: 8, h: 6 },
  platforms: ["desktop"],
  keywords: ["drive", "google drive", "upload", "footage", "sync"],
  defaultConfig: { tab: "inbox", targetProject: null },
  component: lazy(() => import("./GoogleDrive")),
});
