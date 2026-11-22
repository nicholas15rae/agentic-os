/** `arbiter::NodeDef` (static roster definition) as `agent_inspect` serialises it. */
export interface NodeDef {
  id: string;
  label: string;
  group: string;
  compute: "gpu" | "cpu" | "api";
  namespace: string | null;
  schedule: string;
}
