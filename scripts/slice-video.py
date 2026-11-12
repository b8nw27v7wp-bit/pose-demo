"""按镜头切换把一个视频切片，并抽帧/关键帧/接触表。

用法：
  .venv-ppe/Scripts/python.exe scripts/slice-video.py <video> <outDir> [--step 0.5] [--threshold 18]

输出（outDir 下）：
  clips/shot_NN_<t0>-<t1>.mp4     每个镜头一段（有 ffmpeg 时 H.264+AAC，浏览器可回放；
                                  没有则 OpenCV mp4v 兜底：无音轨，Chrome 不能 ?src= 回放）
  frames/f_<sec>.jpg              每 step 秒一帧（截图 / 训练帧的来源）
  keyframes/shot_NN_..._key.jpg   每个镜头中点的一帧
  sheets/overview.jpg             全程接触表（每 1s 一格）
  sheets/shot_NN_....jpg          每个镜头内部的接触表（4 列）
  manifest.json                   fps / 帧数 / 切点 / 每段文件清单
重跑同一个 outDir 会先删除上一次生成的 frames/clips/keyframes/sheets 文件，避免新旧素材混集。

切点算法与 eval-data/equipment/extract_frames.py 一致：缩到 64×36 灰度，
相邻帧平均绝对差 > threshold 视为切点，0.3s 内的切点合并。
只读视频，不联网、不训练。
"""
import argparse
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np


def md5(path, chunk=1 << 20):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def detect_cuts(video, threshold):
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"打不开视频：{video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    prev = None
    cuts = []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (64, 36))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        if prev is not None and float(np.mean(np.abs(gray - prev))) > threshold:
            cuts.append(i / fps)
        prev = gray
        i += 1
    cap.release()
    merged = []
    for c in cuts:
        if not merged or c - merged[-1] > 0.3:
            merged.append(round(c, 3))
    return fps, i, merged


def segments_from_cuts(cuts, duration):
    marks = [0.0] + [c for c in cuts if 0.0 < c < duration] + [duration]
    out = []
    for a, b in zip(marks, marks[1:]):
        if b - a < 0.05:
            continue
        out.append((round(a, 3), round(b, 3)))
    return out


def safe_name(i, t0, t1):
    return f"shot_{i:02d}_{t0:06.2f}-{t1:06.2f}"


def clear_outputs(outdir):
    """删掉本工具上一次生成的产物。

    同一 outDir 换素材重跑时，不清空会让旧帧/旧切片留下来，而 manifest.json 不会提及；
    build_ds.py 之类按 glob 读帧的脚本会把两段素材混进同一个训练集且毫无报错。
    只删四类已知产物，不碰目录里的其他文件。
    """
    patterns = (("frames", "f_*.jpg"), ("clips", "*.mp4"),
                ("keyframes", "*_key.jpg"), ("sheets", "*.jpg"))
    removed = 0
    for sub, pat in patterns:
        for p in glob.glob(os.path.join(outdir, sub, pat)):
            os.remove(p)
            removed += 1
    return removed


def find_ffmpeg():
    """优先用 ffmpeg（H.264/AAC，浏览器可回放且保留音轨），找不到就返回 None。"""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # 可选依赖
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def write_clips_ffmpeg(video, outdir, segs, ffmpeg):
    clip_dir = os.path.join(outdir, "clips")
    os.makedirs(clip_dir, exist_ok=True)
    files = []
    for i, (t0, t1) in enumerate(segs, 1):
        name = safe_name(i, t0, t1)
        path = os.path.join(clip_dir, name + ".mp4")
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
               "-ss", f"{t0:.3f}", "-i", video, "-t", f"{t1 - t0:.3f}",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", path]
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        if r.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) == 0:
            raise SystemExit(f"ffmpeg 切片失败（{name}）：{(r.stderr or '').strip() or r.returncode}")
        files.append({"index": i, "t0": t0, "t1": t1,
                      "clip": os.path.relpath(path, outdir).replace("\\", "/"),
                      "frames_written": None, "encoder": "ffmpeg/libx264"})
    return files


