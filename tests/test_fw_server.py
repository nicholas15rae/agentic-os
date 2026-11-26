"""faster-whisper STT server (stt/fw_server.py) with a fake model: no GPU, no ctranslate2.

Run with: python -m pytest tests/test_fw_server.py -q
"""
import io
import json
import logging
import logging.handlers
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "stt"))

from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import fw_server as fw  # noqa: E402


def wav16k(seconds=1.0, amp=0.1, rate=16000, channels=1) -> bytes:
    n = int(seconds * rate)
    pcm = (np.sin(np.arange(n) * 2 * np.pi * 220 / rate) * amp * 32767).astype("<i2")
    if channels == 2:
        pcm = np.repeat(pcm, 2)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def pcm16(seconds=1.0, amp=0.1, rate=16000) -> bytes:
    """The same sine as wav16k, as raw PCM16 (the stream's frames): wav16k(s)[44:] == pcm16(s)."""
    n = int(seconds * rate)
    return (np.sin(np.arange(n) * 2 * np.pi * 220 / rate) * amp * 32767).astype("<i2").tobytes()


class FakeBackend:
    """Records every decode; `gate` (an Event) can hold the worker inside a decode."""

    def __init__(self, path, device, compute_type, text="Tony, cut it.", gate=None, calls=None, nsp=0.01, lp=-0.2):
        self.path, self.device, self.compute_type, self.text, self.gate, self.nsp, self.lp = path, device, compute_type, text, gate, nsp, lp
        self.calls = calls if calls is not None else []

    def transcribe(self, audio, opts):
        self.calls.append((audio.size, opts))
        if self.gate is not None and not opts.partial and opts.initial_prompt != "__warm__" and audio.size > 40000:
            self.gate.wait(5)
        seg = {"id": 0, "start": 0.0, "end": audio.size / 16000, "text": " " + self.text, "no_speech_prob": self.nsp, "avg_logprob": self.lp}
        return {"text": " " + self.text, "segments": [seg], "language": opts.language or "en", "duration": audio.size / 16000}


