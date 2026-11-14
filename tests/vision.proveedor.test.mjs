// Pruebas sin DOM: seleccion de detector (COCO por defecto, YOLOX opcional), CocoSsdProvider con
// modelo falso y mutex/no acumulacion del gestor. Uso: npm test (dist/).
import assert from 'node:assert/strict';
import { seleccionarDetector, crearProveedor, CocoSsdProvider, GestorVision, DETECTOR_POR_DEFECTO } from '../dist/vision.js';

// --- Seleccion de proveedor ---
assert.equal(DETECTOR_POR_DEFECTO, 'coco');
assert.equal(seleccionarDetector(''), 'coco');
assert.equal(seleccionarDetector('?x=1'), 'coco');
assert.equal(seleccionarDetector('?detector=yolox'), 'yolox');
assert.equal(seleccionarDetector('?detector=YOLOX'), 'yolox');
assert.equal(seleccionarDetector('?detector=otro'), 'coco');
assert.equal(crearProveedor('coco').nombre, 'COCO-SSD');
assert.equal(crearProveedor('yolox').nombre, 'YOLOX-Nano');

// --- CocoSsdProvider con modelo falso (acepta un ImageBitmap simulado) ---
{
  const p = new CocoSsdProvider();
  await assert.rejects(() => p.inicializar(), /COCO-SSD no est/);
  let cargas = 0;
  globalThis.cocoSsd = {
    load: async (o) => {
      cargas++;
      assert.equal(o.base, 'lite_mobilenet_v2');
      return { detect: async (e) => { assert.equal(e.width, 1280); return [{ class: 'person', score: 0.9, bbox: [1, 2, 3, 4] }]; } };
    }
  };
  await Promise.all([p.inicializar(), p.inicializar()]);
  assert.equal(cargas, 1, 'carga concurrente = una sola carga');
  assert.ok(p.listo());
  const d = await p.inferir({ width: 1280, height: 720 });
  assert.deepEqual([d[0].clase, d[0].confianza, d[0].bbox], ['Person', 0.9, [1, 2, 3, 4]]);
  delete globalThis.cocoSsd;
}

// --- Mutex: una sola inferencia en vuelo; las demas se omiten, no se encolan ---
{
  let enVuelo = 0, maxVuelo = 0, llamadas = 0, liberar;
  const proveedor = {
    nombre: 'stub', inicializar: async () => {}, listo: () => true, liberar: () => {},
    inferir: () => {
      llamadas++; enVuelo++; maxVuelo = Math.max(maxVuelo, enVuelo);
      return new Promise(res => { liberar = () => { enVuelo--; res([{ clase: 'A', confianza: 0.9, timestamp: 0 }]); }; });
    }
  };
  let t = 10_000;
  const g = new GestorVision(proveedor, {}, { perf: () => t, wall: () => t });
  const primera = g.inferir({});
  const rafaga = await Promise.all([g.inferir({}), g.inferir({}), g.inferir({})]);
  assert.ok(rafaga.every(r => r.estado === 'omitida' && r.motivo === 'ocupado'));
  assert.equal(llamadas, 1);
  liberar();
  assert.equal((await primera).estado, 'ok');
  // Tras terminar, el throttle sigue aplicando y no hay cola acumulada
  assert.deepEqual(await g.inferir({}), { estado: 'omitida', motivo: 'throttle' });
  t += 1300;
  const siguiente = g.inferir({});
  assert.equal(llamadas, 2);
  liberar(); await siguiente;
  assert.equal(maxVuelo, 1, 'nunca hubo dos inferencias simultaneas');
}
console.log('OK: seleccion de detector, CocoSsdProvider y mutex sin acumulacion');
