// Regresion sin DOM (K3): ningun envio NUEVO tras parar/desconectar/cambiar camara; ciclos de Auto en vuelo
// que aun no hicieron POST se abortan; un POST YA emitido no es evitable (solo se puede abortar el fetch).
// Un envio MANUAL ya iniciado no se cancela al detener Auto. Uso: npm test (dist/).
import assert from 'node:assert/strict';
import { motivoAbortoEnvio, CompuertaTransicion } from '../dist/camera/secuencia.js';

/** Modelo minimo de enviarSimulacion: captura estado al iniciar, espera (analisis) y revisa antes del fetch. */
function crearApp() {
  const app = { autoRunning: false, cicloAuto: 0, sesion: true, gate: new CompuertaTransicion(), camaraViva: true, posts: [], fetchAbortados: 0 };
  app.detenerAuto = () => { app.cicloAuto++; app.autoRunning = false; };   // igual que app.ts
  app.detenerCamara = () => { app.detenerAuto(); app.gate.invalidar(); app.camaraViva = false; };
  app.enviar = async ({ auto = false, usaCamara = false, analisis = async () => {}, signal } = {}) => {
    if (auto && (!app.autoRunning || !app.sesion)) return 'no-inicia';
    const cicloInicio = app.cicloAuto, epocaInicio = app.gate.epoca();
    const ctx = () => ({
      auto, autoActivo: app.autoRunning, cicloInicio, cicloActual: app.cicloAuto, sesionAbierta: app.sesion,
      usaCamara, camaraViva: app.camaraViva, epocaInicio, epocaActual: app.gate.epoca(), transicion: app.gate.bloqueada()
    });
    await analisis();
    const m = motivoAbortoEnvio(ctx());
    if (m) return 'abortado: ' + m;
    app.posts.push({ auto, usaCamara });
    return 'enviado';
  };
  return app;
}
const liberable = () => { let ok; const p = new Promise(r => { ok = r; }); return { p, ok }; };

// 1) Ciclo de Auto con camara en vuelo + parar camara => ningun POST
{
  const app = crearApp(); app.autoRunning = true;
  const l = liberable();
  const ciclo = app.enviar({ auto: true, usaCamara: true, analisis: () => l.p });
  app.detenerCamara();                 // el usuario pulsa Detener durante el analisis
  l.ok();
  assert.match(await ciclo, /abortado/);
  assert.equal(app.posts.length, 0);
}
// 2) Desconexion con ciclo en vuelo => ningun POST (Auto detenido + epoca invalidada)
{
  const app = crearApp(); app.autoRunning = true;
  const l = liberable();
  const ciclo = app.enviar({ auto: true, usaCamara: true, analisis: () => l.p });
  app.detenerCamara(); l.ok();
  assert.match(await ciclo, /abortado/);
  assert.equal(app.posts.length, 0);
}
// 3) Ciclo automatico con fuente ARCHIVO (sin camara) + Detener auto => ningun POST
{
  const app = crearApp(); app.autoRunning = true;
  const l = liberable();
  const ciclo = app.enviar({ auto: true, usaCamara: false, analisis: () => l.p });
  app.detenerAuto(); l.ok();
  assert.match(await ciclo, /abortado: la detecci/);
  assert.equal(app.posts.length, 0);
}
// 3b) Detener y volver a iniciar Auto antes de que termine el ciclo viejo: el viejo igualmente se aborta
{
  const app = crearApp(); app.autoRunning = true;
  const l = liberable();
  const viejo = app.enviar({ auto: true, analisis: () => l.p });
  app.detenerAuto(); app.autoRunning = true;       // Auto reiniciado
  l.ok();
  assert.match(await viejo, /abortado/);
  assert.equal(await app.enviar({ auto: true }), 'enviado');   // el ciclo nuevo si envia
}
// 4) Envio MANUAL en vuelo + Detener auto => permitido (no es un ciclo automatico)
{
  const app = crearApp(); app.autoRunning = true;
  const l = liberable();
  const manual = app.enviar({ auto: false, usaCamara: false, analisis: () => l.p });
  app.detenerAuto(); l.ok();
  assert.equal(await manual, 'enviado');
  assert.equal(app.posts.length, 1);
}
// 5) Ningun ciclo NUEVO arranca con Auto detenido, sesion cerrada o durante un cambio de camara
{
  const app = crearApp();
  assert.equal(await app.enviar({ auto: true }), 'no-inicia');          // Auto detenido
  app.autoRunning = true; app.sesion = false;
  assert.equal(await app.enviar({ auto: true }), 'no-inicia');          // sesion cerrada
  app.sesion = true; app.gate.cerrar();
  assert.match(await app.enviar({ auto: true, usaCamara: true }), /cambio de c/); // transicion
  assert.equal(app.posts.length, 0);
}
// 6) Sesion cerrada tras iniciar el ciclo => aborta
{
  const app = crearApp(); app.autoRunning = true;
  const l = liberable();
  const ciclo = app.enviar({ auto: true, analisis: () => l.p });
  app.sesion = false; l.ok();
  assert.match(await ciclo, /sesi/);
}
// 7) Fetch YA iniciado: no se puede "des-emitir"; solo abortar la peticion con AbortController
{
  let emitido = 0, abortado = 0;
  const fetchFalso = (signal) => new Promise((res, rej) => {
    emitido++;
    signal.addEventListener('abort', () => { abortado++; rej(Object.assign(new Error('abort'), { name: 'AbortError' })); });
    setTimeout(() => res('ok'), 50);
  });
  const ctl = new AbortController();
  const p = fetchFalso(ctl.signal);
  ctl.abort();                                      // parar/desconectar/cerrar sesion
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(emitido, 1);                         // la peticion ya habia salido; aqui solo se cancela su espera
  assert.equal(abortado, 1);
}
console.log('OK: regresion K3 (Auto en vuelo+parar, archivo+Detener, manual permitido, sin ciclos nuevos, abort de fetch)');
