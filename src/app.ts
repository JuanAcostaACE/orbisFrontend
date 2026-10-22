/* ================================================================
   ORBIS app.ts — Panel IoT con autenticación, paginación y IA local
   TypeScript compilado a app.js por tsc
   ================================================================ */

// ----------------------------------------------------------------
// TIPOS
// ----------------------------------------------------------------

interface EventoResponse {
  id?: number;
  modo: string;
  distanciaCm: number;
  etiquetasIA?: string | null;
  fechaHora?: string;
  obstaculoEtiqueta?: string | null;
  obstaculoNivel?: string | null;
}

/** Alias de compatibilidad (algunos paths internos aún usan RegistroEvento) */
type RegistroEvento = EventoResponse;

interface EventoRequest {
  modo: string;
  distanciaCm: number;
  etiquetasIA?: string | null;
}

interface PaginaResponse {
  contenido: EventoResponse[];
  paginaActual: number;
  tamanioPagina: number;
  totalElementos: number;
  totalPaginas: number;
  primera: boolean;
  ultima: boolean;
}

interface AuthResponse {
  id?: number;
  nombre?: string;
  correo: string;
  mensaje?: string;
}

interface Prediccion {
  className: string;
  probability: number;
}

interface MobileNetModel {
  classify(
    img: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
    topk?: number
  ): Promise<Prediccion[]>;
}

import { gestorVision, type ResultadoInferencia, type Deteccion } from './vision.js';
import { HisteresisPasiva, nivelDistancia, UMBRAL_CRITICO_CM } from './alertas.js';

declare const Chart: any;

// ----------------------------------------------------------------
// CONSTANTES
// ----------------------------------------------------------------
// En producción el frontend usa rutas relativas (/api, /auth): vercel.json las
// reescribe hacia Railway, de modo que la cookie de sesión es de PRIMERA parte
// (mismo origen) y no la bloquean las políticas de cookies de terceros.
// En local se apunta directamente al backend de desarrollo.
const IS_LOCAL     = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const API_BASE     = IS_LOCAL ? 'http://localhost:8080' : '';
const EP_EVENTOS   = `${API_BASE}/api/v1/eventos`;
const EP_AUTH      = `${API_BASE}/auth`;
const REFRESH_MS   = 15000;
const PAGE_SIZE    = 20;
const OVERLAY_TTL_MS = 6000;   // tiempo que permanecen visibles las cajas dibujadas

// ----------------------------------------------------------------
// HELPERS DOM
// ----------------------------------------------------------------
function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} no encontrado`);
  return el;
}
function getElOrNull(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ----------------------------------------------------------------
// ESTADO GLOBAL
// ----------------------------------------------------------------
let todosEventos: EventoResponse[]  = [];
let paginaActual: number            = 0;
let totalPaginas: number            = 1;
let totalEventos: number            = 0;
let chart: any | null               = null;
let chartType: 'bar' | 'line'       = 'bar';
let autoInterval: number | null     = null;
let autoRunning: boolean            = false;
let streamActivo: MediaStream | null = null;
let fuenteImagen: 'cam' | 'file'    = 'cam';
let usuarioActual: AuthResponse | null = null;
let sessionChecked: boolean         = false;
const synth: SpeechSynthesis | null = window.speechSynthesis ?? null;

// IA: última detección para deduplicación en simulador
let ultimaDeteccionSimulador: string | null = null;
let ultimoEnvioSimuladorTs = 0;

// Anti-saturación PASIVO (histéresis 100/115 cm + cooldown 5 s) — ver alertas.ts
const histeresis = new HisteresisPasiva();
let envioEnCurso = false;

// Polling del dashboard
let pollTimer: number | null = null;
let pollPausado = false;
let cargaEnCurso = false;
let ultimaFirma = '';
let dashboardListo = false;   // los listeners se registran UNA sola vez (re-login no los duplica)

// Overlay de bounding boxes
let overlayTimer: number | null = null;
let audioCtx: AudioContext | null = null;

// ----------------------------------------------------------------
// FETCH HELPER — siempre con credentials:include para cookies
// ----------------------------------------------------------------
async function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...opts,
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      ...(opts.headers ?? {})
    }
  });
}

// ----------------------------------------------------------------
// AUTENTICACIÓN
// ----------------------------------------------------------------

async function verificarSesion(): Promise<boolean> {
  try {
    const res = await apiFetch(`${EP_AUTH}/me`);
    if (res.ok) {
      const data = await res.json() as { correo: string };
      usuarioActual = { correo: data.correo };
      return true;
    }
  } catch { /* sin conexión */ }
  return false;
}

async function login(correo: string, contrasena: string): Promise<void> {
  const res = await apiFetch(`${EP_AUTH}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correo, contrasena })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ mensaje: `Error ${res.status}` }));
    throw new Error(err.mensaje ?? `HTTP ${res.status}`);
  }
  usuarioActual = await res.json() as AuthResponse;
}

