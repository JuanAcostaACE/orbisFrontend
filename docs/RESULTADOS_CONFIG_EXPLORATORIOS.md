# Resultados exploratorios de configuración: YOLOX-Nano

> **EXPLORATORIO. No es el benchmark principal. No cambia el umbral ni el NMS de producción. Una sola ejecución, una semilla, 60 imágenes.**

Fuentes (solo lectura):
- `exp/resultados_config_yolox_nano.json` (resultados de la ejecución).
- `exp/run_exp.py` y `exp/decode_variants.py` (definición de variantes de NMS y de resize).
- `bench/dataset.json` (worktree `bench`, COCO val2017, semilla 42): recuento de imágenes, personas y estratos.
- `docs/yolo.md` (contexto de producción: umbral 0,55 y NMS por clase con IoU 0,45).

Todas las cifras proceden de estos ficheros. No se ha ejecutado inferencia nueva.

## 0. Verificación del dataset

| Comprobación | JSON de resultados | Dataset (`bench/dataset.json`) | Coincide |
|---|---|---|---|
| Imágenes evaluadas | 60 | 60 | Sí |
| Cajas de persona (ground truth) | 239 | 239 | Sí |
| Personas pequeñas (área < 1 % de la imagen) | 118 (`C.*.small_recall_tp_total`, segundo valor) | 118 | Sí |

No se ha encontrado ninguna discrepancia.

## 1. Imágenes y personas por estrato

El JSON de resultados no contiene desglose por estrato. Los datos siguientes proceden de `bench/dataset.json`:

| Estrato | Imágenes | Personas (GT) | Personas pequeñas |
|---|---|---|---|
| grandes | 12 | 36 | 8 |
| pequeñas | 12 | 73 | 73 |
| difíciles | 8 | 42 | 7 |
| ocluidas | 8 | 37 | 9 |
| múltiples | 10 | 51 | 21 |
| sin_persona | 10 | 0 | 0 |
| **Total** | **60** | **239** | **118** |

## 2. Métricas por umbral de confianza (0,1 a 0,9)

Umbral de referencia del experimento A: 0,5. Métricas de persona con emparejamiento voraz IoU >= 0,5.

### 2.1 NMS por clase (`per_class`, producción actual)

| Umbral | TP | FP | FN | Precisión | Recall | F1 |
|---|---|---|---|---|---|---|
| 0,1 | 142 | 107 | 97 | 0,570 | 0,594 | 0,582 |
| 0,2 | 130 | 48 | 109 | 0,730 | 0,544 | 0,624 |
| 0,3 | 117 | 32 | 122 | 0,785 | 0,490 | 0,603 |
| 0,4 | 109 | 17 | 130 | 0,865 | 0,456 | 0,597 |
| 0,5 | 99 | 10 | 140 | 0,908 | 0,414 | 0,569 |
| 0,6 | 90 | 5 | 149 | 0,947 | 0,377 | 0,539 |
| 0,7 | 75 | 2 | 164 | 0,974 | 0,314 | 0,475 |
| 0,8 | 51 | 0 | 188 | 1,000 | 0,213 | 0,352 |
| 0,9 | 12 | 0 | 227 | 1,000 | 0,050 | 0,096 |

### 2.2 NMS agnóstica a la clase (`agnostic`)

| Umbral | TP | FP | FN | Precisión | Recall | F1 |
|---|---|---|---|---|---|---|
| 0,1 | 142 | 102 | 97 | 0,582 | 0,594 | 0,588 |
| 0,2 | 130 | 48 | 109 | 0,730 | 0,544 | 0,624 |
| 0,3 | 117 | 32 | 122 | 0,785 | 0,490 | 0,603 |
| 0,4 | 109 | 17 | 130 | 0,865 | 0,456 | 0,597 |
| 0,5 | 99 | 10 | 140 | 0,908 | 0,414 | 0,569 |
| 0,6 | 90 | 5 | 149 | 0,947 | 0,377 | 0,539 |
| 0,7 | 75 | 2 | 164 | 0,974 | 0,314 | 0,475 |
| 0,8 | 51 | 0 | 188 | 1,000 | 0,213 | 0,352 |
| 0,9 | 12 | 0 | 227 | 1,000 | 0,050 | 0,096 |

La única diferencia entre ambas variantes está en el umbral 0,1 (FP 107 frente a 102). En el resto de umbrales los resultados son idénticos.

