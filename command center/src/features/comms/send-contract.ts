/**
 * LOCKED contract — Comms send origin + Instant Send trust (build plan Sections 8-10, Comms step 1,
 * decision 5 default: "only replies you type by hand, a card to turn it on, a card for anything
 * Tony/voice/agents start"). The user approved the defaults; change only with a new decision.
 *
 * Shared by the gateway (`os_api.py` POST /api/comms/send, POST /api/comms/contacts) and the desktop
 * (`pipeline.rs` `comms_whatsapp_send`). Kept outside `lib/platform.ts` (like `lib/native-ext.ts`) so
 * the shared NativeCommands file isn't churned; the later Comms split (step 9) folds it into
 * `features/comms/send.ts`.
 *
 * Rules (enforced server-side, mirrored here so the UI knows when to show the card first):
 *  - Trust is an EXACT match on the normalized contact key (phone: last 10 digits; JID/email:
 *    lowercased). A substring of a trusted number is not trusted.
 *  - Only `origin: "ui-typed"` (the hand-typed Chat box) to an exactly trusted contact may skip the
 *    confirmation card. Every other origin — a UI card, voice, Tony, an agent, or none — needs
 *    `approved: true` (desktop) / `confirmed: true` (gateway), or it is refused with
 *    `PERMISSION_REQUIRED:send` (desktop) / HTTP 428 (gateway).
 *  - Instagram, Messenger and RCS can never be trusted.
 *  - Turning trust ON needs the confirmation card (`confirmed: true`) and is audit-logged.
 *  - Note: the gateway can't verify the origin claim; anyone holding the token can fake it. The
 *    token is the real boundary; this guards our own code paths.
 */
import { native } from "@/lib/platform";

/** Who started the send. Wire format is kebab-case; `ui_typed` style is accepted and normalized. */
export type SendOrigin = "ui-typed" | "ui-card" | "voice" | "tony" | "agent";

/** Channels whose contacts can never be trusted (read-only / notification-captured). */
export const UNTRUSTABLE_CHANNELS: readonly string[] = ["instagram", "messenger", "rcs"];

/** `comms_whatsapp_send` (pipeline.rs). `approved` = the confirmation card said yes. */
export interface WhatsAppSendArgs {
  recipient: string;
  message: string;
  approved?: boolean;
  /** Missing = treated as an agent: a card is required. */
  origin?: SendOrigin;
}

/** POST /api/comms/send body. */
export interface CommsSendBody {
  address: string;
  contact?: string;
  body: string;
  channel: "sms";
  confirmed?: boolean;
  origin: SendOrigin;
}

/** POST /api/comms/contacts body. `trusted: true` without `confirmed: true` → 428; read-only channel → 400. */
export interface CommsContactBody {
  address: string;
  name?: string;
  trusted?: boolean;
  confirmed?: boolean;
  channel?: string;
}

/** May this send go out without the card? (Mirror of the server rule; the server re-checks.) */
export function canSkipCard(origin: SendOrigin, trusted: boolean, channel: string): boolean {
  return origin === "ui-typed" && trusted && !UNTRUSTABLE_CHANNELS.includes(channel.toLowerCase());
}

/** Is this the server saying "show the card first" (desktop `PERMISSION_REQUIRED:send`, gateway 428)? */
export function isPermissionRequired(e: unknown): boolean {
  if (typeof e === "string") return e.startsWith("PERMISSION_REQUIRED:");
  if (e && typeof e === "object") {
    const status = (e as { status?: unknown }).status;
    if (status === 428) return true;
    const msg = (e as { message?: unknown }).message;
    return typeof msg === "string" && msg.startsWith("PERMISSION_REQUIRED:");
  }
  return false;
}

/** Desktop WhatsApp send with its origin (desktop-only, like every `native` command). */
export function whatsappSend(args: WhatsAppSendArgs): Promise<string> {
  return native<string>("comms_whatsapp_send", { ...args });
}
