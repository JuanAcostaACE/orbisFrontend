# Visión artificial en el navegador (`src/vision.ts`)

La detección corre localmente con TensorFlow.js; las imágenes no salen del navegador.

## Proveedores

- `CocoSsdProvider` (principal): detecta objetos con caja delimitadora.
- `MobileNetProvider` (respaldo): clasifica la imagen si COCO-SSD falla.

## `GestorVision`

| Parámetro | Valor | Efecto |
|---|---|---|
| `minInferenceMs` | 1200 | intervalo mínimo entre inferencias |
| `minConfianza` | 0.55 | descarta detecciones con menos confianza |
| `cooldownDeduplicacionMs` | 5000 | evita reenviar la misma detección |

## Resultados posibles

- `omitida` (`ocupado`, `throttle`, `no_listo`): no se ejecutó.
- `sin_deteccion`: se ejecutó, ningún objeto superó el umbral.
- `ok`: detecciones válidas, con `etiquetasFormateadas` para el campo `etiquetasIA` y `esDuplicado`.
