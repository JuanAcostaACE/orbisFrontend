"""PARTE 2 - cv2.resize INTER_LINEAR REAL (opencv-python-headless) vs emulaciones, dentro del letterbox oficial
(114, arriba-izquierda, BGR, 416), mismo modelo ONNX, NMS oficial (multiclass_nms clase a clase), umbral 0.5.
NO incluye el canvas del navegador (no hay tensores RGBA guardados): ver informe.
Uso: python -I compare_resize.py <dataset.json> <dir_img> <modelo.onnx> <yolox_demo_utils.py> <salida.json>"""
import sys, os, json, importlib.util
import numpy as np, cv2, onnxruntime as ort
from PIL import Image

T = 416
THR = 0.5


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def rs_cv2(bgr, rw, rh):
    return cv2.resize(bgr, (rw, rh), interpolation=cv2.INTER_LINEAR)


def rs_pil(bgr, rw, rh):
    rgb = np.ascontiguousarray(bgr[:, :, ::-1])
    return np.ascontiguousarray(np.asarray(Image.fromarray(rgb).resize((rw, rh), Image.BILINEAR))[:, :, ::-1])


def rs_np_emul(bgr, rw, rh):  # emulacion numpy del experimento previo (exp-config/exp/run_exp.py)
    h, w = bgr.shape[:2]
    sx, sy = w / rw, h / rh
    xs = np.clip((np.arange(rw) + 0.5) * sx - 0.5, 0, w - 1)
    ys = np.clip((np.arange(rh) + 0.5) * sy - 0.5, 0, h - 1)
    x0 = np.floor(xs).astype(int); x1 = np.minimum(x0 + 1, w - 1); fx = (xs - x0)[None, :, None]
    y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, h - 1); fy = (ys - y0)[:, None, None]
    a = bgr.astype(np.float32)
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return np.clip(np.rint(top * (1 - fy) + bot * fy), 0, 255).astype(np.uint8)


def letterbox(bgr, fn):
    r = min(T / bgr.shape[0], T / bgr.shape[1])
    rw, rh = int(bgr.shape[1] * r), int(bgr.shape[0] * r)
    pad = np.full((T, T, 3), 114, np.uint8)
    pad[:rh, :rw] = fn(bgr, rw, rh)
    return np.ascontiguousarray(pad.transpose(2, 0, 1), np.float32)[None], r


def decode(U, raw, ratio, W, H):
    pred = U.demo_postprocess(raw.copy()[None], (T, T))[0]
    b, s = pred[:, :4], pred[:, 4:5] * pred[:, 5:]
    xy = np.ones_like(b)
    xy[:, 0] = b[:, 0] - b[:, 2] / 2.; xy[:, 1] = b[:, 1] - b[:, 3] / 2.
    xy[:, 2] = b[:, 0] + b[:, 2] / 2.; xy[:, 3] = b[:, 1] + b[:, 3] / 2.
    xy /= ratio
    d = U.multiclass_nms(xy, s, nms_thr=0.45, score_thr=THR, class_agnostic=False)
    out = []
    if d is not None:
        for x1, y1, x2, y2, sc, c in d:
            x1, x2 = np.clip([x1, x2], 0, W); y1, y2 = np.clip([y1, y2], 0, H)
            if x2 > x1 and y2 > y1:
                out.append((int(c), float(sc), (float(x1), float(y1), float(x2), float(y2))))
    return sorted(out, key=lambda t: -t[1])


def iou(a, b):
    w = max(0, min(a[2], b[2]) - max(a[0], b[0])); h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = w * h
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0.0


def xywh2xyxy(g):
    return (g[0], g[1], g[0] + g[2], g[1] + g[3])


