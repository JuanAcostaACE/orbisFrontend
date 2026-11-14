// QA e2e de la camara (ControladorCamara + selector). CAMARAS SIMULADAS:
// navigator.mediaDevices se reemplaza con un fake que dibuja una imagen real en un canvas y
// expone su stream con canvas.captureStream(). No se usa ninguna webcam fisica.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.env.QA_OUT_DIR || path.join(os.tmpdir(), 'qa-camera-e2e');
fs.mkdirSync(OUT, { recursive: true });
const IMG_PATH = process.env.QA_IMG || 'C:\\Windows\\Web\\Wallpaper\\Theme1\\img1.jpg';
const API = 'http://localhost:8080';
const USER = { correo: 'qa.camera@example.test', contrasena: 'QaCam2026!' };
const C920 = { deviceId: 'dev-c920', label: 'Logitech C920s Pro HD Webcam' };
const INT  = { deviceId: 'dev-int',  label: 'Integrated Camera' };
const USB2 = { deviceId: 'dev-usb2', label: 'USB Camera 2' };
const TRES = [C920, INT, USB2];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function guardar(nombre, datos) {
  fs.writeFileSync(path.join(OUT, `${nombre}.json`), JSON.stringify(datos, null, 2));
}

// Se ejecuta en la pagina antes de cualquier script de la app.
function fakeCameraInit(cfg) {
  const qa = {
    devices: cfg.devices, mode: cfg.mode, granted: false,
    gum: [], streams: [], stops: [], liveAtGum: [], lastTrack: null, img: null, w: 0, h: 0
  };
  window.__qa = qa;
  qa.imgReady = new Promise(res => {
    const im = new Image();
    im.onload = () => { qa.img = im; qa.w = im.naturalWidth; qa.h = im.naturalHeight; res(); };
    im.onerror = () => res();
    im.src = '/__qa__/img1.jpg';
  });
  const md = new EventTarget();
  md.getSupportedConstraints = () => ({ deviceId: true, width: true, height: true });
  md.enumerateDevices = async () => qa.devices.map(d => ({
    kind: 'videoinput', deviceId: d.deviceId, groupId: 'g-sim',
    // Como un navegador real: sin permiso concedido las etiquetas llegan vacias
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
    const dev = exact ? qa.devices.find(d => d.deviceId === exact) : qa.devices[0];
    if (!dev) throw new DOMException('Requested device not found (simulada)', 'NotFoundError');
    await qa.imgReady;
    const cv = document.createElement('canvas');
    cv.width = qa.w || 640; cv.height = qa.h || 480;
    const ctx = cv.getContext('2d');
    const dibujar = () => { if (qa.img) ctx.drawImage(qa.img, 0, 0, cv.width, cv.height); };
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
  await page.route('**/__qa__/img1.jpg', route => route.fulfill({ path: IMG_PATH, contentType: 'image/jpeg' }));
  await page.addInitScript(fakeCameraInit, { devices, mode });
}

function instrumentar(page) {
  const log = { consola: [], fallidas: [], http: [], posts: [], errores_pagina: [], cargas: 0 };
  page.on('console', m => { if (m.type() === 'error') log.consola.push({ texto: m.text(), t: Date.now() }); });
  page.on('pageerror', e => log.errores_pagina.push(String(e)));
  page.on('requestfailed', r => log.fallidas.push({ url: r.url(), error: r.failure()?.errorText }));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('__qa__')) log.http.push({ metodo: r.request().method(), url: r.url(), status: r.status() }); });
  page.on('request', q => {
    if (q.method() === 'POST' && q.url().includes('/api/v1/eventos')) log.posts.push({ t: Date.now(), body: q.postData() });
  });
  page.on('load', () => { log.cargas++; });
  return log;
}

