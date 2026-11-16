/* ================================================================
   camera/secuencia.ts — Secuencia de cambio de cámara (sin DOM, testeable)
   Orden garantizado: detener detección -> esperar envío en vuelo -> liberar dispositivo
   anterior -> iniciar nueva fuente -> validarla (settings + primer frame) -> confirmar
   -> reanudar detección SOLO si corría antes. Si algo falla, lanza y NO reanuda.
   ================================================================ */

export interface PasosCambioCamara {
  /** Detiene captura/inferencias y deja Auto parado. Devuelve true si debe reanudarse al terminar. */
  detenerDeteccion(): boolean;
  /** Espera a que no haya inferencia/POST en curso (el que está en vuelo termina, no se lanza otro). */
  esperarEnvioEnCurso(): Promise<void>;
  /** Libera por completo el dispositivo anterior (todas las pistas, srcObject = null). */
  liberar(): void;
  iniciar(): Promise<void>;
  /** Lanza si la nueva fuente no entrega settings o un primer frame válido. */
  validar(): Promise<void>;
  /** Actualiza la UI a "en vivo" (antes de reanudar). */
  confirmar(): void;
  /** Cierra la transición (se reabre la compuerta de envíos) justo antes de reanudar. */
  finTransicion(): void;
  reanudar(): void;
  /** false si un cambio más reciente (o una parada) invalidó este. */
  vigente(): boolean;
}

export async function ejecutarCambioCamara(p: PasosCambioCamara): Promise<'ok' | 'obsoleto'> {
  const reanudar = p.detenerDeteccion();
  await p.esperarEnvioEnCurso();
  if (!p.vigente()) return 'obsoleto';
  p.liberar();
  await p.iniciar();
  if (!p.vigente()) return 'obsoleto';
  await p.validar();
  if (!p.vigente()) return 'obsoleto';
  p.confirmar();
  p.finTransicion();
  if (reanudar) p.reanudar();
  return 'ok';
}

/**
 * Compuerta de transición: mientras está cerrada (cambio de cámara en curso) NO puede iniciarse
 * ningún envío ni análisis, ni de Auto ni manual. Los envíos ya en vuelo terminan antes de liberar.
 */
export class CompuertaTransicion {
  private cerrada = false;
  private generacion = 0;
  cerrar(): void { this.cerrada = true; this.generacion++; }
  /** Invalida los envíos ya iniciados que aún no hicieron POST (parada o desconexión de la cámara). */
  invalidar(): void { this.generacion++; }
  /** Número de generación: un envío compara el valor de su inicio con el actual antes del POST. */
  epoca(): number { return this.generacion; }
  abrir(): void { this.cerrada = false; }
  bloqueada(): boolean { return this.cerrada; }
}

export const compuertaCamara = new CompuertaTransicion();

// ----------------------------------------------------------------
// Control de aborto de un envío (se evalúa antes del fetch y tras cada await)
// ----------------------------------------------------------------

export interface ContextoEnvio {
  /** El envío lo originó el ciclo de Auto. */
  auto: boolean;
  /** Auto sigue activo (detección no detenida). */
  autoActivo: boolean;
  sesionAbierta: boolean;
  /** El envío se basa en un frame de la cámara. */
  usaCamara: boolean;
  camaraViva: boolean;
  /** Época de la compuerta al iniciar el envío y ahora (cambia al parar/desconectar/cambiar). */
  epocaInicio: number;
  epocaActual: number;
  /** Contador de ciclos de Auto: se incrementa al detener Auto; se captura al iniciar cada ciclo. */
  cicloInicio: number;
  cicloActual: number;
  /** Hay un cambio de cámara en curso. */
  transicion: boolean;
}

/** Motivo por el que el envío debe abortarse, o null si puede continuar. */
export function motivoAbortoEnvio(c: ContextoEnvio): string | null {
  // Solo ciclos de Auto (cualquier fuente, cámara o archivo). Un envío MANUAL ya iniciado no se cancela.
  if (c.auto && (!c.autoActivo || c.cicloActual !== c.cicloInicio)) return 'la detección se detuvo';
  if (c.auto && !c.sesionAbierta) return 'la sesión se cerró';
  if (c.usaCamara) {
    if (c.transicion) return 'hay un cambio de cámara en curso';
    if (c.epocaActual !== c.epocaInicio) return 'la cámara se detuvo, cambió o se desconectó';
    if (!c.camaraViva) return 'la cámara no está activa';
  }
  return null;
}

/**
 * Regla de cadencia de Auto: un tick con un ciclo aún en vuelo (análisis IA + POST + refresco) se SALTA
 * por completo (ni se encola ni cambia modo/distancia simulados); no puede haber dos ciclos a la vez.
 */
export function debeSaltarTickAuto(envioEnCurso: boolean): boolean {
  return envioEnCurso;
}
