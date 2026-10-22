/* ================================================================
   ORBIS alertas.ts — Histéresis y cooldown del modo PASIVO

   Lógica pura (sin DOM ni red) para que el simulador:
     1. Active la alerta LOCAL al instante (visual / sonora / vibración).
     2. Envíe como máximo UN POST /api/v1/eventos por episodio de peligro
        y nunca antes de que transcurra el cooldown.

   HISTÉRESIS (evita "rebote" cuando la lectura oscila cerca del umbral):
     - Entra en PELIGRO cuando distancia <= UMBRAL_PELIGRO_CM  (100 cm)
     - Sale de PELIGRO  cuando distancia >  UMBRAL_RECUPERACION_CM (115 cm)
     - Entre 100 y 115 cm se conserva el estado anterior.
   Debe mantenerse alineado con hardware/wokwi/sketch.ino.
   ================================================================ */

export const UMBRAL_PELIGRO_CM      = 100;
export const UMBRAL_RECUPERACION_CM = 115;
export const UMBRAL_CRITICO_CM      = 30;
export const COOLDOWN_PASIVO_MS     = 5000;

export type NivelDistancia = 'SEGURO' | 'PELIGRO' | 'CRITICO';

/** Clasifica una distancia para las insignias (icono + texto, no solo color). */
export function nivelDistancia(cm: number): NivelDistancia {
  if (cm <= UMBRAL_CRITICO_CM) return 'CRITICO';
  if (cm <= UMBRAL_PELIGRO_CM) return 'PELIGRO';
  return 'SEGURO';
}

export interface ResultadoHisteresis {
  enPeligro: boolean;
  entroEnPeligro: boolean;
  salioDePeligro: boolean;
}

export class HisteresisPasiva {
  private enPeligro = false;
  private ultimoEnvioTs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly umbralPeligro: number = UMBRAL_PELIGRO_CM,
    private readonly umbralRecuperacion: number = UMBRAL_RECUPERACION_CM,
    private readonly cooldownMs: number = COOLDOWN_PASIVO_MS
  ) {}

  /** Evalúa una nueva lectura. Lecturas no numéricas o negativas se ignoran. */
  evaluar(distanciaCm: number): ResultadoHisteresis {
    if (!Number.isFinite(distanciaCm) || distanciaCm < 0) {
      return { enPeligro: this.enPeligro, entroEnPeligro: false, salioDePeligro: false };
    }
    let entro = false;
    let salio = false;
    if (!this.enPeligro && distanciaCm <= this.umbralPeligro) {
      this.enPeligro = true;
      entro = true;
    } else if (this.enPeligro && distanciaCm > this.umbralRecuperacion) {
      this.enPeligro = false;
      salio = true;
    }
    return { enPeligro: this.enPeligro, entroEnPeligro: entro, salioDePeligro: salio };
  }

  /** True si ya pasó el cooldown desde el último envío registrado. */
  puedeEnviar(ahoraMs: number): boolean {
    return this.restanteMs(ahoraMs) === 0;
  }

  /** Milisegundos que faltan para poder enviar de nuevo (0 si ya se puede). */
  restanteMs(ahoraMs: number): number {
    return Math.max(0, this.cooldownMs - (ahoraMs - this.ultimoEnvioTs));
  }

  registrarEnvio(ahoraMs: number): void {
    this.ultimoEnvioTs = ahoraMs;
  }

  estaEnPeligro(): boolean {
    return this.enPeligro;
  }

  reiniciar(): void {
    this.enPeligro = false;
    this.ultimoEnvioTs = Number.NEGATIVE_INFINITY;
  }
}
