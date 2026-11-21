/* ================================================================
   ORBIS yolo.ts — Detección de objetos 2D con YOLOX-Nano en ONNX Runtime Web

   Reproduce el demo oficial YOLOX (demo/ONNXRuntime/onnx_inference.py):
   - Preproceso (yolox.data.data_augment.preproc): letterbox arriba-izquierda
     sobre lienzo 416x416 con valor 114, orden de canales BGR (cv2),
     layout CHW, float32 en rango 0-255 SIN normalizar.
   - Decodificación (demo_postprocess): grid + stride 8/16/32.
   - score = objectness * score de clase; NMS por clase.

   Solo produce cajas 2D. No hay reconstrucción 3D.
   ================================================================ */
/** Ruta del modelo (relativa a index.html). */
export const YOLOX_MODEL_PATH = 'public/models/yolox_nano.onnx';
export const INPUT_SIZE = 416;
/** Umbral de confianza (objectness * clase). Único punto de configuración. */
export const MIN_CONFIDENCE = 0.55;
export const NMS_IOU_THRESHOLD = 0.45;
export const COCO_CLASSES = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
    'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
    'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
    'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
    'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
    'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
    'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
    'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
    'teddy bear', 'hair drier', 'toothbrush'
];
// ----------------------------------------------------------------
// DECODIFICACIÓN + NMS (funciones puras, sin dependencias del navegador)
// ----------------------------------------------------------------
/** Número de anclas para una entrada cuadrada (416 -> 52²+26²+13² = 3549). */
export function anchorCount(size, strides = [8, 16, 32]) {
    return strides.reduce((acc, s) => acc + Math.floor(size / s) ** 2, 0);
}
/**
 * Decodifica la salida cruda [1, N, 85] de YOLOX (demo_postprocess + scores + NMS).
 * @param salida   Float32Array de N*(5+nClases) valores
 * @param ratio    escala del letterbox (original -> entrada); las cajas se dividen por ella
 * @param ancho    ancho de la imagen original (para recortar cajas)
 * @param alto     alto de la imagen original
 */
