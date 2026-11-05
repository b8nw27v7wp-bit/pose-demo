"""把三份 YOLO 格式的 PPE 数据统一成 Model Maker 能读的 Pascal VOC 子集。

为什么需要：三份数据的类别名不一致（hardhat / helmet / helmet on；no_hardhat / no helmet），
而且 Safety-helmet 只有 class 0/1（已目测确认 0=裸头、1=戴帽）。直接拿去训练会得到
"helmet 和 helmet on 是两个类"这种错误。这里只做三件事：

1. 类别名统一到一张表（helmet / no_helmet / glove / no_glove / vest / no_vest / person / boots / no_boots）；
2. 按数据集自带的 split 划分 train/val（train 进训练，test/valid 进验证，避免泄漏）；
3. 输出 Pascal VOC XML + 复制图片到 eval-data/ppe-smoke/{train,val}/{images,annotations}。

只读源数据，输出到 eval-data/（已在 .gitignore）。

    py -I scripts/prepare-ppe-dataset.py
    py -I scripts/prepare-ppe-dataset.py --out eval-data/ppe-smoke --max-per-class 0
"""

import argparse
import json
import os
import shutil
import sys
import xml.etree.ElementTree as ET

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPEN = os.path.join(ROOT, "eval-data", "open")

# 统一类别（顺序即 label id）
CLASSES = [
    "helmet", "no_helmet", "glove", "no_glove", "vest", "no_vest",
    "person", "boots", "no_boots",
]
CLASS_ID = {c: i for i, c in enumerate(CLASSES)}

PPE_NAME_MAP = {
    "hardhat": "helmet", "no_hardhat": "no_helmet",
    "gloves": "glove", "no_gloves": "no_glove",
    "vest": "vest", "no_vest": "no_vest",
    "person": "person", "boots": "boots", "no_boots": "no_boots",
}
# data.yaml 里的 names 顺序（这些 Roboflow 导出的 label 是数字 class id）
PPE_CLASSES = ["boots", "gloves", "hardhat", "no_boots", "no_gloves",
               "no_hardhat", "no_vest", "person", "vest"]
PPE_MAP = dict(PPE_NAME_MAP)
PPE_MAP.update({str(i): PPE_NAME_MAP[n] for i, n in enumerate(PPE_CLASSES)})

CONSTRUCTION_NAME_MAP = {
    "helmet": "helmet", "helmet on": "helmet",
    "no helmet": "no_helmet",
    "vest": "vest", "no vest": "no_vest",
    "person": "person", "boots": "boots", "no boots": "no_boots",
}
CONSTRUCTION_CLASSES = ["boots", "helmet", "helmet on", "no boots",
                        "no helmet", "no vest", "person", "vest"]
CONSTRUCTION_MAP = dict(CONSTRUCTION_NAME_MAP)
CONSTRUCTION_MAP.update({str(i): CONSTRUCTION_NAME_MAP[n] for i, n in enumerate(CONSTRUCTION_CLASSES)})

HELMET_MAP = {"0": "no_helmet", "1": "helmet"}

# (本地根目录, 类别映射, train split, val splits, 文件名前缀)
DATASETS = [
    (os.path.join(OPEN, "PPE_detection"), PPE_MAP, "train", ["test"], "ppe"),
    (os.path.join(OPEN, "Safety-helmet-dataset", "Phat_project-3"), HELMET_MAP,
     "train", ["valid", "test"], "sh"),
    (os.path.join(OPEN, "roboflow-construction-ppe-fruwx", "data"), CONSTRUCTION_MAP,
     "train", ["valid", "test"], "con"),
]


