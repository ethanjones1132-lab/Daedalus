"""Fetch the CUDA 13.4.2 components a llama.cpp CUDA build needs from NVIDIA's
official redistributable archives, verify each zip's sha256 against NVIDIA's
manifest, and merge them into one toolkit tree. No installer, no admin rights."""
import hashlib
import json
import pathlib
import shutil
import urllib.request
import zipfile

BASE = "https://developer.download.nvidia.com/compute/cuda/redist/"
ROOT = pathlib.Path(r"C:\cuda\13.4.2")
MANIFEST = pathlib.Path(__file__).with_name("redistrib_13.4.2.json")
NEEDED = ["cuda_nvcc", "cuda_cudart", "cuda_crt", "cccl", "libcublas", "libnvvm",
          "cuda_nvtx", "cuda_profiler_api"]

man = json.loads(MANIFEST.read_text())
ROOT.mkdir(parents=True, exist_ok=True)
for name in NEEDED:
    w = man[name]["windows-x86_64"]
    zpath = ROOT / pathlib.Path(w["relative_path"]).name
    if not zpath.exists():
        urllib.request.urlretrieve(BASE + w["relative_path"], zpath)
    h = hashlib.sha256(zpath.read_bytes()).hexdigest()
    if h != w["sha256"]:
        raise SystemExit(f"{name}: sha256 mismatch {h} != {w['sha256']}")
    with zipfile.ZipFile(zpath) as z:
        top = z.namelist()[0].split("/")[0]
        for m in z.infolist():
            rel = pathlib.PurePosixPath(m.filename).relative_to(top)
            if not rel.parts or m.is_dir():
                continue
            dst = ROOT.joinpath(*rel.parts)
            dst.parent.mkdir(parents=True, exist_ok=True)
            with z.open(m) as src, open(dst, "wb") as out:
                shutil.copyfileobj(src, out)
    zpath.unlink()
    print(f"{name} {man[name]['version']}: ok", flush=True)
print("CUDA_DONE", ROOT)
