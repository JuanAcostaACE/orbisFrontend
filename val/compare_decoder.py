"""PARTE 1 - Paso 3: decoder oficial (demo_postprocess + multiclass_nms de YOLOX) vs decoder TS, mismos tensores crudos.
Uso: python -I compare_decoder.py <yolox_demo_utils.py> <scratch> <ts.json> <salida.json> [umbral]
Solo valida el DECODIFICADOR (post-modelo), no el pipeline completo."""
import sys, os, json, importlib.util
import numpy as np


def load_utils(path):
    spec = importlib.util.spec_from_file_location("demo_utils", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def official(U, raw, ratio, W, H, thr, agnostic):
    pred = U.demo_postprocess(raw.copy()[None], (416, 416))[0]  # copia: la funcion modifica in situ
    boxes, scores = pred[:, :4], pred[:, 4:5] * pred[:, 5:]
    xyxy = np.ones_like(boxes)
    xyxy[:, 0] = boxes[:, 0] - boxes[:, 2] / 2.
    xyxy[:, 1] = boxes[:, 1] - boxes[:, 3] / 2.
    xyxy[:, 2] = boxes[:, 0] + boxes[:, 2] / 2.
    xyxy[:, 3] = boxes[:, 1] + boxes[:, 3] / 2.
    xyxy /= ratio
    d = U.multiclass_nms(xyxy, scores, nms_thr=0.45, score_thr=thr, class_agnostic=agnostic)
    out = []
    if d is not None:
        for x1, y1, x2, y2, s, c in d:
            # mismo recorte que el TS (el oficial solo recorta al dibujar)
            x1, x2 = np.clip([x1, x2], 0, W)
            y1, y2 = np.clip([y1, y2], 0, H)
            if x2 <= x1 or y2 <= y1:
                continue
            out.append((int(c), float(s), [float(x1), float(y1), float(x2), float(y2)]))
    return sorted(out, key=lambda t: -t[1])


def iou(a, b):
    w = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = w * h
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0.0


def match(A, B, thr=0.9):
    """A, B ordenadas por score. Empareja por mayor IoU>=thr (voraz por score de A), SIN exigir misma clase
    para poder contar diferencias de clase. Devuelve [(i,j)]."""
    used, pairs = set(), []
    for i, a in enumerate(A):
        best, bj = thr, -1
        for j, b in enumerate(B):
            if j in used:
                continue
            v = iou(a[2], b[2])
            if v >= best:
                best, bj = v, j
        if bj >= 0:
            used.add(bj)
            pairs.append((i, bj))
    return pairs


def stats(U, scratch, ts, thr, agnostic):
    meta = json.load(open(os.path.join(scratch, "meta.json")))
    nA = nB = pares = cls_diff = 0
    sd, cd, unA, unB = [], [], 0, 0
    peor = None
    for id_, m in meta.items():
        raw = np.fromfile(os.path.join(scratch, f"raw_{id_}.bin"), np.float32).reshape(3549, 85)
        a = official(U, raw, m["ratio"], m["ancho"], m["alto"], thr, agnostic)
        b = sorted([(d["c"], d["s"], d["b"]) for d in ts[id_]], key=lambda t: -t[1])
        nA += len(a)
        nB += len(b)
        pr = match(a, b)
        pares += len(pr)
        unA += len(a) - len(pr)
        unB += len(b) - len(pr)
        for i, j in pr:
            cls_diff += int(a[i][0] != b[j][0])
            sd.append(abs(a[i][1] - b[j][1]))
            e = np.abs(np.array(a[i][2]) - np.array(b[j][2])).max()
            cd.append(e)
            if peor is None or e > peor[0]:
                peor = (float(e), id_)
    return dict(imagenes=len(meta), dets_oficial=nA, dets_ts=nB, pares=pares, sin_par_oficial=unA, sin_par_ts=unB,
                diferencias_clase=cls_diff, score_abs_max=float(max(sd)) if sd else None,
                score_abs_media=float(np.mean(sd)) if sd else None,
                coord_abs_max_px=float(max(cd)) if cd else None, coord_abs_media_px=float(np.mean(cd)) if cd else None,
                peor_caja=peor)


def main():
    util, scratch, tsf, out = sys.argv[1:5]
    thr = float(sys.argv[5]) if len(sys.argv) > 5 else 0.5
    U = load_utils(util)
    ts = json.load(open(tsf))
    res = {"umbral": thr, "tolerancias": {"score": 1e-3, "coord_px": 0.5}}
    for nombre, ag in (("clase_a_clase (equivalente al TS)", False), ("agnostico (default oficial del demo)", True)):
        s = stats(U, scratch, ts, thr, ag)
        s["equivalencia_ok"] = bool(s["dets_oficial"] == s["dets_ts"] == s["pares"] and s["diferencias_clase"] == 0
                                    and s["score_abs_max"] < 1e-3 and s["coord_abs_max_px"] < 0.5)
        res[nombre] = s
    json.dump(res, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
