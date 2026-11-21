/* ================================================================
   ORBIS app.ts — Panel IoT con autenticación, paginación y IA local
   TypeScript compilado a app.js por tsc
   ================================================================ */

// ----------------------------------------------------------------
// TIPOS
// ----------------------------------------------------------------

interface EventResponse {
  id?: number;
  mode: string;
  distanceCm: number;
  aiLabels?: string | null;
  createdAt?: string;
  obstacleLabel?: string | null;
  obstacleLevel?: string | null;
}

interface EventRequest {
  mode: string;
  distanceCm: number;
  aiLabels?: string | null;
}

interface PageResponse {
  content: EventResponse[];
  currentPage: number;
  pageSize: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
}

interface AuthResponse {
  id?: number;
  name?: string;
  email: string;
  message?: string;
}

import { visionManager, MODEL_ERROR_MESSAGE, type InferenceResult, type Detection } from './vision.js';
import { CAP_REFRESH_MS, loadCaptures, startCaptures, startCapturesPolling, stopCapturesPolling, resetCaptures } from './captures.js';

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
const EP_EVENTS   = `${API_BASE}/api/v1/events`;
const EP_AUTH      = `${API_BASE}/auth`;
const REFRESH_MS   = 15000;
const PAGE_SIZE    = 20;
const OVERLAY_TTL_MS = 6000;   // tiempo que permanecen visibles las cajas dibujadas

// Texto visible de cada modo (la API usa los valores en inglés)
const MODE_LABELS: Record<string, string> = { ACTIVE: 'ACTIVO', PASSIVE: 'PASIVO' };
function modeLabel(mode?: string | null): string {
  if (!mode) return '--';
  return MODE_LABELS[mode.toUpperCase()] ?? mode;
}

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
let allEvents: EventResponse[]  = [];
let currentPage: number            = 0;
let totalPages: number            = 1;
let totalEvents: number            = 0;
let chart: any | null               = null;
let chartType: 'bar' | 'line'       = 'bar';
let autoInterval: number | null     = null;
let autoRunning: boolean            = false;
let activeStream: MediaStream | null = null;
let imageSource: 'cam' | 'file'    = 'cam';
let currentUser: AuthResponse | null = null;
const synth: SpeechSynthesis | null = window.speechSynthesis ?? null;

// Evita dos envíos simultáneos
let sendInProgress = false;

// Polling del dashboard
let pollTimer: number | null = null;
let pollPaused = false;
let loadInProgress = false;
let lastSignature = '';
let dashboardReady = false;   // los listeners se registran UNA sola vez (re-login no los duplica)

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

async function checkSession(): Promise<boolean> {
  try {
    const res = await apiFetch(`${EP_AUTH}/me`);
    if (res.ok) {
      const data = await res.json() as { email: string };
      currentUser = { email: data.email };
      return true;
    }
  } catch { /* sin conexión */ }
  return false;
}

async function login(email: string, password: string): Promise<void> {
  const res = await apiFetch(`${EP_AUTH}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `Error ${res.status}` }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
  currentUser = await res.json() as AuthResponse;
}

async function register(name: string, email: string, password: string): Promise<void> {
  const res = await apiFetch(`${EP_AUTH}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `Error ${res.status}` }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
}

async function logout(): Promise<void> {
  await apiFetch(`${EP_AUTH}/logout`, { method: 'POST' }).catch(() => {});
  currentUser = null;
  currentPage = 0;
  allEvents = [];
  showAuthScreen();
}

// ----------------------------------------------------------------
// GESTIÓN DE VISTAS
// ----------------------------------------------------------------

function showAuthScreen(): void {
  stopPolling();
  resetCaptures();
  stopAuto();          // ninguna sesión termina con envíos automáticos en marcha
  stopCamera();
  lastSignature = '';
  getEl('auth-screen').classList.remove('hidden');
  getEl('dashboard-screen').classList.add('hidden');
  clearAuthForm();
}

function showDashboard(): void {
  getEl('auth-screen').classList.add('hidden');
  getEl('dashboard-screen').classList.remove('hidden');
  const emailEl = getElOrNull('user-email');
  if (emailEl && currentUser) emailEl.textContent = currentUser.email;
}

function clearAuthForm(): void {
  ['login-email','login-pass','reg-name','reg-email','reg-pass'].forEach(id => {
    const el = getElOrNull(id) as HTMLInputElement | null;
    if (el) el.value = '';
  });
  showAuthMessage('');
}

