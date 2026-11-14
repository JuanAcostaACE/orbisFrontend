# Detección de objetos con YOLOX-Nano (ONNX Runtime Web)

Detección 2D con bounding boxes en el navegador. No hay reconstrucción 3D.

- Modelo: YOLOX-Nano, entrada 416x416, 80 clases COCO.
- Archivo: `public/models/yolox_nano.onnx` (3.659.407 bytes)
- Origen: https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx
- SHA-256: `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`
- Runtime: onnxruntime-web 1.20.1 desde jsDelivr (`dist/ort.min.js`), SRI sha384
  `RPL/K8tc0JVaNWsunkEmCzLeieefvFX2UCRLKLmLVChCI6P+CTKhzqF7VIeCc3Zp` (mismo archivo en dos descargas).
  El runtime descarga además `ort-wasm-simd-threaded.mjs/.wasm` del mismo directorio de jsDelivr; esos dos archivos no llevan SRI.

## Licencia
- El código de YOLOX es Apache-2.0.
- La licencia de los PESOS (yolox_nano.onnx) NO está verificada. Debe comprobarse antes de cualquier uso comercial.

## Pipeline (reproduce demo/ONNXRuntime/onnx_inference.py)
1. Letterbox arriba-izquierda sobre lienzo 416x416 con valor 114, canales BGR, layout CHW, float32 0-255, sin normalizar.
2. Decodificación con grid y strides 8/16/32.
3. score = objectness * score de clase; umbral `CONFIANZA_MINIMA` (0,55, en `src/yolo.ts`); NMS por clase con IoU 0,45.
4. Cajas reescaladas a coordenadas de la imagen original.

Nota: el demo oficial usa NMS agnóstico a la clase y umbral 0,1; aquí se usa NMS por clase y 0,55 según el requisito del producto.

## Pruebas
`npm test` compila y ejecuta `tests/yolo.decode.test.mjs`, que usa un tensor sintético solo para validar la decodificación.
