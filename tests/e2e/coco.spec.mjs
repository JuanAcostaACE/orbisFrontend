import { tiemposInit, volcarTiempos } from "./tiempos-init.mjs";
// QA e2e del detector por defecto COCO-SSD con camaras SIMULADAS (no hay webcam fisica).
// Frame positivo: img1.jpg (wallpaper). Frame negativo: gris solido.
// Criterio de medicion: TODOS los instantes de las ventanas son performance.now() de la pagina
// (window.__t, ver tiempos-init.mjs). El reloj de Playwright/Node no se usa para comparar POST con paradas.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.env.QA_OUT_DIR || path.join(os.tmpdir(), 'qa-coco-e2e');
fs.mkdirSync(OUT, { recursive: true });
const IMG_PATH = process.env.QA_IMG || 'C:\\Windows\\Web\\Wallpaper\\Theme1\\img1.jpg';
const API = 'http://localhost:8080';
const USER = { correo: 'qa.camera@example.test', contrasena: 'QaCam2026!' };
const C920 = { deviceId: 'dev-c920', label: 'Logitech C920s Pro HD Webcam' };
const INT  = { deviceId: 'dev-int',  label: 'Integrated Camera' };
const USB2 = { deviceId: 'dev-usb2', label: 'USB Camera 2' };
const TRES = [C920, INT, USB2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const guardar = (n, d) => fs.writeFileSync(path.join(OUT, `${n}.json`), JSON.stringify(d, null, 2));
// Resultado por repeticion (test.describe con --repeat-each): un JSON por ejecucion
const guardarRun = (n, ti, d) => fs.writeFileSync(path.join(OUT, `${n}-r${ti.repeatEachIndex}.json`), JSON.stringify({ repeticion: ti.repeatEachIndex, ...d }, null, 2));

function fakeCameraInit(cfg) {
  const qa = {
    devices: cfg.devices, mode: cfg.mode, granted: false, gray: false,
    gum: [], streams: [], stops: [], liveAtGum: [], lastTrack: null, img: null, w: 0, h: 0,
    inf: { cur: 0, max: 0, total: 0, envuelto: false }
  };
  window.__qa = qa;
  qa.imgReady = new Promise(res => {
    const im = new Image();
    im.onload = () => { qa.img = im; qa.w = im.naturalWidth; qa.h = im.naturalHeight; res(); };
    im.onerror = () => res();
    im.src = '/__qa__/img1.jpg';
  });
  // Cuenta inferencias en vuelo del detector (COCO-SSD) envolviendo cocoSsd.load -> model.detect
  let _coco;
  Object.defineProperty(window, 'cocoSsd', {
    configurable: true,
    get() { return _coco; },
    set(v) {
      _coco = v;
      if (v && typeof v.load === 'function' && !v.__qaWrapped) {
        const L = v.load.bind(v);
        v.load = async (...a) => {
          const m = await L(...a);
          const D = m.detect.bind(m);
          m.detect = async (...b) => {
            qa.inf.cur++; qa.inf.total++;
            qa.inf.max = Math.max(qa.inf.max, qa.inf.cur);
            try { return await D(...b); } finally { qa.inf.cur--; }
          };
          return m;
        };
        v.__qaWrapped = true;
        qa.inf.envuelto = true;
      }
    }
  });
  const md = new EventTarget();
  md.getSupportedConstraints = () => ({ deviceId: true, width: true, height: true });
  md.enumerateDevices = async () => qa.devices.map(d => ({
    kind: 'videoinput', deviceId: d.deviceId, groupId: 'g-sim',
    label: qa.granted ? d.label : '', toJSON() { return this; }
  }));
  md.getUserMedia = async (c) => {
    const exact = (c && c.video && typeof c.video === 'object' && c.video.deviceId) ? (c.video.deviceId.exact ?? null) : null;
    const liveAntes = qa.streams.filter(s => s.track.readyState === 'live').length;
    qa.gum.push({ t: Date.now(), exact, mode: qa.mode });
    qa.liveAtGum.push(liveAntes);
    if (qa.mode === 'deny') throw new DOMException('Permission denied (simulada)', 'NotAllowedError');
    if (qa.mode === 'busy') throw new DOMException('Could not start video source (simulada)', 'NotReadableError');
    if (qa.mode === 'notfound') throw new DOMException('Requested device not found (simulada)', 'NotFoundError');
    if (qa.failDevice && exact === qa.failDevice) throw new DOMException('Could not start video source (simulada, dispositivo fallido)', 'NotReadableError');
    const dev = exact ? qa.devices.find(d => d.deviceId === exact) : qa.devices[0];
    if (!dev) throw new DOMException('Requested device not found (simulada)', 'NotFoundError');
    await qa.imgReady;
    const cv = document.createElement('canvas');
    cv.width = qa.w || 640; cv.height = qa.h || 480;
    const ctx = cv.getContext('2d');
    const dibujar = () => {
      if (qa.gray) { ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, cv.width, cv.height); }
      else if (qa.img) ctx.drawImage(qa.img, 0, 0, cv.width, cv.height);
    };
    dibujar();
    const timer = setInterval(dibujar, 100);
    const stream = cv.captureStream(10);
    const track = stream.getVideoTracks()[0];
    Object.defineProperty(track, 'label', { get: () => dev.label });
    track.getSettings = () => ({ width: cv.width, height: cv.height, deviceId: dev.deviceId, frameRate: 10 });
    const stopOriginal = track.stop.bind(track);
    track.stop = () => {
      qa.stops.push({ deviceId: dev.deviceId, t: Date.now(), readyStateAntes: track.readyState });
      clearInterval(timer);
      stopOriginal();
    };
    qa.granted = true;
    qa.streams.push({ deviceId: dev.deviceId, track, stream });
    qa.lastTrack = track;
    return stream;
  };
  Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true });
}

