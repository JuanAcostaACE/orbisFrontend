// Pruebas sin DOM de la secuencia de cambio de camara. Uso: npm test (dist/).
import assert from 'node:assert/strict';
import { ejecutarCambioCamara } from '../dist/camera/secuencia.js';

function pasos(log, { autoCorria = true, falla = null, vigenteHasta = Infinity } = {}) {
  let n = 0;
  return {
    detenerDeteccion: () => { log.push('detener'); return autoCorria; },
    esperarEnvioEnCurso: async () => { log.push('esperarEnvio'); },
    liberar: () => log.push('liberar'),
    iniciar: async () => { log.push('iniciar'); if (falla === 'iniciar') throw new Error('x'); },
    validar: async () => { log.push('validar'); if (falla === 'validar') throw new Error('sin frame'); },
    confirmar: () => log.push('confirmar'),
    reanudar: () => log.push('reanudar'),
    vigente: () => ++n <= vigenteHasta
  };
}

// Orden completo, Auto activo antes: se reanuda al final
{
  const log = [];
  assert.equal(await ejecutarCambioCamara(pasos(log)), 'ok');
  assert.deepEqual(log, ['detener', 'esperarEnvio', 'liberar', 'iniciar', 'validar', 'confirmar', 'reanudar']);
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
console.log('OK: secuencia de cambio de camara (orden, fallo deja Auto parado, obsoletos)');