async function login(page, correo = USER.correo, contrasena = USER.contrasena) {
  await page.goto('/');
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
const textoCam = page => page.locator('#cam-status-text').textContent();
const qaDatos = page => page.evaluate(() => ({
  gum: window.__qa.gum, stops: window.__qa.stops, liveAtGum: window.__qa.liveAtGum,
  vivas: window.__qa.streams.filter(s => s.track.readyState === 'live').length
}));

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  await api.post(`${API}/auth/registro`, { data: { nombre: 'QA Camara', ...USER } }).catch(() => {});
  await api.dispose();
});

test.describe('Camara (fuentes SIMULADAS)', () => {

  test('C1 enumeracion de dispositivos', async ({ page }) => {
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    const opciones = () => page.$$eval('#cam-select option', os => os.map(o => o.textContent));
    await expect(page.locator('#cam-select option')).toHaveCount(3);
    const antes = await opciones();
    await iniciarCamara(page);
    const despues = await opciones();
    const shot = path.join(OUT, 'C1-despues.png');
    await page.screenshot({ path: shot });
    guardar('C1', { antes, despues, shot });
    expect(antes).toEqual(['Camara 1', 'Camara 2', 'Camara 3']);
    expect(despues).toEqual(['Logitech C920s Pro HD Webcam', 'Integrated Camera', 'USB Camera 2']);
  });

  test('C2 seleccion por defecto y preferencia guardada', async ({ page }) => {
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await expect(page.locator('#cam-select option')).toHaveCount(3);
    const defecto = await page.inputValue('#cam-select');
    await page.selectOption('#cam-select', 'dev-usb2');
    const guardado = await page.evaluate(() => localStorage.getItem('orbis.camara.deviceId'));
    await page.reload();
    await expect(page.locator('#pantalla-dashboard')).toBeVisible({ timeout: 15000 });
    await activarCamara(page);
    await expect(page.locator('#cam-select option')).toHaveCount(3);
    const restaurado = await page.inputValue('#cam-select');
    guardar('C2', { defecto, guardado, restaurado });
    expect(defecto).toBe('dev-c920');
    expect(guardado).toBe('dev-usb2');
    expect(restaurado).toBe('dev-usb2');
  });

  test('C2b variante: C920 no es la primera de la lista', async ({ page }) => {
    await setupCamera(page, { devices: [INT, USB2, C920] });
    await loginOk(page);
    await activarCamara(page);
    await expect(page.locator('#cam-select option')).toHaveCount(3);
    const defecto = await page.inputValue('#cam-select');
    await iniciarCamara(page);
    const trasArrancar = await page.inputValue('#cam-select');
    const trasTexto = await textoCam(page);
    guardar('C2b', { defecto, trasArrancar, trasTexto });
    expect(defecto).toBe('dev-c920');
  });

  test('C3 una sola camara', async ({ page }) => {
    await setupCamera(page, { devices: [C920] });
    await loginOk(page);
    await activarCamara(page);
    await expect(page.locator('#cam-select option')).toHaveCount(1);
    const visible = await page.locator('#cam-select').isVisible();
    const habilitado = await page.locator('#cam-select').isEnabled();
    await iniciarCamara(page);
    const qa = await qaDatos(page);
    guardar('C3', { visible, habilitado, gum: qa.gum });
    expect(visible).toBe(true);
    expect(habilitado).toBe(true);
    expect(qa.gum.at(-1).exact).toBe('dev-c920');
  });

  test('C4 inicio, preview en vivo y proporcion', async ({ page }) => {
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await page.waitForFunction(() => {
      const v = document.getElementById('cam-video');
      return v.readyState >= 2 && !v.paused && v.currentTime > 0;
    }, null, { timeout: 15000 });
    const datos = await page.evaluate(() => {
      const v = document.getElementById('cam-video');
      const r = v.getBoundingClientRect();
      const st = window.__qa.streams.at(-1).track.getSettings();
      return {
        playing: !v.paused, readyState: v.readyState, intrinsico: [v.videoWidth, v.videoHeight],
        caja: [Math.round(r.width), Math.round(r.height)], cajaRatio: +(r.width / r.height).toFixed(4),
        intrinsecoRatio: +(v.videoWidth / v.videoHeight).toFixed(4), objectFit: getComputedStyle(v).objectFit,
        getSettings: [st.width, st.height]
      };
    });
    const estado = await textoCam(page);
    const resolucion = await page.locator('#cam-resolution').textContent();
    const dispositivo = await page.locator('#cam-device').textContent();
    const shot = path.join(OUT, 'C4-en-vivo.png');
    await page.locator('#panel-cam').screenshot({ path: shot });
    guardar('C4', { ...datos, estado, resolucion, dispositivo, shot });
    expect(datos.playing).toBe(true);
    expect(estado).toBe('En vivo — Logitech C920s Pro HD Webcam');
    expect(resolucion).toBe(`${datos.getSettings[0]} × ${datos.getSettings[1]}`);
    expect(datos.objectFit).toBe('contain');
  });

  test('C5 cambio de camara en vivo sin recargar', async ({ page }) => {
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await page.evaluate(() => { window.__qaMarcador = 'sobrevive'; });
    const qaAntes = await qaDatos(page);
    const navAntes = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    await page.selectOption('#cam-select', 'dev-usb2');
    await expect(page.locator('#cam-status-text')).toHaveText('En vivo — USB Camera 2', { timeout: 20000 });
    const qa = await qaDatos(page);
    const marcador = await page.evaluate(() => window.__qaMarcador);
    const navDespues = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    const shot = path.join(OUT, 'C5-usb2.png');
    await page.screenshot({ path: shot });
    const stopC920 = qa.stops.find(s => s.deviceId === 'dev-c920');
    guardar('C5', { stopC920, gumTrasCambio: qa.gum.at(-1), liveAtGum: qa.liveAtGum, vivasAntes: qaAntes.vivas, vivasDespues: qa.vivas, marcador, navAntes, navDespues, shot });
    expect(stopC920).toBeTruthy();
    expect(qa.gum.at(-1).exact).toBe('dev-usb2');
    expect(marcador).toBe('sobrevive');
    expect(navDespues).toBe(navAntes);
    expect(qa.liveAtGum.every(n => n === 0)).toBe(true);
    expect(qa.vivas).toBe(1);
  });

  test('C6 deteccion se detiene al parar la camara (Auto)', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(11000);
    const postsAntesDeParar = log.posts.length;
    const tParar = Date.now();
    await page.click('#btn-cam-stop');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'sin-camara');
    const botonAuto = await page.locator('#btn-sim-auto').textContent();
    await sleep(12000);
    const postsTrasParar = log.posts.filter(p => p.t >= tParar).length;
    const qa = await qaDatos(page);
    guardar('C6', { postsAntesDeParar, postsTrasParar, botonAutoTrasParar: botonAuto, vivas: qa.vivas, cuerpos: log.posts.map(p => p.body) });
    expect(postsTrasParar).toBe(0);
    expect(qa.vivas).toBe(0);
  });

  test('C7 permiso denegado con mensaje y reintento', async ({ page }) => {
    await setupCamera(page, { mode: 'deny' });
    await loginOk(page);
    await activarCamara(page);
    await page.click('#btn-cam-start');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'error');
    const mensaje = await textoCam(page);
    const reintentar = await page.locator('#btn-cam-retry').isVisible();
    const shot = path.join(OUT, 'C7-denegado.png');
    await page.screenshot({ path: shot });
    await page.evaluate(() => { window.__qa.mode = 'ok'; });
    await page.click('#btn-cam-retry');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'en-vivo', { timeout: 20000 });
    const dashboard = await page.locator('#pantalla-dashboard').isVisible();
    const correo = await page.locator('#usuario-correo').textContent();
    await page.click('#btn-refresh');
    await sleep(1500);
    const bannerVisible = await page.locator('#error-banner').isVisible();
    guardar('C7', { mensaje, reintentar, shot, dashboard, correo, bannerVisible });
    expect(mensaje).toContain('Permiso de cámara denegado');
    expect(reintentar).toBe(true);
    expect(dashboard).toBe(true);
    expect(correo).toBe(USER.correo);
  });

  test('C8 camara ocupada y no encontrada', async ({ page }) => {
    const errores = [];
    page.on('pageerror', e => errores.push(String(e)));
    await setupCamera(page, { mode: 'busy' });
    await loginOk(page);
    await activarCamara(page);
    await page.click('#btn-cam-start');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'error');
    const ocupada = await textoCam(page);
    const shotBusy = path.join(OUT, 'C8-ocupada.png');
    await page.screenshot({ path: shotBusy });
    await page.evaluate(() => { window.__qa.mode = 'notfound'; });
    await page.click('#btn-cam-retry');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'error', { timeout: 15000 });
    await sleep(500);
    const noEncontrada = await textoCam(page);
    const dashboard = await page.locator('#pantalla-dashboard').isVisible();
    guardar('C8', { ocupada, noEncontrada, dashboard, pageerrors: errores, shotBusy });
    expect(ocupada).toContain('en uso por otra aplicación');
    expect(noEncontrada).toContain('No se encontró ninguna cámara');
    expect(errores).toEqual([]);
    expect(dashboard).toBe(true);
  });

  test('C9 desconexion y recuperacion', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    await sleep(2000);
    await page.evaluate(() => window.__qa.lastTrack.dispatchEvent(new Event('ended')));
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'desconectada', { timeout: 5000 });
    const texto = await textoCam(page);
    const botonAuto = await page.locator('#btn-sim-auto').textContent();
    const tDesc = Date.now();
    await sleep(7000);
    const postsTrasDesconexion = log.posts.filter(p => p.t >= tDesc).length;
    const dashboard = await page.locator('#pantalla-dashboard').isVisible();
    await page.click('#btn-refresh');
    await sleep(1000);
    await page.selectOption('#cam-select', 'dev-usb2');
    await page.click('#btn-cam-start');
    await expect(page.locator('#cam-status')).toHaveAttribute('data-estado', 'en-vivo', { timeout: 20000 });
    const recuperado = await textoCam(page);
    const qa = await qaDatos(page);
    guardar('C9', { texto, botonAuto, postsTrasDesconexion, dashboard, recuperado, gum: qa.gum, stops: qa.stops, pageerrors: log.errores_pagina });
    expect(texto).toContain('La cámara se desconectó');
    expect(botonAuto).toMatch(/Auto/);
    expect(postsTrasDesconexion).toBe(0);
    expect(dashboard).toBe(true);
    expect(recuperado).toBe('En vivo — USB Camera 2');
  });

  test('C10 deteccion IA sobre la camara seleccionada', async ({ page }) => {
    await setupCamera(page);
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await expect(page.locator('#ia-status')).toContainText('listo', { timeout: 90000 }).catch(() => {});
    const iaEstado = await page.locator('#ia-status').textContent();
    await page.click('#btn-sim-enviar');
    await sleep(15000);
    const resultado = await page.locator('#sim-result').textContent();
    const shot = path.join(OUT, 'C10-ia.png');
    await page.screenshot({ path: shot });
    const r = await page.request.get(`${API}/api/v1/eventos?page=0&size=1`);
    const ultimo = (await r.json()).contenido?.[0] ?? null;
    guardar('C10', { iaEstado, resultado, ultimoEvento: ultimo, shot });
    expect(iaEstado).toContain('listo');
    expect(ultimo?.etiquetasIA).toMatch(/person/i);
  });

  test('C11 manual y automatico sin duplicados', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await loginOk(page);
    await page.selectOption('#sim-modo', 'PASIVO');
    await page.click('#btn-sim-enviar');
    await expect(page.locator('#sim-result')).toContainText(/Evento #|Error|cooldown/, { timeout: 15000 });
    await sleep(1000);
    const manualPosts = log.posts.length;
    const manualTexto = await page.locator('#sim-result').textContent();
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Detener/);
    const tIni = Date.now();
    await sleep(16000);
    const autoPosts = log.posts.filter(p => p.t >= tIni);
    await page.click('#btn-sim-auto');
    await expect(page.locator('#btn-sim-auto')).toHaveText(/Auto/);
    const tParo = Date.now();
    await sleep(12000);
    const trasParo = log.posts.filter(p => p.t >= tParo).length;
    const tiempos = autoPosts.map(p => p.t);
    const gaps = tiempos.slice(1).map((t, i) => t - tiempos[i]);
    guardar('C11', { manualPosts, manualTexto, autoPosts: autoPosts.length, gapsMs: gaps, trasParo, cuerpos: log.posts.map(p => p.body) });
    expect(manualPosts).toBe(1);
    expect(trasParo).toBe(0);
    expect(gaps.every(g => g >= 4500)).toBe(true);
  });

  test('C12 regresion: login, logout y subida de foto', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await page.goto('/');
    await page.fill('#login-correo', USER.correo);
    await page.fill('#login-pass', 'Incorrecta123');
    await page.click('#btn-login');
    await expect(page.locator('#auth-mensaje')).toContainText('Credenciales incorrectas', { timeout: 10000 });
    const msgError = await page.locator('#auth-mensaje').textContent();
    await page.fill('#login-pass', USER.contrasena);
    await page.click('#btn-login');
    await expect(page.locator('#pantalla-dashboard')).toBeVisible({ timeout: 15000 });
    await activarCamara(page);
    await page.click('#btn-src-file');
    await page.setInputFiles('#sim-imagen', IMG_PATH);
    await expect(page.locator('#sim-preview')).toBeVisible();
    await page.click('#btn-sim-enviar');
    await expect(page.locator('#sim-result')).toContainText(/Evento #|Error/, { timeout: 60000 });
    const resultadoSubida = await page.locator('#sim-result').textContent();
    await page.click('#btn-logout');
    await expect(page.locator('#pantalla-auth')).toBeVisible();
    const shot = path.join(OUT, 'C12-logout.png');
    await page.screenshot({ path: shot });
    guardar('C12', { msgError, resultadoSubida, shot, http: log.http });
    expect(msgError).toContain('Credenciales incorrectas');
    expect(resultadoSubida).toContain('Evento #');
  });

  test('C13 responsive sin desbordamiento horizontal', async ({ page }) => {
    await setupCamera(page);
    const medidas = {};
    for (const [nombre, vp] of [['375x812', { width: 375, height: 812 }], ['1280x800', { width: 1280, height: 800 }]]) {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.fill('#login-correo', USER.correo);
      await page.fill('#login-pass', USER.contrasena);
      await page.click('#btn-login');
      await expect(page.locator('#pantalla-dashboard')).toBeVisible({ timeout: 15000 });
      await activarCamara(page);
      await page.locator('#cam-select').scrollIntoViewIfNeeded();
      const m = await page.evaluate(() => {
        const s = document.getElementById('cam-select').getBoundingClientRect();
        return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
          selectDentro: s.left >= 0 && s.right <= window.innerWidth };
      });
      await page.screenshot({ path: path.join(OUT, `C13-${nombre}.png`) });
      medidas[nombre] = m;
      await page.evaluate(() => { localStorage.clear(); });
      await page.context().clearCookies();
    }
    guardar('C13', medidas);
    for (const m of Object.values(medidas)) {
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      expect(m.selectDentro).toBe(true);
    }
  });

  test('C14 consola y red', async ({ page }) => {
    const log = instrumentar(page);
    await setupCamera(page);
    await page.goto('/');
    await sleep(2000);
    await page.fill('#login-correo', USER.correo);
    await page.fill('#login-pass', 'Incorrecta123');
    await page.click('#btn-login');
    await expect(page.locator('#auth-mensaje')).toContainText('Credenciales incorrectas');
    await loginOk(page);
    await activarCamara(page);
    await iniciarCamara(page);
    await page.click('#btn-cam-stop');
    await sleep(1000);
    guardar('C14', { consola: log.consola, fallidas: log.fallidas, http: log.http, pageerrors: log.errores_pagina });
    expect(log.errores_pagina).toEqual([]);
  });
});