def read_yolo(label_path, mapping):
    """YOLO → [{name, box(px)}]（尺寸稍后由图片决定）"""
    out = []
    if not os.path.isfile(label_path):
        return out
    with open(label_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 5:
                continue
            cls = parts[0]
            name = mapping.get(cls)
            if not name:
                continue
            try:
                cx, cy, bw, bh = map(float, parts[1:5])
            except ValueError:
                continue
            if bw <= 0 or bh <= 0:
                continue
            out.append({"name": name, "yolo": (cx, cy, bw, bh)})
    return out


def write_xml(path, filename, width, height, objects):
    ann = ET.Element("annotation")
    ET.SubElement(ann, "folder").text = "images"
    ET.SubElement(ann, "filename").text = filename
    size = ET.SubElement(ann, "size")
    ET.SubElement(size, "width").text = str(width)
    ET.SubElement(size, "height").text = str(height)
    ET.SubElement(size, "depth").text = "3"
    for o in objects:
        obj = ET.SubElement(ann, "object")
        ET.SubElement(obj, "name").text = o["name"]
        ET.SubElement(obj, "difficult").text = "0"
        box = ET.SubElement(obj, "bndbox")
        for tag, v in zip(("xmin", "ymin", "xmax", "ymax"), o["box"]):
            ET.SubElement(box, tag).text = str(v)
    ET.ElementTree(ann).write(path, encoding="utf-8", xml_declaration=True)


def write_yolo_label(path, width, height, boxes):
    lines = []
    for b in boxes:
        x1, y1, x2, y2 = b["box"]
        cx = (x1 + x2) / 2 / width
        cy = (y1 + y2) / 2 / height
        bw = (x2 - x1) / width
        bh = (y2 - y1) / height
        lines.append(f"{CLASS_ID[b['name']]} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def process_dataset(root, mapping, train_split, val_splits, prefix, out_root, yolo_root, stats):
    for split, out_split in [(train_split, "train")] + [(s, "val") for s in val_splits]:
        img_dir = os.path.join(root, split, "images")
        lbl_dir = os.path.join(root, split, "labels")
        if not os.path.isdir(img_dir):
            continue
        out_img = os.path.join(out_root, out_split, "images")
        out_ann = os.path.join(out_root, out_split, "annotations")
        y_img = os.path.join(yolo_root, "images", out_split)
        y_lbl = os.path.join(yolo_root, "labels", out_split)
        for d in (out_img, out_ann, y_img, y_lbl):
            os.makedirs(d, exist_ok=True)
        for f in sorted(os.listdir(img_dir)):
            if not f.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            stem = os.path.splitext(f)[0]
            objs = read_yolo(os.path.join(lbl_dir, stem + ".txt"), mapping)
            if not objs:
                continue
            src = os.path.join(img_dir, f)
            try:
                with Image.open(src) as im:
                    W, H = im.size
            except Exception as e:
                print(f"  [skip] 打不开 {src}: {e}")
                continue
            if W <= 0 or H <= 0:
                continue
            boxes = []
            for o in objs:
                cx, cy, bw, bh = o["yolo"]
                x1 = max(0, int(round((cx - bw / 2) * W)))
                y1 = max(0, int(round((cy - bh / 2) * H)))
                x2 = min(W, int(round((cx + bw / 2) * W)))
                y2 = min(H, int(round((cy + bh / 2) * H)))
                if x2 - x1 < 2 or y2 - y1 < 2:
                    continue
                boxes.append({"name": o["name"], "box": (x1, y1, x2, y2)})
            if not boxes:
                continue
            name = f"{prefix}_{stem}"
            ext = os.path.splitext(f)[1].lower()
            shutil.copy2(src, os.path.join(out_img, name + ext))
            shutil.copy2(src, os.path.join(y_img, name + ext))
            write_xml(os.path.join(out_ann, name + ".xml"), name + ext, W, H, boxes)
            write_yolo_label(os.path.join(y_lbl, name + ".txt"), W, H, boxes)
            stats[out_split]["images"] += 1
            for b in boxes:
                stats[out_split]["boxes"][b["name"]] = stats[out_split]["boxes"].get(b["name"], 0) + 1


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="统一 PPE 数据 → Pascal VOC / YOLO（训练用）")
    ap.add_argument("--out", default=os.path.join(ROOT, "eval-data", "ppe-smoke"))
    ap.add_argument("--yolo-out", default=os.path.join(ROOT, "eval-data", "ppe-yolo"),
                    help="同时输出 Ultralytics YOLO 格式；传空字符串则不输出")
    args = ap.parse_args()
    out_root = os.path.abspath(args.out)
    yolo_root = os.path.abspath(args.yolo_out) if args.yolo_out else None
    for d in (out_root, yolo_root):
        if d and os.path.isdir(d):
            shutil.rmtree(d)   # 每次重建，避免上次残留的图片混进来
    stats = {s: {"images": 0, "boxes": {}} for s in ("train", "val")}

    for root, mapping, train_split, val_splits, prefix in DATASETS:
        if not os.path.isdir(root):
            print(f"[skip] 目录不存在：{root}")
            continue
        print(f"[{prefix}] {os.path.relpath(root, ROOT)}")
        process_dataset(root, mapping, train_split, val_splits, prefix, out_root, yolo_root, stats)

    label_map = {name: i for i, name in enumerate(CLASSES)}
    with open(os.path.join(out_root, "label_map.json"), "w", encoding="utf-8") as f:
        json.dump(label_map, f, ensure_ascii=False, indent=2)
    if yolo_root:
        with open(os.path.join(yolo_root, "data.yaml"), "w", encoding="utf-8") as f:
            f.write("path: " + yolo_root.replace("\\", "/") + "\n")
            f.write("train: images/train\nval: images/val\n")
            f.write("names:\n")
            for i, name in enumerate(CLASSES):
                f.write(f"  {i}: {name}\n")
        with open(os.path.join(yolo_root, "labels.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(CLASSES) + "\n")

    print(f"\n输出：{out_root}")
    for split in ("train", "val"):
        s = stats[split]
        print(f"  {split}: {s['images']} 图 / {sum(s['boxes'].values())} 框")
        print("    " + ", ".join(f"{k} {v}" for k, v in sorted(s["boxes"].items())))
    print("\n类别表：", label_map)
    return 0


if __name__ == "__main__":
    sys.exit(main())
