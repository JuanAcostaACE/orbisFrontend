// PARTE 1 - Paso 2: decodifica los tensores crudos con el decodificador TS COMPILADO (dist/yolo.js).
// Uso: node ts_decode.mjs <ruta/dist/yolo.js> <scratch> <salida.json> [confianza]
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [, , yoloJs, scratch, outFile, conf = '0.5'] = process.argv;
const { decodificarYolox } = await import(pathToFileURL(path.resolve(yoloJs)).href);
const meta = JSON.parse(fs.readFileSync(path.join(scratch, 'meta.json'), 'utf8'));
const res = {};
for (const [id, m] of Object.entries(meta)) {
  const b = fs.readFileSync(path.join(scratch, `raw_${id}.bin`));
  const raw = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const d = decodificarYolox(raw, m.ratio, m.ancho, m.alto, { confianza: Number(conf) });
  res[id] = d.map(x => ({ c: x.claseIdx, s: x.confianza, b: [x.bbox[0], x.bbox[1], x.bbox[0] + x.bbox[2], x.bbox[1] + x.bbox[3]] }));
}
fs.writeFileSync(outFile, JSON.stringify(res));
console.log('imagenes', Object.keys(res).length, 'dets', Object.values(res).reduce((a, v) => a + v.length, 0));