class WhisperCppStub:
    """A stdlib stand-in for whisper.cpp :8178: keeps every request body, answers `reply`."""

    def __init__(self, reply=b'{"text":"Play Bilmuri."}', status=200, ctype="application/json"):
        self.reply, self.status, self.ctype, self.bodies = reply, status, ctype, []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                stub.bodies.append(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                self.send_response(stub.status)
                self.send_header("Content-Type", stub.ctype)
                self.send_header("Content-Length", str(len(stub.reply)))
                self.end_headers()
                self.wfile.write(stub.reply)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/v1/audio/transcriptions"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def closed_port_url() -> str:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}/v1/audio/transcriptions"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fw-"))
        for folder in ("faster-distil-whisper-large-v3", "faster-whisper-large-v3-turbo"):
            (self.tmp / folder).mkdir()
            (self.tmp / folder / "model.bin").write_bytes(b"x")
        (self.tmp / "empty-folder").mkdir()
        # fail_loads, not fail: self.fail is unittest's own and must stay callable.
        self.calls, self.loads, self.fail_loads, self.workers = [], [], set(), []
        self.gate = None
        self.text = "Tony, cut it."

        def loader(path, device, compute):
            self.loads.append((path.name, device, compute))
            if (path.name, device, compute) in self.fail_loads or device in self.fail_loads:
                raise RuntimeError("CUDA failed: cublas64_12.dll not found")
            return FakeBackend(path, device, compute, text=self.text, gate=self.gate, calls=self.calls)

        self.loader = loader
        self.gpu = [(8400, 3700)]
        self.worker = self.make_worker()

    def make_worker(self, **kw):
        """A worker on the fake loader; load retries are off unless a test asks for them."""
        w = fw.Worker(self.loader, self.tmp, gpu=lambda: self.gpu[0], min_free_mb=1500, **{"retry_backoff": (0.0, 0.0), **kw})
        self.workers.append(w)
        return w

    def tearDown(self):
        for w in self.workers:
            w.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def start(self, model="distil-large-v3", device="cuda", compute="int8_float16", **kw):
        st = self.worker.load(model, device, compute).result(5)
        self.c = TestClient(fw.create_app(self.worker, **kw))
        return st

    def post(self, seconds=3.0, amp=0.1, **fields):
        fields = {k: str(v) for k, v in fields.items()}
        return self.c.post("/v1/audio/transcriptions", files={"file": ("speech.wav", wav16k(seconds, amp=amp), "audio/wav")}, data=fields)

    def wait_for(self, cond, what, timeout=5.0):
        t0 = time.monotonic()
        while not cond():
            if time.monotonic() - t0 > timeout:
                self.fail(f"timed out waiting for {what}")
            time.sleep(0.01)


class Endpoints(Base):
    def test_rust_client_fields_get_plain_json(self):
        st = self.start()
        self.assertTrue(st["ready"])
        r = self.post(model="distil-large-v3", response_format="json", temperature="0", language="en", prompt="Tony, Gabagool mode.")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"text": "Tony, cut it."})
        self.assertIn("x-decode-ms", r.headers)
        opts = self.calls[-1][1]
        self.assertEqual((opts.language, opts.beam_size, opts.initial_prompt, opts.hotwords, opts.without_timestamps, opts.partial),
                         ("en", 5, "Tony, Gabagool mode.", None, True, False))
        self.assertEqual(opts.temperature[0], 0.0)
        self.assertEqual(self.calls[-1][0], 48000)

    def test_text_and_verbose_json_formats(self):
        self.start()
        r = self.post(response_format="text")
        self.assertEqual((r.status_code, r.text), (200, "Tony, cut it."))
        v = self.post(response_format="verbose_json", language="auto").json()
        self.assertEqual((v["text"], v["language"], v["duration"], len(v["segments"])), ("Tony, cut it.", "en", 3.0, 1))
        self.assertIsNone(self.calls[-1][1].language)  # auto -> detect
        self.assertFalse(self.calls[-1][1].without_timestamps)  # verbose_json keeps timestamps
        self.assertEqual(self.post(response_format="srt").status_code, 400)
        self.assertEqual(self.post(language="../x").status_code, 400)
        self.assertEqual(self.post(beam_size="many").status_code, 400)

    def test_partial_fast_path_and_hotwords(self):
        self.start()
        self.assertEqual(self.post(partial="1", prompt="Bilmuri, Erra", temperature="0.4").status_code, 200)
        o = self.calls[-1][1]
        self.assertEqual((o.partial, o.beam_size, o.without_timestamps, o.condition_on_previous_text, o.temperature, o.vad_filter),
                         (True, 1, True, False, (0.4,), False))
        self.post(hotwords="Madone, Gabagool", beam_size="2")
        o = self.calls[-1][1]
        self.assertEqual((o.hotwords, o.beam_size, o.partial), ("Madone, Gabagool", 2, False))
        self.assertEqual(o.kwargs()["hotwords"], "Madone, Gabagool")

    def test_prompt_mode_sends_the_prompt_as_hotwords(self):
        self.start(prompt_mode="hotwords")
        self.post(prompt="Tony, Gabagool mode.")
        o = self.calls[-1][1]
        self.assertEqual((o.initial_prompt, o.hotwords), (None, "Tony, Gabagool mode."))
        self.c = TestClient(fw.create_app(self.worker, prompt_mode="both"))
        self.post(prompt="Kokoro")
        self.assertEqual((self.calls[-1][1].initial_prompt, self.calls[-1][1].hotwords), ("Kokoro", "Kokoro"))

    def test_models_lists_ct2_folders_by_alias(self):
        self.start()
        r = self.c.get("/v1/models")
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["ready"], r.json()["serving"]), (True, "faster-whisper"))
        self.assertEqual([(m["id"], m["loaded"]) for m in r.json()["data"]], [("distil-large-v3", True), ("large-v3-turbo", False)])

    def test_a_quiet_confident_stock_line_is_kept(self):
        # Nic's soft "Thank you." to Tony: -51 dBFS over the clip, but the model is sure of it.
        self.text = "Thank you."
        self.start()
        self.assertEqual(self.post(seconds=2.0, amp=0.004).json(), {"text": "Thank you."})
        self.calls.clear()
        self.text = "Bye."
        self.start()
        self.assertEqual(self.post(seconds=2.0, amp=0.004).json(), {"text": "Bye."})

    def test_health_reports_device_vram_and_last_timings(self):
        self.gpu = [(8400, 3700)]
        seq = iter([(8400, 3700), (9600, 2500)])
        self.worker.gpu = lambda: next(seq, (9600, 2500))
        self.start()
        self.post(seconds=2.0)
        h = self.c.get("/health").json()
        self.assertEqual((h["ready"], h["device"], h["compute_type"], h["model"], h["vram_mb"]), (True, "cuda", "int8_float16", "distil-large-v3", 1200))
        self.assertEqual(len(h["warmup_ms"]), 2)
        self.assertEqual(h["last"][-1]["audio_s"], 2.0)
        self.assertEqual(set(h["last"][-1]), {"at", "audio_s", "queue_ms", "decode_ms", "partial", "beam", "chars"})
        self.assertEqual(h["gpu_free_mb"], 2500)

    def test_bad_uploads(self):
        self.start()
        self.assertEqual(self.c.post("/v1/audio/transcriptions", data={"model": "x"}).status_code, 400)
        r = self.c.post("/v1/audio/transcriptions", files={"file": ("speech.wav", b"RIFF" + b"\x00" * 200, "audio/wav")})
        self.assertEqual(r.status_code, 400)


