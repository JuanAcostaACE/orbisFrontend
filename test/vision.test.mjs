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
