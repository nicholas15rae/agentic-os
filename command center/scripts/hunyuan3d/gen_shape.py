"""Shape generation for the Orbital fleet (Hunyuan3D-2 turbo + FlashVDM), one mesh per input cutout.

    .venv/Scripts/python.exe gen_shape.py <input.png> <out.glb> [seed]
"""
import os
import sys
import time

os.environ.setdefault("HF_HOME", r"F:\hunyuan3d\hf")

import torch  # noqa: E402
from PIL import Image  # noqa: E402

from hy3dgen.shapegen import DegenerateFaceRemover, FaceReducer, FloaterRemover, Hunyuan3DDiTFlowMatchingPipeline  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1234

pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("tencent/Hunyuan3D-2", subfolder="hunyuan3d-dit-v2-0-turbo", use_safetensors=True)
pipe.enable_flashvdm()

img = Image.open(src).convert("RGBA")
# Pad to a square canvas with a margin (the model expects the object centred with room around it).
side = int(max(img.size) * 1.15)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
canvas = canvas.resize((1024, 1024), Image.LANCZOS)

t = time.time()
mesh = pipe(image=canvas, num_inference_steps=5, octree_resolution=380, num_chunks=200000, generator=torch.manual_seed(seed), output_type="trimesh")[0]
mesh = FloaterRemover()(mesh)
mesh = DegenerateFaceRemover()(mesh)
mesh = FaceReducer()(mesh, max_facenum=60000)
mesh.export(out)
print(f"SHAPE_DONE {out} faces={len(mesh.faces)} {time.time() - t:.1f}s")