class CudaFailure(Base):
    def test_cuda_failure_reports_cpu_unavailable_and_503(self):
        self.fail_loads.add("cuda")
        st = self.start()
        self.assertEqual((st["ready"], st["device"]), (False, "cpu-unavailable"))
        self.assertIn("cublas64_12", st["error"])
        r = self.post()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["device"], "cpu-unavailable")
        self.assertFalse(self.c.get("/health").json()["ready"])

    def test_too_little_free_vram_is_not_loaded(self):
        self.gpu = [(10900, 1200)]
        st = self.start()
        self.assertEqual((st["ready"], st["device"]), (False, "cpu-unavailable"))
        self.assertIn("1200 MB VRAM free", st["error"])
        self.assertEqual(self.loads, [])

    def test_no_vram_reading_is_not_loaded_blind(self):
        self.gpu = [None]  # nvidia-smi failed or timed out
        st = self.start()
        self.assertEqual((st["ready"], st["device"]), (False, "cpu-unavailable"))
        self.assertIn("no free-VRAM reading", st["error"])
        self.assertEqual(self.loads, [])
        self.assertTrue(self.worker.load("distil-large-v3", "cpu", "int8").result(5)["ready"])  # the CPU needs no reading

    def test_loading_answers_503(self):
        self.c = TestClient(fw.create_app(self.worker))
        self.assertEqual(self.post().status_code, 503)


class HotSwap(Base):
    def test_load_switches_model_and_compute_type(self):
        self.start()
        r = self.c.post("/load", json={"model": "large-v3-turbo", "compute_type": "float16"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["model"], r.json()["compute_type"]), ("large-v3-turbo", "float16"))
        self.assertEqual(self.loads[-1], ("faster-whisper-large-v3-turbo", "cuda", "float16"))
        # whisper.cpp-style form with a path: the folder name is used, never the path.
        r = self.c.post("/load", data={"model": r"C:\models\stt\faster-distil-whisper-large-v3"})
        self.assertEqual(r.json()["model"], "distil-large-v3")

    def test_load_warms_two_decodes_and_the_vad(self):
        warmed = []

        class VadBackend(FakeBackend):
            def warm_vad(self):
                warmed.append(self.path.name)

        w = fw.Worker(lambda p, d, c: VadBackend(p, d, c, calls=self.calls), self.tmp, gpu=lambda: (8400, 3700))
        self.workers.append(w)
        st = w.load("large-v3-turbo", "cuda", "int8_float16").result(5)
        self.assertTrue(st["ready"])
        self.assertEqual(warmed, ["faster-whisper-large-v3-turbo"])
        self.assertEqual([(n, o.beam_size) for n, o in self.calls], [(16000, 1), (32000, 5)])

    def test_failed_swap_keeps_the_previous_model(self):
        self.start()
        self.fail_loads.add(("faster-whisper-large-v3-turbo", "cuda", "float16"))
        r = self.c.post("/load", json={"model": "large-v3-turbo", "compute_type": "float16"})
        self.assertEqual(r.status_code, 200)
        h = r.json()
        self.assertEqual((h["ready"], h["model"], h["compute_type"]), (True, "distil-large-v3", "int8_float16"))
        self.assertIn("kept distil-large-v3", h["error"])
        self.assertEqual(self.post().status_code, 200)

    def test_load_rejects_unknown_or_escaping_models(self):
        self.start()
        self.assertEqual(self.c.post("/load", json={"model": "../../Windows"}).status_code, 400)
        self.assertEqual(self.c.post("/load", json={"model": "empty-folder"}).status_code, 400)
        self.assertEqual(self.c.post("/load", json={"model": "large-v3-turbo", "device": "tpu"}).status_code, 400)
        self.assertEqual(self.c.post("/load", content=b"[1]", headers={"content-type": "application/json"}).status_code, 400)


class Scheduling(Base):
    def test_finals_jump_ahead_of_partials_and_stale_partials_are_dropped(self):
        # Asserts on DECODE order (what the worker did), not on the order HTTP responses reach the
        # client threads, which the scheduler doesn't control.
        self.gate = threading.Event()
        self.start()
        warm = len(self.calls)  # the 2 warm-up decodes
        results = {}

        def call(name, **fields):
            results[name] = self.post(seconds=fields.pop("seconds", 1.0), **fields).json()

        threads = [threading.Thread(target=call, args=("blocker",), kwargs={"seconds": 3.0})]
        threads[0].start()
        self.wait_for(lambda: len(self.calls) == warm + 1, "the worker to be inside the blocker's decode")
        for n, (name, kw) in enumerate((("p1", {"partial": "1", "session": "mic"}), ("p2", {"partial": "1", "session": "mic"}), ("final", {})), 1):
            threads.append(threading.Thread(target=call, args=(name,), kwargs=kw))
            threads[-1].start()
            self.wait_for(lambda n=n: self.worker.q.qsize() == n, f"{name} to be queued")  # one at a time: p1 before p2
        self.gate.set()
        for t in threads:
            t.join(10)
        decoded = [(size, o.partial) for size, o in self.calls[warm:]]
        self.assertEqual(decoded, [(48000, False), (16000, False), (16000, True)],
                         "expected the blocker, then the final (ahead of both partials), then only the newest partial")
        self.assertEqual(results, {"blocker": {"text": "Tony, cut it."}, "p1": {"text": "", "stale": True},
                                   "p2": {"text": "Tony, cut it."}, "final": {"text": "Tony, cut it."}})

    def test_old_partials_are_stale(self):
        self.start()
        fut = self.worker.submit(np.zeros(16000, np.float32), fw.build_options({"partial": "1"}, 1.0))
        self.assertEqual(fut.result(5)["text"], "Tony, cut it.")
        saved = fw.PARTIAL_MAX_AGE
        try:
            fw.PARTIAL_MAX_AGE = -1.0
            fut = self.worker.submit(np.zeros(16000, np.float32), fw.build_options({"partial": "1"}, 1.0))
            self.assertTrue(fut.result(5)["stale"])
        finally:
            fw.PARTIAL_MAX_AGE = saved

    def test_queue_full_is_503(self):
        self.start()
        saved = fw.QUEUE_MAX
        try:
            fw.QUEUE_MAX = 0
            r = self.post()
            self.assertEqual((r.status_code, r.json()["error"]["type"]), (503, "busy"))
        finally:
            fw.QUEUE_MAX = saved


