/* ================================================================
   ORBIS envio-pasivo.ts — Registro del cooldown PASIVO tras el POST

   Lógica pura (sin DOM ni red). El cooldown de PASIVO solo debe
   activarse cuando el backend confirma el evento (respuesta ok).
   Si el POST falla o responde error, el siguiente intento queda
   permitido y el estado de histéresis (enPeligro) no se toca.
   ================================================================ */

import type { HisteresisPasiva } from './alertas.js';

/** Respuesta mínima necesaria del fetch. */
export interface RespuestaEnvio {
  readonly ok: boolean;
}

/**
 * Paso posterior a la respuesta del POST /api/v1/eventos.
 * Registra el cooldown solo si el modo es PASIVO y la respuesta es correcta.
 * No modifica evaluar() ni el flag enPeligro.
 */
export function registrarCooldownTrasRespuesta(
  histeresis: Pick<HisteresisPasiva, 'registrarEnvio'>,
  modo: string,
  res: RespuestaEnvio,
  ahoraMs: number
): void {
  if (modo === 'PASIVO' && res.ok) histeresis.registrarEnvio(ahoraMs);
}
