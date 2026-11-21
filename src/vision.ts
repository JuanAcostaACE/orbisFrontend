/* ================================================================
   ORBIS vision.ts — Abstracción de proveedor de visión artificial
   TypeScript compilado a dist/vision.js por tsc

   ARQUITECTURA:
   VisionProvider (interfaz) ← CocoSsdProvider (primario, TF.js COCO-SSD)
                             ← MobileNetProvider (fallback)

   CONTROL DE SATURACIÓN:
   - Mutex inferenceInProgress: evita llamadas paralelas
   - Intervalo mínimo MIN_INFERENCE_MS entre inferencias
   - Umbral mínimo de confianza MIN_CONFIDENCE
   - Deduplicación: no envía POST si la detección es igual y está en cooldown
   ================================================================ */

declare const cocoSsd: any;    // CDN @tensorflow-models/coco-ssd
declare const mobilenet: any;  // CDN @tensorflow-models/mobilenet

// ----------------------------------------------------------------
// INTERFACES PÚBLICAS
// ----------------------------------------------------------------

/** Detección normalizada independiente del modelo subyacente. */
export interface Detection {
  label: string;          // Nombre de la clase detectada
  confidence: number;      // 0.0 – 1.0
  bbox?: [number, number, number, number]; // [x, y, width, height] en píxeles (opcional)
  timestamp: number;      // performance.now() al momento de la inferencia
}

/** Contrato del proveedor de visión. */
export interface VisionProvider {
  /** Nombre identificador del proveedor (para logs y telemetría). */
  readonly name: string;

  /** Carga el modelo. Idempotente: si ya está cargado, retorna inmediatamente. */
  initialize(): Promise<void>;

  /** True si el modelo está listo para inferencia. */
  ready(): boolean;

  /**
   * Ejecuta inferencia sobre un elemento de imagen/video/canvas.
   * @throws Error si el modelo no está inicializado.
   */
  infer(
    element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<Detection[]>;

  /** Libera recursos del modelo de memoria. */
  release(): void;
}

// ----------------------------------------------------------------
// PROVEEDOR PRIMARIO: COCO-SSD (TF.js)
// Bounding boxes + clase + confianza — 80 clases COCO
// Peso: ~6 MB | CPU friendly | Sin GPU requerido
// ----------------------------------------------------------------

export class CocoSsdProvider implements VisionProvider {
  readonly name = 'COCO-SSD';
  private model: any | null = null;
  private loading = false;

  ready(): boolean { return this.model !== null; }

  async initialize(): Promise<void> {
    if (this.model) return;
    if (this.loading) {
      while (this.loading) await sleep(150);
      return;
    }
    this.loading = true;
    try {
      this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    } finally {
      this.loading = false;
    }
  }

  async infer(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<Detection[]> {
    if (!this.model) throw new Error('CocoSsdProvider: modelo no inicializado');
    const predictions = await this.model.detect(elem) as Array<{
      class: string; score: number; bbox: [number, number, number, number];
    }>;
    const ts = performance.now();
    return predictions.map(p => ({
      label:     capitalize(p.class),
      confidence: p.score,
      bbox:      p.bbox,
      timestamp: ts
    }));
  }

  release(): void {
    this.model = null;
  }
}

// ----------------------------------------------------------------
// PROVEEDOR FALLBACK: MobileNet (TF.js)
// Clasificación sin bboxes — fallback si COCO-SSD falla o no disponible
// ----------------------------------------------------------------

export class MobileNetProvider implements VisionProvider {
  readonly name = 'MobileNet';
  private model: any | null = null;
  private loading = false;

  ready(): boolean { return this.model !== null; }

  async initialize(): Promise<void> {
    if (this.model) return;
    if (this.loading) {
      while (this.loading) await sleep(150);
      return;
    }
    this.loading = true;
    try {
      this.model = await mobilenet.load({ version: 2, alpha: 1.0 });
    } finally {
      this.loading = false;
    }
  }

  async infer(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<Detection[]> {
    if (!this.model) throw new Error('MobileNetProvider: modelo no inicializado');
    const predictions = await this.model.classify(elem, 3) as Array<{
      className: string; probability: number;
    }>;
    const ts = performance.now();
    return predictions.map(p => {
      let label = p.className ?? '';
      if (label.includes(',')) label = label.split(',').pop()!.trim();
      return { label: capitalize(label), confidence: p.probability, timestamp: ts };
    });
  }

  release(): void {
    this.model = null;
  }
}

// ----------------------------------------------------------------
// GESTOR DE VISIÓN — Control de saturación + deduplicación
// ----------------------------------------------------------------

/** Configuración del gestor. */
export interface VisionConfig {
  /** Intervalo mínimo en ms entre inferencias (default: 1200ms). */
  minInferenceMs: number;
  /** Confianza mínima para considerar una detección válida (default: 0.55). */
  minConfidence: number;
  /** Ventana de deduplicación en ms (default: 5000ms). */
  dedupCooldownMs: number;
}

/** Motivo por el que una inferencia NO se ejecutó. */
export type SkipReason = 'busy' | 'throttle' | 'not_ready';

/**
 * Resultado de una inferencia gestionada. Los tres casos son distintos:
 *  - omitida: no se ejecutó (mutex, intervalo mínimo o modelo no listo)
 *  - sin_deteccion: se ejecutó, pero ningún objeto superó MIN_CONFIDENCE
 *  - ok: hay detecciones válidas; isDuplicate indica si entran en cooldown
 */
export type InferenceResult =
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'no_detection' }
  | {
      status: 'ok';
      detections: Detection[];
      /** Etiquetas formateadas listas para enviar al backend como aiLabels. */
      formattedLabels: string;
      /** True si esta detección es un duplicado dentro del cooldown. */
      isDuplicate: boolean;
      /** Nombre del proveedor que realizó la inferencia. */
      provider: string;
    };

const CONFIG_DEFAULT: VisionConfig = {
  minInferenceMs:           1200,
  minConfidence:             0.55,
  dedupCooldownMs: 5000
};

export class VisionManager {
  private readonly config: VisionConfig;
  private provider: VisionProvider;
  private fallback: VisionProvider | null;

