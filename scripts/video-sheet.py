"""看素材：读编码信息，按时间间隔抽帧并拼成带时间戳的接触表。

用途是「让人/AI 先看懂素材」：HEVC（hvc1/hev1）、AV1（av01）、H.264 都走 OpenCV 解码，
不依赖浏览器能不能播，也不依赖 ffmpeg。识别链路仍然用 Demo（Chrome），素材能不能播
由 scripts/clip-recognition.mjs 的预检负责。

用法：
  .venv-ppe/Scripts/python.exe scripts/video-sheet.py <video> [outDir]
      [--start 0] [--end 0] [--step 2] [--cols 6] [--thumb 320] [--max 60]
      [--no-frames] [--json]

  --start/--end  只抽这一段（秒）；--end 省略或 0 = 到片尾
  --step         抽帧间隔（秒），默认 2
  --max          最多抽多少帧（默认 60，防止长片一次写出上千张）
  --no-frames    只写接触表，不单独保存每帧 jpg

输出（outDir 下，默认 eval-data/incoming/_inspect/<文件名>）：
  frames/f_<t>.jpg    抽到的帧（--no-frames 时不写）
  sheet.jpg           带时间戳的接触表
  manifest.json       编码/时长/帧率/尺寸/抽帧范围

抽帧成功后才清理 frames/ 里不属于本次的 f_*.jpg；--no-frames 完全不碰已有帧，
本次一帧都没抽到时会报错退出，不删除任何旧文件。

只读素材，不联网、不训练。
"""
import argparse
import glob
import json
import os
import sys

# Windows 下 Python 默认按 GBK 写 stdout，Git Bash/Windows Terminal 是 UTF-8，
# 中文会显示成乱码；统一改 UTF-8（不支持时退回原编码而不是崩掉）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import cv2
import numpy as np

CODEC_NAMES = {
    "avc1": "H.264/AVC", "avc3": "H.264/AVC", "hvc1": "HEVC/H.265", "hev1": "HEVC/H.265",
    "av01": "AV1", "vp09": "VP9", "vp08": "VP8", "mp4v": "MPEG-4 Part 2",
    "apch": "Apple ProRes 422 HQ", "apcn": "Apple ProRes 422", "ap4h": "Apple ProRes 4444",
}

VIDEO_BOXES = {b"moov": None, b"trak": None, b"mdia": None, b"minf": None, b"stbl": None, b"stsd": None}


def _boxes(buf, start, end):
    """遍历 MP4 box（只解析我们关心的层级）。"""
    i = start
    while i + 8 <= end:
        size = int.from_bytes(buf[i:i + 4], "big")
        typ = buf[i + 4:i + 8]
        hdr = 8
        if size == 1:
            if i + 16 > end:
                break
            size = int.from_bytes(buf[i + 8:i + 16], "big")
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            break
        yield typ, i + hdr, i + size
        i += size


def _walk_stsd(buf, start, end, out):
    for typ, body, bend in _boxes(buf, start, end):
        if typ == b"stsd":
            # version/flags(4) + entry_count(4) 之后是 sample entry
            p = body + 8
            if p + 8 > bend:
                continue
            count = int.from_bytes(buf[body + 4:body + 8], "big")
            for _ in range(min(count, 32)):
                if p + 8 > bend:
                    break
                esize = int.from_bytes(buf[p:p + 4], "big")
                etyp = buf[p + 4:p + 8].decode("latin1")
                out.append(etyp)
                if esize < 8:
                    break
                p += esize
        elif typ in VIDEO_BOXES:
            _walk_stsd(buf, body, bend, out)


