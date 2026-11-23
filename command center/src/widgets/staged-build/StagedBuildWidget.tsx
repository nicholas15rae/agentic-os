import type { WidgetProps } from "@/core/widgets/types";
import { SandboxView } from "@/features/buildhub/SandboxView";
import { useHub } from "@/features/buildhub/hub-store";
import { FixMenu } from "./FixMenu";

export default function StagedBuildWidget({ config }: WidgetProps<{ buildId: string; title: string }>) {
  // Re-promoting changes promoted_at: the iframe remounts on the new frozen copy.
  const version = useHub((s) => s.view?.builds.find((b) => b.envelope.build_id === config.buildId)?.promoted_at ?? 0);
  if (!config.buildId) return <p className="p-3 text-xs text-ink-3">Promote a build from the Play Place to show it here.</p>;
  // Chromeless on the grid: the build draws its own surface (or none), so no card or caption here.
  return (
    <div className="group relative h-full">
      <SandboxView buildId={config.buildId} title={config.title} version={version} height="100%" bare />
      <FixMenu buildId={config.buildId} title={config.title} />
    </div>
  );
}