async function setupCamera(page, { devices = TRES, mode = 'ok' } = {}) {
  await page.addInitScript(tiemposInit);
  await page.route('**/__qa__/img1.jpg', route => route.fulfill({ path: IMG_PATH, contentType: 'image/jpeg' }));
  await page.addInitScript(fakeCameraInit, { devices, mode });
}

function instrumentar(page) {
  const log = { consola: [], fallidas: [], http: [], posts: [], errores_pagina: [] };
  page.on('console', m => { if (m.type() === 'error') log.consola.push(m.text()); });
  page.on('pageerror', e => log.errores_pagina.push(String(e)));
  page.on('requestfailed', r => log.fallidas.push({ url: r.url(), error: r.failure()?.errorText }));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('__qa__')) log.http.push({ metodo: r.request().method(), url: r.url(), status: r.status() }); });
  // Solo referencia (no se usa para comparar tiempos): los POST se leen de window.__t
  page.on('request', q => { if (q.method() === 'POST' && q.url().includes('/api/v1/eventos')) log.posts.push({ body: q.postData() }); });
  return log;
}

// Contador real de inferencias: envuelve cocoSsd.load -> model.detect antes de que la app cargue el modelo
async function instalarContadorCoco(page) {
  await page.evaluate(() => {
    const qa = window.__qa;
    if (!window.cocoSsd || window.cocoSsd.__qaWrapped) return;
    const L = window.cocoSsd.load.bind(window.cocoSsd);
    window.cocoSsd.load = async (...a) => {
      const m = await L(...a);
      const D = m.detect.bind(m);
      m.detect = async (...b) => {
        qa.inf.cur++; qa.inf.total++;
        qa.inf.max = Math.max(qa.inf.max, qa.inf.cur);
        // Retraso artificial del detector (solo K3c): mantiene la inferencia en vuelo
        if (qa.retrasoMs) await new Promise(r => setTimeout(r, qa.retrasoMs));
        try { return await D(...b); } finally { qa.inf.cur--; }
      };
      return m;
    };
    window.cocoSsd.__qaWrapped = true;
    qa.inf.envuelto = true;
  });
}