def probe_codecs(path):
    """从 moov/stsd 里读视频编码 fourcc；解析失败时退回字节扫描。

    小于 256MB 的文件整块读；更大的只读头 8MB + 尾 32MB——moov 通常在文件头
    （faststart）或文件尾，两端足以覆盖，不会为读编码把几 GB 素材全塞进内存。
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size <= 256 * 1024 * 1024:
                data = f.read()
            else:
                head = f.read(8 * 1024 * 1024)
                f.seek(max(0, size - 32 * 1024 * 1024))
                data = head + f.read()
    except OSError:
        return []
    found = []
    for typ, body, bend in _boxes(data, 0, len(data)):
        if typ == b"moov":
            _walk_stsd(data, body, bend, found)
    # stsd 里音轨也会列 mp4a，这里只保留认识的视频编码
    video = [c for c in found if c in CODEC_NAMES]
    if not video:
        video = [c for c in CODEC_NAMES if c.encode() in data]
    seen = []
    for c in video:
        if c not in seen:
            seen.append(c)
    return seen


def make_sheet(picks, cols, thumb_w, pad, title, out):
    thumb_h = max(1, int(thumb_w * 9 / 16))
    rows = (len(picks) + cols - 1) // cols
    # 标题单独占一条，第一行的帧标签才不会压在标题上
    top = 26 if title else 0
    sheet = np.zeros((top + rows * (thumb_h + pad) + pad, cols * thumb_w, 3), np.uint8)
    for idx, (label, img) in enumerate(picks):
        r, c = divmod(idx, cols)
        y = top + r * (thumb_h + pad) + pad
        x = c * thumb_w
        sheet[y:y + thumb_h, x:x + thumb_w] = cv2.resize(img, (thumb_w, thumb_h))
        cv2.putText(sheet, label, (x + 4, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (0, 255, 255), 1, cv2.LINE_AA)
    if title:
        cv2.putText(sheet, title, (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                    (255, 255, 255), 1, cv2.LINE_AA)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    if not cv2.imwrite(out, sheet, [cv2.IMWRITE_JPEG_QUALITY, 88]):
        raise SystemExit(f"接触表写不出来：{out}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("outdir", nargs="?")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=0.0)
    ap.add_argument("--step", type=float, default=2.0)
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--thumb", type=int, default=320)
    ap.add_argument("--max", type=int, default=60)
    ap.add_argument("--no-frames", action="store_true")
    ap.add_argument("--json", action="store_true", help="只打印一行 JSON 摘要（脚本调用）")
    args = ap.parse_args()

    if not args.step > 0:
        raise SystemExit(f"--step 必须 > 0（收到 {args.step}）")
    if args.start < 0:
        raise SystemExit(f"--start 不能为负（收到 {args.start}）")
    if args.end and args.end <= args.start:
        raise SystemExit(f"--end 必须大于 --start（{args.start} → {args.end}）")
    if args.max <= 0:
        raise SystemExit(f"--max 必须 > 0（收到 {args.max}）")

    video = os.path.abspath(args.video)
    if not os.path.isfile(video):
        raise SystemExit(f"素材不存在：{video}")
    stem = os.path.splitext(os.path.basename(video))[0]
    outdir = os.path.abspath(args.outdir or os.path.join("eval-data", "incoming", "_inspect", stem))
    os.makedirs(os.path.join(outdir, "frames"), exist_ok=True)

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"OpenCV 打不开素材（编码不支持？）：{video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = nframes / fps if fps > 0 else 0.0
    cap.release()

    start = min(max(0.0, args.start), max(0.0, duration - 0.001))
    end = min(args.end if args.end > 0 else duration, duration)
    if end <= start:
        raise SystemExit(f"抽帧范围为空：{start} → {end}（素材时长 {duration:.2f}s）")

    codecs = probe_codecs(video)
    times = []
    t = start
    # 取区间内均匀分布的时间点：区间很长时自动拉大间隔，保证 <= max 张
    step = max(args.step, (end - start) / args.max)
    while t < end and len(times) < args.max:
        times.append(round(t, 3))
        t += step

    cap = cv2.VideoCapture(video)
    picks = []
    written_names = set()
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        label = f"{t:.1f}s"
        picks.append((label, frame))
        if not args.no_frames:
            name = f"f_{t:07.2f}.jpg"
            path = os.path.join(outdir, "frames", name)
            cv2.imwrite(path, frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
            written_names.add(name)
    cap.release()

    if not picks:
        raise SystemExit("一帧都没抽到（seek 全部失败？）")
    # 成功抽到帧之后再清理上一轮留下的帧：中途失败时旧帧仍然可用。
    # --no-frames 只写接触表，不碰 frames/。
    if not args.no_frames:
        for p in glob.glob(os.path.join(outdir, "frames", "f_*.jpg")):
            if os.path.basename(p) not in written_names:
                os.remove(p)
    codec_txt = ",".join(codecs) if codecs else "unknown"
    title = f"{os.path.basename(video)} · {codec_txt} · {duration:.1f}s · {width}x{height} · {start:.1f}-{end:.1f}s"
    sheet = make_sheet(picks, max(1, args.cols), args.thumb, 22, title,
                       os.path.join(outdir, "sheet.jpg"))

    manifest = {
        "source": video,
        "codec_fourcc": codecs,
        "codec": [CODEC_NAMES.get(c, c) for c in codecs],
        "fps": round(fps, 3),
        "frames_total": nframes,
        "duration_sec": round(duration, 3),
        "width": width,
        "height": height,
        "range": [start, end],
        "step_sec": round(step, 3),
        "frames_sampled": len(picks),
        "frames_written": len(written_names),
        "frames_dir": None if args.no_frames else "frames",
        "sheet": os.path.relpath(sheet, outdir).replace("\\", "/"),
    }
    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    if args.json:
        print(json.dumps(manifest, ensure_ascii=False))
    else:
        print(f"OK {os.path.basename(video)} · {codec_txt} · {duration:.1f}s · {width}x{height}")
        print(f"  抽帧 {len(picks)} 张（{start:.1f}–{end:.1f}s，步长 {step:.2f}s）→ {outdir}")
        print(f"  接触表 {manifest['sheet']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
