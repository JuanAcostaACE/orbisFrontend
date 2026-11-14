/* ================================================================
   ORBIS vision.ts — Abstracción de proveedor de visión artificial
   TypeScript compilado a dist/vision.js por tsc

   ARQUITECTURA:
   VisionProvider (interfaz) ← CocoSsdProvider (POR DEFECTO, TF.js COCO-SSD)
                             ← YoloxProvider (experimental, YOLOX-Nano, ONNX Runtime Web)
   Selección: DETECTOR_POR_DEFECTO ('coco') o parámetro de URL ?detector=yolox

   CONTROL DE SATURACIÓN:
   - Mutex inferenciaEnCurso: evita llamadas paralelas
   - Intervalo mínimo MIN_INFERENCE_MS entre inferencias
   - Umbral mínimo de confianza (CONFIANZA_MINIMA, definido en yolo.ts)
   - Deduplicación: no envía POST si la detección es igual y está en cooldown
   ================================================================ */

import { YoloxNano, CONFIANZA_MINIMA } from './yolo.js';

declare const cocoSsd: any;    // CDN @tensorflow-models/coco-ssd (index.html, con SRI)

// ----------------------------------------------------------------
// INTERFACES PÚBLICAS
// ----------------------------------------------------------------

/** Detección normalizada independiente del modelo subyacente. */
export interface Deteccion {
  clase: string;          // Nombre de la clase detectada
  confianza: number;      // 0.0 – 1.0
  bbox?: [number, number, number, number]; // [x, y, width, height] en píxeles (opcional)
  timestamp: number;      // performance.now() al momento de la inferencia
}

/** Contrato del proveedor de visión. */
export interface VisionProvider {
  /** Nombre identificador del proveedor (para logs y telemetría). */
  readonly nombre: string;

  /** Carga el modelo. Idempotente: si ya está cargado, retorna inmediatamente. */
  inicializar(): Promise<void>;

  /** True si el modelo está listo para inferencia. */
  listo(): boolean;

  /**
   * Ejecuta inferencia sobre un elemento de imagen/video/canvas.
   * @throws Error si el modelo no está inicializado.
   */
  inferir(
    elemento: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap
  ): Promise<Deteccion[]>;

  /** Libera recursos del modelo de memoria. */
  liberar(): void;
}

// ----------------------------------------------------------------
// PROVEEDOR: YOLOX-Nano (ONNX Runtime Web)
// Bounding boxes 2D + clase + confianza — 80 clases COCO, entrada 416x416
// Peso: ~3,6 MB | WASM (CPU) | Sin GPU requerido
// ----------------------------------------------------------------

export class YoloxProvider implements VisionProvider {
  readonly nombre = 'YOLOX-Nano';
  private readonly yolo = new YoloxNano();

  listo(): boolean { return this.yolo.listo(); }

  inicializar(): Promise<void> { return this.yolo.inicializar(); }

  async inferir(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap
  ): Promise<Deteccion[]> {
    if (!this.yolo.listo()) throw new Error('YoloxProvider: modelo no inicializado');
    const dets = await this.yolo.detectar(elem);
    const ts = performance.now();
    return dets.map(d => ({
      clase:     capitalizar(d.clase),
      confianza: d.confianza,
      bbox:      d.bbox,
      timestamp: ts
    }));
  }

  liberar(): void {
    this.yolo.liberar();
  }
}

// ----------------------------------------------------------------
// PROVEEDOR POR DEFECTO: COCO-SSD (TF.js, lite_mobilenet_v2)
// Bounding boxes [x, y, w, h] en píxeles del frame recibido (ImageBitmap/canvas/video).
// ----------------------------------------------------------------

export class CocoSsdProvider implements VisionProvider {
  readonly nombre = 'COCO-SSD';
  private modelo: any | null = null;
  private carga: Promise<void> | null = null;

  listo(): boolean { return this.modelo !== null; }

  inicializar(): Promise<void> {
    if (this.modelo) return Promise.resolve();
    if (!this.carga) {
      this.carga = (async (): Promise<void> => {
        if (typeof cocoSsd === 'undefined') throw new Error('COCO-SSD no está cargado (script del CDN bloqueado o sin red)');
        this.modelo = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      })().finally(() => { this.carga = null; });
    }
    return this.carga;
  }