def write_clips(video, outdir, segs, fps, size, ffmpeg=None):
    if ffmpeg:
        return write_clips_ffmpeg(video, outdir, segs, ffmpeg)
    if fps <= 0:
        raise SystemExit(f"切片帧率无效（{fps}）：--clip-fps 或源 fps 必须 > 0")
    cap = cv2.VideoCapture(video)
    clip_dir = os.path.join(outdir, "clips")
    os.makedirs(clip_dir, exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    files = []
    for i, (t0, t1) in enumerate(segs, 1):
        name = safe_name(i, t0, t1)
        path = os.path.join(clip_dir, name + ".mp4")
        writer = cv2.VideoWriter(path, fourcc, fps, size)
        # 编码器不可用 / 路径不可写时 VideoWriter 不会抛错，只会静默丢弃每一帧；
        # 不检查 isOpened 的话 manifest 会声称写了 N 帧。
        if not writer.isOpened():
            cap.release()
            raise SystemExit(f"无法创建切片（mp4v 编码器不可用或路径不可写）：{path}")
        cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000)
        written = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            # 用 POS_MSEC 判断结束：不同容器 seek 后取到的时间戳不一定精确
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if t >= t1:
                break
            writer.write(frame)
            written += 1
        writer.release()
        if written == 0:
            cap.release()
            raise SystemExit(f"切片写入 0 帧（seek 到 {t0:.2f}s 失败？）：{path}")
        files.append({"index": i, "t0": t0, "t1": t1, "clip": os.path.relpath(path, outdir).replace("\\", "/"),
                      "frames_written": written, "encoder": "opencv/mp4v"})
    cap.release()
    return files


def grabframe(cap, t):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    return frame if ok else None


def save_frame(path, frame, quality=92):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, frame, [cv2.IMWRITE_JPEG_QUALITY, quality])


