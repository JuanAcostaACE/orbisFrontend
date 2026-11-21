// Tests de VisionManager (src/vision.ts) con un proveedor falso: sin TF.js ni navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisionManager, MODEL_ERROR_MESSAGE } from '../dist/vision.js';

/** Proveedor de prueba: devuelve las detecciones que se le indiquen. */
function fakeProvider({ name = 'Falso', ready = true, detections = [], loadFailed = false } = {}) {
  return {
    name,
    loaded: ready,
    calls: 0,
    ready() { return this.loaded; },
    async initialize() {
      if (loadFailed) throw new Error('no carga');
      this.loaded = true;
    },
    async infer() { this.calls++; return detections; },
    release() { this.loaded = false; }
  };
}

const det = (label, confidence) => ({ label, confidence, timestamp: 0 });
const NO_WAIT = { minInferenceMs: 0 };

test('VisionManager: omite la inferencia si el modelo no está listo', async () => {
  const p = fakeProvider({ ready: false });
  const g = new VisionManager(p, null, NO_WAIT);
  assert.deepEqual(await g.infer({}), { status: 'skipped', reason: 'not_ready' });
  assert.equal(p.calls, 0);
});

test('VisionManager: throttle entre inferencias seguidas', async () => {
  const p = fakeProvider({ detections: [det('Silla', 0.9)] });
  const g = new VisionManager(p, null, { minInferenceMs: 60_000 });
  // La primera llamada puede ejecutarse u omitirse según cuánto lleve vivo el proceso
  // (performance.now() empieza en 0); la segunda, inmediata, siempre cae en el throttle.
  await g.infer({});
  const before = p.calls;
  const second = await g.infer({});
  assert.deepEqual(second, { status: 'skipped', reason: 'throttle' });
  assert.equal(p.calls, before, 'el proveedor no se llama durante el throttle');
});

test('VisionManager: una inferencia en curso bloquea la siguiente (mutex)', async () => {
  let release;
  const p = fakeProvider();
  p.infer = () => new Promise(r => { release = () => r([det('Persona', 0.9)]); });
  const g = new VisionManager(p, null, NO_WAIT);
  const inProgress = g.infer({});
  assert.deepEqual(await g.infer({}), { status: 'skipped', reason: 'busy' });
  release();
  assert.equal((await inProgress).status, 'ok');
});

test('VisionManager: descarta detecciones bajo el umbral de confianza', async () => {
  const p = fakeProvider({ detections: [det('Gato', 0.30), det('Perro', 0.54)] });
  const g = new VisionManager(p, null, { ...NO_WAIT, minConfidence: 0.55 });
  assert.deepEqual(await g.infer({}), { status: 'no_detection' });
});

test('VisionManager: ordena por confianza y formatea las etiquetas', async () => {
  const p = fakeProvider({ detections: [det('Silla', 0.60), det('Persona', 0.91), det('Gato', 0.2)] });
  const g = new VisionManager(p, null, NO_WAIT);
  const r = await g.infer({});
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.detections.map(d => d.label), ['Persona', 'Silla']);
  assert.equal(r.formattedLabels, 'Persona (91%), Silla (60%)');
  assert.equal(r.provider, 'Falso');
});

test('VisionManager: la misma clase dentro del cooldown es un duplicado', async () => {
  const p = fakeProvider({ detections: [det('Puerta', 0.8)] });
  const g = new VisionManager(p, null, { ...NO_WAIT, dedupCooldownMs: 60_000 });
  assert.equal((await g.infer({})).isDuplicate, false);
  assert.equal((await g.infer({})).isDuplicate, true);
});

test('VisionManager: otra clase dentro del cooldown no es duplicado', async () => {
  const p = fakeProvider({ detections: [det('Puerta', 0.8)] });
  const g = new VisionManager(p, null, { ...NO_WAIT, dedupCooldownMs: 60_000 });
  await g.infer({});
  p.infer = async () => [det('Escalera', 0.8)];
  assert.equal((await g.infer({})).isDuplicate, false);
});

test('VisionManager: sin cooldown nunca hay duplicados', async () => {
  const p = fakeProvider({ detections: [det('Puerta', 0.8)] });
  const g = new VisionManager(p, null, { ...NO_WAIT, dedupCooldownMs: 0 });
  await g.infer({});
  assert.equal((await g.infer({})).isDuplicate, false);
});

test('VisionManager: una distancia crítica salta el cooldown', async () => {
  const p = fakeProvider({ detections: [det('Poste', 0.8)] });
  const g = new VisionManager(p, null, { ...NO_WAIT, dedupCooldownMs: 60_000 });
  await g.infer({});
  assert.equal((await g.infer({}, 20, 30)).isDuplicate, false, '20 cm < 30 cm');
  assert.equal((await g.infer({}, 50, 30)).isDuplicate, true, '50 cm no es crítico');
});

test('VisionManager: usa el fallback si el proveedor primario no carga', async () => {
  const primary = fakeProvider({ name: 'Primario', ready: false, loadFailed: true });
  const secondary = fakeProvider({ name: 'Respaldo', ready: false, detections: [det('Mesa', 0.7)] });
  const g = new VisionManager(primary, secondary, NO_WAIT);
  const errors = console.error; console.error = () => {};
  try {
    assert.equal(await g.initializeAsync(), 'Respaldo (fallback)');
  } finally { console.error = errors; }
  assert.equal(g.ready(), true);
  assert.equal((await g.infer({})).provider, 'Respaldo');
});

test('VisionManager: si ningún modelo carga, lanza el mensaje para el usuario', async () => {
  const errors = console.error; console.error = () => {};
  try {
    const withoutBackup = new VisionManager(fakeProvider({ ready: false, loadFailed: true }));
    await assert.rejects(withoutBackup.initializeAsync(), { message: MODEL_ERROR_MESSAGE });
    const bothFail = new VisionManager(
      fakeProvider({ ready: false, loadFailed: true }),
      fakeProvider({ ready: false, loadFailed: true }));
    await assert.rejects(bothFail.initializeAsync(), { message: MODEL_ERROR_MESSAGE });
  } finally { console.error = errors; }
});