  async inferir(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap
  ): Promise<Deteccion[]> {
    if (!this.modelo) throw new Error('CocoSsdProvider: modelo no inicializado');
    const predicciones = await this.modelo.detect(elem) as Array<{
      class: string; score: number; bbox: [number, number, number, number];
    }>;
    const ts = performance.now();
    return predicciones.map(p => ({
      clase:     capitalizar(p.class),
      confianza: p.score,
      bbox:      p.bbox,
      timestamp: ts
    }));
  }

  liberar(): void {
    this.modelo = null;
  }
}

// ----------------------------------------------------------------
// SELECCIÓN DE DETECTOR
// ----------------------------------------------------------------

export type NombreDetector = 'coco' | 'yolox';

/** Detector por defecto. Para probar YOLOX-Nano: abrir la app con ?detector=yolox */
export const DETECTOR_POR_DEFECTO: NombreDetector = 'coco';

/** Resuelve el detector a partir de una query string (p. ej. location.search); valor inválido -> defecto. */
export function seleccionarDetector(query: string, porDefecto: NombreDetector = DETECTOR_POR_DEFECTO): NombreDetector {
  const v = new URLSearchParams(query).get('detector')?.toLowerCase();
  return v === 'coco' || v === 'yolox' ? v : porDefecto;
}

export function crearProveedor(nombre: NombreDetector): VisionProvider {
  return nombre === 'yolox' ? new YoloxProvider() : new CocoSsdProvider();
}

// ----------------------------------------------------------------
// GESTOR DE VISIÓN — Control de saturación + deduplicación
// ----------------------------------------------------------------

/** Configuración del gestor. */
export interface VisionConfig {
  /** Intervalo mínimo en ms entre inferencias (default: 1200ms). */
  minInferenceMs: number;
  /** Confianza mínima para considerar una detección válida (default: 0.55). */
  minConfianza: number;
  /** Ventana de deduplicación en ms (default: 5000ms). */
  cooldownDeduplicacionMs: number;
}

/** Motivo por el que una inferencia NO se ejecutó. */
export type MotivoOmision = 'ocupado' | 'throttle' | 'no_listo';

/**
 * Resultado de una inferencia gestionada. Los tres casos son distintos:
 *  - omitida: no se ejecutó (mutex, intervalo mínimo o modelo no listo)
 *  - sin_deteccion: se ejecutó, pero ningún objeto superó la confianza mínima
 *  - ok: hay detecciones válidas; esDuplicado indica si entran en cooldown
 */
export type ResultadoInferencia =
  | { estado: 'omitida'; motivo: MotivoOmision }
  | { estado: 'sin_deteccion' }
  | {
      estado: 'ok';
      detecciones: Deteccion[];
      /** Etiquetas formateadas listas para enviar al backend como etiquetasIA. */
      etiquetasFormateadas: string;
      /** True si esta detección es un duplicado dentro del cooldown. */
      esDuplicado: boolean;
      /** Clase principal de la detección (para confirmarEnvio tras un POST correcto). */
      clasePrincipal: string;
      /** Nombre del proveedor que realizó la inferencia. */
      proveedor: string;
    };

const CONFIG_DEFAULT: VisionConfig = {
  minInferenceMs:           1200,
  minConfianza:             CONFIANZA_MINIMA,
  cooldownDeduplicacionMs: 5000
};

export class GestorVision {
  private readonly config: VisionConfig;
  private readonly proveedor: VisionProvider;

  // Control de saturación
  private inferenciaEnCurso = false;
  private ultimaInferenciaTs = 0;

  // Deduplicación
  private ultimaClasePrincipal: string | null = null;
  private ultimoEnvioTs = 0;

  constructor(
    proveedor: VisionProvider,
    config: Partial<VisionConfig> = {},
    // Reloj inyectable (tests). Por defecto: performance.now() para el throttle y Date.now() para el cooldown.
    private readonly reloj: { perf(): number; wall(): number } = {
      perf: () => performance.now(),
      wall: () => Date.now()
    }
  ) {
    this.proveedor = proveedor;
    this.config    = { ...CONFIG_DEFAULT, ...config };
  }

  /** Carga el modelo. Si falla, registra el error original y lanza el mensaje de usuario. */
  async inicializarAsync(): Promise<string> {
    try {
      await this.proveedor.inicializar();
      return this.proveedor.nombre;
    } catch (err) {
      console.error(`[vision] No se pudo cargar ${this.proveedor.nombre}:`, err);
      throw new Error(MENSAJE_ERROR_MODELO);
    }
  }

