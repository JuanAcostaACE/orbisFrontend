/* ================================================================
   camera/selector.ts — Controlador del panel de cámara
   Une la fuente (VideoSource), la enumeración de dispositivos y el DOM del panel.
   No conoce la lógica de detección: la app le inyecta callbacks.
   ================================================================ */

import { BrowserCameraSource, liberarFrame, type VideoSource, type FrameVideo } from './sources.js';
import { ejecutarCambioCamara, compuertaCamara } from './secuencia.js';
import { camaraSoportada, listarCamaras, leerPreferencia, guardarPreferencia, resolverSeleccion, solicitarPermisoParaEtiquetas, traducirErrorCamara, type CamaraInfo } from './devices.js';

export type EstadoCamara = 'sin-camara' | 'solicitando' | 'en-vivo' | 'error' | 'desconectada';

const ICONOS_CAMARA: Record<EstadoCamara, string> = {
  'sin-camara': '○', 'solicitando': '⏳', 'en-vivo': '●', 'error': '⚠', 'desconectada': '⛔'
};
const TEXTOS_CAMARA: Record<EstadoCamara, string> = {
  'sin-camara': 'Sin cámara seleccionada',
  'solicitando': 'Solicitando permiso de cámara…',
  'en-vivo': 'En vivo',
  'error': 'Error de cámara',
  'desconectada': 'Cámara desconectada'
};

export interface OpcionesControladorCamara {
  /** Detiene el bucle de detección (timer incluido). Devuelve true si estaba corriendo. */
  detenerDeteccion: () => boolean;
  /** Resuelve cuando no hay envío/inferencia en curso (el que está en vuelo termina). */
  esperarEnvioEnCurso: () => Promise<void>;
  /** Reanuda la detección (solo se llama si estaba corriendo antes del cambio). */
  reanudarDeteccion: () => void;
  /** Notifica que la cámara pasó a estar activa/inactiva (limpiar overlay, etc.). */
  alCambiarActiva: (activa: boolean) => void;
  /** Fuente de video; por defecto BrowserCameraSource sobre #cam-video. */
  fuente?: VideoSource;
}

