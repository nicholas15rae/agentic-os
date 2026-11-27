"""Burned-in captions for timeline spec v2: transcript word timestamps → an ASS file.

Input is the JSON that `analyze.transcribe` writes (`transcribe_clip`):
    {"language": "en", "duration": s, "segments": [{"start", "end", "text",
      "words": [{"w": "Hello", "s": 0.52, "e": 0.81, "p": 0.97}, ...]}, ...]}

Word times are in the SOURCE clip's time. Each clip of the timeline keeps the words that fall
inside its [in, out) trim and shifts them onto the OUTPUT timeline (the clip's start there,
after earlier crossfades). Words are grouped into lines of up to `max_words_per_line`, breaking
early on a pause or the end of a sentence. The result is burned with ffmpeg's `ass` filter.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import PolicyError

STYLES = ("clean", "bold_pop", "karaoke", "minimal")
POSITIONS = ("lower", "middle")
GAP_BREAK_S = 0.6     # a pause this long starts a new line
MIN_LINE_S = 0.4      # a line stays up at least this long (if the next one allows)
HOLD_S = 0.25         # linger after the last word when nothing follows
SENTENCE_END = (".", "?", "!", "…")


def load_words(path: Path) -> list[dict]:
    """Strictly read a transcribe_clip JSON; returns [{"w", "s", "e", "seg"}] sorted by start."""
    try:
        data = json.loads(path.read_text("utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise PolicyError(f"could not read the transcript {path.name}: {e}") from None
    segs = data.get("segments") if isinstance(data, dict) else None
    if not isinstance(segs, list):
        raise PolicyError(f"transcript {path.name}: expected an object with a `segments` list")
    words: list[dict] = []
    for si, seg in enumerate(segs):
        if not isinstance(seg, dict):
            raise PolicyError(f"transcript {path.name}: segment {si + 1} must be an object")
        ws = seg.get("words") or []
        if not isinstance(ws, list):
            raise PolicyError(f"transcript {path.name}: segment {si + 1} words must be a list")
        for w in ws:
            if not isinstance(w, dict):
                raise PolicyError(f"transcript {path.name}: a word in segment {si + 1} must be an object")
            text, s, e = w.get("w"), w.get("s"), w.get("e")
            if not isinstance(text, str) or any(isinstance(v, bool) or not isinstance(v, (int, float))
                                                for v in (s, e)):
                raise PolicyError(f"transcript {path.name}: words need w (text), s and e (seconds)"
                                  " — transcribe with word_timestamps on")
            text = text.strip()
            if text and e >= s >= 0:
                words.append({"w": text, "s": float(s), "e": float(e), "seg": si})
    words.sort(key=lambda x: x["s"])
    return words


def place_words(words: list[dict], t_in: float, t_out: float, start: float, visible: float) -> list[dict]:
    """Words whose midpoint is inside the clip trim, re-timed onto the output timeline and clamped to
    the clip's visible span [start, start + visible)."""
    out = []
    end_vis = start + visible
    for w in words:
        mid = (w["s"] + w["e"]) / 2
        if not t_in <= mid < t_out:
            continue
        s = max(start, start + w["s"] - t_in)
        e = min(end_vis, start + w["e"] - t_in)
        if e <= s:
            e = min(end_vis, s + 0.05)
        out.append({"w": w["w"], "s": round(s, 3), "e": round(e, 3), "seg": (id(words), w["seg"])})
    return out


def group_lines(words: list[dict], max_words: int) -> list[list[dict]]:
    lines: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        if cur and (len(cur) >= max_words or w["s"] - cur[-1]["e"] > GAP_BREAK_S or w["seg"] != cur[-1]["seg"]
                    or cur[-1]["w"].endswith(SENTENCE_END)):
            lines.append(cur)
            cur = []
        cur.append(w)
    if cur:
        lines.append(cur)
    return lines