  listo(): boolean { return this.proveedor.listo(); }

  /** Nombre del proveedor activo (para la UI). */
  nombreProveedor(): string { return this.proveedor.nombre; }

  /**
   * Ejecuta inferencia con control de saturación y deduplicación.
   *
   * Devuelve estado 'omitida' si:
   *  - Ya hay una inferencia en curso (mutex)
   *  - No ha pasado el intervalo mínimo (throttle)
   *  - El proveedor no está listo
   * Devuelve 'sin_deteccion' si la inferencia se ejecutó sin resultados válidos.
   */
  async inferir(
    elemento: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap,
    distanciaActual?: number,
    umbralCriticoCm = 30
  ): Promise<ResultadoInferencia> {
    // ── Mutex: evitar llamadas paralelas ──
    if (this.inferenciaEnCurso) return { estado: 'omitida', motivo: 'ocupado' };

    // ── Throttle: intervalo mínimo ──
    const ahora = this.reloj.perf();
    if (ahora - this.ultimaInferenciaTs < this.config.minInferenceMs) return { estado: 'omitida', motivo: 'throttle' };

    // ── Proveedor no listo ──
    if (!this.proveedor.listo()) return { estado: 'omitida', motivo: 'no_listo' };

    this.inferenciaEnCurso = true;

    try {
      const detecciones = await this.proveedor.inferir(elemento);

      // Solo una inferencia completada consume el intervalo mínimo; un fallo no bloquea el siguiente intento.
      this.ultimaInferenciaTs = ahora;

      // Filtrar por umbral mínimo de confianza
      const validas = detecciones
        .filter(d => d.confianza >= this.config.minConfianza)
        .sort((a, b) => b.confianza - a.confianza);

      if (validas.length === 0) return { estado: 'sin_deteccion' };

      const clasePrincipal = validas[0].clase;
      const etiquetas      = validas.map(d =>
        `${d.clase} (${(d.confianza * 100).toFixed(0)}%)`
      ).join(', ');

      // ── Deduplicación (solo lectura: el cooldown se registra en confirmarEnvio tras un POST correcto) ──
      const ahoraWall    = this.reloj.wall();
      const enCooldown   = (ahoraWall - this.ultimoEnvioTs) < this.config.cooldownDeduplicacionMs;
      const mismaCLase   = clasePrincipal === this.ultimaClasePrincipal;

      // Considerar excepción al cooldown si la distancia entró en zona crítica
      const distanciaCritica = distanciaActual !== undefined && distanciaActual < umbralCriticoCm;

      const esDuplicado = enCooldown && mismaCLase && !distanciaCritica;

      return {
        estado: 'ok',
        detecciones: validas,
        etiquetasFormateadas: etiquetas,
        esDuplicado,
        clasePrincipal,
        proveedor: this.proveedor.nombre
      };

    } finally {
      this.inferenciaEnCurso = false;
    }
  }

  /**
   * Registra el cooldown de deduplicación. Llamar solo cuando el evento se envió
   * correctamente (POST con éxito). Si el envío falla, no llamar: la siguiente
   * detección puede enviarse.
   */
  confirmarEnvio(resultado: ResultadoInferencia): void {
    if (resultado.estado !== 'ok' || resultado.esDuplicado) return;
    this.ultimaClasePrincipal = resultado.clasePrincipal;
    this.ultimoEnvioTs        = this.reloj.wall();
  }
}

// ----------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------

/** Mensaje mostrado al usuario cuando el modelo de detección no puede cargarse. */
export const MENSAJE_ERROR_MODELO =
  'No se pudo cargar el modelo de detección. Revisa la conexión e inténtalo de nuevo.';

function capitalizar(s: string): string {
  if (!s || s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------
// INSTANCIA SINGLETON EXPORTADA
// Usada desde app.ts para evitar múltiples cargados de modelo
// ----------------------------------------------------------------
export const gestorVision = new GestorVision(
  crearProveedor(seleccionarDetector(typeof location !== 'undefined' ? location.search : '')),
  { minInferenceMs: 1200, minConfianza: CONFIANZA_MINIMA, cooldownDeduplicacionMs: 5000 }
);
