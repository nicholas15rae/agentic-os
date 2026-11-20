import type { WidgetProps } from "@/core/widgets/types";
import { SandboxView } from "@/features/buildhub/SandboxView";

export default function StagedBuildWidget({ config }: WidgetProps<{ buildId: string; title: string }>) {
  if (!config.buildId) return <p className="p-3 text-xs text-ink-3">Promote a build from the Play Place to show it here.</p>;
  return (
    <div className="flex h-full flex-col">
      <p className="label-caps mb-1 truncate text-ink-3">{config.title}</p>
      <div className="min-h-0 flex-1">
        <SandboxView buildId={config.buildId} title={config.title} version={0} height="100%" />
      </div>
    </div>
  );
}