function showAuthMessage(msg: string, isError = true): void {
  const el = getElOrNull('auth-message');
  if (!el) return;
  el.textContent = msg;
  el.className = 'auth-msg' + (isError && msg ? ' auth-msg--error' : msg ? ' auth-msg--ok' : '');
}

function showAuthTab(tab: 'login' | 'register'): void {
  getEl('tab-login').classList.toggle('active', tab === 'login');
  getEl('tab-register').classList.toggle('active', tab === 'register');
  getEl('tab-login').setAttribute('aria-selected', String(tab === 'login'));
  getEl('tab-register').setAttribute('aria-selected', String(tab === 'register'));
  getEl('form-login').classList.toggle('hidden', tab !== 'login');
  getEl('form-register').classList.toggle('hidden', tab !== 'register');
  showAuthMessage('');
}

// ----------------------------------------------------------------
// INICIALIZACIÓN
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async (): Promise<void> => {
  // 1. Verificar sesión existente antes de mostrar cualquier UI
  const hasSession = await checkSession();

  if (hasSession) {
    showDashboard();
    startDashboard();
  } else {
    showAuthScreen();
  }

  // ── Listeners de autenticación ──
  getEl('tab-login').addEventListener('click', () => showAuthTab('login'));
  getEl('tab-register').addEventListener('click', () => showAuthTab('register'));

  // Formularios reales: Enter y el botón submit disparan el mismo handler
  getEl('form-login').addEventListener('submit', (e: Event): void => {
    e.preventDefault();
    void submitLogin();
  });

  getEl('form-register').addEventListener('submit', (e: Event): void => {
    e.preventDefault();
    void submitRegister();
  });

  getElOrNull('btn-logout')?.addEventListener('click', logout);
});