function elCam<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export class ControladorCamara {
  private readonly fuente: VideoSource;
  private readonly video: HTMLVideoElement;
  private readonly select: HTMLSelectElement;
  private camaras: CamaraInfo[] = [];
  private estado: EstadoCamara = 'sin-camara';
  private deviceActivo = '';
  private token = 0;                 // invalida arranques obsoletos (cambios rápidos de cámara)
  private seleccionManual = false;   // el usuario eligió cámara en esta sesión: se respeta
  private reanudar = false;          // la detección estaba corriendo antes del cambio

  constructor(private readonly opc: OpcionesControladorCamara) {
    this.video = elCam<HTMLVideoElement>('cam-video')!;
    this.select = elCam<HTMLSelectElement>('cam-select')!;
    this.fuente = opc.fuente ?? new BrowserCameraSource(this.video);
    this.fuente.onEnded = (motivo): void => this.alDesconectar(motivo);
    this.fuente.onError = (): void => this.mostrarError('Error al reproducir el video de la cámara. Pulsa Reintentar o elige otra cámara.', 'error');
  }

  /** Registra listeners y carga la lista inicial. Llamar una sola vez. */
  async iniciar(): Promise<void> {
    elCam('btn-cam-start')?.addEventListener('click', () => { void this.arrancar(this.select.value || null, true); });
    elCam('btn-cam-stop')?.addEventListener('click', () => this.detener(true));
    elCam('btn-cam-retry')?.addEventListener('click', () => { void this.refrescarLista().then(() => this.arrancar(this.select.value || null, true)); });
    elCam('btn-cam-choose')?.addEventListener('click', () => this.select.focus());
    this.select.addEventListener('change', () => this.alElegir());
    this.video.addEventListener('loadedmetadata', () => this.pintarInfo());
    this.video.addEventListener('resize', () => this.pintarInfo());

    if (!camaraSoportada()) {
      this.mostrarError('Este navegador no permite usar la cámara (se requiere HTTPS o localhost). Puedes usar “Subir foto”.', 'error');
      (elCam('btn-cam-start') as HTMLButtonElement | null)?.setAttribute('disabled', '');
      this.pintarSelect();
      return;
    }
    navigator.mediaDevices.addEventListener('devicechange', () => { void this.alCambiarDispositivos(); });
    await this.refrescarLista();
    this.fijarEstado('sin-camara');
  }

  activa(): boolean { return this.estado === 'en-vivo'; }

  /** Dimensiones del frame de la fuente activa (para el overlay), o null. */
  dimensiones(): { ancho: number; alto: number } | null {
    const c = this.activa() ? this.fuente.capabilities : null;
    return c && c.width > 0 && c.height > 0 ? { ancho: c.width, alto: c.height } : null;
  }

  /** Frame actual de la fuente activa (el llamador debe liberarlo con liberarFrame). */
  obtenerFrame(): Promise<FrameVideo | null> {
    return this.activa() ? this.fuente.getFrame() : Promise.resolve(null);
  }

  // ---------------- Lista de dispositivos ----------------

  private async refrescarLista(): Promise<void> {
    try { this.camaras = await listarCamaras(); } catch { this.camaras = []; }
    this.pintarSelect(resolverSeleccion(
      this.camaras, this.select.value || null, this.seleccionManual, this.deviceActivo || null, leerPreferencia()
    ));
  }

  private pintarSelect(seleccionado?: string | null): void {
    this.select.textContent = '';
    if (this.camaras.length === 0) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No se detectaron cámaras';
      this.select.appendChild(o);
      this.select.disabled = true;
      return;
    }
    this.select.disabled = false;       // con una sola cámara el selector sigue visible y operable
    for (const c of this.camaras) {
      const o = document.createElement('option');
      o.value = c.deviceId; o.textContent = c.etiqueta;
      this.select.appendChild(o);
    }
    if (seleccionado) this.select.value = seleccionado;
  }

  private async alCambiarDispositivos(): Promise<void> {
    await this.refrescarLista();
    if (this.estado === 'en-vivo' && this.deviceActivo && !this.camaras.some(c => c.deviceId === this.deviceActivo)) {
      this.alDesconectar('El dispositivo activo ya no aparece en la lista');
    }
  }

  private alElegir(): void {
    const id = this.select.value;
    this.seleccionManual = true;
    if (id) guardarPreferencia(id);
    // En vivo/arrancando: cambio en caliente. Desconectada/error: se inicia la nueva cámara de
    // inmediato (es la acción de recuperación). Sin cámara: solo queda lista; se inicia con el botón.
    const auto = this.estado === 'en-vivo' || this.estado === 'solicitando'
      || this.estado === 'desconectada' || this.estado === 'error';
    if (id && auto) void this.arrancar(id, false);
  }

  // ---------------- Arranque / cambio / parada ----------------

  /**
   * Cambio/arranque de cámara: ver ejecutarCambioCamara (secuencia.ts). Si falla, la detección
   * queda detenida (no se reanuda), se muestra el error y las acciones Reintentar/Elegir otra.
   */
  private async arrancar(deviceId: string | null, pedirPermiso: boolean): Promise<void> {
    const mio = ++this.token;
    compuertaCamara.cerrar();            // desde aquí no se inicia ningún envío/análisis
    this.ocultarAcciones();
    this.fijarEstado('solicitando');
    let id = deviceId;
    try {
      await ejecutarCambioCamara({
        // Fusiona de inmediato con el flag: un cambio posterior no pierde "Auto estaba activo"
        detenerDeteccion: () => { this.reanudar = this.opc.detenerDeteccion() || this.reanudar; return this.reanudar; },
        esperarEnvioEnCurso: () => this.opc.esperarEnvioEnCurso(),
        vigente: () => mio === this.token,
        liberar: () => {
          this.fuente.stop();
          this.opc.alCambiarActiva(false);
          this.deviceActivo = '';
        },
        iniciar: async () => {
          // Sin permiso las etiquetas son genéricas: pedirlo una vez para poder elegir la C920/Logitech
          if (pedirPermiso && this.camaras.length > 1 && !this.camaras.some(c => c.etiquetaReal) && !leerPreferencia()) {
            await solicitarPermisoParaEtiquetas();
            if (mio !== this.token) return;
            await this.refrescarLista();
            id = this.select.value || null;
          }
          if (mio !== this.token) return;
          await this.fuente.start(id || undefined);
        },
        validar: () => this.validarFuente(),
        confirmar: () => {
          this.deviceActivo = id ?? '';
          if (id) guardarPreferencia(id);
          if (id && this.camaras.some(c => c.deviceId === id)) this.select.value = id;
          this.opc.alCambiarActiva(true);
          const caps = this.fuente.capabilities;
          this.fijarEstado('en-vivo', caps ? `En vivo — ${caps.label || 'cámara'}` : undefined);
          void this.refrescarLista();    // con permiso ya hay etiquetas reales (la activa se conserva)
        },
        finTransicion: () => compuertaCamara.abrir(),
        reanudar: () => { this.reanudar = false; this.opc.reanudarDeteccion(); }
      });
    } catch (e) {
      if (mio !== this.token) return;     // arranque cancelado por uno más reciente
      this.fuente.stop();
      this.opc.alCambiarActiva(false);
      this.reanudar = false;              // Auto queda detenido
      compuertaCamara.abrir();
      this.mostrarError(traducirErrorCamara(e).mensaje, 'error');
    }
  }

  /** La fuente debe dar settings (resolución) y un primer frame válido en un tiempo razonable. */
  private async validarFuente(): Promise<void> {
    const limite = Date.now() + 3000;
    while (Date.now() < limite) {
      const f = await this.fuente.getFrame();
      if (f) {
        const ok = f.width > 0 && f.height > 0;
        liberarFrame(f);
        if (ok) return;
      }
      await new Promise<void>(r => setTimeout(r, 100));
    }
    throw Object.assign(new Error('La cámara no entregó imagen'), { name: 'NotReadableError' });
  }

  /** @param manual true si lo pidió el usuario: detiene también la detección. */
  detener(manual: boolean): void {
    this.token++;
    compuertaCamara.invalidar();   // un envío en vuelo sin POST se cancela; Auto ya no lanza otros
    compuertaCamara.abrir();
    if (manual) this.opc.detenerDeteccion();
    this.reanudar = false;
    this.fuente.stop();
    this.deviceActivo = '';
    this.opc.alCambiarActiva(false);
    this.ocultarAcciones();
    this.fijarEstado('sin-camara');
  }

  private alDesconectar(motivo: string): void {
    this.token++;
    compuertaCamara.invalidar();
    compuertaCamara.abrir();
    this.opc.detenerDeteccion();
    this.reanudar = false;
    this.fuente.stop();
    this.deviceActivo = '';
    this.opc.alCambiarActiva(false);
    console.warn('[camara] desconectada:', motivo);
    this.mostrarError('La cámara se desconectó. Vuelve a conectarla y pulsa Reintentar, o elige otra cámara.', 'desconectada');
  }

  // ---------------- Presentación ----------------

  private mostrarError(mensaje: string, estado: 'error' | 'desconectada'): void {
    this.fijarEstado(estado, mensaje);
    elCam('cam-acciones')?.classList.remove('hidden');
  }

  private ocultarAcciones(): void { elCam('cam-acciones')?.classList.add('hidden'); }

  private fijarEstado(estado: EstadoCamara, texto?: string): void {
    this.estado = estado;
    const cont = elCam('cam-status');
    if (cont) cont.setAttribute('data-estado', estado);
    const ic = elCam('cam-status-icon'); if (ic) ic.textContent = ICONOS_CAMARA[estado];
    const tx = elCam('cam-status-text'); if (tx) tx.textContent = texto ?? TEXTOS_CAMARA[estado];
    const vivo = estado === 'en-vivo', ocupado = estado === 'solicitando';
    elCam('btn-cam-start')?.classList.toggle('hidden', vivo);
    elCam('btn-cam-stop')?.classList.toggle('hidden', !vivo);
    const bs = elCam<HTMLButtonElement>('btn-cam-start'); if (bs) bs.disabled = ocupado || !camaraSoportada();
    this.pintarInfo();
  }

  private pintarInfo(): void {
    const c = this.activa() ? this.fuente.capabilities : null;
    const d = elCam('cam-device'), r = elCam('cam-resolution');
    const nombre = c ? (c.label || this.select.selectedOptions[0]?.textContent || 'Cámara') : '—';
    if (d) d.textContent = nombre;
    if (r) r.textContent = c && c.width > 0 ? `${c.width} × ${c.height}` : '—';
  }
}