## 3. Personas pequeñas (área < 1 % de la imagen)

| Variante | Umbral | TP | FN | Recall |
|---|---|---|---|---|
| NMS por clase (`cv2_linear`) | 0,5 | 16 | 102 | 0,136 (16/118) |
| Resto de variantes y umbrales | | NO DISPONIBLE EN EL FICHERO | | |

El fichero solo contiene el desglose de personas pequeñas en el experimento C, para la variante de resize `cv2_linear` con NMS por clase y umbral 0,5. Los valores de `pil_bilinear` y `canvas` (16/118 en ambos) también figuran en el fichero, pero no varían la conclusión. Para el resto de umbrales y para la NMS agnóstica el fichero no tiene desglose: NO DISPONIBLE EN EL FICHERO.

## 4. Distribución de confianza de las detecciones

NO DISPONIBLE EN EL FICHERO. El JSON contiene solo valores agregados por umbral (TP, FP, FN). No incluye puntuaciones por detección, así que no se pueden construir contadores por intervalo de confianza (0,1-0,2, 0,2-0,3, etc.) y no se han inventado.

## 5. Variantes de NMS y punto de operación de producción (0,55)

Nombres exactos de las variantes en el fichero y en `exp/decode_variants.py`:
- `per_class`: NMS por clase (replica la aritmética de `src/yolo.ts`, IoU 0,45). Es la configuración de producción.
- `agnostic`: argmax por ancla y un único NMS común (como el demo oficial).
- `person_only`: solo detecciones de la clase persona (aparece únicamente en el experimento A).

Experimento A (umbral 0,5):

| Variante | TP | FP | FN | Precisión | Recall | F1 | Detecciones totales | Pares cruzados entre clases | Duplicados eliminados vs. `per_class` |
|---|---|---|---|---|---|---|---|---|---|
| `per_class` | 99 | 10 | 140 | 0,908 | 0,414 | 0,569 | 182 | 1 (1 redundante) | 0 |
| `agnostic` | 99 | 10 | 140 | 0,908 | 0,414 | 0,569 | 181 | 0 | 1 |
| `person_only` | 99 | 10 | 140 | 0,908 | 0,414 | 0,569 | 109 | 0 | 1 |

Punto de operación de producción, umbral 0,55 (`B_ref_0.55`):

| Variante | TP | FP | FN | Precisión | Recall | F1 |
|---|---|---|---|---|---|---|
| `per_class` | 95 | 6 | 144 | 0,941 | 0,397 | 0,559 |
| `agnostic` | 95 | 6 | 144 | 0,941 | 0,397 | 0,559 |

Comparación de resize en el experimento C (umbral 0,5, NMS por clase). Nota: `cv2_linear` es una emulación en numpy, no OpenCV real.

| Resize | TP | FP | FN | Recall | F1 | Detecciones totales |
|---|---|---|---|---|---|---|
| `cv2_linear` (emulado en numpy) | 99 | 10 | 140 | 0,414 | 0,569 | 182 |
| `pil_bilinear` | 100 | 9 | 139 | 0,418 | 0,575 | 184 |
| `canvas` (navegador) | 100 | 10 | 139 | 0,418 | 0,573 | 183 |

Diferencias de coordenadas entre `cv2_linear` y las otras variantes (pares emparejados): media de 0,89 px frente a `pil_bilinear` (máximo 51,3 px) y media de 0,35 px frente a `canvas` (máximo 22,6 px). Diferencias de score: media de 0,011 frente a `pil_bilinear` y de 0,003 frente a `canvas`.

## Limitaciones

- Una sola ejecución y una sola semilla (42, usada en la construcción del dataset). No hay intervalos de confianza ni repeticiones.
- 60 imágenes. Los estratos tienen entre 8 y 12 imágenes, por lo que las diferencias de unas pocas detecciones no son significativas.
- El redimensionado `cv2_linear` está emulado en numpy. No es OpenCV real; la comparación con OpenCV real se está verificando en otra tarea.
- No se ha evaluado YOLOX-S en este experimento.
- La inferencia usa ONNX Runtime CPU desde Python. No es el runtime de WebAssembly del navegador (onnxruntime-web), por lo que los resultados no garantizan el mismo comportamiento en producción.
- Los resultados son exploratorios y no sustituyen al benchmark principal. No se ha cambiado el umbral (0,55) ni el NMS de producción (`per_class`, IoU 0,45).