async function submitLogin(): Promise<void> {
  const email = (getElOrNull('login-email') as HTMLInputElement)?.value.trim() ?? '';
  const pass   = (getElOrNull('login-pass')   as HTMLInputElement)?.value ?? '';
  if (!email || !pass) { showAuthMessage('Completa todos los campos'); return; }
  const btn = getEl('btn-login') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Iniciando sesión…';
  try {
    await login(email, pass);
    showDashboard();
    startDashboard();
  } catch (e) {
    showAuthMessage((e as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Iniciar sesión';
  }
}

async function submitRegister(): Promise<void> {
  const name  = (getElOrNull('reg-name') as HTMLInputElement)?.value.trim() ?? '';
  const email  = (getElOrNull('reg-email') as HTMLInputElement)?.value.trim() ?? '';
  const pass    = (getElOrNull('reg-pass')   as HTMLInputElement)?.value ?? '';
  if (!name || !email || !pass) { showAuthMessage('Completa todos los campos'); return; }
  if (pass.length < 8) { showAuthMessage('La contraseña debe tener al menos 8 caracteres'); return; }
  // Mismo límite que el backend: BCrypt solo procesa 72 bytes (tildes y emojis ocupan más de 1)
  if (new TextEncoder().encode(pass).length > 72) {
    showAuthMessage('La contraseña es demasiado larga (máximo 72 bytes)');
    return;
  }
  const btn = getEl('btn-register') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Creando cuenta…';
  try {
    await register(name, email, pass);
    showAuthTab('login');
    showAuthMessage('Solicitud procesada. Inicia sesión para continuar.', false);
  } catch (e) {
    showAuthMessage((e as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear cuenta';
  }
}

function startDashboard(): void {
  currentPage = 0;
  lastSignature = '';
  void loadEvents({ force: true });
  startCaptures({
    apiBase: API_BASE,
    fetchApi: apiFetch,
    onSessionExpired: () => { currentUser = null; showAuthScreen(); }
  }, false);
  startPolling();
  refreshStatus();

  if (dashboardReady) return;
  dashboardReady = true;

  loadAIModel().catch(() => {});

  getEl('btn-refresh').addEventListener('click', () => { currentPage = 0; void loadEvents({ force: true }); void loadCaptures(true); });
  getEl('btn-poll-toggle').addEventListener('click', togglePolling);
  getEl('btn-chart-bar').addEventListener('click', () => switchChart('bar'));
  getEl('btn-chart-line').addEventListener('click', () => switchChart('line'));

  getEl('btn-sim-send').addEventListener('click', () => { void sendSimulation(); });
  getEl('btn-sim-auto').addEventListener('click', toggleAuto);

  const modeFilter   = getEl('filter-mode')   as HTMLSelectElement;
  const searchFilter = getEl('filter-search') as HTMLInputElement;
  modeFilter.addEventListener('change', renderTable);
  searchFilter.addEventListener('input', renderTable);

  getEl('btn-src-cam').addEventListener('click', () => switchSource('cam'));
  getEl('btn-src-file').addEventListener('click', () => switchSource('file'));
  getEl('btn-cam-start').addEventListener('click', startCamera);
  getEl('btn-cam-stop').addEventListener('click', stopCamera);

  (getEl('sim-image') as HTMLInputElement).addEventListener('change', function(): void {
    const p = getElOrNull('sim-preview') as HTMLImageElement | null;
    const input = this as HTMLInputElement;
    if (p && input.files?.[0]) {
      // Cada vista previa crea un ObjectURL: se libera el anterior para no acumular memoria
      if (p.src.startsWith('blob:')) URL.revokeObjectURL(p.src);
      p.src = URL.createObjectURL(input.files[0]);
      p.classList.remove('hidden');
    }
  });

  // Paginación
  getElOrNull('btn-pag-prev')?.addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; loadEvents(); }
  });
  getElOrNull('btn-pag-next')?.addEventListener('click', () => {
    if (currentPage < totalPages - 1) { currentPage++; loadEvents(); }
  });
}

// ----------------------------------------------------------------
// IA CON COCO-SSD (primario) + MobileNet (fallback)
// Gestionado por VisionManager en vision.ts
// ----------------------------------------------------------------
async function loadAIModel(): Promise<void> {
  const statusEl = getElOrNull('ia-status');
  try {
    if (statusEl) statusEl.textContent = 'Cargando modelo IA (COCO-SSD, ~6 MB)…';
    const loadedName = await visionManager.initializeAsync();
    if (statusEl) {
      statusEl.textContent = `Modelo ${loadedName} listo`;
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

async function analyzeWithAI(dataUrl: string): Promise<InferenceResult> {
  if (!visionManager.ready()) {
    await visionManager.initializeAsync();
  }

  const video = getElOrNull('cam-video') as HTMLVideoElement | null;
  let element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

  if (imageSource === 'cam' && activeStream && video) {
    element = video;
  } else {
    const img = new Image();
    // Sin onerror, una imagen corrupta o un formato no soportado dejaba el análisis colgado
    await new Promise<void>((resolve, reject) => {
      img.onload  = () => resolve();
      img.onerror = () => reject(new Error('no se pudo leer la imagen seleccionada'));
      img.src = dataUrl;
    });
    element = img;
  }

  const result: InferenceResult = await visionManager.infer(element);

  // Bounding boxes solo sobre el video en vivo (coordenadas del frame del video)
  if (result.status === 'ok' && element === video) drawDetections(result.detections);

  return result;
}

/** Mensaje de estado para un análisis que no produjo evento (nunca se envía vacío). */
function noEventMessage(r: InferenceResult): string | null {
  switch (r.status) {
    case 'skipped':
      if (r.reason === 'throttle') return 'Análisis omitido: espera ~1,2 s entre detecciones. Evento no enviado.';
      if (r.reason === 'busy')  return 'Hay un análisis de IA en curso. Evento no enviado.';
      return 'El modelo de IA aún no está listo. Evento no enviado.';
    case 'no_detection':
      return 'La IA no detectó objetos con confianza suficiente (≥ 55 %). Evento no enviado.';
    case 'ok':
      return r.isDuplicate ? `Detección duplicada (cooldown 5s): ${r.formattedLabels || 'sin etiquetas'} — evento no enviado` : null;
  }
}

// ----------------------------------------------------------------
// OVERLAY DE BOUNDING BOXES (COCO-SSD) sobre el video
// ----------------------------------------------------------------
function clearOverlay(): void {
  if (overlayTimer !== null) { clearTimeout(overlayTimer); overlayTimer = null; }
  const canvas = getElOrNull('cam-overlay') as HTMLCanvasElement | null;
  if (!canvas) return;
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function drawDetections(dets: Detection[]): void {
  const video  = getElOrNull('cam-video')   as HTMLVideoElement  | null;
  const canvas = getElOrNull('cam-overlay') as HTMLCanvasElement | null;
  if (!video || !canvas || !activeStream) return;
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
  const scale = Math.min(cw / vw, ch / vh);
  const offX = (cw - vw * scale) / 2;
  const offY = (ch - vh * scale) / 2;

  ctx.lineWidth = 3;
  ctx.font = 'bold 13px Inter, sans-serif';
  ctx.textBaseline = 'top';
  dets.forEach(d => {
    if (!d.bbox) return;
    const [x, y, w, h] = d.bbox;
    const rx = offX + x * scale, ry = offY + y * scale;
    ctx.strokeStyle = '#F5B94A';
    ctx.strokeRect(rx, ry, w * scale, h * scale);
    const label = `${d.label} ${Math.round(d.confidence * 100)}%`;
    const tw = ctx.measureText(label).width + 8;
    const ty = Math.max(0, ry - 18);
    ctx.fillStyle = '#000';
    ctx.fillRect(rx, ty, tw, 18);
    ctx.fillStyle = '#F5B94A';
    ctx.fillText(label, rx + 4, ty + 2);
  });

  if (overlayTimer !== null) clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(clearOverlay, OVERLAY_TTL_MS);
}

// ----------------------------------------------------------------
// CÁMARA
// ----------------------------------------------------------------
function switchSource(source: 'cam' | 'file'): void {
  imageSource = source;
  getEl('btn-src-cam').classList.toggle('active', source === 'cam');
  getEl('btn-src-file').classList.toggle('active', source === 'file');
  getEl('btn-src-cam').setAttribute('aria-pressed', String(source === 'cam'));
  getEl('btn-src-file').setAttribute('aria-pressed', String(source === 'file'));
  getEl('panel-cam').classList.toggle('hidden', source !== 'cam');
  getEl('panel-file').classList.toggle('hidden', source !== 'file');
  if (source !== 'cam') stopCamera();
}

async function startCamera(): Promise<void> {
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false
    });
    const video = getEl('cam-video') as HTMLVideoElement;
    video.srcObject = activeStream;
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

function stopCamera(): void {
  activeStream?.getTracks().forEach(t => t.stop());
  activeStream = null;
  clearOverlay();
  const video = getElOrNull('cam-video') as HTMLVideoElement | null;
  if (video) video.srcObject = null;
  getElOrNull('btn-cam-start')?.classList.remove('hidden');
  getElOrNull('btn-cam-stop')?.classList.add('hidden');
  const status = getElOrNull('cam-status');
  if (status) { status.textContent = 'Cámara inactiva'; status.className = 'cam-status'; }
}

function captureFrame(): string | null {
  const video  = getElOrNull('cam-video') as HTMLVideoElement | null;
  const canvas = getElOrNull('cam-canvas') as HTMLCanvasElement | null;
  if (!activeStream || !video || !canvas) return null;
  const MAX = 480, w = video.videoWidth || 640, h = video.videoHeight || 480;
  const ratio = Math.min(MAX / w, MAX / h, 1);
  canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.5);
}

// ----------------------------------------------------------------
// FETCH — CARGAR EVENTOS (paginado)
// ----------------------------------------------------------------
class HttpError extends Error {
  constructor(public readonly status: number) { super(`HTTP ${status}`); }
}

interface LoadOptions { silent?: boolean; force?: boolean }

/** Huella de la página para detectar si hubo cambios reales desde el último poll. */
function signPage(p: PageResponse): string {
  return `${p.currentPage}|${p.totalPages}|${p.totalElements}|` +
    p.content.map(e => `${e.id}:${e.mode}:${e.distanceCm}:${e.aiLabels ?? ''}:${e.createdAt ?? ''}`).join(';');
}

async function loadEvents(opts: LoadOptions = {}): Promise<void> {
  if (loadInProgress) return;           // nunca dos cargas simultáneas
  loadInProgress = true;
  if (!opts.silent) showLoading(true);
  try {
    const res = await apiFetch(`${EP_EVENTS}?page=${currentPage}&size=${PAGE_SIZE}`);

    if (res.status === 401) {
      // Sesión expirada
      currentUser = null;
      showAuthScreen();
      return;
    }
    if (!res.ok) throw new HttpError(res.status);

    const page = await res.json() as PageResponse;
    hideError();
    refreshStatus();

    // Sin cambios -> no reconstruir tabla ni gráfica (evita parpadeo y trabajo inútil)
    const signature = signPage(page);
    if (!opts.force && signature === lastSignature) return;
    lastSignature = signature;

    allEvents   = page.content;
    totalPages   = page.totalPages;
    totalEvents   = page.totalElements;
    currentPage   = page.currentPage;

    updateKPIs();
    renderTable();
    renderChart(allEvents);
    updatePaginationControl(page);

  } catch (e) {
    if (e instanceof HttpError) {
      showError(`El servidor no pudo entregar los eventos (error ${e.status}). Se reintentará automáticamente.`);
      refreshStatus('error del servidor');
    } else {
      showError('Sin conexión con el servidor. Se reintentará automáticamente.');
      refreshStatus('sin conexión con el servidor');
    }
  } finally {
    loadInProgress = false;
    showLoading(false);
  }
}

// ----------------------------------------------------------------
// POLLING pausable
// ----------------------------------------------------------------
function startPolling(): void {
  stopPolling();
  if (pollPaused) return;
  pollTimer = window.setInterval(() => {
    if (document.hidden) return;      // pestaña oculta: no consultar
    void loadEvents({ silent: true });
  }, REFRESH_MS);
  startCapturesPolling();
}

function stopPolling(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  stopCapturesPolling();
}

function togglePolling(): void {
  pollPaused = !pollPaused;
  const btn = getEl('btn-poll-toggle');
  btn.setAttribute('aria-pressed', String(pollPaused));
  btn.textContent = pollPaused
    ? 'Reanudar actualización automática'
    : 'Pausar actualización automática';
  if (pollPaused) {
    stopPolling();
  } else {
    startPolling();
    void loadEvents({ silent: true });
    void loadCaptures(true);
  }
  refreshStatus();
}

/** Actualiza el estado anunciado (aria-live polite) solo si el texto cambió. */
function refreshStatus(extra = ''): void {
  const el = getElOrNull('system-status');
  if (!el) return;
  const base = `Sistema operativo · Actualización automática ${pollPaused ? 'en pausa' : `activa (eventos cada ${REFRESH_MS / 1000} s, capturas cada ${CAP_REFRESH_MS / 1000} s)`}`;
  const text = extra ? `${base} · ${extra}` : base;
  if (el.textContent !== text) el.textContent = text;
}

function updatePaginationControl(p: PageResponse): void {
  const info = getElOrNull('pag-info');
  if (info) info.textContent = `Página ${p.currentPage + 1} de ${Math.max(p.totalPages, 1)} · ${p.totalElements} eventos`;

  const btnPrev = getElOrNull('btn-pag-prev') as HTMLButtonElement | null;
  const btnNext = getElOrNull('btn-pag-next') as HTMLButtonElement | null;
  if (btnPrev) btnPrev.disabled = p.first;
  if (btnNext) btnNext.disabled = p.last;
}

// ----------------------------------------------------------------
// KPIs
// ----------------------------------------------------------------
function updateKPIs(): void {
  const countTotal  = getElOrNull('count-total');
  const countActive = getElOrNull('count-active');
  // Mostramos el total general (totalEvents) en el KPI, no solo el de la página
  if (countTotal)  countTotal.textContent  = String(totalEvents);
  if (countActive) countActive.textContent = String(allEvents.filter(e => e.mode?.toUpperCase() === 'ACTIVE').length);
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
function eventTime(e: EventResponse): number {
  const t = e.createdAt ? new Date(e.createdAt).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function renderTable(): void {
  const modeFilter   = getEl('filter-mode')   as HTMLSelectElement;
  const searchFilter = getEl('filter-search') as HTMLInputElement;
  const tbody        = getEl('events-tbody');
  const emptyState   = getEl('empty-state');
  const tableCount   = getEl('table-count');

  const mode   = modeFilter.value.toUpperCase();
  const search = searchFilter.value.toLowerCase();

  const filtered = allEvents
    .filter(e =>
      (!mode   || e.mode?.toUpperCase() === mode) &&
      (!search || (e.aiLabels ?? '').toLowerCase().includes(search))
    )
    .sort((a, b) => eventTime(b) - eventTime(a));

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (filtered.length === 0) {
    const msg = getElOrNull('empty-msg');
    if (msg) {
      msg.textContent = allEvents.length > 0
        ? 'Ningún evento de esta página coincide con los filtros.'
        : 'Sin eventos. Usa el simulador o conecta el hardware.';
    }
    emptyState.classList.remove('hidden');
    tableCount.textContent = '';
    return;
  }
  emptyState.classList.add('hidden');
  tableCount.textContent = `${filtered.length} evento${filtered.length !== 1 ? 's' : ''} en esta página`;

  filtered.forEach(e => {
    const tr = document.createElement('tr');

    tr.appendChild(tdText(`#${e.id ?? '--'}`, 'td-id'));

    const tdMode = document.createElement('td');
    const badge  = document.createElement('span');
    badge.className = 'badge-mode';
    badge.setAttribute('data-mode', (e.mode ?? '').toUpperCase());
    badge.textContent = modeLabel(e.mode);
    tdMode.appendChild(badge);
    tr.appendChild(tdMode);

    // Distancia + nivel con icono y texto explícito (no depende solo del color)
    const tdDist = document.createElement('td');
    tdDist.className = 'td-dist';
    tdDist.textContent = '--'; // sin sensor de distancia en modo activo
    tr.appendChild(tdDist);
    // Mismo criterio que el mensaje de confirmación: SIN_IMAGEN no se muestra
    const visibleLabels = e.aiLabels && e.aiLabels !== 'NO_IMAGE'
      ? e.aiLabels : '--';
    tr.appendChild(tdText(visibleLabels, 'td-ia'));
    tr.appendChild(tdText(formatDate(e.createdAt), 'td-date'));

    const tdVoice = document.createElement('td');
    const hasAI = e.mode?.toUpperCase() === 'ACTIVE' &&
                    e.aiLabels && e.aiLabels !== 'NO_IMAGE' &&
                    !e.aiLabels.startsWith('ERROR');
    // Sin síntesis de voz en el navegador no se ofrece un botón que solo mostraría un alert
    if (hasAI && e.aiLabels && synth) {
      const btn = document.createElement('button');
      btn.className = 'btn-voice'; btn.textContent = 'Leer';
      btn.setAttribute('aria-label', 'Leer etiquetas en voz alta');
      const voiceText = e.aiLabels;
      btn.addEventListener('click', () => readAloud(voiceText, btn));
      tdVoice.appendChild(btn);
    } else {
      tdVoice.textContent = '--';
    }
    tr.appendChild(tdVoice);
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------------------
// GRÁFICA
// ----------------------------------------------------------------
function renderChart(events: EventResponse[]): void {
  const groups: Record<string, number> = {};
  [...events]
    .sort((a, b) => eventTime(a) - eventTime(b))
    .slice(-20)
    .forEach(e => {
      const day = e.createdAt
        ? new Date(e.createdAt).toLocaleDateString('es-CO', { month: 'short', day: 'numeric' })
        : '?';
      if (e.mode?.toUpperCase() !== 'ACTIVE') return;
      groups[day] = (groups[day] ?? 0) + 1;
    });

  const labels  = Object.keys(groups);
  const actives = labels.map(l => groups[l]);

  if (chart) chart.destroy();
  const canvas = getElOrNull('events-chart') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  chart = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [
        { label: 'Activo', data: actives, backgroundColor: 'rgba(143,184,232,0.7)', borderColor: '#8FB8E8', borderWidth: 2, fill: chartType === 'line', tension: 0.4 }
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

function switchChart(kind: 'bar' | 'line'): void {
  chartType = kind;
  getEl('btn-chart-bar').classList.toggle('active',  kind === 'bar');
  getEl('btn-chart-line').classList.toggle('active', kind === 'line');
  getEl('btn-chart-bar').setAttribute('aria-pressed', String(kind === 'bar'));
  getEl('btn-chart-line').setAttribute('aria-pressed', String(kind === 'line'));
  renderChart(allEvents);
}

// ----------------------------------------------------------------
// SIMULADOR
// ----------------------------------------------------------------
function imageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target!.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendSimulation(): Promise<void> {
  const mode      = 'ACTIVE';
  // El bastón no tiene sensor de distancia; el backend exige el campo, así que se envía 0.
  const distance = 0;
  const btn       = getEl('btn-sim-send') as HTMLButtonElement;
  const simResult = getEl('sim-result');

  // Nunca dos envíos simultáneos
  if (sendInProgress) return;
  sendInProgress = true;

  btn.disabled = true; btn.textContent = 'Procesando…';
  simResult.className = 'sim-result';
  simResult.classList.remove('hidden');
  simResult.textContent = 'Procesando…';

  try {
    let aiLabels: string | null = null;

    if (mode === 'ACTIVE') {
      let dataUrl: string | null = null;
      if (imageSource === 'cam' && activeStream) {
        dataUrl = captureFrame();
        if (!dataUrl) throw new Error('No se pudo capturar la imagen de la cámara');
      } else if (imageSource === 'file') {
        const fi = getElOrNull('sim-image') as HTMLInputElement | null;
        if (fi?.files?.[0]) dataUrl = await imageToBase64(fi.files[0]);
      }
      if (dataUrl) {
        simResult.textContent = 'Analizando con IA (COCO-SSD)…';
        try {
          const analysis = await analyzeWithAI(dataUrl);
          const notice = noEventMessage(analysis);
          if (notice !== null) {
            // Sin detección válida, duplicado u omitido: no se envía evento vacío al backend
            simResult.textContent = notice;
            simResult.classList.add('info');
            return;
          }
          if (analysis.status === 'ok') aiLabels = analysis.formattedLabels || null;
        } catch (aiErr) {
          // Error de análisis: no se envía evento al backend; se informa al usuario
          const msgErr = (aiErr as Error).message;
          simResult.textContent = msgErr === MODEL_ERROR_MESSAGE
            ? msgErr
            : 'Error de análisis: ' + msgErr;
          simResult.classList.add('error');
          return;
        }
      }
    }


    const body: EventRequest = { mode, distanceCm: distance, aiLabels };
    const res = await apiFetch(EP_EVENTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.status === 401) { await logout(); return; }
    if (!res.ok) throw new Error(`el servidor rechazó el evento (error ${res.status})`);

    const data = await res.json() as EventResponse;
    simResult.classList.add('success');
    const ai = data.aiLabels && data.aiLabels !== 'NO_IMAGE'
      ? ' | IA: ' + data.aiLabels : '';
    simResult.textContent = `Evento #${data.id} · ${modeLabel(mode)}${ai}`;

    // Refrescar solo la primera página para ver el nuevo evento
    currentPage = 0;
    await loadEvents();

  } catch (e) {
    simResult.classList.add('error');
    simResult.textContent = 'No se pudo enviar el evento: ' + (e as Error).message;
  } finally {
    sendInProgress = false;
    btn.disabled = false; btn.textContent = 'Enviar evento';
  }
}

/** Detiene el envío automático y restaura el botón. Seguro de llamar aunque no esté activo. */
function stopAuto(): void {
  if (autoInterval !== null) { clearInterval(autoInterval); autoInterval = null; }
  if (!autoRunning) return;
  autoRunning = false;
  const btn = getElOrNull('btn-sim-auto');
  if (btn) { btn.textContent = 'Auto (5s)'; btn.classList.remove('btn-danger'); }
}

function toggleAuto(): void {
  const btn = getEl('btn-sim-auto');
  if (autoRunning) {
    stopAuto();
  } else {
    autoRunning = true; btn.textContent = 'Detener auto'; btn.classList.add('btn-danger');
    void sendSimulation();
    autoInterval = window.setInterval(() => { void sendSimulation(); }, 5000);
  }
}

// ----------------------------------------------------------------
// VOZ
// ----------------------------------------------------------------
function readAloud(text: string, btn: HTMLButtonElement): void {
  if (!synth) { alert('Tu navegador no soporta voz.'); return; }
  if (synth.speaking) { synth.cancel(); return; }
  const u = new SpeechSynthesisUtterance(`Obstáculo identificado: ${text}`);
  u.lang = 'es-ES'; u.rate = 0.9;
  u.onstart = (): void => { btn.textContent = 'Parar'; };
  u.onend   = (): void => { btn.textContent = 'Leer'; };
  u.onerror = (): void => { btn.textContent = 'Leer'; };
  synth.speak(u);
}

// ----------------------------------------------------------------
// UI HELPERS
// ----------------------------------------------------------------
function showLoading(visible: boolean): void {
  const loading = getElOrNull('loading');
  if (loading) {
    loading.classList.toggle('hidden', !visible);
    loading.setAttribute('aria-busy', visible ? 'true' : 'false');
  }
}
function showError(msg: string): void {
  const errorBanner = getElOrNull('error-banner');
  if (errorBanner) { errorBanner.textContent = msg; errorBanner.classList.remove('hidden'); }
}
function hideError(): void {
  getElOrNull('error-banner')?.classList.add('hidden');
}
function formatDate(iso?: string): string {
  if (!iso) return '--';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(iso));
  } catch { return iso; }
}