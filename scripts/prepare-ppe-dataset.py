"""把多份 YOLO 格式的 PPE 数据统一成 Pascal VOC + YOLO（训练用）。

为什么需要：不同来源的类别名/类别 id 不一致（hardhat / helmet / helmet on；
no_hardhat / no helmet / 0 / 1）。直接拿去训练会得到「helmet 和 helmet on 是两个类」
这种错误；更危险的是 Safety-helmet 只有 0/1，目测猜反会让 helmet 与 no_helmet 整体翻转。

R11-1 起，映射**只从显式台账** `eval-data/open/sources.json` 读，代码里不再有
HELMET_MAP 之类的硬编码。缺映射时：
  - 默认：跳过该 class id 并在报告里列出（数据会变少，但不会悄悄训错）；
  - `--strict`：直接退出非 0，什么都不写。

    py -I scripts/prepare-ppe-dataset.py --init-sources      # 生成骨架（映射留空）
    py -I scripts/prepare-ppe-dataset.py --strict            # 校验台账并重建
    py -I scripts/prepare-ppe-dataset.py --out eval-data/ppe-smoke --yolo-out eval-data/ppe-yolo

只读源数据，输出到 eval-data/（已在 .gitignore）。不下载、不训练。
输出目录每次重建，但只清空「本脚本的产物」：目录里出现白名单之外的条目（例如
`--out eval-data` 里的源数据）会拒绝删除并退出，避免误删无法恢复的素材。
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPEN = os.path.join(ROOT, "eval-data", "open")
DEFAULT_SOURCES = os.path.join(OPEN, "sources.json")

# 统一类别（顺序即 label id）
CLASSES = [
    "helmet", "no_helmet", "glove", "no_glove", "vest", "no_vest",
    "person", "boots", "no_boots",
]
CLASS_ID = {c: i for i, c in enumerate(CLASSES)}

# 只在 --init-sources 生成骨架时使用：把 data.yaml 里的**名字**映射到统一类别。
# 训练时的映射一律以 sources.json 为准；数值 id 的语义必须回源确认，不能靠这张表猜。
NAME_SYNONYMS = {
    "helmet": "helmet", "hardhat": "helmet", "hard hat": "helmet", "helmet on": "helmet",
    "no helmet": "no_helmet", "no hardhat": "no_helmet", "no hard hat": "no_helmet",
    "glove": "glove", "gloves": "glove", "no glove": "no_glove", "no gloves": "no_glove",
    "vest": "vest", "no vest": "no_vest",
    "person": "person", "boots": "boots", "no boots": "no_boots",
} | {name: name for name in [
    "helmet", "no_helmet", "glove", "no_glove", "vest", "no_vest",
    "person", "boots", "no_boots",
]}

# 已知的本地目录布局：只用于 --init-sources 生成骨架。
SOURCE_DEFS = [
    {
        "id": "ppe-detection",
        "root": os.path.join(OPEN, "PPE_detection"),
        "prefix": "ppe",
        "trainSplit": "train",
        "valSplits": ["test"],
    },
    {
        "id": "safety-helmet",
        "root": os.path.join(OPEN, "Safety-helmet-dataset", "Phat_project-3"),
        "prefix": "sh",
        "trainSplit": "train",
        "valSplits": ["valid", "test"],
    },
    {
        "id": "construction-ppe",
        "root": os.path.join(OPEN, "roboflow-construction-ppe-fruwx", "data"),
        "prefix": "con",
        "trainSplit": "train",
        "valSplits": ["valid", "test"],
    },
]


def parse_names_from_yaml(path):
    """从 data.yaml 读 names，不依赖 PyYAML（与 ppe-dataset-report.py 口径一致）。"""
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return None
    for i, line in enumerate(lines):
        m = re.match(r"^\s*names\s*:\s*(.*)$", line)
        if not m:
            continue
        # 去掉行尾注释：`names:  # 9 类` 不能把下面的缩进列表当成缺省。
        rest = re.sub(r"(^|\s+)#.*$", "", m.group(1).strip()).strip()
        if rest.startswith("[") and rest.endswith("]"):
            names = [x.strip().strip("'\"") for x in rest[1:-1].split(",") if x.strip()]
            return names or None
        if rest.startswith("{") and rest.endswith("}"):
            names = [x.strip().strip("'\"") for x in re.findall(r":\s*([^,}]+)", rest)]
            return names or None
        if rest:
            return None
        names = []
        for nxt in lines[i + 1:]:
            mm = re.match(r"^\s*(?:-\s*|\d+\s*:\s*)(.+?)\s*$", nxt)
            if mm:
                names.append(mm.group(1).strip("'\""))
            elif nxt.strip() and not nxt.startswith((" ", "\t")):
                break
        return names or None
    return None


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    try:
        return os.path.relpath(path, ROOT).replace("\\", "/")
    except ValueError:
        return path


def build_source_skeleton(meta):
    root = meta["root"]
    yaml_path = os.path.join(root, "data.yaml")
    names = parse_names_from_yaml(yaml_path) if os.path.isfile(yaml_path) else None
    entry = {
        "id": meta["id"],
        "root": rel(root),
        "prefix": meta["prefix"],
        "trainSplit": meta["trainSplit"],
        "valSplits": list(meta["valSplits"]),
        "classes": names or [],
        "mapping": {},
    }
    if os.path.isfile(yaml_path):
        entry["dataYaml"] = rel(yaml_path)
        entry["dataYamlSha256"] = file_sha256(yaml_path)
    if names:
        for i, name in enumerate(names):
            norm = name.strip().lower().replace("_", " ")
            entry["mapping"][str(i)] = NAME_SYNONYMS.get(norm, "")
        if any(not v for v in entry["mapping"].values()):
            entry["_comment"] = (
                "有类别名无法自动映射：把 mapping 里空字符串改成统一类别（"
                + "/".join(CLASSES) + "），或确认该类别不需要。"
            )
    else:
        # 没有 data.yaml（或读不到 names）：class id 的语义只能回源确认。
        entry["mapping"] = {"0": "", "1": ""}
        entry["_comment"] = (
            f"{meta['id']} 没有 data.yaml（或读不到 names）：class id 0/1 的语义必须回源确认，"
            "禁止目测。确认后把值改成真实统一类别。"
        )
    return entry


def init_sources(path, force=False):
    if os.path.exists(path) and not force:
        print(f"已存在：{path}\n要重新生成骨架请加 --force（会覆盖人工确认过的映射）。")
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    doc = {
        "version": 1,
        "_comment": (
            "显式类别映射台账。mapping 的键是 label 文件里的 class id（字符串），"
            "值是统一类别：" + "/".join(CLASSES) + "。"
            "空字符串 = 未确认；默认运行会跳过并报告，--strict 会直接失败。"
            "数值 id 的语义必须回源确认，禁止目测。"
        ),
        "sources": [build_source_skeleton(m) for m in SOURCE_DEFS],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"已生成骨架：{path}")
    for s in doc["sources"]:
        empty = [k for k, v in s.get("mapping", {}).items() if not v]
        state = "缺映射 id=" + ",".join(empty) if empty else "映射完整"
        print(f"  {s['id']}: {state}")
    print("下一步：逐条回源确认 mapping（尤其 Safety-helmet 的 0/1），再跑 --strict。")
    return 0


def load_sources(path):
    if not os.path.isfile(path):
        raise SystemExit(
            f"缺少显式映射台账：{path}\n"
            f"先跑 py -I scripts/prepare-ppe-dataset.py --init-sources 生成骨架，"
            "回源确认 mapping 后再运行。"
        )
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    srcs = doc.get("sources")
    if not isinstance(srcs, list) or not srcs:
        raise SystemExit(f"{path} 里没有 sources[]")
    for i, s in enumerate(srcs):
        if not isinstance(s.get("mapping"), dict) or not s["mapping"]:
            raise SystemExit(f"{path} 的 sources[{i}] 缺少 mapping")
        s["_root"] = os.path.abspath(s["root"] if os.path.isabs(s["root"]) else os.path.join(ROOT, s["root"]))
        s.setdefault("trainSplit", "train")
        s.setdefault("valSplits", ["valid", "test"])
        s.setdefault("prefix", f"s{i}")
        # prefix 会拼进输出文件名；带路径分隔符/.. 时能写到输出目录之外。
        prefix = str(s["prefix"])
        if not re.match(r"^[A-Za-z0-9_-]+$", prefix):
            raise SystemExit(
                f"{path} 的 sources[{i}].prefix 非法：{prefix!r}（只允许字母/数字/_/-，"
                "它会拼进输出文件名）"
            )
        s["prefix"] = prefix
    return srcs


def used_class_ids(root, splits):
    """扫描 label 文件，收集实际出现的 class id（用于 strict 检查漏映射）。"""
    used = {}
    for split in splits:
        lbl_dir = os.path.join(root, split, "labels")
        if not os.path.isdir(lbl_dir):
            continue
        for f in os.listdir(lbl_dir):
            if not f.endswith(".txt"):
                continue
            try:
                lines = open(os.path.join(lbl_dir, f), encoding="utf-8", errors="replace")
            except OSError:
                continue
            with lines:
                for line in lines:
                    parts = line.split()
                    if parts:
                        used[parts[0]] = used.get(parts[0], 0) + 1
    return used


def validate_sources(srcs, strict):
    """返回 (可处理源, 错误列表)。strict 下错误非空即退出，且不写任何输出。"""
    errors = []
    warnings = []
    usable = []
    for s in srcs:
        sid = s.get("id", s.get("prefix"))
        root = s["_root"]
        splits = [s["trainSplit"]] + list(s["valSplits"])
        if not os.path.isdir(root):
            msg = f"{sid}: 目录不存在 {root}"
            (errors if strict else warnings).append(msg)
            if strict:
                continue
        bad = sorted([k for k, v in s["mapping"].items() if not str(v).strip()])
        invalid = sorted({v for v in s["mapping"].values() if v and v not in CLASS_ID})
        if bad:
            msg = f"{sid}: 缺映射 class id {bad}（回源确认后填入 mapping）"
            (errors if strict else warnings).append(msg)
        if invalid:
            errors.append(f"{sid}: mapping 里有未知统一类别 {invalid}（允许：{CLASSES}）")
        used = used_class_ids(root, splits) if os.path.isdir(root) else {}
        unmapped = sorted(set(used) - set(s["mapping"]))
        if unmapped:
            n = sum(used[k] for k in unmapped)
            msg = f"{sid}: label 里出现未声明的 class id {unmapped}（{n} 个框会被跳过）"
            (errors if strict else warnings).append(msg)
        if strict and (bad or unmapped):
            continue
        usable.append(s)
    for w in warnings:
        print(f"[warn] {w}")
    return usable, errors


def read_yolo(label_path, mapping, skipped=None):
    """YOLO → [{name, box(px)}]；未映射的 class id 计入 skipped，不猜。"""
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
                if skipped is not None:
                    skipped[cls] = skipped.get(cls, 0) + 1
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
        dirs = [out_img, out_ann]
        y_img = y_lbl = None
        if yolo_root:
            # --yolo-out "" 表示只要 VOC；没有这个 guard，os.path.join(None, ...) 直接 TypeError
            y_img = os.path.join(yolo_root, "images", out_split)
            y_lbl = os.path.join(yolo_root, "labels", out_split)
            dirs += [y_img, y_lbl]
        for d in dirs:
            os.makedirs(d, exist_ok=True)
        for f in sorted(os.listdir(img_dir)):
            if not f.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            stem = os.path.splitext(f)[0]
            objs = read_yolo(os.path.join(lbl_dir, stem + ".txt"), mapping,
                             stats[out_split]["unmapped"])
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
            write_xml(os.path.join(out_ann, name + ".xml"), name + ext, W, H, boxes)
            if yolo_root:
                shutil.copy2(src, os.path.join(y_img, name + ext))
                write_yolo_label(os.path.join(y_lbl, name + ".txt"), W, H, boxes)
            stats[out_split]["images"] += 1
            for b in boxes:
                stats[out_split]["boxes"][b["name"]] = stats[out_split]["boxes"].get(b["name"], 0) + 1


# 自动重建只删「本脚本的产物」。--out 指到 eval-data 或仓库根时，无脑 rmtree 会把源数据
# 一起删掉（不可恢复），所以先看目录内容：出现白名单之外的条目就拒绝，让人手动处理。
VOC_ENTRIES = {"train", "val", "label_map.json"}
YOLO_ENTRIES = {"images", "labels", "data.yaml", "labels.txt"}


def prepare_out_dir(path, allowed, flag):
    if not os.path.isdir(path):
        return
    entries = set(os.listdir(path))
    if entries and not entries <= allowed:
        extra = ", ".join(sorted(entries - allowed))
        raise SystemExit(
            f"拒绝清空 {flag}={path}：目录里不是本脚本的产物（多出：{extra}）。\n"
            "换一个输出目录，或确认后手动删掉再重跑。"
        )
    shutil.rmtree(path)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="统一 PPE 数据 → Pascal VOC / YOLO（映射来自 sources.json）")
    ap.add_argument("--out", default=os.path.join(ROOT, "eval-data", "ppe-smoke"))
    ap.add_argument("--yolo-out", default=os.path.join(ROOT, "eval-data", "ppe-yolo"),
                    help="同时输出 Ultralytics YOLO 格式；传空字符串则不输出")
    ap.add_argument("--sources", default=DEFAULT_SOURCES,
                    help="显式类别映射台账（默认 eval-data/open/sources.json）")
    ap.add_argument("--strict", action="store_true",
                    help="缺目录/缺映射/未声明 class id 直接退出非 0，不写任何输出")
    ap.add_argument("--init-sources", action="store_true",
                    help="生成 sources.json 骨架（映射留空），不处理数据")
    ap.add_argument("--force", action="store_true", help="配合 --init-sources 覆盖已有台账")
    args = ap.parse_args()

    if args.init_sources:
        return init_sources(os.path.abspath(args.sources), args.force)

    srcs = load_sources(os.path.abspath(args.sources))
    usable, errors = validate_sources(srcs, args.strict)
    if errors:
        print("\n无法继续：", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("\n修好 sources.json 后重跑；不加 --strict 时未知映射会被跳过（数据变少）。",
              file=sys.stderr)
        return 1

    out_root = os.path.abspath(args.out)
    yolo_root = os.path.abspath(args.yolo_out) if args.yolo_out else None
    if yolo_root and os.path.normcase(yolo_root) == os.path.normcase(out_root):
        raise SystemExit("--out 与 --yolo-out 不能是同一个目录（VOC 与 YOLO 产物会混在一起）")
    # 每次重建，避免上次残留的图片混进来。但只删「本脚本的产物」：--out 指到
    # eval-data 或仓库根时，无脑 rmtree 会把源数据一起删掉（不可恢复）。
    prepare_out_dir(out_root, VOC_ENTRIES, "--out")
    if yolo_root:
        prepare_out_dir(yolo_root, YOLO_ENTRIES, "--yolo-out")
    stats = {s: {"images": 0, "boxes": {}, "unmapped": {}} for s in ("train", "val")}

    for s in usable:
        print(f"[{s.get('id', s['prefix'])}] {rel(s['_root'])}")
        process_dataset(s["_root"], s["mapping"], s["trainSplit"], s["valSplits"],
                        s["prefix"], out_root, yolo_root, stats)

    produced = sum(stats[s]["images"] for s in ("train", "val"))
    if not produced:
        print("[warn] 没有产出任何图片：检查 sources.json 的 root/split 是否存在、"
              "mapping 是否全部为空、label 文件是否为空。")

    # 没有任何图片时 out_root 可能还没被创建（process_dataset 只在有 split 时建目录）。
    os.makedirs(out_root, exist_ok=True)
    if yolo_root:
        os.makedirs(yolo_root, exist_ok=True)
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
        if s["unmapped"]:
            print("    未映射（已跳过）：" + ", ".join(
                f"id {k} × {v}" for k, v in sorted(s["unmapped"].items())))
    print("\n类别表：", label_map)
    return 0


if __name__ == "__main__":
    sys.exit(main())
