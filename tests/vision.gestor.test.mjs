// Pruebas de GestorVision (throttle y cooldown de duplicados) con proveedor FALSO y reloj inyectado.
// Sin red ni modelo: el proveedor es un stub y el tiempo se controla a mano.
// Uso: npm test  (compila con tsc y ejecuta este archivo contra dist/vision.js)
import assert from 'node:assert/strict';
import { GestorVision } from '../dist/vision.js';

const INTERVALO_MS = 1200;   // minInferenceMs por defecto
const COOLDOWN_MS  = 5000;   // cooldownDeduplicacionMs por defecto

/** Crea un gestor con proveedor stub y reloj controlado (ms). */
function crearGestor(detecciones = [{ clase: 'persona', confianza: 0.9 }]) {
  const estado = { ahora: 10_000, fallar: false, llamadas: 0 };
  const proveedor = {
    nombre: 'stub',
    inicializar: async () => {},
    listo: () => true,
    liberar: () => {},
    inferir: async () => {
      estado.llamadas++;
      if (estado.fallar) throw new Error('fallo simulado');
      return detecciones.map(d => ({ ...d, timestamp: estado.ahora }));
    }
  };
  const reloj = { perf: () => estado.ahora, wall: () => estado.ahora };
  const gestor = new GestorVision(proveedor, {}, reloj);
  return { gestor, estado };
}

const ELEMENTO = {};

// (a) Una inferencia fallida no bloquea el siguiente intento dentro del intervalo normal
{
  const { gestor, estado } = crearGestor();
  estado.fallar = true;
  await assert.rejects(() => gestor.inferir(ELEMENTO));
  estado.fallar = false;
  estado.ahora += 1;                           // 1 ms después del fallo
  const r = await gestor.inferir(ELEMENTO);
  assert.notEqual(r.estado, 'omitida', 'tras un fallo el siguiente intento no debe ser omitido por throttle');
  assert.equal(r.estado, 'ok');
  assert.equal(estado.llamadas, 2);
  console.log('OK (a): fallo de inferencia no consume el intervalo');
}

// (b) Una inferencia correcta sigue aplicando el throttle de 1.2 s
{
  const { gestor, estado } = crearGestor();
  const r1 = await gestor.inferir(ELEMENTO);
  assert.equal(r1.estado, 'ok');
  estado.ahora += INTERVALO_MS - 1;            // 1199 ms: aún dentro del intervalo
  const r2 = await gestor.inferir(ELEMENTO);
  assert.deepEqual(r2, { estado: 'omitida', motivo: 'throttle' });
  assert.equal(estado.llamadas, 1, 'no debe llamarse al proveedor dentro del intervalo');
  estado.ahora += 1;                           // 1200 ms: intervalo cumplido
  const r3 = await gestor.inferir(ELEMENTO);
  assert.notEqual(r3.estado, 'omitida');
  assert.equal(estado.llamadas, 2);
  console.log('OK (b): inferencia correcta aplica throttle de 1.2 s');
}

// (c) Si el POST falla (no se llama a confirmarEnvio), el cooldown de duplicados NO se activa
{
  const { gestor, estado } = crearGestor();
  const r1 = await gestor.inferir(ELEMENTO);
  assert.equal(r1.estado, 'ok');
  assert.equal(r1.esDuplicado, false);
  // Simulación: el POST falla -> no se confirma el envío
  estado.ahora += INTERVALO_MS + 100;
  const r2 = await gestor.inferir(ELEMENTO);
  assert.equal(r2.estado, 'ok');
  assert.equal(r2.esDuplicado, false, 'tras un POST fallido la siguiente detección debe poder enviarse');
  console.log('OK (c): POST fallido no activa cooldown de duplicados');
}

// (d) Si el POST tiene éxito (confirmarEnvio), la misma clase queda en cooldown
{
  const { gestor, estado } = crearGestor();
  const r1 = await gestor.inferir(ELEMENTO);
  assert.equal(r1.esDuplicado, false);
  gestor.confirmarEnvio(r1);
  estado.ahora += INTERVALO_MS + 100;
  const r2 = await gestor.inferir(ELEMENTO);
  assert.equal(r2.estado, 'ok');
  assert.equal(r2.esDuplicado, true, 'tras un POST correcto la misma clase debe marcarse duplicada');
  // Fuera del cooldown de 5 s vuelve a enviarse
  estado.ahora += COOLDOWN_MS;
  const r3 = await gestor.inferir(ELEMENTO);
  assert.equal(r3.esDuplicado, false, 'pasado el cooldown no debe ser duplicado');
  console.log('OK (d): POST correcto activa cooldown de duplicados (5 s)');
}

// (d2) Una detección duplicada no renueva el cooldown ni se confirma como envío nuevo
{
  const { gestor, estado } = crearGestor();
  const r1 = await gestor.inferir(ELEMENTO);
  gestor.confirmarEnvio(r1);                   // cooldown desde t0
  estado.ahora += INTERVALO_MS + 100;          // t0+1300
  const dup = await gestor.inferir(ELEMENTO);
  assert.equal(dup.esDuplicado, true);
  gestor.confirmarEnvio(dup);                  // no debe renovar el cooldown
  estado.ahora += COOLDOWN_MS - 1300 + 1;      // t0+5001: cooldown original ya vencido
  const r3 = await gestor.inferir(ELEMENTO);
  assert.equal(r3.esDuplicado, false, 'confirmar un duplicado no debe extender el cooldown');
  console.log('OK (d2): confirmar un duplicado no renueva el cooldown');
}

console.log('OK: GestorVision (throttle tras fallo, throttle tras éxito, cooldown solo tras POST correcto)');
