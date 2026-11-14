// Prueba unitaria de decodificarYolox con un tensor SINTÉTICO (solo test; la app no usa datos falsos).
// Uso: npm test  (compila con tsc y ejecuta este archivo contra dist/yolo.js)
import assert from 'node:assert/strict';
import { decodificarYolox, numeroAnclas, CLASES_COCO } from '../dist/yolo.js';

const N = numeroAnclas(416);          // 3549
const C = 85;
assert.equal(N, 3549);
const t = new Float32Array(N * C);
// Todas las anclas: objectness 0 y log(w/h)=0
function poner(ancla, cx, cy, lw, lh, obj, cls, p) {
  const o = ancla * C;
  t[o] = cx; t[o + 1] = cy; t[o + 2] = lw; t[o + 3] = lh; t[o + 4] = obj; t[o + 5 + cls] = p;
}
const g8 = 52; // rejilla stride 8: ancla = gy*52 + gx
const L = Math.log(5);
poner(5 * g8 + 10, 0.5, 0.5, L, L, 0.9, 0, 0.8);   // persona: centro (84,44), 40x40 -> score 0.72
poner(5 * g8 + 11, 0.5, 0.5, L, L, 0.9, 0, 0.75);  // misma clase, solapada: NMS la suprime
poner(5 * g8 + 10, 0.5, 0.5, L, L, 0.9, 2, 0.78);  // otra clase, misma caja: se conserva (NMS por clase)
poner(20 * g8 + 30, 0.5, 0.5, L, L, 0.9, 1, 0.3);  // score 0.27 < 0.55: filtrada

const r = decodificarYolox(t, 0.5, 832, 832);
assert.equal(r.length, 2, `se esperaban 2 detecciones, hubo ${r.length}`);
assert.equal(r[0].clase, CLASES_COCO[0]);
assert.ok(Math.abs(r[0].confianza - 0.72) < 1e-5);
// ratio 0.5 -> coordenadas originales = doble: x=(84-20)/.5=128, y=(44-20)/.5=48, 80x80
assert.deepEqual(r[0].bbox.map(v => Math.round(v)), [128, 48, 80, 80]);
assert.equal(r[1].clase, CLASES_COCO[2]);
assert.ok(Math.abs(r[1].confianza - 0.702) < 1e-5);
// Tamaño de salida incorrecto -> error explícito
assert.throws(() => decodificarYolox(new Float32Array(10), 1, 10, 10));
console.log('OK: decodificarYolox (grid/stride, score=obj*cls, umbral, NMS por clase, escala a original)');
