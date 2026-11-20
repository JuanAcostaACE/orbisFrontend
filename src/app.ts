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

import { gestorVision, MENSAJE_ERROR_MODELO, type ResultadoInferencia, type Deteccion } from './vision.js';
import { CAP_REFRESH_MS, cargarCapturas, iniciarCapturas, iniciarPollingCapturas, detenerPollingCapturas, reiniciarCapturas } from './capturas.js';

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
const synth: SpeechSynthesis | null = window.speechSynthesis ?? null;

// Evita dos envíos simultáneos
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
    // Datos personales del usuario: no guardarlos en la caché HTTP del navegador
    cache: opts.cache ?? 'no-store',
    // Sin respuesta en 15 s se aborta, para no dejar la UI colgada si el backend no responde
    signal: opts.signal ?? AbortSignal.timeout(15_000),
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
  reiniciarCapturas();
  detenerAuto();          // ninguna sesión termina con envíos automáticos en marcha
  detenerCamara();
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
  getEl('tab-login').setAttribute('aria-selected', String(tab === 'login'));
  getEl('tab-registro').setAttribute('aria-selected', String(tab === 'registro'));
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

  if (haySession) {
    mostrarDashboard();
    iniciarDashboard();
  } else {
    mostrarPantallaAuth();
  }

  // ── Listeners de autenticación ──
  getEl('tab-login').addEventListener('click', () => mostrarTabAuth('login'));
  getEl('tab-registro').addEventListener('click', () => mostrarTabAuth('registro'));

  // Formularios reales: Enter y el botón submit disparan el mismo handler
  getEl('form-login').addEventListener('submit', (e: Event): void => {
    e.preventDefault();
    void enviarLogin();
  });

  getEl('form-registro').addEventListener('submit', (e: Event): void => {
    e.preventDefault();
    void enviarRegistro();
  });

  getElOrNull('btn-logout')?.addEventListener('click', logout);
});

async function enviarLogin(): Promise<void> {
  const correo = (getElOrNull('login-correo') as HTMLInputElement)?.value.trim() ?? '';
  const pass   = (getElOrNull('login-pass')   as HTMLInputElement)?.value ?? '';
  if (!correo || !pass) { mostrarMsgAuth('Completa todos los campos'); return; }
  const btn = getEl('btn-login') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Iniciando sesión…';
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
}

