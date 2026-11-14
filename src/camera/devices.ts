/* ================================================================
   camera/devices.ts — Enumeración de cámaras, permisos y errores
   Funciones puras + navigator.mediaDevices. Sin dependencias del DOM de la app.
   ================================================================ */

export interface CamaraInfo {
  deviceId: string;
  /** Nombre a mostrar: el real si el navegador lo entrega, o "Camara N" genérico. */
  etiqueta: string;
  /** true si la etiqueta viene del navegador (hay permiso concedido). */
  etiquetaReal: boolean;
}

export type AccionError = 'reintentar' | 'elegir-otra' | 'permisos';

export interface ErrorCamara {
  codigo: string;
  mensaje: string;
  accion: AccionError;
}

export const CLAVE_CAMARA = 'orbis.camara.deviceId';

/** true si el navegador expone la API de cámara (requiere HTTPS o localhost). */
export function camaraSoportada(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof navigator.mediaDevices.enumerateDevices === 'function';
}

/** Lista cruda del navegador -> CamaraInfo (solo videoinput; etiqueta genérica si falta). */
export function construirListaCamaras(
  dispositivos: ReadonlyArray<{ kind: string; deviceId: string; label: string }>
): CamaraInfo[] {
  return dispositivos
    .filter(d => d.kind === 'videoinput')
    .map((d, i) => {
      const real = !!(d.label && d.label.trim());
      return { deviceId: d.deviceId, etiqueta: real ? d.label : `Camara ${i + 1}`, etiquetaReal: real };
    });
}

export async function listarCamaras(): Promise<CamaraInfo[]> {
  if (!camaraSoportada()) return [];
  return construirListaCamaras(await navigator.mediaDevices.enumerateDevices());
}

export function leerPreferencia(): string | null {
  try { return localStorage.getItem(CLAVE_CAMARA); } catch { return null; }
}

export function guardarPreferencia(deviceId: string): void {
  try { localStorage.setItem(CLAVE_CAMARA, deviceId); } catch { /* almacenamiento no disponible */ }
}

/**
 * Cámara por defecto: 1) la última elegida si sigue presente; 2) la primera cuya etiqueta
 * contenga "C920" o "Logitech"; 3) la primera. null si no hay cámaras.
 */
export function elegirPredeterminada(camaras: CamaraInfo[], guardado: string | null): string | null {
  if (camaras.length === 0) return null;
  if (guardado && camaras.some(c => c.deviceId === guardado)) return guardado;
  const preferida = camaras.find(c => /c920|logitech/i.test(c.etiqueta));
  return (preferida ?? camaras[0]).deviceId;
}

/**
 * Selección a mostrar tras refrescar la lista. Prioridad: 1) la cámara activa si sigue presente;
 * 2) la elección manual del usuario en esta sesión si sigue presente; 3) la regla por defecto
 * (guardada > C920/Logitech > primera), que se reevalúa cuando llegan las etiquetas reales.
 */
export function resolverSeleccion(
  camaras: CamaraInfo[], actual: string | null, manual: boolean, activo: string | null, guardado: string | null
): string | null {
  if (activo && camaras.some(c => c.deviceId === activo)) return activo;
  if (manual && actual && camaras.some(c => c.deviceId === actual)) return actual;
  return elegirPredeterminada(camaras, guardado);
}

/**
 * Pide permiso abriendo y cerrando de inmediato un stream, para que el navegador revele las
 * etiquetas reales. El stream se detiene antes de retornar (nunca queda abierto).
 */
export async function solicitarPermisoParaEtiquetas(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  s.getTracks().forEach(t => t.stop());
}

/** Traduce un error de getUserMedia a un mensaje claro en español y una acción sugerida. */
export function traducirErrorCamara(err: unknown): ErrorCamara {
  const nombre = (err && typeof err === 'object' && 'name' in err) ? String((err as { name: unknown }).name) : '';
  switch (nombre) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { codigo: nombre, accion: 'permisos',
        mensaje: 'Permiso de cámara denegado. Habilítalo en el icono de candado de la barra de direcciones y pulsa Reintentar.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { codigo: nombre, accion: 'elegir-otra',
        mensaje: 'No se encontró ninguna cámara. Conecta una y pulsa Reintentar, o elige otra de la lista.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { codigo: nombre, accion: 'elegir-otra',
        mensaje: 'La cámara está en uso por otra aplicación o no se puede abrir. Ciérrala y pulsa Reintentar, o elige otra cámara.' };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { codigo: nombre, accion: 'elegir-otra',
        mensaje: 'La cámara seleccionada ya no está disponible o no admite la resolución pedida. Elige otra cámara.' };
    case 'TypeError':
      return { codigo: nombre, accion: 'reintentar',
        mensaje: 'Este navegador no permite usar la cámara (se requiere HTTPS o localhost).' };
    default:
      return { codigo: nombre || 'desconocido', accion: 'reintentar',
        mensaje: 'No se pudo iniciar la cámara. Pulsa Reintentar o elige otra cámara.' };
  }
}
