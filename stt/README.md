# STT: faster-whisper on the GPU (127.0.0.1:8177)

`fw_server.py` is Tony's speech-to-text server: faster-whisper (CTranslate2) on the RTX 3060, kept
loaded and warmed up. It speaks the same OpenAI-style API as whisper.cpp on :8178, so the desktop
(`voice.rs transcribe_bytes`, a plain multipart POST to `{baseUrl}/audio/transcriptions`) and the
gateway's phone path (`language_hub_api.py`) call it without code changes on the desktop side.

| Piece | Where |
|---|---|
| Server | `G:\agentic os\stt\fw_server.py` (tests: `tests/test_fw_server.py`, a fake model, no GPU) |
| venv | `C:\ai-stt\.venv` (uv, CPython 3.13): ctranslate2 4.9.1, faster-whisper 1.2.1, fastapi, uvicorn, python-multipart, numpy, huggingface_hub; no torch |
| CUDA DLLs | `C:\ai-stt\cuda`: cuBLAS 12 + cuDNN 9.10.2.21 (+ nvrtc / nvJitLink), copied from `D:\VoiceStudio\project\.venv\Lib\site-packages\torch\lib`; added with `os.add_dll_directory` before ctranslate2 is imported |
| Models | `C:\models\stt\faster-distil-whisper-large-v3` (Systran, 1.51 GB) and `C:\models\stt\faster-whisper-large-v3-turbo` (mobiuslabsgmbh, 1.62 GB) |
| Log | `G:\whisper\fw-server.log`: per request audio length, queue and decode ms, never the transcript; 5 MB + one rollover = 10 MB cap |
| Benchmark | `stt\bench\` (clips and results in the gitignored `data\stt-bench\`) |

## API

* `POST /v1/audio/transcriptions` (multipart): `file`, `model` (ignored; the loaded model answers),
  `language` (`en`, `auto` = detect), `prompt`, `response_format` (`json` | `verbose_json` | `text`),
  `temperature`; plus optional `hotwords`, `beam_size` (1-10), `vad` (0/1, overrides the server
  default), `partial=1` and `session`.
  * `partial=1` is the live-caption fast path: beam 1, no timestamps, no conditioning on earlier
    text, a single temperature, no VAD.
  * One GPU worker runs everything from a priority queue: finals go before partials. A partial that
    a newer partial from the same `session` has overtaken, or that waited more than 2 s, is answered
    `{"text": "", "stale": true}` without being decoded.
  * A final it can't decode on the GPU (model loading, CUDA failed or too little VRAM =
    `device: "cpu-unavailable"`, queue full (16), decode error) is forwarded to whisper.cpp :8178
    (`--fallback-url`, loopback only) with the caller's `model`, `language`, `prompt`,
    `response_format` and `temperature`, and whisper.cpp's answer is returned (headers
    `X-STT-Backend: whispercpp`, `X-Fallback-Reason`). This is the desktop's only fallback:
    `voice.rs transcribe_bytes` makes one POST to `policy.stt` and never tries :8178 itself.
    It answers `503` only when :8178 is down or fails too, and for partials (never forwarded).
  * A load that left no model is retried in the background: 30 s, doubling to 10 min
    (`--retry-first-s`, `--retry-max-s`), with the same VRAM pre-flight each time.
  * Headers `X-Queue-Ms` / `X-Decode-Ms` carry the server-side timings; `X-STT-Backend: faster-whisper`.
* `GET /v1/models`: the CT2 folders in `C:\models\stt`, by alias (`distil-large-v3`,
  `large-v3-turbo`) with `loaded`, plus `ready`, `device` and `serving` (`faster-whisper` |
  `whispercpp`). The app's provider probe (up = status < 500) and the Settings model list use it, so
  it answers `503` when finals can't be answered at all (no GPU model and :8178 down), and 200 otherwise.
* `GET /health`: `ready`, `device`, `compute_type`, `model`, `vram_mb` (GPU memory the load took),
  `gpu_free_mb`, `warmup_ms`, `load_ms`, `retry_in_s`, `fallback` (`url`, `used`, `last_error`),
  `queue`, `requests`, `last` (the last 20 requests' timings), and the defaults (`beam_size`,
  `prompt_mode`, `vad`).
* `POST /load` `{model, compute_type?, device?}` (JSON or form; a whisper.cpp-style path is reduced
  to its folder name, never a path outside `C:\models\stt`): hot-swap. The old model is freed first,
  the new one is loaded and warmed; if that fails the previous one is reloaded.
* `WebSocket /v1/stream` (live captions): `{"type":"start","language","prompt","partials","partial_ms"}`,
  then binary PCM16 LE 16 kHz mono frames, `{"type":"config","partials":bool}` at any time, and
  `{"type":"end"}` (or `"cancel"`). Answers `{"type":"ready","partials","device"}`, then
  `{"type":"partial","partial","stable"}` (LocalAgreement-2: `stable` is never retracted) every
  `partial_ms` (300-3000, default 600) of new audio between 0.5 and 30 s, single-flight, on the GPU
  only; then one `{"type":"final","final","backend"}` decoded with exactly a POST's options (or by
  whisper.cpp when this server can't), and a close. A browser page from a non-loopback origin is
  refused. **Needs the `websockets` package in the venv** (uvicorn has no WebSocket support without
  it or `wsproto`; the upgrade then gets a 404). The gateway's phone proxy
  (`/api/cc/lang/stt/stream`, `language_hub_api.py`) uses this when it answers and otherwise runs
  the same session over POSTs (`partial=1` + `session`), so phone streaming works either way.
* Measured (C1, 2026-11-26, Qwen loaded and idle): a final sent after >= 2 s of GPU idle takes
  ~480-510 ms, one within 1 s of other GPU work ~270 ms (clock ramp-up). A partial pass costs about
  what a final does (~265 ms; turbo is encoder-bound, beam 1 saves little), so captions every 600 ms
  keep the GPU ~45% busy while you speak, and keep it warm: end of speech -> final text went from
  p50 546 to 273 ms (desktop) and 493 to 285 ms (phone path, loopback). A final that lands while a
  partial decodes waits for it (~500 ms), which is why both clients stop captions 250 ms into a pause.

Noise: Silero VAD runs before decoding (`--vad on`), so non-speech clips return empty text without
being decoded. `clean_text` is the backstop: whisper.cpp-style silence markers, caption credits
("Transcription by CastingWords") and stock lines ("Thank you.", "you") that the model itself doubts
(`no_speech_prob >= 0.1` or `avg_logprob < -0.6`; large-v3-turbo reports `no_speech_prob` 0 even on
noise, where its "Thank you." scores -0.70 to -0.81). A quiet clip (RMS under -48 dBFS, padding
included) needs less doubt (`avg_logprob < -0.5`) but never none: a softly said "Thank you." or "Bye."
that the model is sure of (-0.29 to -0.36) is kept, as whisper.cpp base.en keeps it.

The `prompt` field (the desktop's vocabulary list, `DEFAULT_STT_PROMPT` in dispatch.rs) becomes
Whisper's initial prompt (`--prompt-mode initial`). For clips up to 30 s, faster-whisper builds the
same decoder prompt from `hotwords` as from `initial_prompt`, so the two are equivalent here; they
only differ on longer audio, where hotwords repeat in every 30 s window.

## Run

```powershell
# start detached (the logon task does this; see G:\ai-startup\start-ai-stack.ps1, step 0b)
$cmd = '"C:\ai-stt\.venv\Scripts\python.exe" "G:\agentic os\stt\fw_server.py" --model large-v3-turbo --compute-type int8_float16'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = 'G:\agentic os\stt' }
Invoke-RestMethod http://127.0.0.1:8177/health
# swap models without a restart
Invoke-RestMethod http://127.0.0.1:8177/load -Method Post -ContentType application/json -Body '{"model":"distil-large-v3","compute_type":"int8_float16"}'
```

Flags (env in brackets): `--model` (`STT_MODEL`), `--compute-type` (`STT_COMPUTE`), `--device cuda|cpu`
(`STT_DEVICE`), `--beam-size` (`STT_BEAM`), `--prompt-mode initial|hotwords|both`
(`STT_PROMPT_MODE`), `--vad on|off` (`STT_VAD`), `--min-free-mb` (refuse a GPU load below this much
free VRAM, or with no nvidia-smi reading), `--fallback-url` (`STT_FALLBACK_URL`, default
`http://127.0.0.1:8178/v1/audio/transcriptions`, `off` = answer 503 instead), `--retry-first-s` /
`--retry-max-s` (load retry backoff, 30 / 600), `--port`, `--models-dir`. A second copy exits at
once: the port is bound exclusively before any model work.

