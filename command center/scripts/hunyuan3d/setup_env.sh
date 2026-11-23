#!/usr/bin/env bash
# Hunyuan3D-2 environment on F: (scratch). Official sources only: pytorch.org, PyPI, Tencent's repo.
set -euo pipefail
cd /f/hunyuan3d
export UV_CACHE_DIR=/f/hunyuan3d/uv-cache
uv venv .venv --python 3.11
PY=/f/hunyuan3d/.venv/Scripts/python.exe
uv pip install --python "$PY" torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$PY" -r Hunyuan3D-2/requirements.txt
uv pip install --python "$PY" -e Hunyuan3D-2
uv pip install --python "$PY" "huggingface_hub[cli]" hf_transfer
"$PY" -c "import torch;print('torch',torch.__version__,'cuda',torch.version.cuda,'ok',torch.cuda.is_available(),torch.cuda.get_device_name(0))"
echo SETUP_ENV_DONE