class FallbackToWhisperCpp(Base):
    """The desktop sends one POST to :8177 and never retries :8178 itself, so a final this server
    can't decode on the GPU is answered by whisper.cpp through it."""

    def setUp(self):
        super().setUp()
        self.wc = WhisperCppStub()
        self.addCleanup(self.wc.close)

    def client(self, url=None):
        self.c = TestClient(fw.create_app(self.worker, fallback=fw.Fallback(url or self.wc.url)))

    def test_loading_forwards_the_callers_own_fields(self):
        self.client()  # nothing loaded yet
        r = self.post(model="large-v3-turbo", response_format="json", temperature="0", language="en", prompt="Tony, Gabagool mode.",
                      hotwords="Madone", vad="1", session="mic", beam_size="3")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"text": "Play Bilmuri."})
        self.assertEqual((r.headers["x-stt-backend"], r.headers["x-fallback-reason"]), ("whispercpp", "not_ready"))
        body = self.wc.bodies[0]
        for k, v in (("model", "large-v3-turbo"), ("response_format", "json"), ("temperature", "0"), ("language", "en"), ("prompt", "Tony, Gabagool mode.")):
            self.assertIn(f'name="{k}"\r\n\r\n{v}\r\n'.encode(), body)
        for k in ("hotwords", "vad", "session", "beam_size", "partial"):  # this server's own fields stay here
            self.assertNotIn(f'name="{k}"'.encode(), body)
        self.assertIn(wav16k(3.0), body)
        self.assertEqual(self.calls, [])

    def test_cuda_unavailable_forwards(self):
        self.fail_loads.add("cuda")
        self.assertEqual(self.start()["device"], "cpu-unavailable")
        self.client()
        r = self.post()
        self.assertEqual((r.status_code, r.json()["text"], r.headers["x-fallback-reason"]), (200, "Play Bilmuri.", "not_ready"))
        self.assertEqual(self.c.get("/health").json()["fallback"]["used"], 1)

    def test_a_full_queue_forwards(self):
        self.start()
        self.client()
        saved = fw.QUEUE_MAX
        try:
            fw.QUEUE_MAX = 0
            r = self.post()
        finally:
            fw.QUEUE_MAX = saved
        self.assertEqual((r.status_code, r.json()["text"], r.headers["x-fallback-reason"]), (200, "Play Bilmuri.", "busy"))

    def test_a_failed_decode_forwards(self):
        self.start()
        self.client()

        def boom(audio, opts):
            raise RuntimeError("CUDA error: an illegal memory access was encountered")

        self.worker.backend.transcribe = boom
        r = self.post()
        self.assertEqual((r.status_code, r.json()["text"], r.headers["x-fallback-reason"]), (200, "Play Bilmuri.", "server_error"))

    def test_gpu_answers_never_touch_whisper_cpp(self):
        self.start()
        self.client()
        r = self.post()
        self.assertEqual((r.status_code, r.json()["text"], r.headers["x-stt-backend"]), (200, "Tony, cut it.", "faster-whisper"))
        self.assertEqual(self.wc.bodies, [])

    def test_partials_are_not_forwarded(self):
        self.client()
        r = self.post(partial="1")
        self.assertEqual((r.status_code, r.json()["error"]["type"]), (503, "not_ready"))
        self.assertEqual(self.wc.bodies, [])

    def test_text_format_passes_through(self):
        self.wc.reply, self.wc.ctype = b"Cut it.\n", "text/plain; charset=utf-8"
        self.client()
        r = self.post(response_format="text")
        self.assertEqual((r.status_code, r.text, r.headers["content-type"]), (200, "Cut it.\n", "text/plain; charset=utf-8"))

    def test_whisper_cpp_down_or_failing_keeps_the_503(self):
        self.client(closed_port_url())
        r = self.post()
        self.assertEqual(r.status_code, 503)
        self.assertIn("whisper.cpp fallback: not listening", r.json()["error"]["message"])
        self.wc.status = 500
        self.client()
        r = self.post()
        self.assertEqual(r.status_code, 503)
        self.assertIn("HTTP 500", r.json()["error"]["message"])

    def test_the_fallback_is_loopback_only(self):
        for url in ("http://10.0.0.5:8178/v1/audio/transcriptions", "https://127.0.0.1:8178/x", "http://example.com/v1"):
            with self.assertRaises(ValueError):
                fw.Fallback(url)
        self.assertEqual(fw.Fallback().port, 8178)


