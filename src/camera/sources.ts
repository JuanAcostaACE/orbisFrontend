/* ================================================================
   camera/sources.ts — Fuentes de video (VideoSource)
   Modelo "pull": el detector pide getFrame() cuando está libre; la fuente
   nunca empuja frames ni los encola.
   ================================================================ */

export interface CapacidadesVideo {
  label: string;
  width: number;    // resolución real de la pista (getSettings), 0 si aún se desconoce
  height: number;
}

export interface FrameVideo {
  source: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
}

export interface VideoSource {
  readonly capabilities: CapacidadesVideo | null;
  /** Abre la fuente. Cierra antes cualquier stream previo (nunca dos abiertos). */
  start(deviceId?: string): Promise<void>;
  /** Detiene TODAS las pistas y suelta el stream. Idempotente. */
  stop(): void;
  /** Frame actual, o null si no hay fuente activa o aún no hay datos. */
  getFrame(): Promise<FrameVideo | null>;
  /** La fuente terminó sola (p. ej. cámara desenchufada). */
  onEnded: ((motivo: string) => void) | null;
  /** Error de ejecución después de arrancar. */
  onError: ((err: Error) => void) | null;
}

/** Libera un frame obtenido con getFrame (cierra el ImageBitmap). */
export function liberarFrame(f: FrameVideo | null): void {
  if (f && typeof ImageBitmap !== 'undefined' && f.source instanceof ImageBitmap) f.source.close();
}

// future: ESP32-CAM — ExternalStreamSource implementaría VideoSource leyendo un stream MJPEG/HTTP
// y devolviendo frames en getFrame(). No implementado en esta rama.

export class BrowserCameraSource implements VideoSource {
  onEnded: ((motivo: string) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  private stream: MediaStream | null = null;
  private caps: CapacidadesVideo | null = null;
  private generacion = 0;
  private limpiarListeners: (() => void) | null = null;

  /** @param video elemento <video> usado como vista previa (recibe srcObject). */
  constructor(private readonly video: HTMLVideoElement) {}

  get capabilities(): CapacidadesVideo | null {
    if (!this.caps) return null;
    // La resolución real puede confirmarse después, al cargar los metadatos del video
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      this.caps.width = this.video.videoWidth;
      this.caps.height = this.video.videoHeight;
    }
    return this.caps;
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    const gen = ++this.generacion;
    const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });

    if (gen !== this.generacion) {   // un stop()/start() posterior canceló esta apertura
      stream.getTracks().forEach(t => t.stop());
      throw new DOMException('Inicio de cámara cancelado', 'AbortError');
    }

    this.stream = stream;
    const pista = stream.getVideoTracks()[0];
    const aj = pista ? pista.getSettings() : {};
    this.caps = { label: pista?.label ?? '', width: aj.width ?? 0, height: aj.height ?? 0 };

    const alTerminar = (): void => {
      if (this.stream !== stream) return;
      this.stop();
      this.onEnded?.('La pista de video terminó (cámara desconectada o liberada)');
    };
    const alFallar = (): void => {
      if (this.stream !== stream) return;
      this.onError?.(new Error('Error en el elemento de video'));
    };
    pista?.addEventListener('ended', alTerminar);
    this.video.addEventListener('error', alFallar);
    this.limpiarListeners = (): void => {
      pista?.removeEventListener('ended', alTerminar);
      this.video.removeEventListener('error', alFallar);
    };

    this.video.srcObject = stream;
    try { await this.video.play(); } catch { /* autoplay lo reintenta; no es fatal */ }
    if (gen !== this.generacion) throw new DOMException('Inicio de cámara cancelado', 'AbortError');
  }

  stop(): void {
    this.generacion++;               // invalida cualquier start() en vuelo
    this.limpiarListeners?.();
    this.limpiarListeners = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.caps = null;
    this.video.srcObject = null;
  }

  async getFrame(): Promise<FrameVideo | null> {
    const v = this.video;
    if (!this.stream || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    const width = v.videoWidth, height = v.videoHeight;
    if (typeof createImageBitmap === 'function') {
      const source = await createImageBitmap(v);
      if (!this.stream) { source.close(); return null; }   // se detuvo mientras se creaba
      return { source, width, height };
    }
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    c.getContext('2d')?.drawImage(v, 0, 0, width, height);
    return { source: c, width, height };
  }
}
