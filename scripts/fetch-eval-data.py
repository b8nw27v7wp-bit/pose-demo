"""下载开源验证素材（子集），供本项目的姿态/多人/PPE 链路跑真实画面。

为什么要脚本：这些素材不进 git（体积 + 许可），但"用哪份数据、哪一版、多少帧"必须能复现，
否则下一次评估说不清结果是从哪来的。跑完会在目标目录写 MANIFEST.json。

    python scripts/fetch-eval-data.py                # 默认下到 eval-data/open（02/05 两条序列）
    python scripts/fetch-eval-data.py --mot17-seqs MOT17-04-FRCNN,MOT17-09-FRCNN,MOT17-10-FRCNN --mot17-frames 180
    python scripts/fetch-eval-data.py --ppe-images 100 --ppe-test-images 100 --helmet-images 300 --site-images 300

依赖：pip install huggingface_hub imageio-ffmpeg
（imageio-ffmpeg 只用于把 MOT17 的 jpg 序列合成 mp4；PATH 里已有 ffmpeg 可忽略）

数据来源与许可（都要自己再核一遍，尤其商业交付前）：

| 数据集 | 用途 | 许可 | 备注 |
|---|---|---|---|
| Lekim89/MOT17（MOT17 镜像） | 多人在街上行走，多目标跟踪 | **CC BY-NC-SA 3.0（非商用）** | 原始 MOTChallenge；只能做研究与验证，不能进商业交付 |
| Chapian/PPE_detection（Roboflow） | 安全帽/手套/反光衣 + 未佩戴对照 | 以 Roboflow 页面声明为准（多为 CC BY 4.0） | 9 类：boots/gloves/hardhat/no_*、vest、person |
| phat06/Safety-helmet-dataset | 安全帽（Roboflow 导出，7k 图 + YOLO 标注） | **MIT** | 第二个独立来源，用来查跨数据集泛化 |
| vikasaarna/roboflow-construction-ppe-fruwx | 工地 PPE（4.4k 图 + YOLO 标注） | **MIT** | 采集自真实工地，与上者不同分布 |

另有两个**需要申请权限**（gated）的好源，脚本里没有自动下：

- `ersace/IITU_Safety-Helmet_Dataset_v1.0`（CC BY 4.0，1664 图，无人机 3~5m/10~15m、0/45/90°、夜间）
- `IswaryaS/Aerial-PPE-Construction-Safety`（CC BY-NC-ND，航拍 PPE，需填表申请）

国内网络注意：huggingface.co 直连不通，走 https://hf-mirror.com（本脚本默认）。
若也走不通，先开代理再 `set HF_ENDPOINT=https://huggingface.co` 重试。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

ENDPOINT = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")

MOT17 = "Lekim89/MOT17"
PPE = "Chapian/PPE_detection"
HELMET = "phat06/Safety-helmet-dataset"
CONSTRUCTION = "vikasaarna/roboflow-construction-ppe-fruwx"

MOT17_SEQS = ["MOT17-02-FRCNN", "MOT17-05-FRCNN"]   # 02 是拥挤街景，05 是俯拍广场
# 本地目录名 → HF 仓库：补 label 时用
DATASETS = [
    ("PPE_detection", PPE),
    ("Safety-helmet-dataset", HELMET),
    ("roboflow-construction-ppe-fruwx", CONSTRUCTION),
]
MAX_WORKERS = 8


def hf():
    try:
        import huggingface_hub as h
    except ImportError:
        print("需要 huggingface_hub：pip install huggingface_hub", file=sys.stderr)
        raise
    os.environ["HF_ENDPOINT"] = ENDPOINT
    return h


def list_files(h, repo):
    return h.list_repo_files(repo_id=repo, repo_type="dataset")


def download(h, repo, files, dest, subdir=None):
    """按文件列表下载（只取需要的子集，不下整仓）。返回成功下载的本地路径。

    并发下载：MOT17 是一帧一个 jpg，串行走镜像每个文件都要一次 TLS 握手，
    实测 600 帧要十几分钟；8 线程并行的瓶颈变成镜像带宽。
    """
    from concurrent.futures import ThreadPoolExecutor
    target = os.path.join(dest, subdir or repo.split("/")[-1])
    done = 0

    def one(f):
        try:
            return h.hf_hub_download(repo_id=repo, filename=f, repo_type="dataset", local_dir=target)
        except Exception as e:
            print(f"  [skip] {f} — {e}")
            return None

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, max(1, len(files)))) as ex:
        out = []
        for p in ex.map(one, files):
            done += 1
            if p:
                out.append(p)
            if done % 50 == 0:
                print(f"    … {done}/{len(files)}", flush=True)
    return out


def pick_mot17(files, seq, frames):
    """取某序列前 N 帧 + 标注。MOT17 每条序列有 DPM/FRCNN/SDP 三份检测，
    画面完全相同；只要 FRCNN 一份，否则同一段视频会被下载三遍。"""
    base = f"val/{seq}"
    imgs = sorted(f for f in files if f.startswith(base + "/img1/") and f.endswith(".jpg"))[:frames]
    extra = [f for f in files if f in (f"{base}/gt/gt.txt", f"{base}/seqinfo.ini")]
    return imgs + extra


def find_ffmpeg():
    """优先 PATH，其次 FFMPEG 环境变量，最后 imageio-ffmpeg 自带的二进制。

    Windows 上 ffmpeg 常常不在 PATH（本机就是）。`pip install imageio-ffmpeg`
    会带一个可用的 ffmpeg.exe，不用改系统 PATH 也能合成视频。
    """
    exe = shutil.which("ffmpeg") or os.environ.get("FFMPEG")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def frames_to_mp4(src_dir, out_mp4, fps=25):
    """MOT17 的 img1 是 6 位序号 jpg。合成 H.264 mp4，浏览器才能直接播。"""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("  [skip] 没找到 ffmpeg，无法合成 mp4（图片仍在，可手动合成；"
              "或 pip install imageio-ffmpeg）")
        return False
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-framerate", str(fps), "-start_number", "1", "-i", os.path.join(src_dir, "%06d.jpg"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart",
        out_mp4,
    ]
    try:
        subprocess.run(cmd, check=True)
        return True
    except Exception as e:
        print(f"  [skip] ffmpeg 失败：{e}")
        return False


def repair_labels(h, dest, workers=2):
    """补下"本地有图、没有 label"的标注文件。

    下载中断/限流时最常出现的状态：图片下了一半，label 缺一批。重新整体跑
    fetch 会换一个抽样（step 变了），补不到原来的文件；这个模式只扫本地缺什么，
    按本地相对路径去仓库里找同名 label，存在才下。
    """
    from concurrent.futures import ThreadPoolExecutor
    jobs = []
    for local_name, repo in DATASETS:
        root = os.path.join(dest, local_name)
        if not os.path.isdir(root):
            continue
        repo_files = set(list_files(h, repo))
        for dirpath, _, filenames in os.walk(root):
            if os.path.basename(dirpath) != "images":
                continue
            lbl_dir = os.path.join(os.path.dirname(dirpath), "labels")
            for f in filenames:
                if not f.lower().endswith((".jpg", ".jpeg", ".png")):
                    continue
                stem = os.path.splitext(f)[0]
                lbl = os.path.join(lbl_dir, stem + ".txt")
                if os.path.exists(lbl):
                    continue
                rel = os.path.relpath(lbl, root).replace(os.sep, "/")
                if rel in repo_files:
                    jobs.append((repo, rel, os.path.join(dest, local_name)))
    print(f"缺 label：{len(jobs)} 个文件")
    if not jobs:
        return 0

    def one(job):
        repo, rel, local_dir = job
        try:
            h.hf_hub_download(repo_id=repo, filename=rel, repo_type="dataset", local_dir=local_dir)
            return None
        except Exception as e:
            return f"{repo}/{rel}: {e}"

    done = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for r in ex.map(one, jobs):
            done += 1
            if r:
                failed += 1
                print(f"  [fail] {r}")
            if done % 10 == 0:
                print(f"  … {done}/{len(jobs)}")
    print(f"完成：{len(jobs) - failed}/{len(jobs)}")
    return 1 if failed else 0


def main():
    # Windows 控制台/管道默认 GBK，中文和进度会乱码或被 npm 吞掉。输出统一走 UTF-8。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="下载开源验证素材子集")
    ap.add_argument("--dest", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "eval-data", "open"))
    ap.add_argument("--mot17-frames", type=int, default=300, help="每条序列取多少帧（25fps，300 帧=12s）")
    ap.add_argument("--mot17-seqs", default=",".join(MOT17_SEQS),
                    help="逗号分隔的 MOT17 序列名（默认 02/05；可加 04/09/10/11/13）")
    ap.add_argument("--ppe-images", type=int, default=100)
    ap.add_argument("--ppe-test-images", type=int, default=100, help="PPE_detection 的 test 集张数（留出评估用）")
    ap.add_argument("--helmet-images", type=int, default=60)
    ap.add_argument("--site-images", type=int, default=60)
    ap.add_argument("--skip-mot17", action="store_true")
    ap.add_argument("--skip-ppe", action="store_true")
    ap.add_argument("--repair-labels", action="store_true",
                    help="只补本地缺的 label（下载中断/限流后用），不重新下载图片")
    ap.add_argument("--workers", type=int, default=8, help="并发下载线程数（限流时降到 2）")
    args = ap.parse_args()
    global MAX_WORKERS
    MAX_WORKERS = max(1, args.workers)

    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)
    h = hf()
    if args.repair_labels:
        print(f"目标目录：{dest}\nHF 端点：{ENDPOINT}\n")
        return repair_labels(h, dest, workers=args.workers)
    # 合并旧清单：只重跑一部分数据集时，不能把上次的 MOT17 序列记录抹掉。
    manifest = {"endpoint": ENDPOINT, "datasets": {}}
    path = os.path.join(dest, "MANIFEST.json")
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                old = json.load(f)
            if isinstance(old, dict) and isinstance(old.get("datasets"), dict):
                manifest["datasets"] = old["datasets"]
        except Exception as e:
            print(f"[warn] 旧 MANIFEST 读不出来，会重写：{e}")
    print(f"目标目录：{dest}\nHF 端点：{ENDPOINT}\n")

    # —— MOT17：多人视频 ——
    if not args.skip_mot17:
        seqs = [s.strip() for s in args.mot17_seqs.split(",") if s.strip()]
        print(f"[1/4] {MOT17} — 多人跟踪（{len(seqs)} 条序列，每条前 {args.mot17_frames} 帧）")
        files = list_files(h, MOT17)
        for seq in seqs:
            want = pick_mot17(files, seq, args.mot17_frames)
            if not want:
                print(f"  {seq}: 没找到 img1，跳过")
                continue
            got = download(h, MOT17, want, dest, subdir=f"mot17/{seq}")
            src = os.path.join(dest, "mot17", seq, "val", seq, "img1")
            mp4 = os.path.join(dest, "mot17", f"{seq}.mp4")
            ok = frames_to_mp4(src, mp4)
            manifest["datasets"].setdefault("mot17", {
                "repo": MOT17, "license": "CC BY-NC-SA 3.0（非商用，研究/验证用）",
                "sequences": {},
            })["sequences"][seq] = {
                "images": len([f for f in want if f.endswith('.jpg')]),
                "mp4": os.path.relpath(mp4, dest) if ok else None,
                "gt": any(f.endswith("gt.txt") for f in want),
            }
            print(f"  {seq}: {len(got)} 个文件{' -> ' + os.path.basename(mp4) if ok else ''}")

    # —— PPE：安全帽/手套 + 未佩戴对照 ——
    if not args.skip_ppe:
        print(f"\n[2/4] {PPE} — 安全帽/手套（train {args.ppe_images} + test {args.ppe_test_images} 张）")
        files = list_files(h, PPE)
        imgs_train = sorted(f for f in files if f.startswith("train/images/"))[:args.ppe_images]
        # 这个仓库自带 100 张 test（带标注）：留着做留出评估，别全拿去训练
        imgs_test = sorted(f for f in files if f.startswith("test/images/"))[:args.ppe_test_images]
        imgs = imgs_train + imgs_test
        labels = [f.replace("/images/", "/labels/").rsplit(".", 1)[0] + ".txt" for f in imgs]
        label_set = set(files)
        labels = [f for f in labels if f in label_set]
        download(h, PPE, imgs, dest)
        download(h, PPE, labels, dest)
        download(h, PPE, [f for f in files if f == "data.yaml"], dest)
        manifest["datasets"]["ppe"] = {
            "repo": PPE, "license": "Roboflow 导出，许可见数据集页（多为 CC BY 4.0）",
            "images": len(imgs), "labels": len(labels),
            "splits": {"train": len(imgs_train), "test": len(imgs_test)},
            "classes": "boots/gloves/hardhat/no_boots/no_gloves/no_hardhat/no_vest/person/vest",
        }
        print(f"  图片 {len(imgs)}（train {len(imgs_train)} + test {len(imgs_test)}）"
              f" + 标注 {len(labels)} + data.yaml")

    # —— 安全帽（独立来源，检验跨数据集泛化）——
    print(f"\n[3/4] {HELMET} — 安全帽（{args.helmet_images} 张）")
    files = list_files(h, HELMET)
    imgs = sorted(f for f in files if f.lower().endswith((".jpg", ".jpeg", ".png")))
    # 均匀抽样：直接取前 N 张会全落在同一个 Roboflow 子集/机位，跨机位就白搭了
    step = max(1, len(imgs) // max(1, args.helmet_images))
    sample = imgs[::step][:args.helmet_images]
    labels = [f.replace("/images/", "/labels/").rsplit(".", 1)[0] + ".txt" for f in sample]
    label_set = set(files)
    # 类别名通常只在 data.yaml 里。不下它，抽到的 labels 就是一堆 0/1，训练时只能靠猜。
    yamls = [f for f in files if f.endswith(("data.yaml", "dataset.yaml"))]
    got = download(h, HELMET, sample + [f for f in labels if f in label_set] + yamls, dest)
    manifest["datasets"]["helmet"] = {
        "repo": HELMET, "license": "MIT",
        "images": len(sample), "sampled_from": len(imgs), "step": step,
        "labels": len([f for f in labels if f in label_set]),
        "data_yaml": yamls[0] if yamls else None,
        "classes_known": bool(yamls),
    }
    print(f"  从 {len(imgs)} 张里按 step={step} 抽了 {len(sample)} 张")

    # —— 工地 PPE（第二个独立来源，MIT）——
    print(f"\n[4/4] {CONSTRUCTION} — 工地 PPE（{args.site_images} 张）")
    files = list_files(h, CONSTRUCTION)
    imgs = sorted(f for f in files if f.lower().endswith((".jpg", ".jpeg", ".png")))
    step = max(1, len(imgs) // max(1, args.site_images))
    sample = imgs[::step][:args.site_images]
    # 只下图片 = 无法训练也无法算指标。labels 与图片同名，一起下（每个文件只有几百字节）。
    labels = [f.replace("/images/", "/labels/").rsplit(".", 1)[0] + ".txt" for f in sample]
    label_set = set(files)
    labels = [f for f in labels if f in label_set]
    extra = [f for f in files if f.endswith(("data.yaml", "README.dataset.txt"))]
    got = download(h, CONSTRUCTION, sample + labels + extra, dest)
    manifest["datasets"]["construction_ppe"] = {
        "repo": CONSTRUCTION, "license": "MIT",
        "images": len(sample), "sampled_from": len(imgs), "step": step,
        "labels": len(labels),
    }
    print(f"  从 {len(imgs)} 张里按 step={step} 抽了 {len(sample)} 张")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n完成。清单：{path}")
    print("提示：这些素材只用于验证链路与后续训练，不代表本项目在真实场景的准确率。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