class ModelsProbe(Base):
    """GET /v1/models is the desktop app's health probe for this provider (up = status < 500)."""

    def test_down_when_nothing_can_answer(self):
        self.c = TestClient(fw.create_app(self.worker))
        r = self.c.get("/v1/models")
        self.assertEqual((r.status_code, r.json()["ready"], r.json()["serving"]), (503, False, None))
        self.assertEqual(r.json()["error"]["type"], "not_ready")
        self.c = TestClient(fw.create_app(self.worker, fallback=fw.Fallback(closed_port_url())))
        self.assertEqual(self.c.get("/v1/models").status_code, 503)

    def test_up_while_whisper_cpp_answers_for_it(self):
        wc = WhisperCppStub()
        self.addCleanup(wc.close)
        self.fail_loads.add("cuda")
        self.start(fallback=fw.Fallback(wc.url))
        r = self.c.get("/v1/models")
        self.assertEqual((r.status_code, r.json()["ready"], r.json()["serving"], r.json()["device"]), (200, False, "whispercpp", "cpu-unavailable"))
        self.assertFalse(any(m["loaded"] for m in r.json()["data"]))


class LoadRetry(Base):
    """A load that left no model is retried with backoff instead of staying down for good."""

    def test_a_refused_gpu_load_is_retried_once_vram_frees(self):
        self.worker = self.make_worker(retry_backoff=(0.05, 0.4))
        self.gpu = [(10900, 1200)]  # a 3D job holds the GPU
        st = self.start(model="large-v3-turbo")
        self.assertEqual((st["ready"], st["device"]), (False, "cpu-unavailable"))
        self.assertIsNotNone(st["retry_in_s"])
        self.assertEqual(self.c.get("/v1/models").status_code, 503)  # the app's probe shows STT down, not green
        time.sleep(0.2)
        self.assertEqual(self.loads, [], "a retry skipped the VRAM pre-check")
        self.gpu = [(8400, 3700)]  # the job ended
        self.wait_for(lambda: self.worker.health()["ready"], "the retried load")
        h = self.c.get("/health").json()
        self.assertEqual((h["device"], h["model"], h["retry_in_s"], h["error"]), ("cuda", "large-v3-turbo", None, None))
        self.assertEqual(self.loads, [("faster-whisper-large-v3-turbo", "cuda", "int8_float16")])
        self.assertEqual(self.c.get("/v1/models").status_code, 200)
        self.assertEqual(self.post().json(), {"text": "Tony, cut it."})

    def test_retries_double_up_to_the_cap(self):
        self.worker = self.make_worker(retry_backoff=(0.05, 0.1))
        self.fail_loads.add("cuda")
        self.start()
        self.wait_for(lambda: len(self.loads) >= 4, "three retries")
        self.assertEqual(self.worker._retry_wait, 0.1)
        self.assertFalse(self.worker.health()["ready"])
        self.assertEqual({d for _, d, _ in self.loads}, {"cuda"})

    def test_a_failed_swap_that_lost_both_models_retries_the_previous_one(self):
        self.worker = self.make_worker(retry_backoff=(0.05, 0.4))
        self.start()
        self.fail_loads.update({("faster-whisper-large-v3-turbo", "cuda", "float16"), ("faster-distil-whisper-large-v3", "cuda", "int8_float16")})
        r = self.c.post("/load", json={"model": "large-v3-turbo", "compute_type": "float16"})
        self.assertEqual((r.status_code, r.json()["device"]), (503, "cpu-unavailable"))
        self.fail_loads.clear()
        self.wait_for(lambda: self.worker.health()["ready"], "the retried load")
        h = self.worker.health()
        self.assertEqual((h["model"], h["compute_type"]), ("distil-large-v3", "int8_float16"))

    def test_a_manual_load_replaces_the_pending_retry(self):
        self.worker = self.make_worker(retry_backoff=(30.0, 600.0))
        self.gpu = [(10900, 1200)]
        self.start()
        self.assertGreater(self.worker.health()["retry_in_s"], 20)
        self.gpu = [(8400, 3700)]
        r = self.c.post("/load", json={"model": "distil-large-v3"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["ready"], r.json()["device"], r.json()["retry_in_s"]), (True, "cuda", None))


