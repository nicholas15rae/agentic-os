/**
 * "Send to Biz Ops" (contract §6): an approved final → the EXISTING Instagram ConfirmCard.
 *
 * The plan is the orchestrator's own `instagram.publish_post` plan (plan.ts `heuristicPlan`, so the
 * switchboard freeze and agent-grant checks apply), raised with `requestConfirmation`. This file
 * only RAISES the card: the post goes live only if Nic approves it there (execute.ts, approved:
 * true). Instagram needs a public https media URL, so the render must already be uploaded to
 * Drive AND shared ("Create share link"); the media URL is that file's Drive direct-download link.
 * Whether Meta accepts a Drive link is still to be tested (contract §6): if it refuses, the post
 * fails at Instagram and nothing else is tried.
 */
import type { CloudState } from "@/features/cloud/cloud-store";
import { shareLinkFor } from "@/features/cloud/cloud-store";
import { pushRecordFor, pushTransferFor } from "@/features/cloud/match";
import { heuristicPlan, type ActionPlan } from "@/features/orchestrator/plan";
import { requestConfirmation } from "@/features/voice/voice-controller";
import type { Deliverable, VerifiedRender } from "./contract";

/** Instagram's limits: 2200 caption characters, 30 hashtags. */
export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAGS_MAX = 30;

/** Drive's direct-download link for a file id (the media URL Instagram fetches). */
export const driveDirectUrl = (driveFileId: string) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`;

/** "#Dance", "dance reel", "dance" → "dance", "dancereel": letters, digits and _ only; duplicates (any case) dropped; ≤ 30. */
export function cleanHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const tag = t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]+/gu, "").slice(0, 60);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= IG_HASHTAGS_MAX) break;
  }
  return out;
}

/** Caption + hashtags on one line (the card's plan parser reads a single line), ≤ 2200 characters. */
export function bizOpsCaption(caption: string, hashtags: string[]): string {
  const text = caption
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“']+|["”']+$/g, "")
    .trim();
  const tags = cleanHashtags(hashtags).map((t) => `#${t}`);
  let out = text;
  for (const t of tags) {
    const next = out ? `${out} ${t}` : t;
    if (next.length > IG_CAPTION_MAX) break;
    out = next;
  }
  return out.slice(0, IG_CAPTION_MAX);
}

type CloudView = Pick<CloudState, "history" | "transfers" | "pushByRender" | "sharedLinks">;

/** The Drive file a render (or its final copy) was uploaded as, and its share link, if it has been shared. */
export function driveShareFor(render: VerifiedRender, cloud: CloudView, deliverable?: Pick<Deliverable, "path"> | null): { driveFileId: string; shareLink: string } | null {
  const record = pushRecordFor(render.path, cloud.history) ?? (deliverable ? pushRecordFor(deliverable.path, cloud.history) : null);
  const transfer = pushTransferFor(render, cloud.transfers, cloud.pushByRender[render.id]);
  const driveFileId = record?.driveFileId ?? (transfer?.status === "done" ? transfer.result?.driveFileId : undefined) ?? null;
  if (!driveFileId) return null;
  const shareLink = shareLinkFor(driveFileId, record, cloud.sharedLinks);
  return shareLink ? { driveFileId, shareLink } : null;
}

export interface BizOpsPost {
  caption: string;
  hashtags: string[];
  /** A public https media URL (from `driveDirectUrl`). */
  mediaUrl: string;
}
export type BizOpsResult = { ok: true; plan: ActionPlan } | { ok: false; reason: string };

/**
 * Build the Instagram Reel plan Biz Ops would carry (pure apart from reading the switchboard /
 * grants, as every plan does). Refused — with the reason the card would have given — when the
 * URL isn't https, Instagram is frozen or not Biz Ops's tool, or the app isn't the desktop.
 */
export async function bizOpsInstagramPlan(post: BizOpsPost): Promise<BizOpsResult> {
  const url = post.mediaUrl.trim();
  if (!/^https:\/\/\S+$/i.test(url)) return { ok: false, reason: "Instagram needs a public https link to the video. Upload the final to Drive and create a share link first." };
  const caption = bizOpsCaption(post.caption, post.hashtags);
  const plan = heuristicPlan(caption ? `post a reel ${url} to Instagram with caption ${caption}` : `post a reel ${url} to Instagram`, "bizops");
  if (!plan.mutating) return { ok: false, reason: plan.run ? (await plan.run()).text : "Biz Ops can't post to Instagram right now." };
  const t = plan.target;
  // The card must say exactly what will be posted: the same video URL and caption, nothing else.
  if (t.kind !== "tool" || t.tool !== "instagram.publish_post" || t.args.videoUrl !== url || (t.args.caption ?? "") !== caption || t.args.imageUrl !== undefined) {
    return { ok: false, reason: "Couldn't build the Instagram card from that caption. Edit the caption and try again." };
  }
  plan.plannerNote = "Director Suite · Send to Biz Ops";
  return { ok: true, plan };
}

/** "Send to Biz Ops": raise the Instagram ConfirmCard for this post. Publishes nothing by itself. */
export async function sendToBizOps(post: BizOpsPost): Promise<BizOpsResult> {
  const r = await bizOpsInstagramPlan(post);
  if (r.ok) await requestConfirmation(r.plan, "text");
  return r;
}

/** The same, straight from a render: its Drive share link must exist (upload + share come first). */
export async function sendRenderToBizOps(render: VerifiedRender, cloud: CloudView, text: { caption: string; hashtags: string[] }, deliverable?: Pick<Deliverable, "path"> | null): Promise<BizOpsResult> {
  const share = driveShareFor(render, cloud, deliverable);
  if (!share) return { ok: false, reason: "Upload the final to Drive and create a share link first: Instagram can only fetch a public link." };
  return sendToBizOps({ ...text, mediaUrl: driveDirectUrl(share.driveFileId) });
}
