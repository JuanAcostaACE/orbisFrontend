"""PARTE 1/2 - Paso 1: ejecuta el modelo ONNX UNA vez por imagen (preproceso oficial YOLOX con cv2 real)
y guarda el tensor crudo [3549,85] float32 en <scratch>/raw_<id>.bin, mas meta.json (ratio, ancho, alto).
Uso: python -I dump_raw.py <dataset.json> <dir_img> <modelo.onnx> <scratch>"""
import sys, os, json
import numpy as np, cv2, onnxruntime as ort

T = 416


def preproc_oficial(img_bgr):
    # copia literal de yolox.data.data_augment.preproc (swap=(2,0,1)), entrada BGR de cv2.imread
    padded = np.ones((T, T, 3), dtype=np.uint8) * 114
    r = min(T / img_bgr.shape[0], T / img_bgr.shape[1])
    resized = cv2.resize(img_bgr, (int(img_bgr.shape[1] * r), int(img_bgr.shape[0] * r)),
                         interpolation=cv2.INTER_LINEAR).astype(np.uint8)
    padded[: int(img_bgr.shape[0] * r), : int(img_bgr.shape[1] * r)] = resized
    return np.ascontiguousarray(padded.transpose((2, 0, 1)), dtype=np.float32), r


def main():
    ds, imgd, model, scratch = sys.argv[1:5]
    meta = json.load(open(ds, encoding="utf-8"))["imagenes"]
    os.makedirs(scratch, exist_ok=True)
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name
    out = {}
    for im in meta:
        img = cv2.imread(os.path.join(imgd, im["file_name"]))
        assert img is not None and img.shape[1] == im["width"] and img.shape[0] == im["height"], im["file_name"]
        x, r = preproc_oficial(img)
        raw = sess.run(None, {inp: x[None]})[0][0].astype(np.float32)
        assert raw.shape == (3549, 85), raw.shape
        raw.tofile(os.path.join(scratch, f"raw_{im['id']}.bin"))
        out[str(im["id"])] = dict(ratio=r, ancho=im["width"], alto=im["height"])
    json.dump(out, open(os.path.join(scratch, "meta.json"), "w"))
    print("imagenes:", len(out))


if __name__ == "__main__":
    main()
