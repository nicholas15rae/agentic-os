"""Texture a generated mesh from its reference cutout (Hunyuan3D-Paint v2.0 turbo, CPU offload).

    .venv/Scripts/python.exe gen_texture.py <mesh.glb> <input.png> <out.glb>
"""
import sys
import time

import torch  # noqa: F401
import trimesh
from PIL import Image

from hy3dgen.texgen import Hunyuan3DPaintPipeline

SNAP = r"F:\hunyuan3d\hf\hub\models--tencent--Hunyuan3D-2\snapshots\9cd649ba6913f7a852e3286bad86bfa9a2d83dcf"

mesh_path, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
mesh = trimesh.load(mesh_path, force="mesh")
img = Image.open(src).convert("RGBA")
side = int(max(img.size) * 1.15)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
canvas = canvas.resize((1024, 1024), Image.LANCZOS)

t = time.time()
paint = Hunyuan3DPaintPipeline.from_pretrained(SNAP, subfolder="hunyuan3d-paint-v2-0-turbo")
paint.enable_model_cpu_offload()
textured = paint(mesh, image=canvas)
textured.export(out)
print(f"TEXTURE_DONE {out} {time.time() - t:.1f}s")
