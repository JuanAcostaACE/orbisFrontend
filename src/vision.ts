/* ================================================================
   ORBIS vision.ts — Abstracción de proveedor de visión artificial
   TypeScript compilado a dist/vision.js por tsc

   ARQUITECTURA:
   VisionProvider (interfaz) ← CocoSsdProvider (primario, TF.js COCO-SSD)
                             ← MobileNetProvider (fallback)

   CONTROL DE SATURACIÓN:
   - Mutex inferenciaEnCurso: evita llamadas paralelas
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
    elemento: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<Deteccion[]>;

  /** Libera recursos del modelo de memoria. */
  liberar(): void;
}

// ----------------------------------------------------------------
// PROVEEDOR PRIMARIO: COCO-SSD (TF.js)
// Bounding boxes + clase + confianza — 80 clases COCO
// Peso: ~6 MB | CPU friendly | Sin GPU requerido
// ----------------------------------------------------------------

export class CocoSsdProvider implements VisionProvider {
  readonly nombre = 'COCO-SSD';
  private modelo: any | null = null;
  private cargando = false;

  listo(): boolean { return this.modelo !== null; }

  async inicializar(): Promise<void> {
    if (this.modelo) return;
    if (this.cargando) {
      while (this.cargando) await sleep(150);
      return;
    }
    this.cargando = true;
    try {
      this.modelo = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    } finally {
      this.cargando = false;
    }
  }

  async inferir(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
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
// PROVEEDOR FALLBACK: MobileNet (TF.js)
// Clasificación sin bboxes — fallback si COCO-SSD falla o no disponible
// ----------------------------------------------------------------

export class MobileNetProvider implements VisionProvider {
  readonly nombre = 'MobileNet';
  private modelo: any | null = null;
  private cargando = false;

  listo(): boolean { return this.modelo !== null; }

  async inicializar(): Promise<void> {
    if (this.modelo) return;
    if (this.cargando) {
      while (this.cargando) await sleep(150);
      return;
    }
    this.cargando = true;
    try {
      this.modelo = await mobilenet.load({ version: 2, alpha: 1.0 });
    } finally {
      this.cargando = false;
    }
  }

  async inferir(
    elem: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<Deteccion[]> {
    if (!this.modelo) throw new Error('MobileNetProvider: modelo no inicializado');
    const predicciones = await this.modelo.classify(elem, 3) as Array<{
      className: string; probability: number;
    }>;
    const ts = performance.now();
    return predicciones.map(p => {
      let clase = p.className ?? '';
      if (clase.includes(',')) clase = clase.split(',').pop()!.trim();
      return { clase: capitalizar(clase), confianza: p.probability, timestamp: ts };
    });
  }

  liberar(): void {
    this.modelo = null;
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
  minConfianza: number;
  /** Ventana de deduplicación en ms (default: 5000ms). */
  cooldownDeduplicacionMs: number;
}

/** Resultado de una inferencia gestionada. */
export interface ResultadoInferencia {
  detecciones: Deteccion[];
  /** Etiquetas formateadas listas para enviar al backend como etiquetasIA. */
  etiquetasFormateadas: string;
  /** True si esta detección es un duplicado dentro del cooldown. */
  esDuplicado: boolean;
  /** Nombre del proveedor que realizó la inferencia. */
  proveedor: string;
}

const CONFIG_DEFAULT: VisionConfig = {
  minInferenceMs:           1200,
  minConfianza:             0.55,
  cooldownDeduplicacionMs: 5000
};

export class GestorVision {
  private readonly config: VisionConfig;
  private proveedor: VisionProvider;
  private fallback: VisionProvider | null;

  // Control de saturación
  private inferenciaEnCurso = false;
  private ultimaInferenciaTs = 0;

  // Deduplicación
  private ultimaClasePrincipal: string | null = null;
  private ultimoEnvioTs = 0;

  constructor(
    proveedor: VisionProvider,
    fallback: VisionProvider | null = null,
    config: Partial<VisionConfig> = {}
  ) {
    this.proveedor = proveedor;
    this.fallback  = fallback;
    this.config    = { ...CONFIG_DEFAULT, ...config };
  }

  /** Inicializa el proveedor primario en segundo plano; carga el fallback si el primario falla. */
  async inicializarAsync(): Promise<string> {
    try {
      await this.proveedor.inicializar();
      return this.proveedor.nombre;
    } catch {
      if (this.fallback) {
        await this.fallback.inicializar();
        this.proveedor = this.fallback;
        this.fallback  = null;
        return `${this.proveedor.nombre} (fallback)`;
      }
      throw new Error('No hay proveedor de visión disponible');
    }
  }

  listo(): boolean { return this.proveedor.listo(); }
  nombreProveedor(): string { return this.proveedor.nombre; }

  /**
   * Ejecuta inferencia con control de saturación y deduplicación.
   *
   * Retorna null si:
   *  - Ya hay una inferencia en curso (mutex)
   *  - No ha pasado el intervalo mínimo
   *  - El proveedor no está listo
   */
  async inferir(
    elemento: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
    distanciaActual?: number,
    umbralCriticoCm = 30
  ): Promise<ResultadoInferencia | null> {
    // ── Mutex: evitar llamadas paralelas ──
    if (this.inferenciaEnCurso) return null;

    // ── Throttle: intervalo mínimo ──
    const ahora = performance.now();
    if (ahora - this.ultimaInferenciaTs < this.config.minInferenceMs) return null;

    // ── Proveedor no listo ──
    if (!this.proveedor.listo()) return null;

    this.inferenciaEnCurso = true;
    this.ultimaInferenciaTs = ahora;

    try {
      const detecciones = await this.proveedor.inferir(elemento);

      // Filtrar por umbral mínimo de confianza
      const validas = detecciones
        .filter(d => d.confianza >= this.config.minConfianza)
        .sort((a, b) => b.confianza - a.confianza);

      if (validas.length === 0) return null;

      const clasePrincipal = validas[0].clase;
      const etiquetas      = validas.map(d =>
        `${d.clase} (${(d.confianza * 100).toFixed(0)}%)`
      ).join(', ');

      // ── Deduplicación ──
      const ahoraSinPerf = Date.now();
      const enCooldown   = (ahoraSinPerf - this.ultimoEnvioTs) < this.config.cooldownDeduplicacionMs;
      const mismaCLase   = clasePrincipal === this.ultimaClasePrincipal;

      // Considerar excepción al cooldown si la distancia entró en zona crítica
      const distanciaCritica = distanciaActual !== undefined && distanciaActual < umbralCriticoCm;

      const esDuplicado = enCooldown && mismaCLase && !distanciaCritica;

      if (!esDuplicado) {
        this.ultimaClasePrincipal = clasePrincipal;
        this.ultimoEnvioTs        = ahoraSinPerf;
      }

      return {
        detecciones: validas,
        etiquetasFormateadas: etiquetas,
        esDuplicado,
        proveedor: this.proveedor.nombre
      };

    } finally {
      this.inferenciaEnCurso = false;
    }
  }

  /** Libera los recursos del modelo (llamar al destruir el componente). */
  liberar(): void {
    this.proveedor.liberar();
    this.fallback?.liberar();
  }
}

// ----------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function capitalizar(s: string): string {
  if (!s || s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------
// INSTANCIA SINGLETON EXPORTADA
// Usada desde app.ts para evitar múltiples cargados de modelo
// ----------------------------------------------------------------
export const gestorVision = new GestorVision(
  new CocoSsdProvider(),
  new MobileNetProvider(),
  { minInferenceMs: 1200, minConfianza: 0.55, cooldownDeduplicacionMs: 5000 }
);