class Stream(Base):
    """WebSocket /v1/stream: PCM16 frames in, LocalAgreement-2 partials while you speak, one final."""

    def script(self, fn):
        """Replace the loaded backend's decode: fn(seconds, opts) -> text."""
        calls = self.calls

        def transcribe(audio, opts):
            calls.append((audio.size, opts))
            text = fn(audio.size / 16000, opts)
            seg = {"id": 0, "start": 0.0, "end": audio.size / 16000, "text": text, "no_speech_prob": 0.01, "avg_logprob": -0.2}
            return {"text": text, "segments": [seg], "language": "en", "duration": audio.size / 16000}

        self.worker.backend.transcribe = transcribe

    def begin(self, ws, **start):
        ws.send_text(json.dumps({"type": "start", "language": "en", "prompt": "Tony, Gabagool mode.", "partial_ms": 600, **start}))
        return ws.receive_json()

    @staticmethod
    def growing(secs, opts):
        if not opts.partial:
            return "Tony, cut it."
        return "Tony" if secs < 0.9 else "Tony cut" if secs < 1.5 else "Tony, cut it"

    def test_partials_while_speaking_then_one_full_final(self):
        self.start()
        self.script(self.growing)
        warm = len(self.calls)
        with self.c.websocket_connect("/v1/stream") as ws:
            self.assertEqual(self.begin(ws), {"type": "ready", "partials": True, "device": "cuda", "model": "distil-large-v3"})
            got = []
            for _ in range(3):  # 0.6 s of new audio each time, the default spacing
                ws.send_bytes(pcm16(0.6))
                got.append(ws.receive_json())
            ws.send_text(json.dumps({"type": "end"}))
            final = ws.receive_json()
            with self.assertRaises(WebSocketDisconnect) as closed:
                ws.receive_json()
        self.assertEqual(closed.exception.code, 1000)
        self.assertEqual([(g["type"], g["partial"], g["stable"], g["audio_s"]) for g in got],
                         [("partial", "Tony", "", 0.6), ("partial", "Tony cut", "Tony", 1.2), ("partial", "Tony cut it", "Tony cut", 1.8)])
        self.assertEqual((final["type"], final["final"], final["backend"], final["audio_s"]), ("final", "Tony, cut it.", "faster-whisper", 1.8))
        decoded = [(n, o.partial, o.beam_size, o.initial_prompt) for n, o in self.calls[warm:]]
        self.assertEqual(decoded, [(9600, True, 1, "Tony, Gabagool mode."), (19200, True, 1, "Tony, Gabagool mode."), (28800, True, 1, "Tony, Gabagool mode."),
                                   (28800, False, 5, "Tony, Gabagool mode.")])
        # The final is decoded with exactly a POST's options for the same clip.
        posted = fw.build_options({"language": "en", "prompt": "Tony, Gabagool mode.", "response_format": "json", "temperature": "0"}, 1.8)
        self.assertEqual(self.calls[-1][1].kwargs(), posted.kwargs())

    def test_no_partial_under_half_a_second_and_spacing_is_honoured(self):
        self.start()
        self.script(self.growing)
        warm = len(self.calls)
        with self.c.websocket_connect("/v1/stream") as ws:
            self.begin(ws, partial_ms=300)
            ws.send_bytes(pcm16(0.3))  # 0.3 s: under the 0.5 s minimum
            ws.send_bytes(pcm16(0.3))  # 0.6 s: one partial
            self.assertEqual(ws.receive_json()["audio_s"], 0.6)
            ws.send_bytes(pcm16(0.1))  # 0.1 s of new audio < 300 ms: none
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json()["type"], "final")
        self.assertEqual([(n, o.partial) for n, o in self.calls[warm:]], [(9600, True), (11200, False)])

    def test_cpu_model_streams_the_final_without_partials(self):
        self.start(device="cpu", compute="int8")
        self.script(self.growing)
        warm = len(self.calls)
        with self.c.websocket_connect("/v1/stream") as ws:
            self.assertEqual(self.begin(ws)["partials"], False)
            for _ in range(4):
                ws.send_bytes(pcm16(0.6))
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json()["final"], "Tony, cut it.")
        self.assertEqual([o.partial for _, o in self.calls[warm:]], [False])

    def test_partials_can_be_paused_mid_stream(self):
        # The client pauses captions while Tony's reply streams (the GPU is his then).
        self.start()
        self.script(self.growing)
        warm = len(self.calls)
        with self.c.websocket_connect("/v1/stream") as ws:
            self.begin(ws)
            ws.send_bytes(pcm16(0.6))
            self.assertEqual(ws.receive_json()["type"], "partial")
            ws.send_text(json.dumps({"type": "config", "partials": False}))
            ws.send_bytes(pcm16(1.2))
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json()["type"], "final")
        self.assertEqual([o.partial for _, o in self.calls[warm:]], [True, False])

    def test_without_a_gpu_model_whisper_cpp_answers_the_final(self):
        wc = WhisperCppStub()
        self.addCleanup(wc.close)
        self.c = TestClient(fw.create_app(self.worker, fallback=fw.Fallback(wc.url)))  # nothing loaded
        with self.c.websocket_connect("/v1/stream") as ws:
            self.assertEqual(self.begin(ws, model="large-v3-turbo")["partials"], False)
            ws.send_bytes(pcm16(1.5))
            ws.send_text(json.dumps({"type": "end"}))
            final = ws.receive_json()
        self.assertEqual((final["final"], final["backend"]), ("Play Bilmuri.", "whispercpp"))
        body = wc.bodies[0]
        self.assertIn(wav16k(1.5), body)  # the streamed PCM, as the WAV a POST would carry
        for k, v in (("language", "en"), ("prompt", "Tony, Gabagool mode."), ("response_format", "json"), ("model", "large-v3-turbo")):
            self.assertIn(f'name="{k}"\r\n\r\n{v}\r\n'.encode(), body)
        self.assertEqual(self.calls, [])

    def test_not_ready_without_a_fallback_is_an_error(self):
        self.c = TestClient(fw.create_app(self.worker))
        with self.c.websocket_connect("/v1/stream") as ws:
            self.assertEqual(self.begin(ws)["type"], "error")
            with self.assertRaises(WebSocketDisconnect) as closed:
                ws.receive_json()
        self.assertEqual(closed.exception.code, 1013)

    def test_bad_starts_and_payload_caps(self):
        self.start()
        with self.c.websocket_connect("/v1/stream") as ws:
            ws.send_bytes(pcm16(0.1))
            self.assertEqual(ws.receive_json()["error"], "expected a start message")
        with self.c.websocket_connect("/v1/stream") as ws:
            self.assertIn("bad start", self.begin(ws, language="../x")["error"])
        with self.c.websocket_connect("/v1/stream") as ws:
            self.begin(ws)
            ws.send_bytes(b"\x00\x01\x02")  # odd length: not PCM16
            self.assertEqual(ws.receive_json()["type"], "error")
        saved = fw.STREAM_MAX_BYTES
        try:
            fw.STREAM_MAX_BYTES = 32000
            with self.c.websocket_connect("/v1/stream") as ws:
                self.begin(ws, partials=False)
                ws.send_bytes(pcm16(0.6))
                ws.send_bytes(pcm16(0.6))
                self.assertEqual(ws.receive_json()["error"], "audio too long or not PCM16")
        finally:
            fw.STREAM_MAX_BYTES = saved

    def test_cancel_decodes_nothing(self):
        self.start()
        warm = len(self.calls)
        with self.c.websocket_connect("/v1/stream") as ws:
            self.begin(ws, partials=False)
            ws.send_bytes(pcm16(1.0))
            ws.send_text(json.dumps({"type": "cancel"}))
            with self.assertRaises(WebSocketDisconnect):
                ws.receive_json()
        self.assertEqual(self.calls[warm:], [])

    def test_a_web_page_origin_is_refused(self):
        self.start()
        with self.assertRaises(WebSocketDisconnect):
            with self.c.websocket_connect("/v1/stream", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        with self.c.websocket_connect("/v1/stream", headers={"origin": "http://tauri.localhost"}) as ws:
            self.assertEqual(self.begin(ws)["type"], "ready")


class Pure(unittest.TestCase):
    def test_local_agreement_commits_the_agreed_prefix_and_never_retracts(self):
        la = fw.LocalAgreement()
        self.assertEqual(la.push("Play"), ("Play", ""))
        self.assertEqual(la.push("Play Bill"), ("Play Bill", "Play"))
        self.assertEqual(la.push("Play Bilmuri on"), ("Play Bilmuri on", "Play"))  # "Bill" was never agreed on
        self.assertEqual(la.push("play, Bilmuri on Spotify."), ("Play Bilmuri on Spotify.", "Play Bilmuri on"))
        # A hypothesis that rewrites committed words commits nothing more and retracts nothing.
        self.assertEqual(la.push("Pay Bilmuri on Spotify now"), ("Play Bilmuri on Spotify now", "Play Bilmuri on"))
        self.assertEqual(la.push(""), ("Play Bilmuri on", "Play Bilmuri on"))

    def test_wav16k_wraps_raw_pcm(self):
        raw = pcm16(0.25)
        self.assertEqual(fw.wav16k(raw), wav16k(0.25))
        self.assertEqual(fw.pcm16_audio(raw).size, 4000)

    def test_decode_wav_reads_the_apps_wav_without_pyav(self):
        a = fw.decode_audio_bytes(wav16k(0.5, amp=0.5))
        self.assertEqual((a.dtype, a.size), (np.float32, 8000))
        self.assertAlmostEqual(float(np.max(np.abs(a))), 0.5, places=2)

    def test_clean_text_drops_noise_lines_only_when_the_model_doubts_speech(self):
        quiet, loud = 0.001, 0.05
        self.assertEqual(fw.clean_text("[BLANK_AUDIO]", [], loud), "")
        self.assertEqual(fw.clean_text(" Thank you.", [{"no_speech_prob": 0.4}], loud), "")
        self.assertEqual(fw.clean_text("you", [{"no_speech_prob": 0.2}], loud), "")
        # large-v3-turbo: no_speech_prob is 0 on noise, but the line is a low-confidence guess
        # (the benchmark's white / brown / hum noise: -0.74 to -0.81; room tone at -55 dBFS: -0.70).
        self.assertEqual(fw.clean_text(" Thank you.", [{"no_speech_prob": 0.0, "avg_logprob": -0.80}], loud), "")
        self.assertEqual(fw.clean_text(" Thank you.", [{"no_speech_prob": 0.0, "avg_logprob": -0.6966}], 0.0018), "")
        self.assertEqual(fw.clean_text("Transcription by CastingWords", [{"no_speech_prob": 0.0, "avg_logprob": -0.4}], loud), "")
        # A quiet clip needs less doubt, but some: -0.55 is dropped there and kept on a loud clip.
        self.assertEqual(fw.clean_text("Thank you.", [{"no_speech_prob": 0.0, "avg_logprob": -0.55}], quiet), "")
        self.assertEqual(fw.clean_text("Thank you.", [{"no_speech_prob": 0.0, "avg_logprob": -0.55}], loud), "Thank you.")
        # Real speech: confident, or more than a stock line.
        self.assertEqual(fw.clean_text("Thank you.", [{"no_speech_prob": 0.01}], loud), "Thank you.")
        self.assertEqual(fw.clean_text("Thank you, Tony.", [{"no_speech_prob": 0.5}], loud), "Thank you, Tony.")
        self.assertEqual(fw.clean_text("Okay.", [{"no_speech_prob": 0.5}], loud), "Okay.")

    def test_clean_text_keeps_a_quiet_stock_line_the_model_is_sure_of(self):
        # Kokoro "Thank you." / "Bye." padded like the app's clips, -49 dBFS over the clip: turbo is
        # sure (avg_logprob -0.29 / -0.36, no_speech_prob 0) and whisper.cpp base.en keeps them too.
        for text, lp, level in (("Thank you.", -0.29, 0.0035), ("Bye.", -0.36, 0.0035), ("Thank you.", -0.31, 0.0005)):
            self.assertEqual(fw.clean_text(text, [{"no_speech_prob": 0.0, "avg_logprob": lp}], level), text)

    def test_build_options_defaults(self):
        o = fw.build_options({}, 45.0, beam_size=3, vad="on")
        self.assertEqual((o.language, o.beam_size, o.without_timestamps, o.vad_filter, o.temperature), (None, 3, False, True, (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)))
        self.assertFalse(fw.build_options({"vad": "0"}, 3.0, vad="on").vad_filter)
        self.assertEqual(fw.build_options({"language": "en-US", "beam_size": "50"}, 3.0).beam_size, 10)

    def test_resolve_model(self):
        tmp = Path(tempfile.mkdtemp(prefix="fw-m-"))
        try:
            (tmp / "faster-whisper-large-v3-turbo").mkdir()
            (tmp / "faster-whisper-large-v3-turbo" / "model.bin").write_bytes(b"x")
            self.assertEqual(fw.resolve_model("large-v3-turbo", tmp).name, "faster-whisper-large-v3-turbo")
            self.assertEqual(fw.resolve_model("faster-whisper-large-v3-turbo", tmp).name, "faster-whisper-large-v3-turbo")
            for bad in ("..", "a/b", "", "distil-large-v3"):
                with self.assertRaises(ValueError):
                    fw.resolve_model(bad, tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_bind_exclusive_refuses_a_taken_port(self):
        s = fw.bind_exclusive("127.0.0.1", 0)
        try:
            with self.assertRaises(OSError):
                fw.bind_exclusive("127.0.0.1", s.getsockname()[1])
        finally:
            s.close()

    def test_log_is_capped_at_10_mb_and_never_has_the_transcript(self):
        tmp = Path(tempfile.mkdtemp(prefix="fw-log-"))
        saved = list(fw.log.handlers)
        try:
            fw.log.handlers.clear()
            fw.setup_logging(tmp / "fw-server.log")
            h = fw.log.handlers[0]
            self.assertIsInstance(h, logging.handlers.RotatingFileHandler)
            self.assertLessEqual(h.maxBytes * (h.backupCount + 1), 10 * 1024 * 1024)
            self.assertGreaterEqual(h.backupCount, 1)  # 0 would never roll over
            w = fw.Worker(lambda p, d, c: FakeBackend(p, d, c, text="secret words"), Path(tempfile.gettempdir()), gpu=lambda: None)
            w.backend, w.state["ready"] = FakeBackend(None, "cuda", "int8_float16", text="secret words"), True
            w.submit(np.zeros(32000, np.float32), fw.build_options({}, 2.0)).result(5)
            w.stop()
            h.flush()
            text = (tmp / "fw-server.log").read_text(encoding="utf-8")
            self.assertIn("audio=2.00s", text)
            self.assertIn("decode=", text)
            self.assertNotIn("secret", text)
        finally:
            for h in fw.log.handlers:
                h.close()
            fw.log.handlers[:] = saved
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