async function enviarRegistro(): Promise<void> {
  const nombre  = (getElOrNull('reg-nombre') as HTMLInputElement)?.value.trim() ?? '';
  const correo  = (getElOrNull('reg-correo') as HTMLInputElement)?.value.trim() ?? '';
  const pass    = (getElOrNull('reg-pass')   as HTMLInputElement)?.value ?? '';
  if (!nombre || !correo || !pass) { mostrarMsgAuth('Completa todos los campos'); return; }
  if (pass.length < 8) { mostrarMsgAuth('La contraseña debe tener al menos 8 caracteres'); return; }
  // Mismo límite que el backend: BCrypt solo procesa 72 bytes (tildes y emojis ocupan más de 1)
  if (new TextEncoder().encode(pass).length > 72) {
    mostrarMsgAuth('La contraseña es demasiado larga (máximo 72 bytes)');
    return;
  }
  const btn = getEl('btn-registro') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Creando cuenta…';
  try {
    await registro(nombre, correo, pass);
    mostrarTabAuth('login');
    mostrarMsgAuth('Solicitud procesada. Inicia sesión para continuar.', false);
  } catch (e) {
    mostrarMsgAuth((e as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear cuenta';
  }
}

function iniciarDashboard(): void {
  paginaActual = 0;
  ultimaFirma = '';
  void cargarEventos({ forzar: true });
  iniciarCapturas({
    apiBase: API_BASE,
    fetchApi: apiFetch,
    alExpirarSesion: () => { usuarioActual = null; mostrarPantallaAuth(); }
  }, false);
  iniciarPolling();
  refrescarEstado();

  if (dashboardListo) return;
  dashboardListo = true;

  cargarModeloIA().catch(() => {});

  getEl('btn-refresh').addEventListener('click', () => { paginaActual = 0; void cargarEventos({ forzar: true }); void cargarCapturas(true); });
  getEl('btn-poll-toggle').addEventListener('click', togglePolling);
  getEl('btn-chart-bar').addEventListener('click', () => cambiarChart('bar'));
  getEl('btn-chart-line').addEventListener('click', () => cambiarChart('line'));

  getEl('btn-sim-enviar').addEventListener('click', () => { void enviarSimulacion(); });
  getEl('btn-sim-auto').addEventListener('click', toggleAuto);

  const filtroModo   = getEl('filtro-modo')   as HTMLSelectElement;
  const filtroBuscar = getEl('filtro-buscar') as HTMLInputElement;
  filtroModo.addEventListener('change', renderTabla);
  filtroBuscar.addEventListener('input', renderTabla);

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
    if (statusEl) statusEl.textContent = 'Cargando modelo IA (COCO-SSD, ~6 MB)…';
    const nombreCargado = await gestorVision.inicializarAsync();
    if (statusEl) {
      statusEl.textContent = `Modelo ${nombreCargado} listo`;
      (statusEl as HTMLElement).style.color = '#2DD4BF';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'Error al cargar modelo IA';
      (statusEl as HTMLElement).style.color = '#F87171';
    }
    throw e;
  }
}

async function analizarConIA(dataUrl: string): Promise<ResultadoInferencia> {
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

  const resultado: ResultadoInferencia = await gestorVision.inferir(elemento);

  // Bounding boxes solo sobre el video en vivo (coordenadas del frame del video)
  if (resultado.estado === 'ok' && elemento === video) dibujarDetecciones(resultado.detecciones);

  return resultado;
}

/** Mensaje de estado para un análisis que no produjo evento (nunca se envía vacío). */
function mensajeSinEvento(r: ResultadoInferencia): string | null {
  switch (r.estado) {
    case 'omitida':
      if (r.motivo === 'throttle') return 'Análisis omitido: espera ~1,2 s entre detecciones. Evento no enviado.';
      if (r.motivo === 'ocupado')  return 'Hay un análisis de IA en curso. Evento no enviado.';
      return 'El modelo de IA aún no está listo. Evento no enviado.';
    case 'sin_deteccion':
      return 'La IA no detectó objetos con confianza suficiente (≥ 55 %). Evento no enviado.';
    case 'ok':
      return r.esDuplicado ? `Detección duplicada (cooldown 5s): ${r.etiquetasFormateadas || 'sin etiquetas'} — evento no enviado` : null;
  }
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
    ctx.strokeStyle = '#F5B94A';
    ctx.strokeRect(rx, ry, w * escala, h * escala);
    const etiqueta = `${d.clase} ${Math.round(d.confianza * 100)}%`;
    const tw = ctx.measureText(etiqueta).width + 8;
    const ty = Math.max(0, ry - 18);
    ctx.fillStyle = '#000';
    ctx.fillRect(rx, ty, tw, 18);
    ctx.fillStyle = '#F5B94A';
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
  getEl('btn-src-cam').setAttribute('aria-pressed', String(fuente === 'cam'));
  getEl('btn-src-file').setAttribute('aria-pressed', String(fuente === 'file'));
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
    if (status) { status.textContent = 'Cámara activa'; status.className = 'cam-status active'; }
  } catch (e) {
    const status = getElOrNull('cam-status');
    if (status) {
      status.textContent = 'No se pudo acceder a la cámara: ' + (e as Error).message;
      status.className = 'cam-status';
    }
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
  if (status) { status.textContent = 'Cámara inactiva'; status.className = 'cam-status'; }
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
class ErrorHttp extends Error {
  constructor(public readonly status: number) { super(`HTTP ${status}`); }
}

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
    if (!res.ok) throw new ErrorHttp(res.status);

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
    if (e instanceof ErrorHttp) {
      mostrarError(`El servidor no pudo entregar los eventos (error ${e.status}). Se reintentará automáticamente.`);
      refrescarEstado('error del servidor');
    } else {
      mostrarError('Sin conexión con el servidor. Se reintentará automáticamente.');
      refrescarEstado('sin conexión con el servidor');
    }
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
  iniciarPollingCapturas();
}

function detenerPolling(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  detenerPollingCapturas();
}

function togglePolling(): void {
  pollPausado = !pollPausado;
  const btn = getEl('btn-poll-toggle');
  btn.setAttribute('aria-pressed', String(pollPausado));
  btn.textContent = pollPausado
    ? 'Reanudar actualización automática'
    : 'Pausar actualización automática';
  if (pollPausado) {
    detenerPolling();
  } else {
    iniciarPolling();
    void cargarEventos({ silencioso: true });
    void cargarCapturas(true);
  }
  refrescarEstado();
}

/** Actualiza el estado anunciado (aria-live polite) solo si el texto cambió. */
function refrescarEstado(extra = ''): void {
  const el = getElOrNull('estado-sistema');
  if (!el) return;
  const base = `Sistema operativo · Actualización automática ${pollPausado ? 'en pausa' : `activa (eventos cada ${REFRESH_MS / 1000} s, capturas cada ${CAP_REFRESH_MS / 1000} s)`}`;
  const texto = extra ? `${base} · ${extra}` : base;
  if (el.textContent !== texto) el.textContent = texto;
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
  const countTotal  = getElOrNull('count-total');
  const countActivo = getElOrNull('count-activo');
  // Mostramos el total general (totalEventos) en el KPI, no solo el de la página
  if (countTotal)  countTotal.textContent  = String(totalEventos);
  if (countActivo) countActivo.textContent = String(todosEventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO').length);
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

/** Marca de tiempo del evento; 0 si falta o es inválida (evita NaN en el orden). */
function tiempoEvento(e: EventoResponse): number {
  const t = e.fechaHora ? new Date(e.fechaHora).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
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
    .sort((a, b) => tiempoEvento(b) - tiempoEvento(a));

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (filtrados.length === 0) {
    const msg = getElOrNull('empty-msg');
    if (msg) {
      msg.textContent = todosEventos.length > 0
        ? 'Ningún evento de esta página coincide con los filtros.'
        : 'Sin eventos. Usa el simulador o conecta el hardware.';
    }
    emptyState.classList.remove('hidden');
    tableCount.textContent = '';
    return;
  }
  emptyState.classList.add('hidden');
  tableCount.textContent = `${filtrados.length} evento${filtrados.length !== 1 ? 's' : ''} en esta página`;

  filtrados.forEach(e => {
    const tr = document.createElement('tr');

    tr.appendChild(tdText(`#${e.id ?? '--'}`, 'td-id'));

    const tdModo = document.createElement('td');
    const badge  = document.createElement('span');
    badge.className = 'badge-modo';
    badge.setAttribute('data-modo', (e.modo ?? '').toUpperCase());
    badge.textContent = e.modo ?? '--';
    tdModo.appendChild(badge);
    tr.appendChild(tdModo);

    // Distancia + nivel con icono y texto explícito (no depende solo del color)
    const tdDist = document.createElement('td');
    tdDist.className = 'td-dist';
    tdDist.textContent = '--'; // sin sensor de distancia en modo activo
    tr.appendChild(tdDist);
    // Mismo criterio que el mensaje de confirmación: SIN_IMAGEN no se muestra
    const etiquetasVisibles = e.etiquetasIA && e.etiquetasIA !== 'SIN_IMAGEN'
      ? e.etiquetasIA : '--';
    tr.appendChild(tdText(etiquetasVisibles, 'td-ia'));
    tr.appendChild(tdText(formatFecha(e.fechaHora), 'td-fecha'));

    const tdVoz = document.createElement('td');
    const tieneIA = e.modo?.toUpperCase() === 'ACTIVO' &&
                    e.etiquetasIA && e.etiquetasIA !== 'SIN_IMAGEN' &&
                    !e.etiquetasIA.startsWith('ERROR');
    if (tieneIA && e.etiquetasIA) {
      const btn = document.createElement('button');
      btn.className = 'btn-voz'; btn.textContent = 'Leer';
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
  const grupos: Record<string, number> = {};
  [...eventos]
    .sort((a, b) => tiempoEvento(a) - tiempoEvento(b))
    .slice(-20)
    .forEach(e => {
      const dia = e.fechaHora
        ? new Date(e.fechaHora).toLocaleDateString('es-CO', { month: 'short', day: 'numeric' })
        : '?';
      if (e.modo?.toUpperCase() !== 'ACTIVO') return;
      grupos[dia] = (grupos[dia] ?? 0) + 1;
    });

  const labels  = Object.keys(grupos);
  const activos = labels.map(l => grupos[l]);

  if (chart) chart.destroy();
  const canvas = getElOrNull('eventos-chart') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  chart = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [
        { label: 'Activo', data: activos, backgroundColor: 'rgba(143,184,232,0.7)', borderColor: '#8FB8E8', borderWidth: 2, fill: chartType === 'line', tension: 0.4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:  { labels:  { color: '#C5D3E4', font: { family: 'Inter', size: 12 } } },
        tooltip: { backgroundColor: '#1A2639', titleColor: '#EAF2FB', bodyColor: '#A3B4C9' }
      },
      scales: {
        x: { ticks: { color: '#8A9BB3' }, grid: { color: 'rgba(234,242,251,0.07)' } },
        y: { ticks: { color: '#8A9BB3', stepSize: 1 }, grid: { color: 'rgba(234,242,251,0.07)' }, beginAtZero: true }
      }
    }
  });
}

function cambiarChart(tipo: 'bar' | 'line'): void {
  chartType = tipo;
  getEl('btn-chart-bar').classList.toggle('active',  tipo === 'bar');
  getEl('btn-chart-line').classList.toggle('active', tipo === 'line');
  getEl('btn-chart-bar').setAttribute('aria-pressed', String(tipo === 'bar'));
  getEl('btn-chart-line').setAttribute('aria-pressed', String(tipo === 'line'));
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

async function enviarSimulacion(): Promise<void> {
  const modo      = 'ACTIVO';
  // El bastón no tiene sensor de distancia; el backend exige el campo, así que se envía 0.
  const distancia = 0;
  const btn       = getEl('btn-sim-enviar') as HTMLButtonElement;
  const simResult = getEl('sim-result');

  // Nunca dos envíos simultáneos
  if (envioEnCurso) return;
  envioEnCurso = true;

  btn.disabled = true; btn.textContent = 'Procesando…';
  simResult.className = 'sim-result';
  simResult.classList.remove('hidden');
  simResult.textContent = 'Procesando…';

  try {
    let etiquetasIA: string | null = null;

    if (modo === 'ACTIVO') {
      let dataUrl: string | null = null;
      if (fuenteImagen === 'cam' && streamActivo) {
        dataUrl = capturarFrame();
        if (!dataUrl) throw new Error('No se pudo capturar la imagen de la cámara');
      } else if (fuenteImagen === 'file') {
        const fi = getElOrNull('sim-imagen') as HTMLInputElement | null;
        if (fi?.files?.[0]) dataUrl = await imagenABase64(fi.files[0]);
      }
      if (dataUrl) {
        simResult.textContent = 'Analizando con IA (COCO-SSD)…';
        try {
          const analisis = await analizarConIA(dataUrl);
          const aviso = mensajeSinEvento(analisis);
          if (aviso !== null) {
            // Sin detección válida, duplicado u omitido: no se envía evento vacío al backend
            simResult.textContent = aviso;
            simResult.classList.add('info');
            return;
          }
          if (analisis.estado === 'ok') etiquetasIA = analisis.etiquetasFormateadas || null;
        } catch (iaErr) {
          // Error de análisis: no se envía evento al backend; se informa al usuario
          const msgErr = (iaErr as Error).message;
          simResult.textContent = msgErr === MENSAJE_ERROR_MODELO
            ? msgErr
            : 'Error de análisis: ' + msgErr;
          simResult.classList.add('error');
          return;
        }
      }
    }


    const body: EventoRequest = { modo, distanciaCm: distancia, etiquetasIA };
    const res = await apiFetch(EP_EVENTOS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.status === 401) { await logout(); return; }
    if (!res.ok) throw new Error(`el servidor rechazó el evento (error ${res.status})`);

    const data = await res.json() as EventoResponse;
    simResult.classList.add('success');
    const ia = data.etiquetasIA && data.etiquetasIA !== 'SIN_IMAGEN'
      ? ' | IA: ' + data.etiquetasIA : '';
    simResult.textContent = `Evento #${data.id} · ${modo}${ia}`;

    // Refrescar solo la primera página para ver el nuevo evento
    paginaActual = 0;
    await cargarEventos();

  } catch (e) {
    simResult.classList.add('error');
    simResult.textContent = 'No se pudo enviar el evento: ' + (e as Error).message;
  } finally {
    envioEnCurso = false;
    btn.disabled = false; btn.textContent = 'Enviar evento';
  }
}

/** Detiene el envío automático y restaura el botón. Seguro de llamar aunque no esté activo. */
function detenerAuto(): void {
  if (autoInterval !== null) { clearInterval(autoInterval); autoInterval = null; }
  if (!autoRunning) return;
  autoRunning = false;
  const btn = getElOrNull('btn-sim-auto');
  if (btn) { btn.textContent = 'Auto (5s)'; btn.classList.remove('btn-danger'); }
}

function toggleAuto(): void {
  const btn = getEl('btn-sim-auto');
  if (autoRunning) {
    detenerAuto();
  } else {
    autoRunning = true; btn.textContent = 'Detener auto'; btn.classList.add('btn-danger');
    void enviarSimulacion();
    autoInterval = window.setInterval(() => { void enviarSimulacion(); }, 5000);
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
  u.onstart = (): void => { btn.textContent = 'Parar'; };
  u.onend   = (): void => { btn.textContent = 'Leer'; };
  u.onerror = (): void => { btn.textContent = 'Leer'; };
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