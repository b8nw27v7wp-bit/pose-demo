"""盘点本地 YOLO 格式数据：图片/标注是否配齐、每类有多少框、类别名从哪来。

为什么单独一个脚本：训练前最容易犯的错不是调参，而是拿一份"看起来有标注"的数据
直接开训——实际缺 label、类别名没下下来、只有 train 没有 val。这个脚本只读，
先把这些问题暴露出来，再决定能不能训、能训哪几类。

    python -I scripts/ppe-dataset-report.py
    python -I scripts/ppe-dataset-report.py --root eval-data/open --json

只读：不写、不改、不下载。类别名只从 data.yaml 读；读不到就明确说"未知"，不猜。
"""

import argparse
import json
import os
import re
import sys
from collections import Counter

IMG_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def parse_names(path):
    """从 data.yaml 里尽量读 names。不依赖 PyYAML：只认 names 的三种常见写法。"""
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return None
    names = []
    for i, line in enumerate(lines):
        m = re.match(r"^\s*names\s*:\s*(.*)$", line)
        if not m:
            continue
        rest = m.group(1).strip()
        if rest.startswith("[") and rest.endswith("]"):
            names = [x.strip().strip("'\"") for x in rest[1:-1].split(",") if x.strip()]
            return names or None
        if rest:
            # names: {0: helmet, 1: head}
            names = [x.strip().strip("'\"") for x in re.findall(r":\s*([^,}]+)", rest)]
            return names or None
        # 换行列表：后面缩进的 "- xxx"
        for nxt in lines[i + 1:]:
            mm = re.match(r"^\s*-\s*(.+?)\s*$", nxt)
            if mm:
                names.append(mm.group(1).strip("'\""))
            elif nxt.strip() and not nxt.startswith((" ", "\t")):
                break
        return names or None
    return None


def count_split(img_dir, lbl_dir, names):
    images = []
    if os.path.isdir(img_dir):
        images = [f for f in os.listdir(img_dir) if f.lower().endswith(IMG_EXT)]
    label_files = []
    if os.path.isdir(lbl_dir):
        label_files = [f for f in os.listdir(lbl_dir) if f.lower().endswith(".txt")]
    stems = {os.path.splitext(f)[0] for f in images}
    label_stems = {os.path.splitext(f)[0] for f in label_files}
    missing = sorted(stems - label_stems)
    boxes = Counter()
    empty = 0
    bad_lines = 0
    for f in label_files:
        p = os.path.join(lbl_dir, f)
        try:
            lines = [ln.strip() for ln in open(p, encoding="utf-8", errors="replace") if ln.strip()]
        except OSError:
            continue
        if not lines:
            empty += 1
        for ln in lines:
            parts = ln.split()
            try:
                cls = int(float(parts[0]))
            except (ValueError, IndexError):
                bad_lines += 1
                continue
            boxes[cls] += 1
    return {
        "images": len(images),
        "labels": len(label_files),
        "missingLabels": len(missing),
        "missingSample": missing[:5],
        "emptyLabels": empty,
        "boxes": dict(sorted(boxes.items())),
        "totalBoxes": sum(boxes.values()),
        "badLines": bad_lines,
    }


def describe(name, root, splits, yaml_path):
    out = {"name": name, "root": root, "dataYaml": yaml_path, "classes": None, "splits": {}, "warnings": []}
    names = parse_names(yaml_path) if yaml_path else None
    out["classes"] = names
    for split in splits:
        img_dir = os.path.join(root, split, "images")
        lbl_dir = os.path.join(root, split, "labels")
        if not os.path.isdir(img_dir) and not os.path.isdir(lbl_dir):
            continue
        s = count_split(img_dir, lbl_dir, names)
        out["splits"][split] = s
        if s["missingLabels"]:
            out["warnings"].append(f"{split}: {s['missingLabels']} 张图没有 label")
        if s["badLines"]:
            out["warnings"].append(f"{split}: {s['badLines']} 行 label 解析失败")
        if names:
            unknown = [c for c in s["boxes"] if c >= len(names) or c < 0]
            if unknown:
                out["warnings"].append(f"{split}: class id {unknown} 超出 names 范围（{len(names)} 类）")

    if not any(s["images"] for s in out["splits"].values()):
        out["warnings"].append("没有找到图片")
    if not names:
        out["warnings"].append("没有 data.yaml / 读不到 names：类别名未知，训练前必须回源确认，不能猜")
    total = sum(s["images"] for s in out["splits"].values())
    if total and total < 300:
        out["warnings"].append(f"总图片只有 {total} 张：只能做冒烟/微调，不能据此承诺准确率")
    if "train" in out["splits"] and "valid" not in out["splits"] and "test" not in out["splits"]:
        out["warnings"].append("只有 train：训练时必须自己切验证集，否则 loss 曲线没有意义")
    return out


def find_yaml(root):
    for base in (root, os.path.join(root, "data")):
        for f in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            if f in ("data.yaml", "dataset.yaml"):
                return os.path.join(base, f)
    return None


def main():
    # Windows 控制台默认 GBK，中文和 ⚠ 会直接抛 UnicodeEncodeError。输出统一走 UTF-8。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="盘点本地 YOLO 数据集（只读）")
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "eval-data", "open"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    specs = [
        ("PPE_detection", os.path.join(args.root, "PPE_detection"), ["train", "valid", "test"]),
        ("Safety-helmet", os.path.join(args.root, "Safety-helmet-dataset", "Phat_project-3"),
         ["train", "valid", "test"]),
        ("construction-ppe", os.path.join(args.root, "roboflow-construction-ppe-fruwx", "data"),
         ["train", "valid", "test"]),
    ]
    reports = []
    for name, root, splits in specs:
        if not os.path.isdir(root):
            reports.append({"name": name, "root": root, "missing": True, "warnings": ["目录不存在，先跑 scripts/fetch-eval-data.py"]})
            continue
        reports.append(describe(name, root, splits, find_yaml(root)))

    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
        return 0

    for r in reports:
        print(f"\n== {r['name']}")
        if r.get("missing"):
            print(f"   {r['warnings'][0]}")
            continue
        names = r["classes"]
        print(f"   目录：{r['root']}")
        print(f"   类别：{len(names)} 类 {names}" if names else "   类别：未知（没有 data.yaml 或没有 names）")
        for split, s in r["splits"].items():
            print(f"   {split}: 图 {s['images']} / label {s['labels']} / 框 {s['totalBoxes']}"
                  + (f" / 缺 label {s['missingLabels']}" if s["missingLabels"] else ""))
            if names:
                parts = []
                for c, n in s["boxes"].items():
                    label = names[c] if 0 <= c < len(names) else f"#{c}?"
                    parts.append(f"{label} {n}")
                print("      " + ", ".join(parts))
            else:
                print("      class id 计数：" + ", ".join(f"{c}:{n}" for c, n in s["boxes"].items()))
        if r["warnings"]:
            print("   注意：" + "；".join(r["warnings"]))
    print("\n注：这里只回答「数据配没配齐、类别名有没有」。样本量小的类即使训出来也不能单独报准确率。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
