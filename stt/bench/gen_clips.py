"""Benchmark clip set for the STT comparison (Kokoro synthetic speech + non-speech).

Speech: ~30 vocabulary-rich sentences of ~1-25 s, spoken by Kokoro (http://127.0.0.1:8880,
OpenAI-style /v1/audio/speech) in 2-3 voices, then box-filter decimated to 16 kHz mono PCM16
exactly like the app's encodeWav16k (command center/src/features/voice/engines.ts).
Non-speech: 6 seeded clips (digital silence, room tone, white / brown noise, mains hum, key clicks)
that every engine should return empty for.

Writes G:\\agentic os\\data\\stt-bench\\clips\\*.wav + manifest.json (gitignored).

  python -I "G:\\agentic os\\stt\\bench\\gen_clips.py"
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
import wave
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[2] / "data" / "stt-bench" / "clips"
KOKORO = "http://127.0.0.1:8880/v1/audio/speech"
VOICES = ("am_michael", "af_heart", "bm_george")

SHORT = [  # 1-5 s: the live-turn bucket; each in two voices
    "Cut it.",
    "Whoa, Tony.",
    "Take it easy.",
    "Madone, aspetta.",
    "Hey Tony, Gabagool mode.",
    "Tony, ask the Booking Desk about Friday.",
    "Play some Bilmuri on Spotify.",
    "Have the Librarian file the deal memo.",
    "Send the call sheet to Serena.",
    "Switch Kokoro to the deeper voice.",
    "Erra is playing in Toronto next month.",
    "Nic wants the Tauri build fixed today.",
    "Gabagool mode on, keep it short.",
    "Tony, what is on my calendar tomorrow morning?",
    "Check WhatsApp for anything from Serena.",
]
LONG = [  # 5-25 s: one voice each
    "Tony, tell the Booking Desk to hold the Thursday slot and send Serena the call sheet before lunch.",
    "Ask the Librarian to pull every deal memo we signed with the venue last summer and summarize the terms.",
    "Put Bilmuri and Erra on the gym playlist, then turn the volume down a little while I am on the phone.",
    "The Tauri app crashed again after the update, so open a checkpoint and roll back the last change.",
    "Kokoro sounds robotic on long sentences, so try the other voice and read the call sheet back to me.",
    "Madone, the coffee machine is broken again. Remind me to call the repair guy at noon.",
    "Nic needs the deal memo signed by Friday, so flag it as urgent and tell the Booking Desk.",
    "Tony, before the show tonight, check the call sheet for load in times, confirm the van with Serena, "
    "and ask the Booking Desk whether the second night is still on hold.",
    "I listened to the new Bilmuri record twice this morning. The production is wild, but the mix buries the vocals "
    "on the second half, so add a note to the deal memo about mastering.",
    "Gabagool mode for the rest of the day please. Keep the answers short, skip the small talk, "
    "and only ping me if the Librarian finds something urgent in the contracts folder.",
    "Here is the plan for tomorrow. Breakfast with Serena at nine, then the Erra interview, then the Tauri release "
    "review with the team. Block the afternoon for the call sheet and the deal memo.",
    "Tony, I want a summary of every email from the venue this week, the open questions on the deal memo, "
    "and anything the Booking Desk still needs from me before we can confirm the tour dates with Erra and Bilmuri.",
    "Take it easy on the notifications today. If Serena calls, put her through. If it is the label, take a message. "
    "Everything else can wait until after the Kokoro voice test and the Tauri build.",
    "Let me dictate a quick note for the Librarian. The new deal memo replaces the old one from the spring. "
    "Keep both in the archive, mark the old one as superseded, and link the call sheet for the first show.",
    "Okay Tony, last thing for tonight. Ask the Booking Desk to send the final call sheet to the whole crew, "
    "remind Nic about the deal memo signature, and set an alarm for seven so I can catch the early train with Serena.",
    "Long note for the record. The meeting with the label went well. They liked the Bilmuri demos and want Erra on the "
    "same bill in the spring. The deal memo needs a new clause about merch, and the Librarian should keep the old draft. "
    "Serena will send the call sheet once the venue confirms the date.",
    "Tony, here is everything for the morning brief. First, the Tauri release is blocked on the audio bug, so the team "
    "needs a checkpoint before lunch. Second, Kokoro needs a calmer voice for the late night readings. Third, ask the "
    "Booking Desk to confirm the van, the hotel and the call sheet, and tell Nic the deal memo is waiting for his "
    "signature. Gabagool mode after that, please.",
]


def decimate16k(pcm: np.ndarray, in_rate: int) -> np.ndarray:
    """encodeWav16k: box-filter decimation of float samples, clamped, to int16 (asymmetric scale)."""
    ratio = in_rate / 16000
    n = int(len(pcm) // ratio)
    out = np.empty(n, dtype=np.float64)
    for i in range(n):
        a, b = int(i * ratio), min(len(pcm), int((i + 1) * ratio))
        out[i] = pcm[a:b].sum() / max(1, b - a)
    out = np.clip(out, -1, 1)
    return np.where(out < 0, out * 0x8000, out * 0x7FFF).astype("<i2")


def write_wav(path: Path, pcm16: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm16.tobytes())


def kokoro(text: str, voice: str) -> tuple[np.ndarray, int]:
    body = json.dumps({"model": "kokoro", "input": text, "voice": voice, "response_format": "wav", "speed": 1.0}).encode()
    req = urllib.request.Request(KOKORO, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    with wave.open(io.BytesIO(data)) as w:
        rate, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    assert sw == 2, f"unexpected sample width {sw}"
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    return pcm, rate


def noise_clips(rng: np.random.Generator) -> dict[str, np.ndarray]:
    sr = 16000

    def db(x: np.ndarray, dbfs: float) -> np.ndarray:
        r = np.sqrt(np.mean(x ** 2)) or 1.0
        return x / r * (10 ** (dbfs / 20))

    white = rng.standard_normal(sr * 2)
    pink = np.cumsum(rng.standard_normal(sr * 3)) * 0.02
    pink = pink - np.convolve(pink, np.ones(400) / 400, mode="same")  # crude pink: integrated, high-passed
    brown = np.cumsum(rng.standard_normal(sr * 4))
    brown -= np.convolve(brown, np.ones(2000) / 2000, mode="same")
    t = np.arange(sr * 3) / sr
    hum = sum(np.sin(2 * np.pi * 60 * k * t) / k for k in (1, 2, 3, 5)) + rng.standard_normal(t.size) * 0.05
    clicks = rng.standard_normal(sr * 3) * 0.002
    for pos in rng.integers(0, sr * 3 - 400, 14):
        clicks[pos:pos + 300] += rng.standard_normal(300) * np.exp(-np.arange(300) / 40) * 0.3
    return {
        "noise_silence": np.zeros(sr * 2),
        "noise_roomtone": db(pink, -55),
        "noise_white": db(white, -30),
        "noise_brown": db(brown, -35),
        "noise_hum": db(hum, -30),
        "noise_clicks": clicks,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    jobs = [(f"s{i:02d}_{v}", s, v) for i, s in enumerate(SHORT) for v in (VOICES[i % 3], VOICES[(i + 1) % 3])]
    jobs += [(f"l{i:02d}_{VOICES[i % 3]}", s, VOICES[i % 3]) for i, s in enumerate(LONG)]
    for cid, text, voice in jobs:
        pcm, rate = kokoro(text, voice)
        pcm16 = decimate16k(pcm, rate)
        write_wav(OUT / f"{cid}.wav", pcm16)
        manifest.append({"id": cid, "kind": "speech", "voice": voice, "text": text, "seconds": round(pcm16.size / 16000, 2)})
        print(f"{cid:22} {pcm16.size / 16000:5.2f}s  {text[:60]}", flush=True)
    for cid, x in noise_clips(np.random.default_rng(1126)).items():
        pcm16 = np.clip(x * 32767, -32768, 32767).astype("<i2")
        write_wav(OUT / f"{cid}.wav", pcm16)
        manifest.append({"id": cid, "kind": "noise", "voice": None, "text": "", "seconds": round(pcm16.size / 16000, 2)})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"{len(manifest)} clips -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
