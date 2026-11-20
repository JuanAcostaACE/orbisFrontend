# Alertas del modo PASIVO (`src/alertas.ts`)

| Constante | Valor | Uso |
|---|---|---|
| `UMBRAL_PELIGRO_CM` | 100 | entra en peligro si la distancia es ≤ 100 cm |
| `UMBRAL_RECUPERACION_CM` | 115 | sale de peligro si supera 115 cm |
| `UMBRAL_CRITICO_CM` | 30 | nivel CRÍTICO para las insignias |
| `COOLDOWN_PASIVO_MS` | 5000 | tiempo mínimo entre envíos al backend |

## Histéresis

Entre 100 y 115 cm se conserva el estado anterior, para que una lectura que oscila cerca del
umbral no dispare alertas repetidas. Se envía como máximo un evento por episodio de peligro.

## API de `HisteresisPasiva`

- `evaluar(cm)` → `{ enPeligro, entroEnPeligro, salioDePeligro }`. Ignora valores no numéricos o negativos.
- `puedeEnviar(ahora)` / `restanteMs(ahora)` → control del cooldown.
- `registrarEnvio(ahora)` → llamar **solo** tras un envío correcto.
- `reiniciar()` → vuelve al estado inicial.

Estos valores deben coincidir con `hardware/wokwi/sketch.ino` del backend.
