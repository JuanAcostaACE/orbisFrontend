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

import { gestorVision, type ResultadoInferencia } from './vision.js';

declare const Chart: any;

// ----------------------------------------------------------------
// CONSTANTES
// ----------------------------------------------------------------
const RAILWAY_URL = 'https://orbisbackend-production.up.railway.app';
const API_BASE    = window.location.hostname === 'localhost'
                    ? 'http://localhost:8080'
                    : RAILWAY_URL;
const EP_EVENTOS  = `${API_BASE}/api/v1/eventos`;
const EP_AUTH     = `${API_BASE}/auth`;
const REFRESH_MS  = 15000;
const PAGE_SIZE   = 20;

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
  cargarEventos();

  // Auto-refresh: solo si no hay sesión expirada
  window.setInterval(async () => {
    const sigueActivo = await verificarSesion();
    if (!sigueActivo) { mostrarPantallaAuth(); return; }
    cargarEventos();
  }, REFRESH_MS);

  cargarModeloIA().catch(() => {});

  getEl('btn-refresh').addEventListener('click', () => { paginaActual = 0; cargarEventos(); });
  getEl('btn-chart-bar').addEventListener('click', () => cambiarChart('bar'));
  getEl('btn-chart-line').addEventListener('click', () => cambiarChart('line'));

  (getEl('sim-distancia') as HTMLInputElement).addEventListener('input', function(): void {
    const lbl = getElOrNull('sim-distancia-val');
    if (lbl) lbl.textContent = `${(this as HTMLInputElement).value} cm`;
  });

  getEl('btn-sim-enviar').addEventListener('click', enviarSimulacion);
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
): Promise<{ etiquetas: string; esDuplicado: boolean }> {
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
    30   // umbral crítico de distancia: 30cm fuerza el envío aunque sea duplicado
  );

  if (!resultado) {
    // Throttle activo o mutex — retornar último valor o vacío
    return { etiquetas: '', esDuplicado: true };
  }

  return {
    etiquetas:    resultado.etiquetasFormateadas,
    esDuplicado:  resultado.esDuplicado
  };
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
async function cargarEventos(): Promise<void> {
  mostrarCargando(true);
  ocultarError();
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
  } finally {
    mostrarCargando(false);
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
    badge.textContent = e.modo ?? '--';
    tdModo.appendChild(badge);
    tr.appendChild(tdModo);

    tr.appendChild(tdText(e.distanciaCm != null ? `${e.distanciaCm.toFixed(1)} cm` : '--', 'td-dist'));
    tr.appendChild(tdText(e.etiquetasIA ?? '--', 'td-ia'));
    tr.appendChild(tdText(formatFecha(e.fechaHora), 'td-fecha'));

    const tdVoz = document.createElement('td');
    const tieneIA = e.modo?.toUpperCase() === 'ACTIVO' &&
                    e.etiquetasIA && e.etiquetasIA !== 'SIN_IMAGEN' &&
                    !e.etiquetasIA.startsWith('ERROR');
    if (tieneIA && e.etiquetasIA) {
      const btn = document.createElement('button');
      btn.className = 'btn-voz'; btn.textContent = '🔊';
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

async function enviarSimulacion(): Promise<void> {
  const modo      = (getEl('sim-modo')      as HTMLSelectElement).value;
  const distancia = parseFloat((getEl('sim-distancia') as HTMLInputElement).value);
  const btn       = getEl('btn-sim-enviar') as HTMLButtonElement;
  const simResult = getEl('sim-result');

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
    void enviarSimulacion();
    autoInterval = window.setInterval(() => {
      const modos = ['PASIVO', 'ACTIVO'];
      const sel = getEl('sim-modo') as HTMLSelectElement;
      sel.value = modos[Math.floor(Math.random() * modos.length)];
      const d = Math.floor(Math.random() * 150) + 10;
      (getEl('sim-distancia') as HTMLInputElement).value = String(d);
      const lbl = getElOrNull('sim-distancia-val');
      if (lbl) lbl.textContent = d + ' cm';
      void enviarSimulacion();
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