async function login(page, correo = USER.correo, contrasena = USER.contrasena) {
  await page.goto('/');
  await instalarContadorCoco(page);
  await page.fill('#login-correo', correo);
  await page.fill('#login-pass', contrasena);
  await page.click('#btn-login');
}
async function loginOk(page) {
  await login(page);
  await expect(page.locator('#pantalla-dashboard')).toBeVisible({ timeout: 15000 });
}
async function activarCamara(page) {
  await page.selectOption('#sim-modo', 'ACTIVO');
  await expect(page.locator('#grupo-camara')).toBeVisible();
}
async function iniciarCamara(page) {
  await page.click('#btn-cam-start');
  await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'en-vivo', { timeout: 20000 });
}
const qaDatos = page => page.evaluate(() => ({
  gum: window.__qa.gum, stops: window.__qa.stops, liveAtGum: window.__qa.liveAtGum,
  vivas: window.__qa.streams.filter(s => s.track.readyState === 'live').length, inf: window.__qa.inf
}));

// ---- Helpers de ventanas: solo relojes de pagina (window.__t) ----
const leerT = page => page.evaluate(() => window.__t);
const primera = (T, tipo, despuesDe = -Infinity) => T.marks.find(m => m.tipo === tipo && m.t > despuesDe) ?? null;
// POST con t en (desde, hasta); hasta null = sin cota superior
const postsEn = (T, desde, hasta = null) => T.fetches.filter(p => p.t > desde && (hasta === null || p.t < hasta));
const cuerpo = b => { try { const j = JSON.parse(b); return { modo: j.modo, distanciaCm: j.distanciaCm }; } catch { return { modo: null, distanciaCm: null, crudo: b }; } };
const detalle = (posts, ref) => posts.map(p => ({ tPagina: +p.t.toFixed(1), msDesdeRef: +(p.t - ref).toFixed(1), ...cuerpo(p.body), body: p.body }));

// Diagnostico con el mismo COCO-SSD (lite_mobilenet_v2) sobre el frame actual de la camara
async function diagnosticoCoco(page) {
  return page.evaluate(async () => {
    const v = document.getElementById('cam-video');
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    const m = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    const bajo = await m.detect(cv, 100, 0.1);
    const personas = bajo.filter(p => p.class === 'person');
    return {
      maxPersona: personas.length ? Math.max(...personas.map(p => p.score)) : 0,
      personasUmbral01: personas.length,
      personasUmbral055: personas.filter(p => p.score >= 0.55).length,
      top: bajo.slice(0, 5).map(p => [p.class, +p.score.toFixed(3)])
    };
  });
}
async function esperarModelo(page) {
  await expect(page.locator('#ia-status')).toContainText('listo', { timeout: 120000 });
  return page.locator('#ia-status').textContent();
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  await api.post(`${API}/auth/registro`, { data: { nombre: 'QA Camara', ...USER } }).catch(() => {});
  await api.dispose();
});