Who starts it:
* logon: `G:\ai-startup\start-ai-stack.ps1` step 0b, before Tony's Qwen load (settings `$STT_*` in
  `ai-stack.config.ps1`). It is started even when the 1.5 GB free-VRAM pre-flight fails: the server
  then loads nothing on the GPU, forwards finals to :8178 and retries the GPU load after
  `$STT_RETRY_FIRST_SECONDS` (300 s, so after Tony's Qwen load). Step 0b also starts whisper.cpp :8178.
* the gateway: a phone turn that finds :8177 closed uses :8178 for that turn and re-spawns this
  server detached, at most once per backoff window (30 s, doubling to 10 min).
* The desktop app does not manage it (its `whisper_ensure` only handles `engine: "whispercpp"`), and
  once `policy.stt` is faster-whisper it no longer restarts :8178 either.

What covers desktop voice when something fails (`policy.stt` = faster-whisper):

| Failure | Desktop voice |
|---|---|
| Model loading, CUDA failed, too little VRAM, queue full, decode error | works: :8177 forwards to :8178 |
| The above while :8178 is down too | fails (503; the app's probe shows STT red) |
| The :8177 process is dead (crash, killed) | fails until the gateway's next phone turn re-spawns it, a re-run of `start-ai-stack.ps1`, or a reboot |
| :8178 dies | nothing restarts it until a re-run of `start-ai-stack.ps1` or a reboot (only matters while :8177 has no GPU model) |

Closing the last two rows needs the Rust side: an `stt_ensure` for `engine: "fasterwhisper"` in
`services.rs` (start :8177 like `whisper_ensure` starts :8178, and keep :8178 alive as its fallback)
and a retry of the `whisper` provider in `voice.rs transcribe_bytes` when the POST fails to connect.

## Config (providers.json)

```json
{"id": "faster-whisper", "label": "faster-whisper (GPU)", "kind": "stt", "baseUrl": "http://127.0.0.1:8177/v1",
 "model": "large-v3-turbo", "needsKey": false, "engine": "fasterwhisper", "language": "en", "custom": true}
```

`policy.stt` points at it (switched 2026-11-26; backup `providers.json.20261126-094917-before-faster-whisper`,
script `stt\bench\switch_providers.py`). The running desktop app reads providers.json only at start,
so it uses :8177 from its next launch. With `engine: "fasterwhisper"` the app probes `{baseUrl}/models`,
lists models from it, and does not try to manage the process; choosing a model in Settings saves it
but does not hot-swap the server (use `POST /load`). The `whisper` provider (`engine: "whispercpp"`, `modelsDir G:\whisper\models`)
stays: both Language Hub sidecars find `ggml-small.bin` through it, and it is the fallback (the
gateway's directly; the desktop's only through :8177, see the table above).

## Benchmark

```powershell
python -I "G:\agentic os\stt\bench\gen_clips.py"     # Kokoro clips + noise -> data\stt-bench\clips
python -I "G:\agentic os\stt\bench\bench.py"          # all arms, 3 runs -> data\stt-bench\results-*.json
python -I "G:\agentic os\stt\bench\probe_noise.py"    # segment stats behind the noise guard
python -I "G:\agentic os\stt\bench\qwen_tps.py"       # Tony's Qwen tokens/s (read-only; never loads a model)
python -I "G:\agentic os\stt\bench\phone_path.py" --old <8b1bac6 language_hub_api.py>
```

### Results (2026-11-26, Qwen 3.5 9B loaded in Bionic at 32k x 2)

Clips: 47 Kokoro sentences (voices am_michael, af_heart, bm_george; 0.9-23 s; Tony, Gabagool, Madone,
Bilmuri, Erra, Booking Desk, Librarian, Kokoro, Tauri, Nic, Serena, call sheet, deal memo...) plus 6
non-speech clips, all decimated to 16 kHz exactly like `encodeWav16k`. Every request carried the
desktop's fields (json, temperature 0, en, `DEFAULT_STT_PROMPT`). Latency is client wall time
over HTTP, 3 runs after a dropped warm-up. Full data: `data\stt-bench\results-20261126-094726.json`.

| Arm | <=2 s p50 | 2-5 s p50 / p95 | 5-10 s p50 | 10-30 s p50 | WER | vocab | noise FP | VRAM |
|---|---|---|---|---|---|---|---|---|
| whisper.cpp base.en, CPU 8 threads (before) | 0.508 | 0.544 / 0.593 | 0.651 | 0.853 | 2.73% | 91.3% | 6 raw, 3 after guards | 0 |
| distil-large-v3 int8_float16 beam 5 | 0.251 | 0.267 / 0.275 | 0.294 | 0.347 | 6.18% | 68.0% | 0 (4 without VAD) | 1.03 GB |
| distil-large-v3 float16 beam 5 | 0.284 | 0.295 / 0.309 | 0.330 | 0.394 | 6.32% | 68.0% | 0 (4 without VAD) | 2.02 GB |
| **large-v3-turbo int8_float16 beam 5 (winner)** | 0.264 | **0.279 / 0.297** | 0.337 | 0.440 | **1.29%** | **94.2%** | **0** (0 without VAD) | **1.10 GB** |
| large-v3-turbo int8_float16 beam 1 | 0.262 | 0.276 / 0.288 | 0.321 | 0.406 | 1.29% | 94.2% | 0 | 1.10 GB |
| large-v3-turbo float16 beam 5 | 0.284 | 0.300 / 0.316 | 0.340 | 0.416 | 1.29% | 94.2% | 0 (1 without VAD) | 2.15 GB |

* Gate (WER <= base.en, 0 noise false positives, GPU p50 <= 0.30 s on 2-5 s clips, >= 500 MB VRAM
  free with Qwen loaded): **large-v3-turbo int8_float16 passes**. Re-run on the final server:
  p50 0.277 s / p95 0.309 s on 2-5 s, WER 1.29%, 0 false positives, 2.39 GB VRAM free at the
  lowest point (`results-final-winner.json`).
* distil-large-v3 is fast but ignores the vocabulary prompt ("Bill Murie", "Madden as better",
  "Tory build", "Cicaro"), so it fails the WER gate. It stays on disk.
* Prompt vs hotwords: identical output on every clip (one 30 s window, same decoder prompt).
  Beam 1 vs 5: same WER on this set; beam 5 is kept (3 ms more at p50 on 2-5 s clips, more robust
  on real mic audio). Turbo's remaining errors: "Nic" -> "Nick" (Nic is not in the prompt),
  "Tony, ask" -> "Tony asked", "load in" -> "load and", "demos" -> "DeMoss".
* VRAM (nvidia-smi): 8385 MiB used / 3731 MiB free before; 9586 / 2530 with the server idle
  (turbo int8_float16 = 1.2 GB with the CUDA context).
* Tony's Qwen (one 160-token completion, `reasoning_effort: none`): 48.9-49.3 tok/s before,
  49.1-49.2 tok/s with the STT loaded and idle. While STT decodes back to back (worst case,
  92 clips in a row) Qwen drops to ~11 tok/s and STT p50 rises to 0.33 s: they share the GPU, so
  live partials (the streaming task) should pause while Qwen generates.
* Cold start: spawn to `/health` ready in 5-13 s (load 3.4-3.9 s from the C: SSD, warm-up ~0.5 s).
* Phone path (`language_hub_api._transcribe`, same clips, median of 5):

  | clip | before: verbose_json, no prompt, :8178 | json + prompt, :8178 | json + prompt, :8177 |
  |---|---|---|---|
  | 3.0 s | 0.817 s | 0.524 s | 0.286 s |
  | 2.8 s | 0.827 s | 0.542 s | 0.293 s |
  | 6.6 s | 0.927 s | 0.631 s | 0.318 s |

  With :8177 down, a turn answers from :8178 (~0.5 s plus the port check) and the server is
  re-spawned in the background (measured: back and ready 6.7-8.7 s later).
