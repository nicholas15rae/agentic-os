# Orbital fleet: generated 3D models

The E46 (and the interceptor, when present) in `src/assets/orbital-models/` are generated from
the reference renders with **Hunyuan3D-2** (Tencent, open weights), run locally on the RTX 3060.
`fleet/models.ts` loads them (`buildE46FromMesh`) and falls back to the hand-built models while
they load or if a file is missing.

| Model | Input cutout | Output |
|-------|--------------|--------|
| E46 Touring X-wing | `e46-rear-cutout.png` (matted from `e46-rear-scene.webp`) | `src/assets/orbital-models/e46.glb` |
| Interceptor | `fighter-cutout.png` (matted from `dogfight-scene.webp`) | `src/assets/orbital-models/fighter.glb` |

The capital ship stays procedural: its reference image only ever arrived inline in chat, never
as a file. Drop it here as `capital-ship.png` (any background) to generate it the same way.

## Re-running

The toolchain lives on the scratch drive (`F:\hunyuan3d`), not in the repo:

- `.venv`: Python 3.11, torch 2.11 + CUDA 12.8, the Hunyuan3D-2 repo installed editable, with
  `transformers==4.49.0`, `diffusers==0.32.2` (newer `transformers` renames DINOv2 weights).
- `hf/`: model weights (`tencent/Hunyuan3D-2`: dit-v2-0-turbo, vae-v2-0-turbo,
  paint-v2-0-turbo, delight-v2-0), ~23 GB.
- `cudatk/`: a no-admin CUDA 12.8 toolkit from conda-forge via pixi (nvcc, cudart, cuBLAS,
  cuSPARSE, cuSOLVER, cuRAND headers + libs, libs mirrored into `lib/x64` for torch).

`scripts/hunyuan3d/` holds the scripts:

```
setup_env.sh        venv + torch + Hunyuan3D-2
build_texgen.bat    compile custom_rasterizer (CUDA) + differentiable_renderer (MSVC 2022)
gen_shape.py        image → mesh (turbo + FlashVDM, ~20 s)
gen_texture.py      mesh + image → textured GLB (paint turbo, ~2.5 min, CPU offload)
preview.py          quick shaded previews
```

One local patch was needed in the Hunyuan3D-2 clone: `custom_rasterizer_kernel/rasterizer.h`
includes `torch/types.h` instead of `torch/extension.h` when compiling CUDA (`__CUDACC__`), to
avoid MSVC's C2872 "'std': ambiguous symbol" in torch's dynamo headers.

The generated textures carry the render's violet nebula cast; `buildE46FromMesh` warms the
paint back towards silver.