test.describe('COCO-SSD por defecto (SIMULADAS)', () => {
  test.afterEach(async ({ page }, ti) => { await volcarTiempos(page, ti, OUT); });

  test('K1 positivo: img1 en camara simulada -> persona >=0.55 y evento con etiqueta', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    const iaEstado = await esperarModelo(page);
    const diag = await diagnosticoCoco(page);
    await page.click('#btn-sim-enviar');
    await expect(page.locator('#sim-result')).toContainText(/Evento #|no detectó|Error/, { timeout: 60000 });
    const resultado = await page.locator('#sim-result').textContent();
    const ev = (await (await page.request.get(`${API}/api/v1/eventos?page=0&size=1`)).json()).contenido?.[0] ?? null;
    const shot = path.join(OUT, 'K1-positivo.png');
    await page.screenshot({ path: shot });
    const qa = await qaDatos(page);
    guardar('K1', { iaEstado, resultado, ultimoEvento: ev, diag, posts: log.posts.map(p => p.body), inf: qa.inf, shot, pageerrors: log.errores_pagina });
    expect(diag.personasUmbral055).toBeGreaterThan(0);
    expect(ev?.etiquetasIA).toMatch(/person/i);
  });

  test('K2 negativo: gris solido -> cero POST', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await page.evaluate(() => { window.__qa.gray = true; });
    await iniciarCamara(page);
    const iaEstado = await esperarModelo(page);
    const diag = await diagnosticoCoco(page);
    await sleep(1500);
    await page.click('#btn-sim-enviar');
    await expect(page.locator('#sim-result')).toContainText(/no detectó|Evento #|Error|duplicada|omitido|Análisis/, { timeout: 60000 });
    await sleep(1000);
    const resultado = await page.locator('#sim-result').textContent();
    const shot = path.join(OUT, 'K2-gris.png');
    await page.screenshot({ path: shot });
    guardar('K2', { iaEstado, diag, resultado, postsTrasEnvio: log.posts.length, shot, pageerrors: log.errores_pagina });
    expect(log.posts.length).toBe(0);
  });

  // K3: parada de camara con Auto activo (ventana: parar-camara -> siguiente iniciar-auto) y
  // desconexion con Auto activo (ventana: desconexion -> fin). El clic de iniciar Auto emite un POST
  // inmediato por diseno (iniciarAuto(true)); por eso la ventana de parada termina en ese clic.
  test('K3 parar o desconectar con Auto: cero POST tras el evento', async ({ page }, ti) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(11000);
    await page.click('#btn-cam-stop');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'sin-camara');
    await sleep(12000);
    // Fase 2: nueva conexion y Auto (inicio de Auto = fin de la ventana de parada)
    await iniciarCamara(page);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(6000);
    await page.evaluate(() => window.__qa.lastTrack.dispatchEvent(new Event('ended')));
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'desconectada', { timeout: 5000 });
    const botonAuto = await page.locator('#btn-sim-auto').textContent();
    await sleep(10000);
    const T = await leerT(page);
    const inicio1 = primera(T, 'iniciar-auto');
    const parar = primera(T, 'parar-camara');
    const inicio2 = parar ? primera(T, 'iniciar-auto', parar.t) : null;
    const desc = primera(T, 'desconexion');
    const previos = inicio1 && parar ? postsEn(T, inicio1.t, parar.t) : [];
    const ventanaParar = parar ? postsEn(T, parar.t, inicio2 ? inicio2.t : null) : [];
    const ventanaDesc = desc ? postsEn(T, desc.t, null) : [];
    const veredicto = (ventanaParar.length === 0 && ventanaDesc.length === 0 && previos.length >= 1) ? 'PASS' : 'FAIL';
    guardarRun('K3', ti, {
      veredicto, marcas: { inicioAuto1: inicio1?.t ?? null, paraCamara: parar?.t ?? null, inicioAuto2: inicio2?.t ?? null, desconexion: desc?.t ?? null },
      postsPreviosAParada: detalle(previos, parar?.t ?? 0),
      ventanaParada: { desde: parar?.t ?? null, hasta: inicio2?.t ?? null, posts: detalle(ventanaParar, parar?.t ?? 0) },
      ventanaDesconexion: { desde: desc?.t ?? null, hasta: null, posts: detalle(ventanaDesc, desc?.t ?? 0) },
      botonAutoTrasDesconexion: botonAuto, pageerrors: log.errores_pagina
    });
    expect(previos.length, 'K3: sin POST previos a la parada (prueba no valida)').toBeGreaterThanOrEqual(1);
    expect(ventanaParar.length, 'K3: POST tras parar la camara').toBe(0);
    expect(ventanaDesc.length, 'K3: POST tras desconexion').toBe(0);
  });

  test('K4 cambio de camara con Auto: anterior liberada y maximo de inferencias concurrentes', async ({ page }, ti) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(6000);
    await page.selectOption('#cam-select', 'dev-usb2');
    await expect(page.locator('#cam-status-text')).toHaveText('En vivo — USB Camera 2', { timeout: 20000 });
    await sleep(10000);
    const qa = await qaDatos(page);
    const stopC920 = qa.stops.find(s => s.deviceId === 'dev-c920');
    const T = await leerT(page);
    guardarRun('K4', ti, { stopC920, gumUltimo: qa.gum.at(-1), liveAtGum: qa.liveAtGum, vivasAhora: qa.vivas, inferenciasMaxConcurrentes: qa.inf.max, inferenciasTotales: qa.inf.total, envuelto: qa.inf.envuelto, veredicto: qa.inf.max <= 1 && qa.inf.envuelto ? 'PASS' : 'FAIL', postsPagina: T.fetches.length, pageerrors: log.errores_pagina });
    expect(stopC920).toBeTruthy();
    expect(qa.gum.at(-1).exact).toBe('dev-usb2');
    expect(qa.liveAtGum.every(n => n === 0)).toBe(true);
    expect(qa.vivas).toBe(1);
    expect(qa.inf.envuelto, 'K4: el contador de inferencias no esta instalado (prueba no valida)').toBe(true);
    expect(qa.inf.total, 'K4: sin inferencias contadas').toBeGreaterThan(0);
    expect(qa.inf.max).toBeLessThanOrEqual(1);
  });

  test('K5 manual una vez; Auto cada ~5 s sin duplicados dentro del cooldown', async ({ page }, ti) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    // Sin fijar la distancia: Auto la aleatoriza en cada ciclo (comportamiento de la simulacion)
    await page.click('#btn-sim-enviar');
    await expect(page.locator('#sim-result')).toContainText(/Evento #|no detectó|duplicada|Error/, { timeout: 60000 });
    await sleep(1500);
    await page.evaluate(() => window.__t.marks.push({ tipo: 'iniciar-auto', t: performance.now() }));
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(40000);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Auto/);
    const T = await leerT(page);
    const ini = primera(T, 'iniciar-auto');
    const par = ini ? primera(T, 'parar-auto', ini.t) : null;
    const manual = ini ? T.fetches.filter(p => p.t < ini.t).length : null;
    const ventana = ini ? postsEn(T, ini.t, par ? par.t : null) : [];
    const tiempos = ventana.map(p => p.t);
    const intervalos = tiempos.slice(1).map((t, i) => +(t - tiempos[i]).toFixed(1));
    const distancias = ventana.map(p => cuerpo(p.body).distanciaCm);
    guardarRun('K5', ti, { postsManual: manual, ventanaAuto: { inicio: ini?.t ?? null, fin: par?.t ?? null, posts: detalle(ventana, ini?.t ?? 0) }, intervalosMs: intervalos, distancias, pageerrors: log.errores_pagina });
    expect(manual).toBeLessThanOrEqual(1);
    expect(ventana.length, 'K5: menos de un POST por ciclo de 5 s').toBeGreaterThanOrEqual(3);
    const ordenados = [...intervalos].sort((a, b) => a - b);
    const mediana = ordenados.length ? ordenados[Math.floor(ordenados.length / 2)] : null;
    guardarRun('K5-criterio', ti, { medianaMs: mediana, minimoMs: ordenados[0] ?? null, paresMenoresDe2s: intervalos.filter(g => g < 2000).length });
    expect(mediana !== null && mediana >= 4000 && mediana <= 6000, 'K5: mediana de intervalos fuera de 4-6 s').toBe(true);
    expect(intervalos.filter(g => g < 2000).length, 'K5: pares de POST de Auto separados menos de 2 s').toBe(0);
  });

  test('K6 regresion: login/logout con cookie y subida de foto', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await page.goto('/');
    await page.fill('#login-correo', USER.correo);
    await page.fill('#login-pass', 'Incorrecta123');
    await page.click('#btn-login');
    await expect(page.locator('#auth-mensaje')).toContainText('Credenciales incorrectas', { timeout: 10000 });
    await page.fill('#login-pass', USER.contrasena);
    await page.click('#btn-login');
    await expect(page.locator('#pantalla-dashboard')).toBeVisible({ timeout: 15000 });
    await activarCamara(page);
    await page.click('#btn-src-file');
    await page.setInputFiles('#sim-imagen', IMG_PATH);
    await expect(page.locator('#sim-preview')).toBeVisible();
    await page.click('#btn-sim-enviar');
    await expect(page.locator('#sim-result')).toContainText(/Evento #|no detectó|Error/, { timeout: 90000 });
    const resultadoSubida = await page.locator('#sim-result').textContent();
    const ev = (await (await page.request.get(`${API}/api/v1/eventos?page=0&size=1`)).json()).contenido?.[0] ?? null;
    await page.click('#btn-logout');
    await expect(page.locator('#pantalla-auth')).toBeVisible({ timeout: 10000 });
    const sidTras = (await page.context().cookies()).find(c => c.name === 'ORBIS_SID') ?? null;
    const me = await page.request.get(`${API}/auth/me`);
    await page.reload();
    const loginVisible = await page.locator('#pantalla-auth').isVisible();
    guardar('K6', { resultadoSubida, ultimoEvento: ev, sidTras, meStatus: me.status(), loginVisible, pageerrors: log.errores_pagina });
    expect(resultadoSubida).toMatch(/Evento #|no detectó/);
    expect(sidTras).toBeNull();
    expect(me.status()).toBe(401);
    expect(loginVisible).toBe(true);
  });

  // K3c: desconexion durante un analisis en curso. Ventana: desconexion -> siguiente iniciar-auto
  // (inicio de Auto tras reconectar). Se comprueba Reintentar con espera previa del estado.
  test('K3c desconexion con un analisis en curso: 0 POST tras el evento y un Auto posterior funciona', async ({ page }, ti) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    // Retrasar el detector 6 s para que el analisis siga en vuelo al desconectar
    await page.evaluate(() => { window.__qa.retrasoMs = 6000; });
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    // Esperar a que un ciclo de Auto este analizando con la IA, y desconectar en ese instante
    const enAnalisis = await page.waitForFunction(() => /Analizando|Procesando/.test(document.getElementById('sim-result').textContent), null, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    // Lectura de inferencias en vuelo y desconexion en la misma tarea de pagina
    const infEnVuelo = await page.evaluate(() => { const c = window.__qa.inf.cur; window.__qa.retrasoMs = 0; window.__qa.lastTrack.dispatchEvent(new Event('ended')); return c; });
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'desconectada', { timeout: 5000 });
    // Esperar el texto del estado desconectada (hasta 20 s) antes de comprobar acciones
    await expect(page.locator('#cam-status-text'), 'K3c: texto de estado desconectada no aparece').toContainText('se desconectó', { timeout: 20000 });
    const botonTras = await page.locator('#btn-sim-auto').textContent();
    await sleep(10000);
    const T1 = await leerT(page);
    const desc = primera(T1, 'desconexion');
    const ventanaDesc1 = desc ? postsEn(T1, desc.t, null) : [];
    // Boton explicito del estado desconectada: "Reintentar" (#btn-cam-retry)
    const reintentar = page.locator('#btn-cam-retry');
    const visibleReintentar = await reintentar.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (!visibleReintentar) {
      const diagnostico = await page.evaluate(() => {
        const b = document.getElementById('btn-cam-retry');
        const a = document.getElementById('cam-acciones');
        const cs = b ? getComputedStyle(b) : null;
        const ca = a ? getComputedStyle(a) : null;
        return {
          estadoCam: document.getElementById('cam-status')?.getAttribute('data-estado') ?? null,
          textoCam: document.getElementById('cam-status-text')?.textContent ?? null,
          retryOuterHTML: b ? b.outerHTML : null,
          retryDisplay: cs?.display ?? null, retryVisibility: cs?.visibility ?? null, retryOpacity: cs?.opacity ?? null,
          retryRect: b ? b.getBoundingClientRect().toJSON() : null,
          accionesOuterHTML: a ? a.outerHTML.slice(0, 600) : null,
          accionesClase: a ? a.className : null, accionesDisplay: ca?.display ?? null
        };
      });
      guardarRun('K3c', ti, { veredicto: 'FAIL', motivo: 'Reintentar no visible en desconectada', infEnVuelo, enAnalisis, desconexion: desc?.t ?? null, postsTrasDesconexion: detalle(ventanaDesc1, desc?.t ?? 0), botonTrasDesconexion: botonTras, diagnosticoReintentar: diagnostico, pageerrors: log.errores_pagina });
    }
    expect(ventanaDesc1.length, 'K3c: POST tras la desconexion').toBe(0);
    expect(visibleReintentar, 'K3c: no aparece el boton Reintentar en estado desconectada (ver diagnosticoReintentar en el JSON)').toBe(true);
    await reintentar.click({ timeout: 10000 });
    await expect(page.locator('#cam-status'), 'K3c: la camara no vuelve a en-vivo tras Reintentar').toHaveAttribute('data-estado', 'en-vivo', { timeout: 15000 });
    await esperarModelo(page).catch(() => {});
    const autoBtn = page.locator('#btn-sim-auto');
    await expect(autoBtn, 'K3c: el boton Auto no esta habilitado tras reconectar').toBeEnabled({ timeout: 10000 });
    await autoBtn.click({ timeout: 10000 });
    await expect(autoBtn, 'K3c: Auto no pasa a Detener').toHaveText(/Detener/, { timeout: 5000 });
    await sleep(12000);
    await autoBtn.click({ timeout: 10000 });
    const T2 = await leerT(page);
    const desc2 = primera(T2, 'desconexion');
    const inicioTrasReconectar = desc2 ? primera(T2, 'iniciar-auto', desc2.t) : null;
    const ventanaDesc = desc2 ? postsEn(T2, desc2.t, inicioTrasReconectar ? inicioTrasReconectar.t : null) : [];
    const autoPosts = inicioTrasReconectar ? postsEn(T2, inicioTrasReconectar.t, null) : [];
    guardarRun('K3c', ti, {
      veredicto: ventanaDesc.length === 0 && autoPosts.length > 0 ? 'PASS' : 'FAIL',
      infEnVuelo, enAnalisis, desconexion: desc2?.t ?? null, inicioAutoTrasReconectar: inicioTrasReconectar?.t ?? null,
      ventanaDesconexion: detalle(ventanaDesc, desc2?.t ?? 0), postsAutoPosteriores: detalle(autoPosts, inicioTrasReconectar?.t ?? 0),
      botonTrasDesconexion: botonTras, pageerrors: log.errores_pagina
    });
    expect(ventanaDesc.length).toBe(0);
    expect(autoPosts.length).toBeGreaterThan(0);
  });

  // K7: cambio de camara con Auto. Ventana: change de #cam-select -> reanudacion de Auto
  // (primer cambio de texto a "Detener" tras el cambio; si no lo hay, en-vivo de #cam-status).
  test('K7 cambio de camara con Auto: cero POST durante la transicion y Auto se reanuda', async ({ page }, ti) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(6000);
    await page.selectOption('#cam-select', 'dev-usb2');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'en-vivo', { timeout: 20000 });
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/, { timeout: 15000 });
    await sleep(16000);
    const T = await leerT(page);
    const cambio = primera(T, 'cambio-camara');
    let fin = cambio ? primera(T, 'auto-texto', cambio.t) : null;
    let finPor = 'auto-texto';
    while (fin && !/Detener/.test(fin.texto)) fin = primera(T, 'auto-texto', fin.t);
    if (!fin && cambio) { fin = primera(T, 'estado-camara', cambio.t); finPor = 'estado-camara'; }
    // Si no hay cambio de texto, el fin de la ventana es el primer "en-vivo" y se registra
    if (!fin) finPor = 'sin-marca';
    const ventana = cambio ? postsEn(T, cambio.t, fin ? fin.t : null) : [];
    const inicioAuto = primera(T, 'iniciar-auto');
    const previos = inicioAuto && cambio ? postsEn(T, inicioAuto.t, cambio.t) : [];
    const trasReanudar = fin ? postsEn(T, fin.t, null) : [];
    const qa = await qaDatos(page);
    const botonTras = await page.locator('#btn-sim-auto').textContent();
    guardarRun('K7', ti, {
      veredicto: ventana.length === 0 && previos.length >= 1 && qa.gum.at(-1)?.exact === 'dev-usb2' ? 'PASS' : 'FAIL',
      cambio: cambio?.t ?? null, finVentana: fin ? { t: fin.t, por: finPor, texto: fin.texto ?? fin.estado ?? null } : null,
      postsPreviosAlCambio: detalle(previos, cambio?.t ?? 0),
      postsDuranteVentana: detalle(ventana, cambio?.t ?? 0),
      postsTrasReanudar: detalle(trasReanudar, fin?.t ?? 0),
      msPrimerPostTrasReanudar: trasReanudar.length && fin ? +(trasReanudar[0].t - fin.t).toFixed(1) : null,
      botonTrasValidar: botonTras, gum: qa.gum.at(-1), inferenciasMaxConcurrentes: qa.inf.max, pageerrors: log.errores_pagina
    });
    expect(previos.length, 'K7: sin POST previos al cambio (prueba no valida)').toBeGreaterThanOrEqual(1);
    expect(ventana.length, 'K7: POST durante la transicion').toBe(0);
    expect(botonTras).toMatch(/Detener/);
    expect(qa.gum.at(-1).exact).toBe('dev-usb2');
  });

  test('K8 nueva camara falla (NotReadableError): Auto parado, error con Reintentar', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    await page.evaluate(() => { window.__qa.failDevice = 'dev-usb2'; });
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(6000);
    await page.selectOption('#cam-select', 'dev-usb2');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'error', { timeout: 20000 });
    const texto = await textoCamara(page);
    const reintentar = await page.locator('#btn-cam-retry').isVisible();
    const botonAuto = await page.locator('#btn-sim-auto').textContent();
    const tErr = await page.evaluate(() => performance.now());
    await sleep(10000);
    const T = await leerT(page);
    const postsTrasError = postsEn(T, tErr, null).length;
    const shot = path.join(OUT, 'K8-error.png');
    await page.screenshot({ path: shot });
    guardar('K8', { texto, reintentar, botonAuto, postsTrasError, shot, pageerrors: log.errores_pagina });
    expect(texto).toContain('en uso por otra aplicación');
    expect(reintentar).toBe(true);
    expect(botonAuto).toMatch(/Auto/);
    expect(postsTrasError).toBe(0);
  });

  test('K9 la camara anterior se libera (stop de tracks) antes de abrir la nueva', async ({ page }) => {
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await esperarModelo(page);
    await page.click('#btn-sim-auto');
    await sleep(3000);
    await page.selectOption('#cam-select', 'dev-usb2');
    await expect(page.locator('#cam-status-text')).toHaveText('En vivo — USB Camera 2', { timeout: 20000 });
    const qa = await qaDatos(page);
    const stopC920 = qa.stops.find(s => s.deviceId === 'dev-c920');
    const gumUsb2 = qa.gum.find(g => g.exact === 'dev-usb2');
    const liberadaAntes = stopC920 && gumUsb2 ? stopC920.t <= gumUsb2.t : false;
    guardar('K9', { stopC920, gumUsb2, liberadaAntes, liveAtGum: qa.liveAtGum, vivas: qa.vivas });
    expect(liberadaAntes).toBe(true);
    expect(qa.liveAtGum.every(n => n === 0)).toBe(true);
  });
});

async function textoCamara(page) {
  return page.locator('#cam-status-text').textContent();
}
