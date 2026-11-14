"""Runner de experimentos de configuracion YOLOX-Nano (A: NMS, B: umbral, C: resize).
Uso: python -I run_exp.py <dataset.json> <dir_imagenes> <modelo.onnx> <scratch> <salida.json> [<dir_canvas_rgba>]
Preproceso estilo oficial: BGR, letterbox arriba-izquierda, relleno 114, 416x416, float32 0-255.
Resize 'cv2_linear' = bilinear 2x2 sin antialias (semantica cv2.INTER_LINEAR, emulada en numpy; cv2 NO instalado).
Resize 'pil_bilinear' = PIL BILINEAR (con antialias al reducir).
Resize 'canvas' = lienzo 416x416 compuesto por el navegador (drawImage, smoothing high), volcado en RGBA."""
import sys, os, json
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from decode_variants import decode, TAMANO

T = TAMANO


def resize_cv2_linear(rgb, rw, rh):
    h, w = rgb.shape[:2]
    sx, sy = w / rw, h / rh
    xs = np.clip((np.arange(rw) + 0.5) * sx - 0.5, 0, w - 1)
    ys = np.clip((np.arange(rh) + 0.5) * sy - 0.5, 0, h - 1)
    x0 = np.floor(xs).astype(int); x1 = np.minimum(x0 + 1, w - 1); fx = (xs - x0)[None, :, None]
    y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, h - 1); fy = (ys - y0)[:, None, None]
    a = rgb.astype(np.float32)
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return np.clip(np.rint(top * (1 - fy) + bot * fy), 0, 255).astype(np.uint8)


def resize_pil_bilinear(rgb, rw, rh):
    return np.asarray(Image.fromarray(rgb).resize((rw, rh), Image.BILINEAR))


def letterbox(rgb, method, canvas_rgba=None):
    h, w = rgb.shape[:2]
    r = min(T / h, T / w)
    rw, rh = int(w * r), int(h * r)
    pad = np.full((T, T, 3), 114, np.uint8)
    if method == "canvas":
        pad = canvas_rgba[:, :, :3].copy()
    elif method == "cv2_linear":
        pad[:rh, :rw] = resize_cv2_linear(rgb, rw, rh)
    elif method == "pil_bilinear":
        pad[:rh, :rw] = resize_pil_bilinear(rgb, rw, rh)
    bgr = pad[:, :, ::-1]
    return np.ascontiguousarray(bgr.transpose(2, 0, 1), np.float32)[None], r


def infer(sess, rgb, method, canvas=None):
    x, r = letterbox(rgb, method, canvas)
    raw = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    return raw, r


def iou_xywh(a, b):
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    w = max(0, min(ax2, bx2) - max(a[0], b[0]))
    h = max(0, min(ay2, by2) - max(a[1], b[1]))
    i = w * h
    u = a[2] * a[3] + b[2] * b[3] - i
    return i / u if u > 0 else 0


def match_person(dets, gts):
    """dets person ordenadas por score; emparejado voraz IoU>=0.5. Devuelve (tp, fp, fn, flags_gt)."""
    used = [False] * len(gts)
    tp = fp = 0
    for _, s, box in dets:
        best, bj = 0.0, -1
        for j, g in enumerate(gts):
            if used[j]:
                continue
            v = iou_xywh(box, g)
            if v >= 0.5 and v > best:
                best, bj = v, j
        if bj >= 0:
            used[bj] = True
            tp += 1
        else:
            fp += 1
    return tp, fp, len(gts) - tp, used


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else float("nan")
    r = tp / (tp + fn) if tp + fn else float("nan")
    f = 2 * p * r / (p + r) if tp and (p + r) > 0 else 0.0
    return p, r, f


def eval_set(raws, meta, thr, mode):
    TP = FP = FN = 0
    per_img = {}
    for im in meta:
        raw, r = raws[im["id"]]
        dets = decode(raw, r, im["width"], im["height"], thr, mode)
        pd = [d for d in dets if d[0] == 0]
        tp, fp, fn, used = match_person(pd, im["personas_bbox_xywh"])
        TP += tp; FP += fp; FN += fn
        per_img[im["id"]] = (dets, used)
    p, r_, f = prf(TP, FP, FN)
    return dict(thr=thr, TP=TP, FP=FP, FN=FN, precision=p, recall=r_, f1=f), per_img


def cross_class_dups(per_img):
    """Pares de detecciones con etiquetas distintas e IoU>=0.5, y detecciones redundantes (menor score de cada par)."""
    pairs = pairs_person = redundant = 0
    for dets, _ in per_img.values():
        red = set()
        for i in range(len(dets)):
            for j in range(i + 1, len(dets)):
                if dets[i][0] != dets[j][0] and iou_xywh(dets[i][2], dets[j][2]) >= 0.5:
                    pairs += 1
                    if 0 in (dets[i][0], dets[j][0]):
                        pairs_person += 1
                    red.add(j)
        redundant += len(red)
    return dict(pares=pairs, pares_con_person=pairs_person, detecciones_redundantes=redundant)


