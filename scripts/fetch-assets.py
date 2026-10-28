"""下载 demo 需要的二进制资产（MediaPipe 的 js/wasm 与模型权重）。

这些文件共约 65MB，不进 git；克隆后跑一次本脚本即可：

    python scripts/fetch-assets.py

幂等：已存在且大小正确的文件会跳过；加 --force 强制重下。
"""

import argparse
import io
import os
import sys
import tarfile
import urllib.request

TASKS_VISION_VERSION = "1.2.0"
NPM_TGZ = (
    "https://registry.npmjs.org/@mediapipe/tasks-vision/-/"
    f"tasks-vision-{TASKS_VISION_VERSION}.tgz"
)

MODEL_BASE = "https://storage.googleapis.com/mediapipe-models"
MODELS = {
    "pose_landmarker_full.task":
        f"{MODEL_BASE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    "pose_landmarker_lite.task":
        f"{MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    "hand_landmarker.task":
        f"{MODEL_BASE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
}

# npm 包里需要挑出来的文件（其余是 .cjs/.map/type 声明，用不到）
VENDOR_FILES = ["package/vision_bundle.mjs"]
VENDOR_WASM_PREFIX = "package/wasm/"


def log(msg):
    print(msg, flush=True)


def download(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "pose-demo-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def fetch_vendor(dest, force):
    vendor = os.path.join(dest, "vendor")
    bundle = os.path.join(vendor, "vision_bundle.mjs")
    wasm_dir = os.path.join(vendor, "wasm")
    if not force and os.path.isfile(bundle) and os.path.isdir(wasm_dir):
        log(f"[skip] {vendor} 已存在")
        return

    log(f"下载 @mediapipe/tasks-vision@{TASKS_VISION_VERSION} …")
    raw = download(NPM_TGZ)
    log(f"  {len(raw) / 1024 / 1024:.1f} MB")

    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        for member in tar.getmembers():
            if member.name in VENDOR_FILES:
                out = os.path.join(vendor, os.path.basename(member.name))
                write_bytes(out, tar.extractfile(member).read())
                log(f"  → vendor/{os.path.basename(member.name)}")
            elif member.name.startswith(VENDOR_WASM_PREFIX) and member.isfile():
                name = member.name[len(VENDOR_WASM_PREFIX):]
                if not name:
                    continue
                out = os.path.join(wasm_dir, name)
                write_bytes(out, tar.extractfile(member).read())
                log(f"  → vendor/wasm/{name}")


def fetch_models(dest, force):
    models = os.path.join(dest, "models")
    for name, url in MODELS.items():
        out = os.path.join(models, name)
        if not force and os.path.isfile(out) and os.path.getsize(out) > 1_000_000:
            log(f"[skip] models/{name} 已存在（{os.path.getsize(out) / 1024 / 1024:.1f} MB）")
            continue
        log(f"下载 {name} …")
        data = download(url)
        write_bytes(out, data)
        log(f"  → models/{name}  {len(data) / 1024 / 1024:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description="下载 pose-demo 的二进制资产")
    ap.add_argument("--dest", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "web"), help="输出目录（默认仓库内的 web/）")
    ap.add_argument("--force", action="store_true", help="已存在也重新下载")
    args = ap.parse_args()

    dest = os.path.abspath(args.dest)
    log(f"目标目录：{dest}")
    try:
        fetch_vendor(dest, args.force)
        fetch_models(dest, args.force)
    except Exception as e:  # 网络问题最常见，给出可操作的提示
        log(f"\n失败：{e}")
        log("检查网络；国内可先开代理再重试（本机代理为 127.0.0.1:33210，"
            "必要时 export HTTPS_PROXY=http://127.0.0.1:33210）")
        return 1

    log("\n完成。启动：python serve.py  →  http://127.0.0.1:8765/web/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
