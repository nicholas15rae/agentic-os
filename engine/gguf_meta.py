"""Read a GGUF file's header metadata (key/value pairs only, never the tensors).

Used by the model manager to size a model's KV cache before loading it. Array values (the tokenizer's
150k-entry vocab) are skipped, not kept: only their length is recorded.
"""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Any, BinaryIO

_SCALAR = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_STR, _ARR = 8, 9
MAX_KV = 100_000
KEEP_ARRAY = 1024  # arrays up to this many scalar items are kept (per-layer head counts); longer ones skipped


class GGUFError(ValueError):
    pass


def _read(f: BinaryIO, n: int) -> bytes:
    b = f.read(n)
    if len(b) != n:
        raise GGUFError("truncated GGUF header")
    return b


def _str(f: BinaryIO) -> str:
    (n,) = struct.unpack("<Q", _read(f, 8))
    if n > 1 << 24:
        raise GGUFError("string too long")
    return _read(f, n).decode("utf-8", "replace")


def _value(f: BinaryIO, t: int) -> Any:
    if t in _SCALAR:
        fmt = _SCALAR[t]
        return struct.unpack(fmt, _read(f, struct.calcsize(fmt)))[0]
    if t == _STR:
        return _str(f)
    if t == _ARR:
        (et,) = struct.unpack("<I", _read(f, 4))
        (n,) = struct.unpack("<Q", _read(f, 8))
        if et in _SCALAR:
            size = struct.calcsize(_SCALAR[et])
            if n <= KEEP_ARRAY:
                return [_value(f, et) for _ in range(n)]
            f.seek(size * n, 1)
            return {"array_len": n}
        if et == _STR:
            for _ in range(n):
                (ln,) = struct.unpack("<Q", _read(f, 8))
                f.seek(ln, 1)
            return {"array_len": n}
        raise GGUFError(f"unsupported array type {et}")
    raise GGUFError(f"unknown value type {t}")


def read_meta(path: str | Path) -> dict[str, Any]:
    with open(path, "rb") as f:
        if _read(f, 4) != b"GGUF":
            raise GGUFError("not a GGUF file")
        (ver,) = struct.unpack("<I", _read(f, 4))
        if ver < 2:
            raise GGUFError(f"GGUF v{ver} not supported")
        _tensors, n_kv = struct.unpack("<QQ", _read(f, 16))
        if n_kv > MAX_KV:
            raise GGUFError("too many keys")
        meta: dict[str, Any] = {"gguf.version": ver}
        for _ in range(n_kv):
            k = _str(f)
            (t,) = struct.unpack("<I", _read(f, 4))
            meta[k] = _value(f, t)
    return meta


# Bytes per KV element by llama.cpp cache type (block-quant types include their scale bytes).
KV_BYTES = {"f32": 4.0, "f16": 2.0, "bf16": 2.0, "q8_0": 34 / 32, "q5_1": 24 / 32, "q5_0": 22 / 32,
            "q4_1": 20 / 32, "q4_0": 18 / 32, "iq4_nl": 18 / 32}


def _num(meta: dict, key: str, default=None):
    v = meta.get(key, default)
    if isinstance(v, list):  # per-layer values: the largest
        nums = [x for x in v if isinstance(x, (int, float))]
        return max(nums) if nums else default
    return v


def attention_layers(meta: dict) -> int:
    """How many layers keep a KV cache. Hybrid models (Qwen3.5 / Qwen3-Next: linear attention with a
    full-attention layer every `full_attention_interval`) only cache those layers; per-layer
    head_count_kv arrays with zeros mark the recurrent layers too."""
    arch = meta.get("general.architecture", "")
    n = int(_num(meta, f"{arch}.block_count", 0) or 0)
    kv = meta.get(f"{arch}.attention.head_count_kv")
    if isinstance(kv, list) and kv:
        return sum(1 for x in kv if x)
    interval = _num(meta, f"{arch}.full_attention_interval")
    if isinstance(interval, int) and interval > 1:
        return n // interval
    return n


def kv_cache_bytes(meta: dict, ctx: int, k_type: str = "f16", v_type: str = "f16") -> int:
    arch = meta.get("general.architecture", "")
    heads = int(_num(meta, f"{arch}.attention.head_count", 0) or 0)
    heads_kv = int(_num(meta, f"{arch}.attention.head_count_kv", heads) or heads)
    emb = int(_num(meta, f"{arch}.embedding_length", 0) or 0)
    head_dim = emb // heads if heads else 0
    k_len = int(_num(meta, f"{arch}.attention.key_length", head_dim) or head_dim)
    v_len = int(_num(meta, f"{arch}.attention.value_length", head_dim) or head_dim)
    per_tok = attention_layers(meta) * heads_kv * (k_len * KV_BYTES.get(k_type, 2.0) + v_len * KV_BYTES.get(v_type, 2.0))
    return int(per_tok * ctx)


def summary(meta: dict) -> dict:
    arch = meta.get("general.architecture", "")
    return {
        "arch": arch,
        "name": meta.get("general.name", ""),
        "layers": _num(meta, f"{arch}.block_count"),
        "attentionLayers": attention_layers(meta),
        "trainCtx": _num(meta, f"{arch}.context_length"),
        "fileType": meta.get("general.file_type"),
        "hasChatTemplate": isinstance(meta.get("tokenizer.chat_template"), str),
    }
