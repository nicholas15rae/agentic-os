"""Quick shaded previews of a GLB from several angles (matplotlib painter's algorithm).

    .venv/Scripts/python.exe preview.py <mesh.glb> <out.png>
"""
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import trimesh  # noqa: E402
from matplotlib.collections import PolyCollection  # noqa: E402

m = trimesh.load(sys.argv[1], force="mesh")
v = m.vertices - m.bounds.mean(0)
v /= np.abs(v).max()
f = m.faces
has_tex = hasattr(m.visual, "to_color")
try:
    fc_tex = m.visual.to_color().face_colors[:, :3] / 255.0 if has_tex else None
except Exception:
    fc_tex = None


def rot(yaw, pitch):
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return rx @ ry


views = [("front-left", -0.7, 0.25), ("side", np.pi / 2, 0.1), ("rear-right", 2.5, 0.3), ("top", 0.3, 1.2)]
fig, axes = plt.subplots(1, len(views), figsize=(4.2 * len(views), 4.2), facecolor="#101014")
light = np.array([-0.4, 0.6, 0.7])
light /= np.linalg.norm(light)
for ax, (name, yaw, pitch) in zip(axes, views):
    r = rot(yaw, pitch)
    pv = v @ r.T
    tri = pv[f]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    vis = n[:, 2] > 0
    shade = np.clip(n @ light, 0, 1) * 0.8 + 0.2
    base = fc_tex if fc_tex is not None else np.full((len(f), 3), 0.75)
    col = base * shade[:, None]
    order = np.argsort(tri[:, :, 2].mean(1))
    order = order[vis[order]]
    ax.add_collection(PolyCollection(tri[order][:, :, :2], facecolors=col[order], edgecolors="none"))
    ax.set_xlim(-1.05, 1.05)
    ax.set_ylim(-1.05, 1.05)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(name, color="w")
plt.tight_layout()
plt.savefig(sys.argv[2], dpi=90, facecolor="#101014")
print("PREVIEW", sys.argv[2], len(f), "faces")