  // Control de saturación
  private inferenceInProgress = false;
  private lastInferenceTs = 0;

  // Deduplicación
  private lastMainClass: string | null = null;
  private lastSendTs = 0;

  constructor(
    provider: VisionProvider,
    fallback: VisionProvider | null = null,
    config: Partial<VisionConfig> = {}
  ) {
    this.provider = provider;
    this.fallback  = fallback;
    this.config    = { ...CONFIG_DEFAULT, ...config };
  }

  /** Inicializa el proveedor primario en segundo plano; carga el fallback si el primario falla. */
  async initializeAsync(): Promise<string> {
    try {
      await this.provider.initialize();
      return this.provider.name;
    } catch (errPrimary) {
      console.error(`[vision] No se pudo cargar ${this.provider.name}:`, errPrimary);
      if (this.fallback) {
        try {
          await this.fallback.initialize();
        } catch (errFallback) {
          console.error(`[vision] No se pudo cargar ${this.fallback.name}:`, errFallback);
          throw new Error(MODEL_ERROR_MESSAGE);
        }
        this.provider = this.fallback;
        this.fallback  = null;
        return `${this.provider.name} (fallback)`;
      }
      throw new Error(MODEL_ERROR_MESSAGE);
    }
  }

  ready(): boolean { return this.provider.ready(); }

  /**
   * Ejecuta inferencia con control de saturación y deduplicación.
   *
   * Devuelve estado 'omitida' si:
   *  - Ya hay una inferencia en curso (mutex)
   *  - No ha pasado el intervalo mínimo (throttle)
   *  - El proveedor no está listo
   * Devuelve 'sin_deteccion' si la inferencia se ejecutó sin resultados válidos.
   */
  async infer(
    element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
    currentDistance?: number,
    criticalThresholdCm = 30
  ): Promise<InferenceResult> {
    // ── Mutex: evitar llamadas paralelas ──
    if (this.inferenceInProgress) return { status: 'skipped', reason: 'busy' };

    // ── Throttle: intervalo mínimo ──
    const now = performance.now();
    if (now - this.lastInferenceTs < this.config.minInferenceMs) return { status: 'skipped', reason: 'throttle' };

    // ── Proveedor no listo ──
    if (!this.provider.ready()) return { status: 'skipped', reason: 'not_ready' };

    this.inferenceInProgress = true;
    this.lastInferenceTs = now;

    try {
      const detections = await this.provider.infer(element);

      // Filtrar por umbral mínimo de confianza
      const valid = detections
        .filter(d => d.confidence >= this.config.minConfidence)
        .sort((a, b) => b.confidence - a.confidence);

      if (valid.length === 0) return { status: 'no_detection' };

      const mainClass = valid[0].label;
      const labels      = valid.map(d =>
        `${d.label} (${(d.confidence * 100).toFixed(0)}%)`
      ).join(', ');

      // ── Deduplicación ──
      const nowWallClock = Date.now();
      const inCooldown   = (nowWallClock - this.lastSendTs) < this.config.dedupCooldownMs;
      const sameClass   = mainClass === this.lastMainClass;

      // Considerar excepción al cooldown si la distancia entró en zona crítica
      const criticalDistance = currentDistance !== undefined && currentDistance < criticalThresholdCm;

      const isDuplicate = inCooldown && sameClass && !criticalDistance;

      if (!isDuplicate) {
        this.lastMainClass = mainClass;
        this.lastSendTs        = nowWallClock;
      }

      return {
        status: 'ok',
        detections: valid,
        formattedLabels: labels,
        isDuplicate,
        provider: this.provider.name
      };

    } finally {
      this.inferenceInProgress = false;
    }
  }
}

// ----------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------

/** Mensaje mostrado al usuario cuando ningún modelo de detección puede cargarse. */
export const MODEL_ERROR_MESSAGE =
  'No se pudo cargar el modelo de detección. Revisa la conexión e inténtalo de nuevo.';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function capitalize(s: string): string {
  if (!s || s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------
// INSTANCIA SINGLETON EXPORTADA
// Usada desde app.ts para evitar múltiples cargados de modelo
// ----------------------------------------------------------------
export const visionManager = new VisionManager(
  new CocoSsdProvider(),
  new MobileNetProvider(),
  { minInferenceMs: 1200, minConfidence: 0.55, dedupCooldownMs: 5000 }
);
