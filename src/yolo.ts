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

declare const ort: any; // CDN onnxruntime-web (index.html)

/** Ruta del modelo (relativa a index.html). */
export const RUTA_MODELO_YOLOX = 'public/models/yolox_nano.onnx';
export const TAMANO_ENTRADA = 416;
/** Umbral de confianza (objectness * clase). Único punto de configuración. */
export const CONFIANZA_MINIMA = 0.55;
export const UMBRAL_IOU_NMS = 0.45;

export const CLASES_COCO: readonly string[] = [
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

/** Detección cruda en coordenadas de la imagen original. */
export interface DeteccionYolo {
  claseIdx: number;
  clase: string;                              // vocabulario COCO (minúsculas)
  confianza: number;                          // objectness * clase, 0-1
  bbox: [number, number, number, number];     // [x, y, ancho, alto] en píxeles originales
}

// ----------------------------------------------------------------
// DECODIFICACIÓN + NMS (funciones puras, sin dependencias del navegador)
// ----------------------------------------------------------------

/** Número de anclas para una entrada cuadrada (416 -> 52²+26²+13² = 3549). */
export function numeroAnclas(tamano: number, strides: number[] = [8, 16, 32]): number {
  return strides.reduce((acc, s) => acc + Math.floor(tamano / s) ** 2, 0);
}

/**
 * Decodifica la salida cruda [1, N, 85] de YOLOX (demo_postprocess + scores + NMS).
 * @param salida   Float32Array de N*(5+nClases) valores
 * @param ratio    escala del letterbox (original -> entrada); las cajas se dividen por ella
 * @param ancho    ancho de la imagen original (para recortar cajas)
 * @param alto     alto de la imagen original
 */
export function decodificarYolox(
  salida: ArrayLike<number>,
  ratio: number,
  ancho: number,
  alto: number,
  opciones: {
    tamano?: number; confianza?: number; iou?: number; clases?: readonly string[];
  } = {}
): DeteccionYolo[] {
  const tamano    = opciones.tamano    ?? TAMANO_ENTRADA;
  const confianza = opciones.confianza ?? CONFIANZA_MINIMA;
  const iou       = opciones.iou       ?? UMBRAL_IOU_NMS;
  const clases    = opciones.clases    ?? CLASES_COCO;
  const nCls      = clases.length;
  const stride5   = 5 + nCls;
  const strides   = [8, 16, 32];
  const n         = numeroAnclas(tamano, strides);
  if (salida.length !== n * stride5) {
    throw new Error(`Salida YOLOX inesperada: ${salida.length} valores, se esperaban ${n * stride5}`);
  }

  // Candidatos por clase (solo los que superan el umbral)
  const porClase = new Map<number, Array<{ box: [number, number, number, number]; score: number }>>();

  let a = 0;
  for (const stride of strides) {
    const g = Math.floor(tamano / stride);
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++, a++) {
        const o   = a * stride5;
        const obj = salida[o + 4];
        if (obj < confianza) continue; // score = obj*cls <= obj: descarte seguro

        const cx = (salida[o]     + gx) * stride;
        const cy = (salida[o + 1] + gy) * stride;
        const w  = Math.exp(salida[o + 2]) * stride;
        const h  = Math.exp(salida[o + 3]) * stride;
        const x1 = (cx - w / 2) / ratio, y1 = (cy - h / 2) / ratio;
        const x2 = (cx + w / 2) / ratio, y2 = (cy + h / 2) / ratio;

        for (let c = 0; c < nCls; c++) {
          const score = obj * salida[o + 5 + c];
          if (score < confianza) continue;
          let lista = porClase.get(c);
          if (!lista) { lista = []; porClase.set(c, lista); }
          lista.push({ box: [x1, y1, x2, y2], score });
        }
      }
    }
  }

  const resultado: DeteccionYolo[] = [];
  porClase.forEach((cands, c) => {
    for (const k of nms(cands, iou)) {
      const [x1r, y1r, x2r, y2r] = k.box;
      const x1 = Math.max(0, Math.min(ancho, x1r)), y1 = Math.max(0, Math.min(alto, y1r));
      const x2 = Math.max(0, Math.min(ancho, x2r)), y2 = Math.max(0, Math.min(alto, y2r));
      if (x2 <= x1 || y2 <= y1) continue;
      resultado.push({
        claseIdx: c, clase: clases[c], confianza: k.score,
        bbox: [x1, y1, x2 - x1, y2 - y1]
      });
    }
  });
  return resultado.sort((p, q) => q.confianza - p.confianza);
}