def small_recall(meta, per):
    n = tot = 0
    for im in meta:
        used = per[im["id"]][1]
        for g, u in zip(im["personas_bbox_xywh"], used):
            if g[2] * g[3] < 0.01 * im["width"] * im["height"]:
                tot += 1
                n += int(u)
    return n, tot


def main():
    ds_path, img_dir, model, scratch, out = sys.argv[1:6]
    canvas_dir = sys.argv[6] if len(sys.argv) > 6 else None
    import onnxruntime as ort
    meta = json.load(open(ds_path, encoding="utf-8"))["imagenes"]
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    imgs = {im["id"]: np.asarray(Image.open(os.path.join(img_dir, im["file_name"])).convert("RGB")) for im in meta}
    res = {"n_imagenes": len(meta), "n_personas_gt": sum(len(m["personas_bbox_xywh"]) for m in meta)}
    os.makedirs(scratch, exist_ok=True)

    raws = {}
    for im in meta:
        raw, r = infer(sess, imgs[im["id"]], "cv2_linear")
        np.save(os.path.join(scratch, f"raw_{im['id']}.npy"), raw)
        raws[im["id"]] = (raw, r)

    # Experimento A
    modes = ["per_class", "agnostic", "person_only"]
    A = {}
    for m in modes:
        e, per = eval_set(raws, meta, 0.5, m)
        e["cross_class"] = cross_class_dups(per)
        e["n_detecciones_total"] = sum(len(d) for d, _ in per.values())
        A[m] = e
    for m in modes:
        A[m]["duplicados_eliminados_vs_per_class"] = A["per_class"]["cross_class"]["pares"] - A[m]["cross_class"]["pares"]
    res["A"] = A

    # Experimento B
    thrs = [round(0.1 * k, 1) for k in range(1, 10)]
    res["B"] = {m: [eval_set(raws, meta, t, m)[0] for t in thrs] for m in ["per_class", "agnostic"]}
    res["B_ref_0.55"] = {m: eval_set(raws, meta, 0.55, m)[0] for m in ["per_class", "agnostic"]}

    # Experimento C
    methods = ["cv2_linear", "pil_bilinear"] + (["canvas"] if canvas_dir else [])
    raws_m = {"cv2_linear": raws}
    for mth in methods[1:]:
        d = {}
        for im in meta:
            cv = None
            if mth == "canvas":
                cv = np.fromfile(os.path.join(canvas_dir, f"{im['id']}.rgba"), np.uint8).reshape(T, T, 4)
            d[im["id"]] = infer(sess, imgs[im["id"]], mth, cv)
        raws_m[mth] = d
    C = {"thr": 0.5, "nms": "per_class", "comparaciones": {}}
    evs = {mth: eval_set(raws_m[mth], meta, 0.5, "per_class") for mth in methods}
    for mth in methods:
        e, per = evs[mth]
        e = dict(e)
        e["small_recall_tp_total"] = small_recall(meta, per)
        e["n_dets_total"] = sum(len(d) for d, _ in per.values())
        C[mth] = e
    perR = evs["cv2_linear"][1]
    for mth in methods[1:]:
        perM = evs[mth][1]
        bd, sd, appear, disappear = [], [], 0, 0
        for im in meta:
            a = perR[im["id"]][0]
            b = perM[im["id"]][0]
            ub = set()
            for da in a:
                bj, bv = -1, 0.5
                for j, db in enumerate(b):
                    if j in ub or db[0] != da[0]:
                        continue
                    v = iou_xywh(da[2], db[2])
                    if v >= bv:
                        bv, bj = v, j
                if bj < 0:
                    disappear += 1
                else:
                    ub.add(bj)
                    db = b[bj]
                    ca = np.array([da[2][0], da[2][1], da[2][0] + da[2][2], da[2][1] + da[2][3]])
                    cb = np.array([db[2][0], db[2][1], db[2][0] + db[2][2], db[2][1] + db[2][3]])
                    bd.extend(np.abs(ca - cb).tolist())
                    sd.append(abs(da[1] - db[1]))
            appear += len(b) - len(ub)
        dr = [np.abs(raws_m["cv2_linear"][i][0] - raws_m[mth][i][0]).mean() for i in raws]
        C["comparaciones"][f"cv2_linear_vs_{mth}"] = dict(
            pares_emparejados=len(sd), coord_abs_media_px=float(np.mean(bd)), coord_abs_max_px=float(np.max(bd)),
            score_abs_media=float(np.mean(sd)), score_abs_max=float(np.max(sd)),
            detecciones_que_aparecen=appear, detecciones_que_desaparecen=disappear,
            raw_abs_media=float(np.mean(dr)))
    res["C"] = C
    json.dump(res, open(out, "w", encoding="utf-8"), indent=1)
    print("ok")


if __name__ == "__main__":
    main()
