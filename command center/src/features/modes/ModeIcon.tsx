import { Briefcase, Flame, GraduationCap, Hammer, Lightbulb, MessageCircle, Sparkles, type LucideIcon } from "lucide-react";
import type { ModeIconName } from "./mode-ui";

const ICONS: Record<ModeIconName, LucideIcon> = {
  "message-circle": MessageCircle,
  lightbulb: Lightbulb,
  hammer: Hammer,
  briefcase: Briefcase,
  flame: Flame,
  "graduation-cap": GraduationCap,
  sparkles: Sparkles,
};

/** A mode's icon: one of the lucide names, otherwise the text itself (an emoji). */
export function ModeIcon({ icon, size = 14, className = "" }: { icon: string; size?: number; className?: string }) {
  const Icon = ICONS[icon as ModeIconName];
  if (Icon) return <Icon size={size} aria-hidden className={className} />;
  return (
    <span aria-hidden className={`inline-block leading-none ${className}`} style={{ fontSize: size }}>
      {Array.from(icon).slice(0, 2).join("")}
    </span>
  );
}
