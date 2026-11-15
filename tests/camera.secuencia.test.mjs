// Pruebas sin DOM de la secuencia de cambio de camara. Uso: npm test (dist/).
import assert from 'node:assert/strict';
import { ejecutarCambioCamara, compuertaCamara, CompuertaTransicion } from '../dist/camera/secuencia.js';

function pasos(log, { autoCorria = true, falla = null, vigenteHasta = Infinity } = {}) {
  let n = 0;
  return {
    detenerDeteccion: () => { log.push('detener'); return autoCorria; },
    esperarEnvioEnCurso: async () => { log.push('esperarEnvio'); },
    liberar: () => log.push('liberar'),
    iniciar: async () => { log.push('iniciar'); if (falla === 'iniciar') throw new Error('x'); },
    validar: async () => { log.push('validar'); if (falla === 'validar') throw new Error('sin frame'); },
    confirmar: () => log.push('confirmar'),
    finTransicion: () => log.push('finTransicion'),
    reanudar: () => log.push('reanudar'),
    vigente: () => ++n <= vigenteHasta
  };
}

// Orden completo, Auto activo antes: se reanuda al final
{
  const log = [];
  assert.equal(await ejecutarCambioCamara(pasos(log)), 'ok');
  assert.deepEqual(log, ['detener', 'esperarEnvio', 'liberar', 'iniciar', 'validar', 'confirmar', 'finTransicion', 'reanudar']);
}
// Auto NO estaba activo: no se reanuda
{
  const log = [];
  await ejecutarCambioCamara(pasos(log, { autoCorria: false }));
  assert.ok(!log.includes('reanudar'));
}
// Fallo al iniciar o al validar: lanza, nunca confirma ni reanuda (Auto queda parado)
for (const falla of ['iniciar', 'validar']) {
  const log = [];
  await assert.rejects(() => ejecutarCambioCamara(pasos(log, { falla })));
  assert.ok(!log.includes('confirmar') && !log.includes('reanudar'), `fallo en ${falla}`);
  assert.equal(log[0], 'detener');
}
// Cambio obsoleto (otro posterior lo invalida) tras esperar el envio: no libera ni reanuda
{
  const log = [];
  assert.equal(await ejecutarCambioCamara(pasos(log, { vigenteHasta: 0 })), 'obsoleto');
  assert.deepEqual(log, ['detener', 'esperarEnvio']);
}
// Obsoleto tras iniciar: no valida ni reanuda
{
  const log = [];
  assert.equal(await ejecutarCambioCamara(pasos(log, { vigenteHasta: 1 })), 'obsoleto');
  assert.ok(!log.includes('validar') && !log.includes('reanudar'));
}
// K7: un envio en vuelo termina ANTES de liberar; nada nuevo se inicia durante la transicion;
// reanudar no dispara un envio inmediato (el primero llega con el intervalo).
{
  const log = [];
  const gate = new CompuertaTransicion();
  let enVuelo = false, posts = 0;
  let terminarEnvio;
  // Mismo patron que enviarSimulacion: if (enVuelo) return; if (gate.bloqueada()) return;
  const enviar = () => {
    if (enVuelo || gate.bloqueada()) { log.push('envio-rechazado'); return null; }
    enVuelo = true; posts++; log.push('envio-inicia');
    return new Promise(res => { terminarEnvio = () => { enVuelo = false; log.push('envio-termina'); res(); }; });
  };
  const inflight = enviar();                       // envio de Auto iniciado antes del cambio
  const p = pasos(log);
  p.detenerDeteccion = () => { gate.cerrar(); log.push('detener'); return true; };
  p.esperarEnvioEnCurso = async () => { log.push('esperarEnvio'); while (enVuelo) await new Promise(r => setTimeout(r, 1)); };
  p.finTransicion = () => { gate.abrir(); log.push('finTransicion'); };
  p.iniciar = async () => { log.push('iniciar'); enviar(); enviar(); };   // intentos durante la transicion
  const cambio = ejecutarCambioCamara(p);
  await new Promise(r => setTimeout(r, 5));
  assert.ok(!log.includes('liberar'), 'no se libera con un envio en vuelo');
  terminarEnvio(); await inflight; await cambio;
  assert.ok(log.indexOf('envio-termina') < log.indexOf('liberar'), 'el envio en vuelo termina antes de liberar');
  assert.equal(posts, 1, 'ningun envio nuevo durante la transicion');
  assert.equal(log.filter(x => x === 'envio-rechazado').length, 2);
  assert.equal(log.at(-1), 'reanudar');
  assert.ok(!gate.bloqueada());
  assert.ok(compuertaCamara instanceof CompuertaTransicion);
}
console.log('OK: secuencia de cambio de camara (orden, fallo deja Auto parado, obsoletos)');
