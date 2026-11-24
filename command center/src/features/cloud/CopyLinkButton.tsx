import { Copy } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";

/** Copy a link to the clipboard. Toasts the outcome. Returns whether it worked. */
export async function copyLink(link: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    useToasts.getState().push({ title: "Link copied", body: link, tone: "info" });
    return true;
  } catch (e) {
    useToasts.getState().push({ title: "Couldn't copy the link", body: e instanceof Error ? e.message : String(e), tone: "error" });
    return false;
  }
}

export function CopyLinkButton({ link, compact = false }: { link: string; compact?: boolean }) {
  return (
    <button onClick={() => void copyLink(link)} className={`pill-glass !h-7 shrink-0 text-[11px] ${compact ? "!w-7 !p-0" : "!px-2"}`} title="Copy the share link" aria-label="Copy link">
      <Copy size={11} />
      {!compact && " Copy link"}
    </button>
  );
}
