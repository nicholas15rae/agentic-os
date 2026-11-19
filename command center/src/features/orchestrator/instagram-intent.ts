/**
 * Instagram writes Tony can do — always as a confirmation-card plan, never directly:
 *
 *   "post https://…/headshot.jpg to Instagram with caption New headshots"
 *   "publish to insta: https://…/clip.mp4 caption Set day"            (video → Reel)
 *   "reply to Instagram comment 17890012345 saying thank you!"
 *
 * Pure parsing (no I/O). A publish request without a public https media link returns
 * `ask`, so Tony asks for one instead of building a plan it can't run.
 */
export type InstagramIntent =
  | { kind: "publish"; imageUrl?: string; videoUrl?: string; caption: string }
  | { kind: "reply"; commentId: string; message: string }
  | { kind: "ask"; reply: string };

const IG = String.raw`(?:instagram|insta|ig)`;
const VERB = String.raw`(?:post|publish|share|upload)`;
const URL_RE = String.raw`(https?:\/\/\S+)`;
const CAPTION = String.raw`(?:[,.]?\s*(?:with\s+(?:the\s+)?caption|captioned|caption|saying)\s*[:\-–]?\s*(.+))?`;

const PUBLISH_A = new RegExp(String.raw`^${VERB}\s+(?:(?:a|this|my)\s+)?(?:photo|picture|pic|image|video|reel|post\s+)?\s*(?:to|on)\s+${IG}\b\s*[:,\-–]?\s*${URL_RE}${CAPTION}$`, "i");
const PUBLISH_B = new RegExp(String.raw`^${VERB}\s+(?:(?:a|this|my)\s+)?(?:photo|picture|pic|image|video|reel)?\s*${URL_RE}\s+(?:to|on)\s+${IG}\b${CAPTION}$`, "i");
const PUBLISH_NO_URL = new RegExp(String.raw`^${VERB}\b.*\b(?:to|on)\s+${IG}\b`, "i");
const REPLY = new RegExp(String.raw`^reply\s+to\s+(?:(?:the|that|${IG})\s+)*comment\s+(?:id\s+)?(\d{5,40})(?:\s+on\s+${IG})?\s*(?:saying|with|:|-|–)\s*(.+)$`, "i");

const VIDEO = /\.(mp4|mov|m4v)(\?|#|$)/i;

function clean(s: string): string {
  return s
    .trim()
    .replace(/^["“']|["”']$/g, "")
    .trim();
}

export function parseInstagramIntent(text: string): InstagramIntent | null {
  const t = text.trim().replace(/[\s]+/g, " ");
  const r = REPLY.exec(t);
  if (r) {
    const message = clean(r[2]);
    return message ? { kind: "reply", commentId: r[1], message } : null;
  }
  const m = PUBLISH_A.exec(t) ?? PUBLISH_B.exec(t);
  if (m) {
    const url = m[1].replace(/[),.;]+$/, "");
    if (!url.toLowerCase().startsWith("https://")) return { kind: "ask", reply: "Instagram needs a public https link to the photo or video — send me one with the caption." };
    const caption = clean(m[2] ?? "");
    const isVideo = VIDEO.test(url) || /\b(video|reel)\b/i.test(t.slice(0, t.indexOf(m[1])));
    return isVideo ? { kind: "publish", videoUrl: url, caption } : { kind: "publish", imageUrl: url, caption };
  }
  if (PUBLISH_NO_URL.test(t)) return { kind: "ask", reply: "Sure — send me a public https link to the photo or video and the caption, and I'll show you the post before anything goes live." };
  return null;
}
