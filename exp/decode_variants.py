"""Copia EXPERIMENTAL de decodificarYolox + nms (src/yolo.ts de feat/yolo-onnx) con variantes de NMS.
No sustituye al codigo de produccion. Variante 'per_class' replica la aritmetica de src/yolo.ts
(prefiltro obj<umbral, score=obj*cls por clase, NMS por clase con areas +1, supresion IoU > 0.45)."""
import numpy as np

TAMANO = 416
STRIDES = (8, 16, 32)
IOU_NMS = 0.45
PERSON = 0


def grid_decode(raw):
    """raw [N,85] -> (boxes_xyxy en espacio 416 [N,4], obj [N], cls [N,80])."""
    gs, ss = [], []
    for s in STRIDES:
        g = TAMANO // s
        yy, xx = np.meshgrid(np.arange(g), np.arange(g), indexing="ij")
        gs.append(np.stack([xx.ravel(), yy.ravel()], 1))
        ss.append(np.full(g * g, s))
    grid = np.concatenate(gs).astype(np.float32)
    stride = np.concatenate(ss).astype(np.float32)[:, None]
    cxy = (raw[:, :2] + grid) * stride
    wh = np.exp(raw[:, 2:4]) * stride
    xyxy = np.concatenate([cxy - wh / 2, cxy + wh / 2], 1)
    return xyxy, raw[:, 4], raw[:, 5:]


def nms_idx(boxes, scores, thr=IOU_NMS):
    """NMS de una pasada, aritmetica de yolox.utils.nms / src/yolo.ts (areas con +1, IoU > thr suprime)."""
    order = np.argsort(-scores, kind="stable")
    keep = []
    b = boxes
    areas = (b[:, 2] - b[:, 0] + 1) * (b[:, 3] - b[:, 1] + 1)
    sup = np.zeros(len(order), bool)
    for ii, i in enumerate(order):
        if sup[i]:
            continue
        keep.append(i)
        rest = order[ii + 1:]
        w = np.maximum(0, np.minimum(b[i, 2], b[rest, 2]) - np.maximum(b[i, 0], b[rest, 0]) + 1)
        h = np.maximum(0, np.minimum(b[i, 3], b[rest, 3]) - np.maximum(b[i, 1], b[rest, 1]) + 1)
        inter = w * h
        iou = inter / (areas[i] + areas[rest] - inter)
        sup[rest[iou > thr]] = True
    return keep


def _finish(cands, ratio, W, H):
    out = []
    for c, s, box in cands:
        x1, y1, x2, y2 = box / ratio
        x1, x2 = np.clip([x1, x2], 0, W)
        y1, y2 = np.clip([y1, y2], 0, H)
        if x2 <= x1 or y2 <= y1:
            continue
        out.append((int(c), float(s), (float(x1), float(y1), float(x2 - x1), float(y2 - y1))))
    out.sort(key=lambda d: -d[1])
    return out


def decode(raw, ratio, W, H, thr, mode="per_class"):
    """Devuelve lista [(clase, score, (x,y,w,h))] en pixeles originales."""
    boxes, obj, cls = grid_decode(raw)
    cands = []  # (clase, score, caja)
    if mode == "per_class":  # produccion actual
        m = obj >= thr
        scores = obj[:, None] * cls
        ai, ci = np.nonzero((scores >= thr) & m[:, None])
        for c in np.unique(ci):
            sel = ai[ci == c]
            for k in nms_idx(boxes[sel], scores[sel, c]):
                cands.append((c, scores[sel[k], c], boxes[sel[k]]))
    elif mode == "agnostic":  # demo oficial: argmax por ancla + un NMS comun
        scores_all = obj[:, None] * cls
        c = scores_all.argmax(1)
        s = scores_all[np.arange(len(c)), c]
        sel = np.nonzero(s >= thr)[0]
        for k in nms_idx(boxes[sel], s[sel]):
            cands.append((c[sel[k]], s[sel[k]], boxes[sel[k]]))
    elif mode == "person_only":
        scores_all = obj[:, None] * cls
        ps = scores_all[:, PERSON]
        is_max = scores_all.argmax(1) == PERSON
        sel = np.nonzero((is_max | (ps >= thr)) & (ps >= thr))[0]  # el score final debe pasar el umbral
        for k in nms_idx(boxes[sel], ps[sel]):
            cands.append((PERSON, ps[sel[k]], boxes[sel[k]]))
    else:
        raise ValueError(mode)
    return _finish(cands, ratio, W, H)