def make_sheet(frames, cols, thumb_w=320, pad=20, title=None, out=None):
    """frames: [(label, img)] → 网格 jpg"""
    if not frames:
        return None
    thumb_h = int(thumb_w * 9 / 16)
    rows = (len(frames) + cols - 1) // cols
    sheet = np.zeros((rows * (thumb_h + pad) + (pad if title else 0), cols * thumb_w, 3), np.uint8)
    y0 = pad if title else 0
    for idx, (label, img) in enumerate(frames):
        r, c = divmod(idx, cols)
        y = y0 + r * (thumb_h + pad)
        x = c * thumb_w
        sheet[y + pad:y + pad + thumb_h, x:x + thumb_w] = cv2.resize(img, (thumb_w, thumb_h))
        cv2.putText(sheet, label, (x + 4, y + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (0, 255, 255), 1, cv2.LINE_AA)
    if title:
        cv2.putText(sheet, title, (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    if out:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cv2.imwrite(out, sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("outdir")
    ap.add_argument("--step", type=float, default=0.5, help="抽帧间隔（秒）")
    ap.add_argument("--threshold", type=float, default=18.0, help="切点灰度差阈值")
    ap.add_argument("--clip-fps", type=float, default=None, help="切片写入帧率（默认沿用源）")
    ap.add_argument("--ffmpeg", default=None, help="ffmpeg 可执行文件（默认自动查找 PATH / imageio-ffmpeg）")
    ap.add_argument("--no-ffmpeg", action="store_true", help="强制用 OpenCV 写 mp4v（无音轨，浏览器不可回放）")
    args = ap.parse_args()

    # t += step 的循环：step<=0 会原地死循环、反复写同一帧
    if not args.step > 0:
        raise SystemExit(f"--step 必须 > 0（收到 {args.step}）")
    if args.clip_fps is not None and not args.clip_fps > 0:
        raise SystemExit(f"--clip-fps 必须 > 0（收到 {args.clip_fps}）")

    video = os.path.abspath(args.video)
    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    cleared = clear_outputs(outdir)

    if args.no_ffmpeg:
        ffmpeg = None
    elif args.ffmpeg:
        if not os.path.isfile(args.ffmpeg):
            raise SystemExit(f"--ffmpeg 指向的文件不存在：{args.ffmpeg}")
        ffmpeg = args.ffmpeg
    else:
        ffmpeg = find_ffmpeg()
    if ffmpeg is None and not args.no_ffmpeg:
        print("[warn] 未找到 ffmpeg：切片改用 OpenCV mp4v（无音轨，Chrome 不能通过 ?src= 回放）。"
              "装好 ffmpeg（或 pip install imageio-ffmpeg）后重跑即可。", file=sys.stderr)

    fps, nframes, cuts = detect_cuts(video, args.threshold)
    duration = nframes / fps if fps else 0.0
    segs = segments_from_cuts(cuts, duration)

    cap = cv2.VideoCapture(video)
    ok, probe = cap.read()
    if not ok:
        raise SystemExit("读不到首帧")
    h, w = probe.shape[:2]
    cap.release()

    framefiles = write_clips(video, outdir, segs, args.clip_fps or fps, (w, h), ffmpeg=ffmpeg)

    cap = cv2.VideoCapture(video)
    # 每 step 秒一帧。只写盘、不攒在内存里：1 小时 1080p × 0.5s ≈ 7200 帧 ≈ 数十 GB。
    t = 0.0
    while t < duration:
        img = grabframe(cap, t)
        if img is not None:
            p = os.path.join(outdir, "frames", f"f_{t:06.2f}.jpg")
            save_frame(p, img)
        t += args.step

    # 每段中点关键帧
    keyframes = []
    for seg in framefiles:
        mid = (seg["t0"] + seg["t1"]) / 2
        img = grabframe(cap, mid)
        if img is None:
            continue
        name = safe_name(seg["index"], seg["t0"], seg["t1"])
        p = os.path.join(outdir, "keyframes", name + "_key.jpg")
        save_frame(p, img, 95)
        keyframes.append({"index": seg["index"], "t": round(mid, 3),
                          "file": os.path.relpath(p, outdir).replace("\\", "/")})
        seg["keyframe"] = keyframes[-1]["file"]
    cap.release()

    # 全程接触表（每 1s 一格，最多 64 格；超过则自动拉大间隔）
    step_sheet = max(1.0, duration / 64)
    picks = []
    cap_sheet = cv2.VideoCapture(video)
    t = 0.0
    while t < duration and len(picks) < 64:
        img = grabframe(cap_sheet, t)
        if img is not None:
            picks.append((f"{t:.1f}s", img))
        t += step_sheet
    cap_sheet.release()
    overview = make_sheet(picks, 8, 240, 20, f"{os.path.basename(video)} · {duration:.2f}s · {len(segs)} shots",
                          os.path.join(outdir, "sheets", "overview.jpg"))

    # 每段接触表：段内每 0.5s 一格（最多 12 格）
    for seg in framefiles:
        path = os.path.join(outdir, "clips", os.path.basename(seg["clip"]))
        c2 = cv2.VideoCapture(video)
        imgs = []
        t = seg["t0"]
        while t < seg["t1"] and len(imgs) < 12:
            img = grabframe(c2, t)
            if img is not None:
                imgs.append((f"{t:.1f}s", img))
            t += 0.5
        c2.release()
        name = safe_name(seg["index"], seg["t0"], seg["t1"])
        seg["sheet"] = make_sheet(imgs, 4, 320, 20, f"{name} · {seg['t1'] - seg['t0']:.2f}s",
                                  os.path.join(outdir, "sheets", name + ".jpg"))

    manifest = {
        "source": video,
        "source_md5": md5(video),
        "fps": fps,
        "frames": nframes,
        "width": w,
        "height": h,
        "duration": round(duration, 3),
        "frame_step": args.step,
        "clip_encoder": "ffmpeg/libx264" if ffmpeg else "opencv/mp4v",
        "cleared_previous_files": cleared,
        "cuts": cuts,
        "shots": len(segs),
        "segments": framefiles,
        "keyframes": keyframes,
        "frames_dir": "frames",
        "overview_sheet": os.path.relpath(overview, outdir).replace("\\", "/") if overview else None,
    }
    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps({"duration": manifest["duration"], "fps": fps, "frames": nframes,
                      "shots": len(segs), "cuts": cuts, "out": outdir,
                      "clip_encoder": manifest["clip_encoder"],
                      "cleared_previous_files": cleared}, ensure_ascii=False))


if __name__ == "__main__":
    main()