def person_eval(dets, gts):
    """Voraz por score, IoU>=0.5 contra GT person (igual que exp-config). Devuelve tp, fp, flags GT usados."""
    used = [False] * len(gts); tp = fp = 0
    for c, s, b in dets:
        if c != 0:
            continue
        best, bj = 0.0, -1
        for j, g in enumerate(gts):
            if used[j]:
                continue
            v = iou(b, xywh2xyxy(g))
            if v >= 0.5 and v > best:
                best, bj = v, j
        if bj >= 0:
            used[bj] = True; tp += 1
        else:
            fp += 1
    return tp, fp, used


def compare(A, B):
    """Emparejamiento por clase igual e IoU>=0.5 (voraz por score de A). Devuelve (coord_dif, score_dif, aparecen, desaparecen)."""
    used = set(); cd, sd = [], []
    for a in A:
        best, bj = 0.5, -1
        for j, b in enumerate(B):
            if j in used or b[0] != a[0]:
                continue
            v = iou(a[2], b[2])
            if v >= best:
                best, bj = v, j
        if bj >= 0:
            used.add(bj)
            cd.extend(np.abs(np.array(a[2]) - np.array(B[bj][2])).tolist()); sd.append(abs(a[1] - B[bj][1]))
    return cd, sd, len(B) - len(used), len(A) - len(sd)


def main():
    ds, imgd, model, util, out = sys.argv[1:6]
    U = load(util, "demo_utils")
    meta = json.load(open(ds, encoding="utf-8"))["imagenes"]
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name
    methods = {"cv2_INTER_LINEAR_REAL": rs_cv2, "PIL_bilinear": rs_pil, "numpy_emulacion_previa": rs_np_emul}
    dets = {k: {} for k in methods}
    pix = {k: [] for k in methods}
    for im in meta:
        bgr = cv2.imread(os.path.join(imgd, im["file_name"]))
        base = None
        for k, fn in methods.items():
            x, r = letterbox(bgr, fn)
            if base is None:
                base = x
            pix[k].append(float(np.abs(x - base).mean()))
            raw = sess.run(None, {inp: x})[0][0]
            dets[k][im["id"]] = decode(U, raw, r, im["width"], im["height"])
    res = {"etiqueta": "cv2.resize REAL (opencv-python-headless %s), no emulacion" % cv2.__version__,
           "umbral": THR, "nms": "oficial multiclass_nms clase a clase", "imagenes": len(meta),
           "personas_gt": sum(len(m["personas_bbox_xywh"]) for m in meta)}
    for k in methods:
        TP = FP = FN = st = sg = 0
        for im in meta:
            gts = im["personas_bbox_xywh"]
            tp, fp, used = person_eval(dets[k][im["id"]], gts)
            TP += tp; FP += fp; FN += len(gts) - tp
            for g, u in zip(gts, used):
                if g[2] * g[3] < 0.01 * im["width"] * im["height"]:
                    sg += 1; st += int(u)
        res[k] = dict(person_TP=TP, person_FP=FP, person_FN=FN, recall=TP / (TP + FN),
                      precision=TP / (TP + FP) if TP + FP else None,
                      pequenas_area_lt_1pct=dict(detectadas=st, total=sg, recall=st / sg if sg else None),
                      n_dets_total=sum(len(v) for v in dets[k].values()),
                      pixeles_abs_media_vs_cv2=float(np.mean(pix[k])))
    for k in ("PIL_bilinear", "numpy_emulacion_previa"):
        cd, sd, ap, di = [], [], 0, 0
        for im in meta:
            c, s, a, d = compare(dets["cv2_INTER_LINEAR_REAL"][im["id"]], dets[k][im["id"]])
            cd += c; sd += s; ap += a; di += d
        res["cv2_REAL_vs_" + k] = dict(pares_emparejados=len(sd), coord_abs_media_px=float(np.mean(cd)),
                                       coord_abs_max_px=float(np.max(cd)), score_abs_media=float(np.mean(sd)),
                                       score_abs_max=float(np.max(sd)), detecciones_que_aparecen=ap,
                                       detecciones_que_desaparecen=di)
    json.dump(res, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