def _ts(t: float) -> str:
    cs = int(round(max(0.0, t) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _esc(text: str) -> str:
    return text.replace("\\", "⧵").replace("{", "(").replace("}", ")").replace("\n", " ")


def _style_line(style: str, W: int, H: int, position: str) -> str:
    base = min(W, H)
    align, margin_v = (2, int(H * 0.09)) if position == "lower" else (5, 0)
    margin_h = int(W * 0.06)
    # Format: Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline,
    # StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL/R/V, Encoding
    if style == "clean":
        font, size, prim, sec, outl, back, bold, border, ow, sh = (
            "Arial", 0.055, "&H00FFFFFF", "&H00FFFFFF", "&H00000000", "&H64000000", 0, 1, 0.0035, 0.0015)
    elif style == "bold_pop":
        font, size, prim, sec, outl, back, bold, border, ow, sh = (
            "Arial Black", 0.075, "&H00FFFFFF", "&H00FFFFFF", "&H00000000", "&H96000000", -1, 1, 0.007, 0.003)
    elif style == "karaoke":
        # \k fills from Secondary (white) to Primary (warm yellow) as each word is spoken.
        font, size, prim, sec, outl, back, bold, border, ow, sh = (
            "Arial", 0.062, "&H0033D6FF", "&H00FFFFFF", "&H00000000", "&H96000000", -1, 1, 0.005, 0.002)
    else:  # minimal: small text on a soft box
        font, size, prim, sec, outl, back, bold, border, ow, sh = (
            "Arial", 0.04, "&H00FFFFFF", "&H00FFFFFF", "&H80000000", "&H80000000", 0, 3, 0.006, 0.0)
    return (f"Style: Cap,{font},{max(12, int(base * size))},{prim},{sec},{outl},{back},{bold},0,0,0,100,100,0,0,"
            f"{border},{max(0.0, round(base * ow, 1))},{round(base * sh, 1)},{align},{margin_h},{margin_h},"
            f"{margin_v},1")


def build_ass(lines: list[list[dict]], style: str, position: str, W: int, H: int, total: float) -> str:
    events = []
    for i, line in enumerate(lines):
        start = line[0]["s"]
        nxt = lines[i + 1][0]["s"] if i + 1 < len(lines) else total
        end = max(line[-1]["e"], min(start + MIN_LINE_S, nxt))
        end = min(max(end, min(line[-1]["e"] + HOLD_S, nxt)), total)
        if end <= start:
            continue
        if style == "karaoke":
            parts = []
            cursor = start
            for w in line:
                lead = int(round((w["s"] - cursor) * 100))
                if lead > 0:
                    parts.append(f"{{\\k{lead}}}")
                dur = max(1, int(round((w["e"] - max(w["s"], cursor)) * 100)))
                parts.append(f"{{\\kf{dur}}}{_esc(w['w'])} ")
                cursor = max(cursor, w["e"])
            text = "".join(parts).rstrip()
        else:
            words = " ".join(_esc(w["w"]) for w in line)
            if style == "bold_pop":
                text = "{\\fscx82\\fscy82\\t(0,120,\\fscx100\\fscy100)}" + words.upper()
            elif style == "minimal":
                text = words.lower() if words.isupper() else words
            else:
                text = words
        events.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Cap,,0,0,0,,{text}")
    return "\n".join([
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
        "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding",
        _style_line(style, W, H, position), "",
        "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events, ""])


def timeline_ass(plan: dict) -> tuple[str, int]:
    """ASS text for a validated v2 plan (captions enabled) and the number of caption lines."""
    cap = plan["captions"]
    placed: list[dict] = []
    cache: dict[str, list[dict]] = {}
    for c in plan["clips"]:
        tp = c.get("transcript")
        if not tp:
            continue
        if tp not in cache:
            cache[tp] = load_words(Path(tp))
        placed += place_words(cache[tp], c["in"] if c["kind"] == "video" else 0.0,
                              c["out"] if c["kind"] == "video" else c["duration"],
                              c["start"], c["duration"])
    placed.sort(key=lambda w: w["s"])
    lines = group_lines(placed, cap["max_words_per_line"])
    return build_ass(lines, cap["style"], cap["position"], plan["width"], plan["height"],
                     plan["total_duration"]), len(lines)