async function registro(nombre: string, correo: string, contrasena: string): Promise<void> {
  const res = await apiFetch(`${EP_AUTH}/registro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, correo, contrasena })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ mensaje: `Error ${res.status}` }));
    throw new Error(err.mensaje ?? `HTTP ${res.status}`);
  }
}

async function logout(): Promise<void> {
  await apiFetch(`${EP_AUTH}/logout`, { method: 'POST' }).catch(() => {});
  usuarioActual = null;
  paginaActual = 0;
  todosEventos = [];
  mostrarPantallaAuth();
}

// ----------------------------------------------------------------
// GESTIÓN DE VISTAS
// ----------------------------------------------------------------

function mostrarPantallaAuth(): void {
  detenerPolling();
  detenerCamara();
  histeresis.reiniciar();
  limpiarPeligro();
  ultimaFirma = '';
  getEl('pantalla-auth').classList.remove('hidden');
  getEl('pantalla-dashboard').classList.add('hidden');
  limpiarFormAuth();
}

function mostrarDashboard(): void {
  getEl('pantalla-auth').classList.add('hidden');
  getEl('pantalla-dashboard').classList.remove('hidden');
  const correoEl = getElOrNull('usuario-correo');
  if (correoEl && usuarioActual) correoEl.textContent = usuarioActual.correo;
}

function limpiarFormAuth(): void {
  ['login-correo','login-pass','reg-nombre','reg-correo','reg-pass'].forEach(id => {
    const el = getElOrNull(id) as HTMLInputElement | null;
    if (el) el.value = '';
  });
  mostrarMsgAuth('');
}

function mostrarMsgAuth(msg: string, esError = true): void {
  const el = getElOrNull('auth-mensaje');
  if (!el) return;
  el.textContent = msg;
  el.className = 'auth-msg' + (esError && msg ? ' auth-msg--error' : msg ? ' auth-msg--ok' : '');
}

function mostrarTabAuth(tab: 'login' | 'registro'): void {
  getEl('tab-login').classList.toggle('active', tab === 'login');
  getEl('tab-registro').classList.toggle('active', tab === 'registro');
  getEl('form-login').classList.toggle('hidden', tab !== 'login');
  getEl('form-registro').classList.toggle('hidden', tab !== 'registro');
  mostrarMsgAuth('');
}

// ----------------------------------------------------------------
// INICIALIZACIÓN
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async (): Promise<void> => {
  // 1. Verificar sesión existente antes de mostrar cualquier UI
  const haySession = await verificarSesion();
  sessionChecked = true;

  if (haySession) {
    mostrarDashboard();
    iniciarDashboard();
  } else {
    mostrarPantallaAuth();
  }

  // ── Listeners de autenticación ──
  getEl('tab-login').addEventListener('click', () => mostrarTabAuth('login'));
  getEl('tab-registro').addEventListener('click', () => mostrarTabAuth('registro'));

  getEl('btn-login').addEventListener('click', async () => {
    const correo = (getElOrNull('login-correo') as HTMLInputElement)?.value.trim() ?? '';
    const pass   = (getElOrNull('login-pass')   as HTMLInputElement)?.value ?? '';
    if (!correo || !pass) { mostrarMsgAuth('Completa todos los campos'); return; }
    const btn = getEl('btn-login') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Iniciando...';
    try {
      await login(correo, pass);
      mostrarDashboard();
      iniciarDashboard();
    } catch (e) {
      mostrarMsgAuth((e as Error).message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Iniciar sesión';
    }
  });

  getEl('btn-registro').addEventListener('click', async () => {
    const nombre  = (getElOrNull('reg-nombre') as HTMLInputElement)?.value.trim() ?? '';
    const correo  = (getElOrNull('reg-correo') as HTMLInputElement)?.value.trim() ?? '';
    const pass    = (getElOrNull('reg-pass')   as HTMLInputElement)?.value ?? '';
    if (!nombre || !correo || !pass) { mostrarMsgAuth('Completa todos los campos'); return; }
    const btn = getEl('btn-registro') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Registrando...';
    try {
      await registro(nombre, correo, pass);
      mostrarMsgAuth('Cuenta creada. Ahora inicia sesión.', false);
      mostrarTabAuth('login');
    } catch (e) {
      mostrarMsgAuth((e as Error).message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear cuenta';
    }
  });

  getElOrNull('btn-logout')?.addEventListener('click', logout);
});

function iniciarDashboard(): void {
  paginaActual = 0;
  ultimaFirma = '';
  void cargarEventos({ forzar: true });
  iniciarPolling();
  refrescarEstado();

  if (dashboardListo) return;
  dashboardListo = true;

  cargarModeloIA().catch(() => {});

  getEl('btn-refresh').addEventListener('click', () => { paginaActual = 0; void cargarEventos({ forzar: true }); });
  getEl('btn-poll-toggle').addEventListener('click', togglePolling);
  getEl('btn-chart-bar').addEventListener('click', () => cambiarChart('bar'));
  getEl('btn-chart-line').addEventListener('click', () => cambiarChart('line'));

  (getEl('sim-distancia') as HTMLInputElement).addEventListener('input', function(): void {
    const valor = parseFloat((this as HTMLInputElement).value);
    const lbl = getElOrNull('sim-distancia-val');
    if (lbl) lbl.textContent = `${valor} cm`;
    // Alerta local inmediata (sin red). El POST solo ocurre al ENTRAR en peligro y fuera de cooldown.
    procesarDistanciaSimulador(valor, true);
  });

  getEl('btn-sim-enviar').addEventListener('click', () => { void enviarSimulacion(); });
  getEl('btn-sim-auto').addEventListener('click', toggleAuto);

  const filtroModo   = getEl('filtro-modo')   as HTMLSelectElement;
  const filtroBuscar = getEl('filtro-buscar') as HTMLInputElement;
  filtroModo.addEventListener('change', renderTabla);
  filtroBuscar.addEventListener('input', renderTabla);

  (getEl('sim-modo') as HTMLSelectElement).addEventListener('change', function(): void {
    const grupo = getElOrNull('grupo-camara');
    if (grupo) grupo.classList.toggle('hidden', (this as HTMLSelectElement).value !== 'ACTIVO');
  });

  getEl('btn-src-cam').addEventListener('click', () => cambiarFuente('cam'));
  getEl('btn-src-file').addEventListener('click', () => cambiarFuente('file'));
  getEl('btn-cam-start').addEventListener('click', iniciarCamara);
  getEl('btn-cam-stop').addEventListener('click', detenerCamara);

  (getEl('sim-imagen') as HTMLInputElement).addEventListener('change', function(): void {
    const p = getElOrNull('sim-preview') as HTMLImageElement | null;
    const input = this as HTMLInputElement;
    if (p && input.files?.[0]) {
      p.src = URL.createObjectURL(input.files[0]);
      p.classList.remove('hidden');
    }
  });

  // Paginación
  getElOrNull('btn-pag-prev')?.addEventListener('click', () => {
    if (paginaActual > 0) { paginaActual--; cargarEventos(); }
  });
  getElOrNull('btn-pag-next')?.addEventListener('click', () => {
    if (paginaActual < totalPaginas - 1) { paginaActual++; cargarEventos(); }
  });
}

// ----------------------------------------------------------------
// IA CON COCO-SSD (primario) + MobileNet (fallback)
// Gestionado por GestorVision en vision.ts
// ----------------------------------------------------------------
async function cargarModeloIA(): Promise<void> {
  const statusEl = getElOrNull('ia-status');
  try {
    if (statusEl) statusEl.textContent = 'Cargando modelo IA (COCO-SSD, ~6MB)...';
    const nombreCargado = await gestorVision.inicializarAsync();
    if (statusEl) {
      statusEl.textContent = `Modelo ${nombreCargado} listo ✓`;
      (statusEl as HTMLElement).style.color = '#22c55e';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'Error al cargar modelo IA';
      (statusEl as HTMLElement).style.color = '#ef4444';
    }
    throw e;
  }
}

async function analizarConIA(
  dataUrl: string,
  distanciaActual?: number
): Promise<{ etiquetas: string; esDuplicado: boolean; detecciones: Deteccion[] }> {
  if (!gestorVision.listo()) {
    await gestorVision.inicializarAsync();
  }

  const video = getElOrNull('cam-video') as HTMLVideoElement | null;
  let elemento: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

  if (fuenteImagen === 'cam' && streamActivo && video) {
    elemento = video;
  } else {
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>(r => { img.onload = () => r(); });
    elemento = img;
  }

  const resultado: ResultadoInferencia | null = await gestorVision.inferir(
    elemento,
    distanciaActual,
    UMBRAL_CRITICO_CM   // distancia crítica: fuerza el envío aunque sea duplicado
  );

  if (!resultado) {
    // Throttle activo o mutex — retornar vacío
    return { etiquetas: '', esDuplicado: true, detecciones: [] };
  }

  // Bounding boxes solo sobre el video en vivo (coordenadas del frame del video)
  if (elemento === video) dibujarDetecciones(resultado.detecciones);

  return {
    etiquetas:    resultado.etiquetasFormateadas,
    esDuplicado:  resultado.esDuplicado,
    detecciones:  resultado.detecciones
  };
}

// ----------------------------------------------------------------
// OVERLAY DE BOUNDING BOXES (COCO-SSD) sobre el video
// ----------------------------------------------------------------
function limpiarOverlay(): void {
  if (overlayTimer !== null) { clearTimeout(overlayTimer); overlayTimer = null; }
  const canvas = getElOrNull('cam-overlay') as HTMLCanvasElement | null;
  if (!canvas) return;
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function dibujarDetecciones(dets: Deteccion[]): void {
  const video  = getElOrNull('cam-video')   as HTMLVideoElement  | null;
  const canvas = getElOrNull('cam-overlay') as HTMLCanvasElement | null;
  if (!video || !canvas || !streamActivo) return;
  const cw = video.clientWidth, ch = video.clientHeight;
  const vw = video.videoWidth,  vh = video.videoHeight;
  if (!cw || !ch || !vw || !vh) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  // El video usa object-fit: contain -> escala uniforme + márgenes
  const escala = Math.min(cw / vw, ch / vh);
  const offX = (cw - vw * escala) / 2;
  const offY = (ch - vh * escala) / 2;

  ctx.lineWidth = 3;
  ctx.font = 'bold 13px Inter, sans-serif';
  ctx.textBaseline = 'top';
  dets.forEach(d => {
    if (!d.bbox) return;
    const [x, y, w, h] = d.bbox;
    const rx = offX + x * escala, ry = offY + y * escala;
    ctx.strokeStyle = '#fde047';
    ctx.strokeRect(rx, ry, w * escala, h * escala);
    const etiqueta = `${d.clase} ${Math.round(d.confianza * 100)}%`;
    const tw = ctx.measureText(etiqueta).width + 8;
    const ty = Math.max(0, ry - 18);
    ctx.fillStyle = '#000';
    ctx.fillRect(rx, ty, tw, 18);
    ctx.fillStyle = '#fde047';
    ctx.fillText(etiqueta, rx + 4, ty + 2);
  });

  if (overlayTimer !== null) clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(limpiarOverlay, OVERLAY_TTL_MS);
}

// ----------------------------------------------------------------
// CÁMARA
// ----------------------------------------------------------------
function cambiarFuente(fuente: 'cam' | 'file'): void {
  fuenteImagen = fuente;
  getEl('btn-src-cam').classList.toggle('active', fuente === 'cam');
  getEl('btn-src-file').classList.toggle('active', fuente === 'file');
  getEl('panel-cam').classList.toggle('hidden', fuente !== 'cam');
  getEl('panel-file').classList.toggle('hidden', fuente !== 'file');
  if (fuente !== 'cam') detenerCamara();
}

async function iniciarCamara(): Promise<void> {
  try {
    streamActivo = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false
    });
    const video = getEl('cam-video') as HTMLVideoElement;
    video.srcObject = streamActivo;
    getEl('btn-cam-start').classList.add('hidden');
    getEl('btn-cam-stop').classList.remove('hidden');
    const status = getElOrNull('cam-status');
    if (status) { status.textContent = 'Camara activa'; status.className = 'cam-status active'; }
  } catch (e) {
    alert('No se pudo acceder a la camara: ' + (e as Error).message);
  }
}

function detenerCamara(): void {
  streamActivo?.getTracks().forEach(t => t.stop());
  streamActivo = null;
  limpiarOverlay();
  const video = getElOrNull('cam-video') as HTMLVideoElement | null;
  if (video) video.srcObject = null;
  getElOrNull('btn-cam-start')?.classList.remove('hidden');
  getElOrNull('btn-cam-stop')?.classList.add('hidden');
  const status = getElOrNull('cam-status');
  if (status) { status.textContent = 'Camara inactiva'; status.className = 'cam-status'; }
}

function capturarFrame(): string | null {
  const video  = getElOrNull('cam-video') as HTMLVideoElement | null;
  const canvas = getElOrNull('cam-canvas') as HTMLCanvasElement | null;
  if (!streamActivo || !video || !canvas) return null;
  const MAX = 480, w = video.videoWidth || 640, h = video.videoHeight || 480;
  const ratio = Math.min(MAX / w, MAX / h, 1);
  canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.5);
}

// ----------------------------------------------------------------
// FETCH — CARGAR EVENTOS (paginado)
// ----------------------------------------------------------------
interface OpcionesCarga { silencioso?: boolean; forzar?: boolean }

/** Huella de la página para detectar si hubo cambios reales desde el último poll. */
function firmarPagina(p: PaginaResponse): string {
  return `${p.paginaActual}|${p.totalPaginas}|${p.totalElementos}|` +
    p.contenido.map(e => `${e.id}:${e.modo}:${e.distanciaCm}:${e.etiquetasIA ?? ''}:${e.fechaHora ?? ''}`).join(';');
}

async function cargarEventos(opts: OpcionesCarga = {}): Promise<void> {
  if (cargaEnCurso) return;           // nunca dos cargas simultáneas
  cargaEnCurso = true;
  if (!opts.silencioso) mostrarCargando(true);
  try {
    const res = await apiFetch(`${EP_EVENTOS}?page=${paginaActual}&size=${PAGE_SIZE}`);

    if (res.status === 401) {
      // Sesión expirada
      usuarioActual = null;
      mostrarPantallaAuth();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const pagina = await res.json() as PaginaResponse;
    ocultarError();
    refrescarEstado();

    // Sin cambios -> no reconstruir tabla ni gráfica (evita parpadeo y trabajo inútil)
    const firma = firmarPagina(pagina);
    if (!opts.forzar && firma === ultimaFirma) return;
    ultimaFirma = firma;

    todosEventos   = pagina.contenido;
    totalPaginas   = pagina.totalPaginas;
    totalEventos   = pagina.totalElementos;
    paginaActual   = pagina.paginaActual;

    actualizarKPIs();
    renderTabla();
    renderChart(todosEventos);
    actualizarControlPaginacion(pagina);

  } catch (e) {
    mostrarError(`Sin conexión: ${(e as Error).message}`);
    refrescarEstado('sin conexión con el servidor');
  } finally {
    cargaEnCurso = false;
    mostrarCargando(false);
  }
}

// ----------------------------------------------------------------
// POLLING pausable
// ----------------------------------------------------------------
function iniciarPolling(): void {
  detenerPolling();
  if (pollPausado) return;
  pollTimer = window.setInterval(() => {
    if (document.hidden) return;      // pestaña oculta: no consultar
    void cargarEventos({ silencioso: true });
  }, REFRESH_MS);
}

function detenerPolling(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

function togglePolling(): void {
  pollPausado = !pollPausado;
  const btn = getEl('btn-poll-toggle');
  btn.setAttribute('aria-pressed', String(pollPausado));
  btn.textContent = pollPausado
    ? '▶ Reanudar actualización automática'
    : '⏸ Pausar actualización automática';
  if (pollPausado) {
    detenerPolling();
  } else {
    iniciarPolling();
    void cargarEventos({ silencioso: true });
  }
  refrescarEstado();
}

/** Actualiza el estado anunciado (aria-live polite) solo si el texto cambió. */
function refrescarEstado(extra = ''): void {
  const el = getElOrNull('estado-sistema');
  if (!el) return;
  const base = `Sistema operativo · Actualización automática ${pollPausado ? 'en pausa' : `activa (cada ${REFRESH_MS / 1000} s)`}`;
  const texto = extra ? `${base} · ${extra}` : base;
  if (el.textContent !== texto) el.textContent = texto;
}

// ----------------------------------------------------------------
// ALERTA LOCAL (visual + sonora + vibración) — sin depender de la red
// ----------------------------------------------------------------
function beepLocal(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      audioCtx = audioCtx ?? new AC();
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    }
  } catch { /* audio no disponible hasta que haya gesto del usuario */ }
  try { navigator.vibrate?.(200); } catch { /* sin vibración */ }
}

function anunciarPeligro(distancia: number): void {
  const el = getElOrNull('alerta-peligro');
  const nivel = nivelDistancia(distancia);
  if (el) {
    el.textContent = nivel === 'CRITICO'
      ? `⛔ PELIGRO CRÍTICO: obstáculo a ${distancia} cm`
      : `⚠ PELIGRO: obstáculo a ${distancia} cm`;
  }
  beepLocal();
}

function limpiarPeligro(): void {
  const el = getElOrNull('alerta-peligro');
  if (el) el.textContent = '';
}

/**
 * Procesa una lectura del slider del simulador.
 *  - La alerta local reacciona al instante (histéresis 100/115 cm).
 *  - En modo PASIVO se envía UN solo POST al entrar en peligro y solo si pasó el cooldown.
 *    Mover el slider dentro de la zona de peligro NO genera peticiones.
 */
function procesarDistanciaSimulador(distancia: number, permitirEnvio: boolean): void {
  const r = histeresis.evaluar(distancia);
  if (r.entroEnPeligro) anunciarPeligro(distancia);
  if (r.salioDePeligro) limpiarPeligro();
  if (!r.entroEnPeligro || !permitirEnvio) return;

  const modo = (getElOrNull('sim-modo') as HTMLSelectElement | null)?.value;
  if (modo === 'PASIVO' && histeresis.puedeEnviar(Date.now())) {
    void enviarSimulacion();
  }
}

function actualizarControlPaginacion(p: PaginaResponse): void {
  const info = getElOrNull('pag-info');
  if (info) info.textContent = `Página ${p.paginaActual + 1} de ${Math.max(p.totalPaginas, 1)} · ${p.totalElementos} eventos`;

  const btnPrev = getElOrNull('btn-pag-prev') as HTMLButtonElement | null;
  const btnNext = getElOrNull('btn-pag-next') as HTMLButtonElement | null;
  if (btnPrev) btnPrev.disabled = p.primera;
  if (btnNext) btnNext.disabled = p.ultima;
}

// ----------------------------------------------------------------
// KPIs
// ----------------------------------------------------------------
function actualizarKPIs(): void {
  const pasivos = todosEventos.filter(e => e.modo?.toUpperCase() === 'PASIVO');
  const activos = todosEventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO');
  const dists   = todosEventos.filter(e => e.distanciaCm != null).map(e => e.distanciaCm);
  const prom    = dists.length ? (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1) + ' cm' : '--';

  const countTotal  = getElOrNull('count-total');
  const countPasivo = getElOrNull('count-pasivo');
  const countActivo = getElOrNull('count-activo');
  const avgDist     = getElOrNull('avg-distancia');

  // Mostramos el total general (totalEventos) en el KPI, no solo el de la página
  if (countTotal)  countTotal.textContent  = String(totalEventos);
  if (countPasivo) countPasivo.textContent = String(pasivos.length);
  if (countActivo) countActivo.textContent = String(activos.length);
  if (avgDist)     avgDist.textContent     = prom;
}

// ----------------------------------------------------------------
// TABLA (sin innerHTML — XSS fix Fase 1 preservado)
// ----------------------------------------------------------------
function tdText(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderTabla(): void {
  const filtroModo   = getEl('filtro-modo')   as HTMLSelectElement;
  const filtroBuscar = getEl('filtro-buscar') as HTMLInputElement;
  const tbody        = getEl('eventos-tbody');
  const emptyState   = getEl('empty-state');
  const tableCount   = getEl('table-count');

  const modo   = filtroModo.value.toUpperCase();
  const buscar = filtroBuscar.value.toLowerCase();

  const filtrados = todosEventos
    .filter(e =>
      (!modo   || e.modo?.toUpperCase() === modo) &&
      (!buscar || (e.etiquetasIA ?? '').toLowerCase().includes(buscar))
    )
    .sort((a, b) => new Date(b.fechaHora!).getTime() - new Date(a.fechaHora!).getTime());

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (filtrados.length === 0) {
    emptyState.classList.remove('hidden');
    tableCount.textContent = '';
    return;
  }
  emptyState.classList.add('hidden');
  tableCount.textContent = `${filtrados.length} evento${filtrados.length !== 1 ? 's' : ''}`;

  filtrados.forEach(e => {
    const tr = document.createElement('tr');

    tr.appendChild(tdText(`#${e.id ?? '--'}`, 'td-id'));

    const tdModo = document.createElement('td');
    const badge  = document.createElement('span');
    badge.className = 'badge-modo';
    badge.setAttribute('data-modo', (e.modo ?? '').toUpperCase());
    const iconoModo = (e.modo ?? '').toUpperCase() === 'ACTIVO' ? '📷' : '📡';
    badge.textContent = `${iconoModo} ${e.modo ?? '--'}`;
    tdModo.appendChild(badge);
    tr.appendChild(tdModo);

    // Distancia + nivel con icono y texto explícito (no depende solo del color)
    const tdDist = document.createElement('td');
    tdDist.className = 'td-dist';
    if (e.distanciaCm != null) {
      tdDist.appendChild(document.createTextNode(`${e.distanciaCm.toFixed(1)} cm`));
      const nivel = nivelDistancia(e.distanciaCm);
      const nb = document.createElement('span');
      nb.className = 'badge-dist';
      nb.setAttribute('data-nivel', nivel);
      nb.textContent = nivel === 'CRITICO' ? '⛔ CRÍTICO' : nivel === 'PELIGRO' ? '⚠ PELIGRO' : '✔ SEGURO';
      tdDist.appendChild(nb);
    } else {
      tdDist.textContent = '--';
    }
    tr.appendChild(tdDist);
    tr.appendChild(tdText(e.etiquetasIA ?? '--', 'td-ia'));
    tr.appendChild(tdText(formatFecha(e.fechaHora), 'td-fecha'));

    const tdVoz = document.createElement('td');
    const tieneIA = e.modo?.toUpperCase() === 'ACTIVO' &&
                    e.etiquetasIA && e.etiquetasIA !== 'SIN_IMAGEN' &&
                    !e.etiquetasIA.startsWith('ERROR');
    if (tieneIA && e.etiquetasIA) {
      const btn = document.createElement('button');
      btn.className = 'btn-voz'; btn.textContent = '🔊';
      btn.setAttribute('aria-label', 'Leer etiquetas en voz alta');
      const textoVoz = e.etiquetasIA;
      btn.addEventListener('click', () => leerVoz(textoVoz, btn));
      tdVoz.appendChild(btn);
    } else {
      tdVoz.textContent = '--';
    }
    tr.appendChild(tdVoz);
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------------------
// GRÁFICA
// ----------------------------------------------------------------
function renderChart(eventos: EventoResponse[]): void {
  const grupos: Record<string, { PASIVO: number; ACTIVO: number }> = {};
  [...eventos]
    .sort((a, b) => new Date(a.fechaHora!).getTime() - new Date(b.fechaHora!).getTime())
    .slice(-20)
    .forEach(e => {
      const dia = e.fechaHora
        ? new Date(e.fechaHora).toLocaleDateString('es-CO', { month: 'short', day: 'numeric' })
        : '?';
      if (!grupos[dia]) grupos[dia] = { PASIVO: 0, ACTIVO: 0 };
      if (e.modo?.toUpperCase() === 'ACTIVO') grupos[dia].ACTIVO++;
      else grupos[dia].PASIVO++;
    });

  const labels  = Object.keys(grupos);
  const pasivos = labels.map(l => grupos[l].PASIVO);
  const activos = labels.map(l => grupos[l].ACTIVO);

  if (chart) chart.destroy();
  const canvas = getElOrNull('eventos-chart') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  chart = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [
        { label: 'Pasivo', data: pasivos, backgroundColor: 'rgba(34,197,94,0.7)',  borderColor: 'rgba(34,197,94,1)',  borderWidth: 2, fill: chartType === 'line', tension: 0.4 },
        { label: 'Activo', data: activos, backgroundColor: 'rgba(99,102,241,0.7)', borderColor: 'rgba(99,102,241,1)', borderWidth: 2, fill: chartType === 'line', tension: 0.4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:  { labels:  { color: '#cbd5e1', font: { family: 'Inter', size: 12 } } },
        tooltip: { backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#94a3b8' }
      },
      scales: {
        x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#64748b', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
      }
    }
  });
}

function cambiarChart(tipo: 'bar' | 'line'): void {
  chartType = tipo;
  getEl('btn-chart-bar').classList.toggle('active',  tipo === 'bar');
  getEl('btn-chart-line').classList.toggle('active', tipo === 'line');
  renderChart(todosEventos);
}

// ----------------------------------------------------------------
// SIMULADOR
// ----------------------------------------------------------------
function imagenABase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target!.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface OpcionesEnvio { ignorarCooldown?: boolean }

async function enviarSimulacion(opts: OpcionesEnvio = {}): Promise<void> {
  const modo      = (getEl('sim-modo')      as HTMLSelectElement).value;
  const distancia = parseFloat((getEl('sim-distancia') as HTMLInputElement).value);
  const btn       = getEl('btn-sim-enviar') as HTMLButtonElement;
  const simResult = getEl('sim-result');

  // Anti-saturación: nunca dos envíos simultáneos, y en PASIVO respeta el cooldown.
  // La alerta local ya se disparó antes y no depende de este envío.
  if (envioEnCurso) return;
  if (modo === 'PASIVO' && !opts.ignorarCooldown) {
    const restante = histeresis.restanteMs(Date.now());
    if (restante > 0) {
      simResult.className = 'sim-result info';
      simResult.textContent = `Cooldown activo: espera ${Math.ceil(restante / 1000)} s para enviar otro evento PASIVO (la alerta local sigue funcionando).`;
      return;
    }
  }
  envioEnCurso = true;
  if (modo === 'PASIVO') histeresis.registrarEnvio(Date.now());

  btn.disabled = true; btn.textContent = 'Procesando...';
  simResult.className = 'sim-result';
  simResult.classList.remove('hidden');
  simResult.textContent = 'Procesando...';

  try {
    let etiquetasIA: string | null = null;

    if (modo === 'ACTIVO') {
      let dataUrl: string | null = null;
      if (fuenteImagen === 'cam' && streamActivo) {
        dataUrl = capturarFrame();
        if (!dataUrl) throw new Error('No se pudo capturar frame');
      } else if (fuenteImagen === 'file') {
        const fi = getElOrNull('sim-imagen') as HTMLInputElement | null;
        if (fi?.files?.[0]) dataUrl = await imagenABase64(fi.files[0]);
      }
      if (dataUrl) {
        simResult.textContent = 'Analizando con IA (COCO-SSD)...';
        try {
          const { etiquetas, esDuplicado } = await analizarConIA(dataUrl, distancia);
          if (esDuplicado) {
            simResult.textContent = `Detección duplicada (cooldown 5s): ${etiquetas || 'sin etiquetas'} — evento no enviado`;
            simResult.classList.add('info');
            return;
          }
          etiquetasIA = etiquetas || null;
        } catch (iaErr) { etiquetasIA = 'ERROR_IA: ' + (iaErr as Error).message; }
      }
    }


    const body: EventoRequest = { modo, distanciaCm: distancia, etiquetasIA };
    const res = await apiFetch(EP_EVENTOS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.status === 401) { await logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as EventoResponse;
    simResult.classList.add('success');
    const ia = data.etiquetasIA && data.etiquetasIA !== 'SIN_IMAGEN'
      ? ' | IA: ' + data.etiquetasIA : '';
    simResult.textContent = `Evento #${data.id} - ${modo} | ${distancia} cm${ia}`;

    // Refrescar solo la primera página para ver el nuevo evento
    paginaActual = 0;
    await cargarEventos();

  } catch (e) {
    simResult.classList.add('error');
    simResult.textContent = 'Error: ' + (e as Error).message;
  } finally {
    envioEnCurso = false;
    btn.disabled = false; btn.textContent = 'Enviar evento';
  }
}

function toggleAuto(): void {
  const btn = getEl('btn-sim-auto');
  if (autoRunning) {
    if (autoInterval !== null) clearInterval(autoInterval);
    autoRunning = false; btn.textContent = 'Auto (5s)'; btn.classList.remove('btn-danger');
  } else {
    autoRunning = true; btn.textContent = 'Detener auto'; btn.classList.add('btn-danger');
    void enviarSimulacion({ ignorarCooldown: true });
    autoInterval = window.setInterval(() => {
      const modos = ['PASIVO', 'ACTIVO'];
      const sel = getEl('sim-modo') as HTMLSelectElement;
      sel.value = modos[Math.floor(Math.random() * modos.length)];
      const d = Math.floor(Math.random() * 150) + 10;
      (getEl('sim-distancia') as HTMLInputElement).value = String(d);
      const lbl = getElOrNull('sim-distancia-val');
      if (lbl) lbl.textContent = d + ' cm';
      procesarDistanciaSimulador(d, false);   // alerta local; el envío lo hace el propio intervalo (5 s)
      void enviarSimulacion({ ignorarCooldown: true });
    }, 5000);
  }
}

// ----------------------------------------------------------------
// VOZ
// ----------------------------------------------------------------
function leerVoz(texto: string, btn: HTMLButtonElement): void {
  if (!synth) { alert('Tu navegador no soporta voz.'); return; }
  if (synth.speaking) { synth.cancel(); return; }
  const u = new SpeechSynthesisUtterance(`Obstáculo identificado: ${texto}`);
  u.lang = 'es-ES'; u.rate = 0.9;
  u.onstart = (): void => { btn.textContent = '⏹'; };
  u.onend   = (): void => { btn.textContent = '🔊'; };
  u.onerror = (): void => { btn.textContent = '🔊'; };
  synth.speak(u);
}

// ----------------------------------------------------------------
// UI HELPERS
// ----------------------------------------------------------------
function mostrarCargando(visible: boolean): void {
  const loading = getElOrNull('loading');
  if (loading) {
    loading.classList.toggle('hidden', !visible);
    loading.setAttribute('aria-busy', visible ? 'true' : 'false');
  }
}
function mostrarError(msg: string): void {
  const errorBanner = getElOrNull('error-banner');
  if (errorBanner) { errorBanner.textContent = msg; errorBanner.classList.remove('hidden'); }
}
function ocultarError(): void {
  getElOrNull('error-banner')?.classList.add('hidden');
}
function formatFecha(iso?: string): string {
  if (!iso) return '--';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(iso));
  } catch { return iso; }
}