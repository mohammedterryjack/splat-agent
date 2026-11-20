# /// script
# requires-python = ">=3.10"
# dependencies = ["plyfile==1.1", "numpy"]
# ///
"""Load a .ply exactly the way the reference 3D Gaussian Splatting code does (GaussianModel.load_ply in
graphdeco-inria/gaussian-splatting, degree-0 SH) and sanity-check the result. Usage: check_ply_3dgs.py file.ply"""
import sys
import numpy as np
from plyfile import PlyData

path = sys.argv[1]
plydata = PlyData.read(path)
el = plydata.elements[0]
xyz = np.stack((np.asarray(el["x"]), np.asarray(el["y"]), np.asarray(el["z"])), axis=1)
opacities = np.asarray(el["opacity"])[..., np.newaxis]
features_dc = np.zeros((xyz.shape[0], 3, 1))
features_dc[:, 0, 0] = np.asarray(el["f_dc_0"])
features_dc[:, 1, 0] = np.asarray(el["f_dc_1"])
features_dc[:, 2, 0] = np.asarray(el["f_dc_2"])
extra_f_names = [p.name for p in el.properties if p.name.startswith("f_rest_")]
max_sh_degree = 0
assert len(extra_f_names) == 3 * (max_sh_degree + 1) ** 2 - 3
scale_names = sorted([p.name for p in el.properties if p.name.startswith("scale_")], key=lambda x: int(x.split("_")[-1]))
scales = np.stack([np.asarray(el[n]) for n in scale_names], axis=1)
rot_names = sorted([p.name for p in el.properties if p.name.startswith("rot")], key=lambda x: int(x.split("_")[-1]))
rots = np.stack([np.asarray(el[n]) for n in rot_names], axis=1)
assert scales.shape[1] == 3 and rots.shape[1] == 4
for name, a in (("xyz", xyz), ("opacity", opacities), ("f_dc", features_dc), ("scale", scales), ("rot", rots)):
    assert np.isfinite(a).all(), f"{name} has non-finite values"
qn = np.linalg.norm(rots, axis=1)
assert np.allclose(qn, 1, atol=1e-4), "quaternions are not unit length"
rgb = np.clip(features_dc[:, :, 0] * 0.28209479177387814 + 0.5, 0, 1)
op = 1 / (1 + np.exp(-opacities[:, 0]))
print(f"OK {path}: {xyz.shape[0]} gaussians, sh degree {max_sh_degree}; extent {xyz.min(0).round(2).tolist()}..{xyz.max(0).round(2).tolist()}; "
      f"scale (std) median {np.exp(np.median(scales)):.4f}; opacity mean {op.mean():.3f}; mean rgb {rgb.mean(0).round(3).tolist()}")