export function decodeYolox(output, ratio, imgWidth, imgHeight, options = {}) {
    const size = options.size ?? INPUT_SIZE;
    const confidence = options.confidence ?? MIN_CONFIDENCE;
    const iou = options.iou ?? NMS_IOU_THRESHOLD;
    const classes = options.classes ?? COCO_CLASSES;
    const nCls = classes.length;
    const stride5 = 5 + nCls;
    const strides = [8, 16, 32];
    const n = anchorCount(size, strides);
    if (output.length !== n * stride5) {
        throw new Error(`Salida YOLOX inesperada: ${output.length} valores, se esperaban ${n * stride5}`);
    }
    // Candidatos por clase (solo los que superan el umbral)
    const byClass = new Map();
    let a = 0;
    for (const stride of strides) {
        const g = Math.floor(size / stride);
        for (let gy = 0; gy < g; gy++) {
            for (let gx = 0; gx < g; gx++, a++) {
                const o = a * stride5;
                const obj = output[o + 4];
                if (obj < confidence)
                    continue; // score = obj*cls <= obj: descarte seguro
                const cx = (output[o] + gx) * stride;
                const cy = (output[o + 1] + gy) * stride;
                const w = Math.exp(output[o + 2]) * stride;
                const h = Math.exp(output[o + 3]) * stride;
                const x1 = (cx - w / 2) / ratio, y1 = (cy - h / 2) / ratio;
                const x2 = (cx + w / 2) / ratio, y2 = (cy + h / 2) / ratio;
                for (let c = 0; c < nCls; c++) {
                    const score = obj * output[o + 5 + c];
                    if (score < confidence)
                        continue;
                    let list = byClass.get(c);
                    if (!list) {
                        list = [];
                        byClass.set(c, list);
                    }
                    list.push({ box: [x1, y1, x2, y2], score });
                }
            }
        }
    }
    const result = [];
    byClass.forEach((cands, c) => {
        for (const k of nms(cands, iou)) {
            const [x1r, y1r, x2r, y2r] = k.box;
            const x1 = Math.max(0, Math.min(imgWidth, x1r)), y1 = Math.max(0, Math.min(imgHeight, y1r));
            const x2 = Math.max(0, Math.min(imgWidth, x2r)), y2 = Math.max(0, Math.min(imgHeight, y2r));
            if (x2 <= x1 || y2 <= y1)
                continue;
            result.push({
                classIdx: c, label: classes[c], confidence: k.score,
                bbox: [x1, y1, x2 - x1, y2 - y1]
            });
        }
    });
    return result.sort((p, q) => q.confidence - p.confidence);
}
/** NMS de una sola clase (misma aritmética que yolox.utils.nms, áreas con +1). */
function nms(cands, threshold) {
    const order = cands.slice().sort((p, q) => q.score - p.score);
    const keep = [];
    const suppressed = new Array(order.length).fill(false);
    for (let i = 0; i < order.length; i++) {
        if (suppressed[i])
            continue;
        keep.push(order[i]);
        const [ax1, ay1, ax2, ay2] = order[i].box;
        const areaA = (ax2 - ax1 + 1) * (ay2 - ay1 + 1);
        for (let j = i + 1; j < order.length; j++) {
            if (suppressed[j])
                continue;
            const [bx1, by1, bx2, by2] = order[j].box;
            const w = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1) + 1);
            const h = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1) + 1);
            const inter = w * h;
            const areaB = (bx2 - bx1 + 1) * (by2 - by1 + 1);
            if (inter / (areaA + areaB - inter) > threshold)
                suppressed[j] = true;
        }
    }
    return keep;
}
// ----------------------------------------------------------------
// PREPROCESO (letterbox 114, BGR, CHW, float32 0-255)
// ----------------------------------------------------------------
export function preprocess(elem) {
    const imgWidth = elem instanceof HTMLVideoElement ? elem.videoWidth
        : elem instanceof HTMLImageElement ? elem.naturalWidth
            : elem.width;
    const imgHeight = elem instanceof HTMLVideoElement ? elem.videoHeight
        : elem instanceof HTMLImageElement ? elem.naturalHeight
            : elem.height;
    if (!imgWidth || !imgHeight)
        throw new Error('Imagen sin dimensiones (aún no cargada)');
    const T = INPUT_SIZE;
    const ratio = Math.min(T / imgHeight, T / imgWidth);
    const rw = Math.floor(imgWidth * ratio), rh = Math.floor(imgHeight * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = T;
    canvas.height = T;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx)
        throw new Error('No se pudo crear el contexto 2D');
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, T, T);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(elem, 0, 0, rw, rh); // arriba-izquierda, como padded_img[:rh, :rw]
    const px = ctx.getImageData(0, 0, T, T).data; // RGBA
    const plane = T * T;
    const tensorData = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        tensorData[i] = px[i * 4 + 2]; // B
        tensorData[plane + i] = px[i * 4 + 1]; // G
        tensorData[2 * plane + i] = px[i * 4]; // R
    }
    return { tensorData, ratio, imgWidth, imgHeight };
}
// ----------------------------------------------------------------
// CARGA DEL MODELO + INFERENCIA
// ----------------------------------------------------------------
export class YoloxNano {
    constructor() {
        this.session = null;
        this.loadPromise = null;
    }
    ready() { return this.session !== null; }
    /** Idempotente; llamadas concurrentes comparten la misma carga. */
    initialize() {
        if (this.session)
            return Promise.resolve();
        if (!this.loadPromise) {
            this.loadPromise = this.load().catch(e => { this.loadPromise = null; throw e; });
        }
        return this.loadPromise;
    }
    async load() {
        if (typeof ort === 'undefined')
            throw new Error('onnxruntime-web (ort) no está disponible');
        ort.env.wasm.numThreads = 1; // no exige cross-origin isolation
        this.session = await ort.InferenceSession.create(YOLOX_MODEL_PATH, {
            executionProviders: ['wasm']
        });
        console.info('[yolo] Modelo YOLOX-Nano listo (ONNX Runtime Web, entrada 416x416)');
    }
    async detect(elem, confidence = MIN_CONFIDENCE) {
        if (!this.session)
            throw new Error('YoloxNano: modelo no inicializado');
        const { tensorData, ratio, imgWidth, imgHeight } = preprocess(elem);
        const T = INPUT_SIZE;
        const input = new ort.Tensor('float32', tensorData, [1, 3, T, T]);
        const outputs = await this.session.run({ [this.session.inputNames[0]]: input });
        const output = outputs[this.session.outputNames[0]].data;
        return decodeYolox(output, ratio, imgWidth, imgHeight, { confidence });
    }
    release() {
        this.session?.release?.();
        this.session = null;
        this.loadPromise = null;
    }
}
