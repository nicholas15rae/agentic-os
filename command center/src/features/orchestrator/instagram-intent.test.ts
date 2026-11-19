import { describe, expect, it } from "vitest";
import { parseInstagramIntent } from "./instagram-intent";

describe("parseInstagramIntent", () => {
  it("publish: url then caption", () => {
    expect(parseInstagramIntent("post https://cdn.example.com/headshot.jpg to Instagram with caption New headshots!")).toEqual({
      kind: "publish",
      imageUrl: "https://cdn.example.com/headshot.jpg",
      caption: "New headshots!",
    });
  });

  it("publish: to insta with a colon, video becomes a Reel", () => {
    expect(parseInstagramIntent("publish to insta: https://cdn.example.com/clip.mp4 caption Set day")).toEqual({
      kind: "publish",
      videoUrl: "https://cdn.example.com/clip.mp4",
      caption: "Set day",
    });
    expect(parseInstagramIntent("share a reel to IG https://cdn.example.com/v?id=3")).toMatchObject({ kind: "publish", videoUrl: "https://cdn.example.com/v?id=3", caption: "" });
  });

  it("publish without a usable link asks for one", () => {
    expect(parseInstagramIntent("post my new headshot to Instagram")?.kind).toBe("ask");
    expect(parseInstagramIntent("post http://cdn.example.com/a.jpg to instagram")?.kind).toBe("ask");
  });

  it("reply to a comment by id", () => {
    expect(parseInstagramIntent("reply to Instagram comment 17890012345 saying thank you so much!")).toEqual({ kind: "reply", commentId: "17890012345", message: "thank you so much!" });
    expect(parseInstagramIntent("reply to comment 17890012345 on insta: “appreciate it”")).toEqual({ kind: "reply", commentId: "17890012345", message: "appreciate it" });
  });

  it("ignores everything else", () => {
    for (const t of ["how many followers do I have on instagram", "reply to Sam's email saying yes", "post the update to Slack", "what's my latest reel doing"]) {
      expect(parseInstagramIntent(t), t).toBeNull();
    }
  });
});
