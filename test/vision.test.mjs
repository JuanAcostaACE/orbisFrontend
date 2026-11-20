// Tests de GestorVision (src/vision.ts) con un proveedor falso: sin TF.js ni navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GestorVision, MENSAJE_ERROR_MODELO } from '../dist/vision.js';

/** Proveedor de prueba: devuelve las detecciones que se le indiquen. */
function proveedorFalso({ nombre = 'Falso', listo = true, detecciones = [], falloAlCargar = false } = {}) {
  return {
    nombre,
    cargado: listo,
    llamadas: 0,
    listo() { return this.cargado; },
    async inicializar() {
      if (falloAlCargar) throw new Error('no carga');
      this.cargado = true;
    },
    async inferir() { this.llamadas++; return detecciones; },
    liberar() { this.cargado = false; }
  };
}

const det = (clase, confianza) => ({ clase, confianza, timestamp: 0 });
const SIN_ESPERA = { minInferenceMs: 0 };

test('GestorVision: omite la inferencia si el modelo no está listo', async () => {
  const p = proveedorFalso({ listo: false });
  const g = new GestorVision(p, null, SIN_ESPERA);
  assert.deepEqual(await g.inferir({}), { estado: 'omitida', motivo: 'no_listo' });
  assert.equal(p.llamadas, 0);
});

test('GestorVision: throttle entre inferencias seguidas', async () => {
  const p = proveedorFalso({ detecciones: [det('Silla', 0.9)] });
  const g = new GestorVision(p, null, { minInferenceMs: 60_000 });
  // La primera llamada puede ejecutarse u omitirse según cuánto lleve vivo el proceso
  // (performance.now() empieza en 0); la segunda, inmediata, siempre cae en el throttle.
  await g.inferir({});
  const antes = p.llamadas;
  const segunda = await g.inferir({});
  assert.deepEqual(segunda, { estado: 'omitida', motivo: 'throttle' });
  assert.equal(p.llamadas, antes, 'el proveedor no se llama durante el throttle');
});

test('GestorVision: una inferencia en curso bloquea la siguiente (mutex)', async () => {
  let liberar;
  const p = proveedorFalso();
  p.inferir = () => new Promise(r => { liberar = () => r([det('Persona', 0.9)]); });
  const g = new GestorVision(p, null, SIN_ESPERA);
  const enCurso = g.inferir({});
  assert.deepEqual(await g.inferir({}), { estado: 'omitida', motivo: 'ocupado' });
  liberar();
  assert.equal((await enCurso).estado, 'ok');
});

test('GestorVision: descarta detecciones bajo el umbral de confianza', async () => {
  const p = proveedorFalso({ detecciones: [det('Gato', 0.30), det('Perro', 0.54)] });
  const g = new GestorVision(p, null, { ...SIN_ESPERA, minConfianza: 0.55 });
  assert.deepEqual(await g.inferir({}), { estado: 'sin_deteccion' });
});

test('GestorVision: ordena por confianza y formatea las etiquetas', async () => {
  const p = proveedorFalso({ detecciones: [det('Silla', 0.60), det('Persona', 0.91), det('Gato', 0.2)] });
  const g = new GestorVision(p, null, SIN_ESPERA);
  const r = await g.inferir({});
  assert.equal(r.estado, 'ok');
  assert.deepEqual(r.detecciones.map(d => d.clase), ['Persona', 'Silla']);
  assert.equal(r.etiquetasFormateadas, 'Persona (91%), Silla (60%)');
  assert.equal(r.proveedor, 'Falso');
});

test('GestorVision: la misma clase dentro del cooldown es un duplicado', async () => {
  const p = proveedorFalso({ detecciones: [det('Puerta', 0.8)] });
  const g = new GestorVision(p, null, { ...SIN_ESPERA, cooldownDeduplicacionMs: 60_000 });
  assert.equal((await g.inferir({})).esDuplicado, false);
  assert.equal((await g.inferir({})).esDuplicado, true);
});

test('GestorVision: otra clase dentro del cooldown no es duplicado', async () => {
  const p = proveedorFalso({ detecciones: [det('Puerta', 0.8)] });
  const g = new GestorVision(p, null, { ...SIN_ESPERA, cooldownDeduplicacionMs: 60_000 });
  await g.inferir({});
  p.inferir = async () => [det('Escalera', 0.8)];
  assert.equal((await g.inferir({})).esDuplicado, false);
});

test('GestorVision: sin cooldown nunca hay duplicados', async () => {
  const p = proveedorFalso({ detecciones: [det('Puerta', 0.8)] });
  const g = new GestorVision(p, null, { ...SIN_ESPERA, cooldownDeduplicacionMs: 0 });
  await g.inferir({});
  assert.equal((await g.inferir({})).esDuplicado, false);
});

test('GestorVision: una distancia crítica salta el cooldown', async () => {
  const p = proveedorFalso({ detecciones: [det('Poste', 0.8)] });
  const g = new GestorVision(p, null, { ...SIN_ESPERA, cooldownDeduplicacionMs: 60_000 });
  await g.inferir({});
  assert.equal((await g.inferir({}, 20, 30)).esDuplicado, false, '20 cm < 30 cm');
  assert.equal((await g.inferir({}, 50, 30)).esDuplicado, true, '50 cm no es crítico');
});

test('GestorVision: usa el fallback si el proveedor primario no carga', async () => {
  const primario = proveedorFalso({ nombre: 'Primario', listo: false, falloAlCargar: true });
  const respaldo = proveedorFalso({ nombre: 'Respaldo', listo: false, detecciones: [det('Mesa', 0.7)] });
  const g = new GestorVision(primario, respaldo, SIN_ESPERA);
  const errores = console.error; console.error = () => {};
  try {
    assert.equal(await g.inicializarAsync(), 'Respaldo (fallback)');
  } finally { console.error = errores; }
  assert.equal(g.listo(), true);
  assert.equal((await g.inferir({})).proveedor, 'Respaldo');
});

test('GestorVision: si ningún modelo carga, lanza el mensaje para el usuario', async () => {
  const errores = console.error; console.error = () => {};
  try {
    const sinRespaldo = new GestorVision(proveedorFalso({ listo: false, falloAlCargar: true }));
    await assert.rejects(sinRespaldo.inicializarAsync(), { message: MENSAJE_ERROR_MODELO });
    const ambosFallan = new GestorVision(
      proveedorFalso({ listo: false, falloAlCargar: true }),
      proveedorFalso({ listo: false, falloAlCargar: true }));
    await assert.rejects(ambosFallan.inicializarAsync(), { message: MENSAJE_ERROR_MODELO });
  } finally { console.error = errores; }
});