/** NMS de una sola clase (misma aritmética que yolox.utils.nms, áreas con +1). */
function nms(
  cands: Array<{ box: [number, number, number, number]; score: number }>,
  umbral: number
): Array<{ box: [number, number, number, number]; score: number }> {
  const orden = cands.slice().sort((p, q) => q.score - p.score);
  const keep: typeof orden = [];
  const suprimido = new Array<boolean>(orden.length).fill(false);
  for (let i = 0; i < orden.length; i++) {
    if (suprimido[i]) continue;
    keep.push(orden[i]);
    const [ax1, ay1, ax2, ay2] = orden[i].box;
    const areaA = (ax2 - ax1 + 1) * (ay2 - ay1 + 1);
    for (let j = i + 1; j < orden.length; j++) {
      if (suprimido[j]) continue;
      const [bx1, by1, bx2, by2] = orden[j].box;
      const w = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1) + 1);
      const h = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1) + 1);
      const inter = w * h;
      const areaB = (bx2 - bx1 + 1) * (by2 - by1 + 1);
      if (inter / (areaA + areaB - inter) > umbral) suprimido[j] = true;
    }
  }
  return keep;
}

// ----------------------------------------------------------------
// PREPROCESO (letterbox 114, BGR, CHW, float32 0-255)
// ----------------------------------------------------------------

export function preprocesar(
  elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap
): { datos: Float32Array; ratio: number; ancho: number; alto: number } {
  const ancho = elem instanceof HTMLVideoElement ? elem.videoWidth
              : elem instanceof HTMLImageElement ? elem.naturalWidth
              : elem.width;
  const alto  = elem instanceof HTMLVideoElement ? elem.videoHeight
              : elem instanceof HTMLImageElement ? elem.naturalHeight
              : elem.height;
  if (!ancho || !alto) throw new Error('Imagen sin dimensiones (aún no cargada)');

  const T = TAMANO_ENTRADA;
  const ratio = Math.min(T / alto, T / ancho);
  const rw = Math.floor(ancho * ratio), rh = Math.floor(alto * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = T; canvas.height = T;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No se pudo crear el contexto 2D');
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, T, T);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(elem, 0, 0, rw, rh); // arriba-izquierda, como padded_img[:rh, :rw]

  const px = ctx.getImageData(0, 0, T, T).data; // RGBA
  const plano = T * T;
  const datos = new Float32Array(3 * plano);
  for (let i = 0; i < plano; i++) {
    datos[i]             = px[i * 4 + 2]; // B
    datos[plano + i]     = px[i * 4 + 1]; // G
    datos[2 * plano + i] = px[i * 4];     // R
  }
  return { datos, ratio, ancho, alto };
}

// ----------------------------------------------------------------
// CARGA DEL MODELO + INFERENCIA
// ----------------------------------------------------------------

export class YoloxNano {
  private sesion: any | null = null;
  private carga: Promise<void> | null = null;

  listo(): boolean { return this.sesion !== null; }

  /** Idempotente; llamadas concurrentes comparten la misma carga. */
  inicializar(): Promise<void> {
    if (this.sesion) return Promise.resolve();
    if (!this.carga) {
      this.carga = this.cargar().catch(e => { this.carga = null; throw e; });
    }
    return this.carga;
  }

  private async cargar(): Promise<void> {
    if (typeof ort === 'undefined') throw new Error('onnxruntime-web (ort) no está disponible');
    ort.env.wasm.numThreads = 1; // no exige cross-origin isolation
    this.sesion = await ort.InferenceSession.create(RUTA_MODELO_YOLOX, {
      executionProviders: ['wasm']
    });
    console.info('[yolo] Modelo YOLOX-Nano listo (ONNX Runtime Web, entrada 416x416)');
  }

  async detectar(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap,
    confianza = CONFIANZA_MINIMA
  ): Promise<DeteccionYolo[]> {
    if (!this.sesion) throw new Error('YoloxNano: modelo no inicializado');
    const { datos, ratio, ancho, alto } = preprocesar(elem);
    const T = TAMANO_ENTRADA;
    const entrada = new ort.Tensor('float32', datos, [1, 3, T, T]);
    const salidas = await this.sesion.run({ [this.sesion.inputNames[0]]: entrada });
    const salida = salidas[this.sesion.outputNames[0]].data as Float32Array;
    return decodificarYolox(salida, ratio, ancho, alto, { confianza });
  }

  liberar(): void {
    this.sesion?.release?.();
    this.sesion = null;
    this.carga = null;
  }
}
