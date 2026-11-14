// Pruebas del cooldown PASIVO tras el POST (envio-pasivo + HisteresisPasiva) con reloj inyectado.
// Sin red: la respuesta del POST es un stub. Uso: npm test (compila con tsc y ejecuta contra dist/).
import assert from 'node:assert/strict';
import { HisteresisPasiva, COOLDOWN_PASIVO_MS, UMBRAL_PELIGRO_CM } from '../dist/alertas.js';
import { registrarCooldownTrasRespuesta } from '../dist/envio-pasivo.js';

/**
 * Reproduce el orden del call site en enviarSimulacion:
 *   evaluar -> (cooldown check) -> POST -> if !ok throw -> registrar cooldown.
 * El POST se simula con un stub que devuelve { ok } o lanza error.
 */
async function intentarEnvio(histeresis, modo, postStub, ahoraMs) {
  if (modo === 'PASIVO' && !histeresis.puedeEnviar(ahoraMs)) return 'cooldown';
  try {
    const res = await postStub();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    registrarCooldownTrasRespuesta(histeresis, modo, res, ahoraMs);
    return 'enviado';
  } catch {
    return 'error';
  }
}

const POST_OK = async () => ({ ok: true, status: 201 });
const POST_500 = async () => ({ ok: false, status: 500 });
const POST_RED = async () => { throw new Error('network down'); };

// (a) POST con éxito: el cooldown queda activo
{
  const h = new HisteresisPasiva();
  const t0 = 50_000;
  assert.equal(h.evaluar(50).entroEnPeligro, true);
  assert.equal(await intentarEnvio(h, 'PASIVO', POST_OK, t0), 'enviado');
  assert.equal(h.restanteMs(t0), COOLDOWN_PASIVO_MS, 'justo tras el éxito debe faltar el cooldown completo');
  assert.equal(h.puedeEnviar(t0), false);
  console.log('OK (a): POST correcto activa el cooldown PASIVO');
}

// (b) POST fallido (no ok o error de red): el cooldown NO se activa
{
  for (const [nombre, post] of [['no ok', POST_500], ['error de red', POST_RED]]) {
    const h = new HisteresisPasiva();
    const t0 = 50_000;
    h.evaluar(50);
    assert.equal(await intentarEnvio(h, 'PASIVO', post, t0), 'error', `${nombre}: debe fallar`);
    assert.equal(h.restanteMs(t0), 0, `${nombre}: no debe registrar cooldown`);
    assert.equal(h.puedeEnviar(t0), true, `${nombre}: puedeEnviar debe seguir true`);
  }
  console.log('OK (b): POST fallido (no ok o red) no activa el cooldown');
}

// (b2) Modo ACTIVO no registra cooldown PASIVO aunque el POST sea correcto
{
  const h = new HisteresisPasiva();
  const t0 = 50_000;
  assert.equal(await intentarEnvio(h, 'ACTIVO', POST_OK, t0), 'enviado');
  assert.equal(h.puedeEnviar(t0), true, 'ACTIVO no debe activar el cooldown PASIVO');
  console.log('OK (b2): modo ACTIVO no registra cooldown PASIVO');
}

// (c) Tras un fallo se permite un nuevo intento y enPeligro se conserva
{
  const h = new HisteresisPasiva();
  const t0 = 50_000;
  assert.equal(h.evaluar(50).enPeligro, true);
  assert.equal(await intentarEnvio(h, 'PASIVO', POST_500, t0), 'error');
  // Lectura dentro de la banda 100-115 cm: el estado debe seguir en peligro
  const mitad = h.evaluar(UMBRAL_PELIGRO_CM + 5);
  assert.equal(mitad.enPeligro, true, 'el fallo no debe resetear enPeligro');
  assert.equal(mitad.salioDePeligro, false);
  assert.equal(h.puedeEnviar(t0 + 1), true, 'tras un fallo el reintento debe estar permitido');
  assert.equal(await intentarEnvio(h, 'PASIVO', POST_OK, t0 + 1), 'enviado');
  assert.equal(h.evaluar(UMBRAL_PELIGRO_CM + 5).enPeligro, true, 'el envío exitoso tampoco altera enPeligro');
  console.log('OK (c): tras un fallo se reintenta y enPeligro se conserva');
}

// (d) Duplicado dentro del cooldown se suprime; tras el cooldown se permite
{
  const h = new HisteresisPasiva();
  const t0 = 50_000;
  h.evaluar(50);
  assert.equal(await intentarEnvio(h, 'PASIVO', POST_OK, t0), 'enviado');
  assert.equal(await intentarEnvio(h, 'PASIVO', POST_OK, t0 + COOLDOWN_PASIVO_MS - 1), 'cooldown',
    'un duplicado a 1 ms antes del fin del cooldown debe suprimirse');
  assert.equal(await intentarEnvio(h, 'PASIVO', POST_OK, t0 + COOLDOWN_PASIVO_MS), 'enviado',
    'en exactamente COOLDOWN_PASIVO_MS ya debe permitirse');
  console.log('OK (d): duplicado dentro del cooldown suprimido; tras COOLDOWN_PASIVO_MS permitido');
}

console.log('OK: cooldown PASIVO solo tras envio correcto (a, b, b2, c, d)');
