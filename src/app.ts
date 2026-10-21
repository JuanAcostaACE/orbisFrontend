/* ================================================================
   ORBIS app.ts - Panel IoT con grafica, tabla, simulador y camara
   TypeScript — compilado a app.js por tsc
   ================================================================ */

// ----------------------------------------------------------------
// TIPOS / INTERFACES
// ----------------------------------------------------------------

interface RegistroEvento {
  id?: number;
  modo: string;
  distanciaCm: number;
  imagenUrl?: string | null;
  etiquetasIA?: string | null;
  fechaHora?: string;
  comandoVoz?: string;
}

interface EventoRequest {
  modo: string;
  distanciaCm: number;
  etiquetasIA?: string | null;
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

// Declaraciones globales para librerias cargadas via CDN
declare const mobilenet: {
  load(config?: { version?: number; alpha?: number }): Promise<MobileNetModel>;
};

declare const Chart: any;

// ----------------------------------------------------------------
// CONSTANTES
// ----------------------------------------------------------------
const RAILWAY_URL  = 'https://orbisbackend-production.up.railway.app';
const API_BASE     = window.location.hostname === 'localhost'
                     ? 'http://localhost:8080'
                     : RAILWAY_URL;
const EP_EVENTOS   = `${API_BASE}/api/v1/eventos`;
const REFRESH_MS   = 10000;

// ----------------------------------------------------------------
// HELPERS DOM
// ----------------------------------------------------------------
function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} no encontrado en el DOM`);
  return el;
}

function getElOrNull(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ----------------------------------------------------------------
// REFERENCIAS DOM
// ----------------------------------------------------------------
const errorBanner  = getEl('error-banner');
const loading      = getEl('loading');
const emptyState   = getEl('empty-state');
const tbody        = getEl('eventos-tbody');
const tableCount   = getEl('table-count');
const countTotal   = getEl('count-total');
const countPasivo  = getEl('count-pasivo');
const countActivo  = getEl('count-activo');
const avgDist      = getEl('avg-distancia');
const filtroModo   = getEl('filtro-modo')   as HTMLSelectElement;
const filtroBuscar = getEl('filtro-buscar') as HTMLInputElement;
const simResult    = getEl('sim-result');

// ----------------------------------------------------------------
// ESTADO GLOBAL
// ----------------------------------------------------------------
let todosEventos: RegistroEvento[] = [];
let chart: any | null              = null;
let chartType: 'bar' | 'line'      = 'bar';
let autoInterval: number | null    = null;
let autoRunning: boolean           = false;
const synth: SpeechSynthesis | null = window.speechSynthesis ?? null;
let streamActivo: MediaStream | null = null;
let fuenteImagen: 'cam' | 'file'    = 'cam';

// ----------------------------------------------------------------
// INICIALIZACION
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', (): void => {
  cargarEventos();
  setInterval(cargarEventos, REFRESH_MS);
  cargarModeloIA().catch((): void => {});

  getEl('btn-refresh').addEventListener('click', cargarEventos);
  getEl('btn-chart-bar').addEventListener('click', (): void => cambiarChart('bar'));
  getEl('btn-chart-line').addEventListener('click', (): void => cambiarChart('line'));

  (getEl('sim-distancia') as HTMLInputElement).addEventListener('input', function (this: HTMLInputElement): void {
    const lbl = getElOrNull('sim-distancia-val');
    if (lbl) lbl.textContent = `${this.value} cm`;
  });

  getEl('btn-sim-enviar').addEventListener('click', enviarSimulacion);
  getEl('btn-sim-auto').addEventListener('click', toggleAuto);

  filtroModo.addEventListener('change', renderTabla);
  filtroBuscar.addEventListener('input', renderTabla);

  // Mostrar/ocultar seccion camara segun modo
  (getEl('sim-modo') as HTMLSelectElement).addEventListener('change', function (this: HTMLSelectElement): void {
    const grupo = getElOrNull('grupo-camara');
    if (grupo) grupo.classList.toggle('hidden', this.value !== 'ACTIVO');
  });
  const modoSelect = getEl('sim-modo') as HTMLSelectElement;
  const grupoCamara = getElOrNull('grupo-camara');
  if (modoSelect.value === 'ACTIVO' && grupoCamara) {
    grupoCamara.classList.remove('hidden');
  }

  // Tabs fuente de imagen
  getEl('btn-src-cam').addEventListener('click', (): void => cambiarFuente('cam'));
  getEl('btn-src-file').addEventListener('click', (): void => cambiarFuente('file'));

  // Camara
  getEl('btn-cam-start').addEventListener('click', iniciarCamara);
  getEl('btn-cam-stop').addEventListener('click', detenerCamara);

  // Preview archivo
  (getEl('sim-imagen') as HTMLInputElement).addEventListener('change', function (this: HTMLInputElement): void {
    const p = getElOrNull('sim-preview') as HTMLImageElement | null;
    if (p && this.files?.[0]) {
      p.src = URL.createObjectURL(this.files[0]);
      p.classList.remove('hidden');
    }
  });
});

// ----------------------------------------------------------------
// IA LOCAL CON MOBILENET (TensorFlow.js)
// ----------------------------------------------------------------
let mobilenetModel: MobileNetModel | null = null;
let modeloCargando: boolean               = false;

async function cargarModeloIA(): Promise<MobileNetModel> {
  if (mobilenetModel) return mobilenetModel;

  if (modeloCargando) {
    while (modeloCargando) {
      await new Promise<void>(r => setTimeout(r, 200));
    }
    return mobilenetModel!;
  }

  modeloCargando = true;
  const statusEl = getElOrNull('ia-status');

  try {
    if (statusEl) statusEl.textContent = 'Cargando modelo IA (~5MB)...';
    mobilenetModel = await mobilenet.load({ version: 2, alpha: 1.0 });
    if (statusEl) {
      statusEl.textContent = 'Modelo IA listo ✓';
      (statusEl as HTMLElement).style.color = '#22c55e';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'Error al cargar modelo IA';
      (statusEl as HTMLElement).style.color = '#ef4444';
    }
    throw e;
  } finally {
    modeloCargando = false;
  }

  return mobilenetModel!;
}

async function analizarConIA(dataUrl: string): Promise<string> {
  const modelo = await cargarModeloIA();
  const video  = getElOrNull('cam-video') as HTMLVideoElement | null;

  let predicciones: Prediccion[];

  if (fuenteImagen === 'cam' && streamActivo && video) {
    predicciones = await modelo.classify(video, 3);
  } else {
    const img   = new Image();
    img.src     = dataUrl;
    await new Promise<void>(r => { img.onload = () => r(); });
    predicciones = await modelo.classify(img, 3);
  }

  return predicciones
    .map((p: Prediccion): string => {
      let label = p.className ?? '';
      if (label.includes(',')) label = label.split(',').pop()!.trim();
      return label.charAt(0).toUpperCase() + label.slice(1);
    })
    .join(', ') || 'Objeto detectado';
}

// ----------------------------------------------------------------
// CAMARA
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
    if (status) {
      status.textContent = 'Camara activa - lista para capturar';
      status.className = 'cam-status active';
    }
  } catch (e) {
    const err = e as Error;
    alert('No se pudo acceder a la camara: ' + err.message);
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
  if (status) {
    status.textContent = 'Camara inactiva';
    status.className = 'cam-status';
  }
}

function capturarFrame(): string | null {
  const video  = getElOrNull('cam-video') as HTMLVideoElement | null;
  const canvas = getElOrNull('cam-canvas') as HTMLCanvasElement | null;
  if (!streamActivo || !video || !canvas) return null;
  const MAX   = 480;
  const w     = video.videoWidth  || 640;
  const h     = video.videoHeight || 480;
  const ratio = Math.min(MAX / w, MAX / h, 1);
  canvas.width  = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.5);
}

// ----------------------------------------------------------------
// FETCH — CARGAR EVENTOS
// ----------------------------------------------------------------
async function cargarEventos(): Promise<void> {
  mostrarCargando(true);
  ocultarError();
  try {
    const res = await fetch(EP_EVENTOS, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    todosEventos = await res.json() as RegistroEvento[];
    actualizarKPIs(todosEventos);
    renderTabla();
    renderChart(todosEventos);
  } catch (e) {
    const err = e as Error;
    mostrarError(`Sin conexion: ${err.message}`);
  } finally {
    mostrarCargando(false);
  }
}

// ----------------------------------------------------------------
// KPIs
// ----------------------------------------------------------------
function actualizarKPIs(eventos: RegistroEvento[]): void {
  const pasivos = eventos.filter(e => e.modo?.toUpperCase() === 'PASIVO');
  const activos = eventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO');
  const dists   = eventos
    .filter(e => e.distanciaCm != null)
    .map(e => e.distanciaCm);
  const prom = dists.length
    ? (dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1) + ' cm'
    : '--';

  countTotal.textContent  = String(eventos.length);
  countPasivo.textContent = String(pasivos.length);
  countActivo.textContent = String(activos.length);
  avgDist.textContent     = prom;
}

// ----------------------------------------------------------------
// TABLA
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// Crea una celda <td> con textContent seguro (sin XSS)
// ----------------------------------------------------------------
function tdText(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderTabla(): void {
  const modo   = filtroModo.value.toUpperCase();
  const buscar = filtroBuscar.value.toLowerCase();

  const filtrados = todosEventos
    .filter(e =>
      (!modo   || e.modo?.toUpperCase() === modo) &&
      (!buscar || (e.etiquetasIA ?? '').toLowerCase().includes(buscar))
    )
    .sort((a, b) => new Date(b.fechaHora!).getTime() - new Date(a.fechaHora!).getTime());

  // Limpia la tabla de forma segura
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

    // ID
    tr.appendChild(tdText(`#${e.id ?? '--'}`, 'td-id'));

    // Modo — badge creado via DOM (sin innerHTML)
    const tdModo  = document.createElement('td');
    const badge   = document.createElement('span');
    badge.className = 'badge-modo';
    badge.setAttribute('data-modo', (e.modo ?? '').toUpperCase());
    badge.textContent = e.modo ?? '--';
    tdModo.appendChild(badge);
    tr.appendChild(tdModo);

    // Distancia
    tr.appendChild(tdText(
      e.distanciaCm != null ? `${e.distanciaCm.toFixed(1)} cm` : '--',
      'td-dist'
    ));

    // Etiquetas IA — textContent evita XSS aunque el server devuelva HTML
    tr.appendChild(tdText(e.etiquetasIA ?? '--', 'td-ia'));

    // Fecha
    tr.appendChild(tdText(formatFecha(e.fechaHora), 'td-fecha'));

    // Botón de voz
    const tdVoz = document.createElement('td');
    const tieneIA = e.modo?.toUpperCase() === 'ACTIVO' &&
                    e.etiquetasIA &&
                    e.etiquetasIA !== 'SIN_IMAGEN' &&
                    !e.etiquetasIA.startsWith('ERROR');
    if (tieneIA && e.etiquetasIA) {
      const btn = document.createElement('button');
      btn.className   = 'btn-voz';
      btn.textContent = '🔊';
      // Captura el valor en closure para evitar inyección vía dataset
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
// GRAFICA
// ----------------------------------------------------------------
function renderChart(eventos: RegistroEvento[]): void {
  interface Grupo { PASIVO: number; ACTIVO: number }
  const grupos: Record<string, Grupo> = {};

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

  const ctx = (getEl('eventos-chart') as HTMLCanvasElement).getContext('2d')!;
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
      responsive: true,
      maintainAspectRatio: false,
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
    const reader       = new FileReader();
    reader.onload  = e => resolve(e.target!.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function enviarSimulacion(): Promise<void> {
  const modo      = (getEl('sim-modo') as HTMLSelectElement).value;
  const distancia = parseFloat((getEl('sim-distancia') as HTMLInputElement).value);
  const btn       = getEl('btn-sim-enviar') as HTMLButtonElement;

  btn.disabled        = true;
  btn.textContent     = 'Procesando...';
  simResult.className = 'sim-result';
  simResult.classList.remove('hidden');
  simResult.textContent = 'Procesando...';

  try {
    let etiquetasIA: string | null = null;

    if (modo === 'ACTIVO') {
      let dataUrl: string | null = null;

      if (fuenteImagen === 'cam' && streamActivo) {
        dataUrl = capturarFrame();
        if (!dataUrl) throw new Error('No se pudo capturar frame de la camara');
      } else if (fuenteImagen === 'file') {
        const fi = getElOrNull('sim-imagen') as HTMLInputElement | null;
        if (fi?.files?.[0]) dataUrl = await imagenABase64(fi.files[0]);
      }

      if (dataUrl) {
        simResult.textContent = 'Analizando con IA...';
        try {
          etiquetasIA = await analizarConIA(dataUrl);
        } catch (iaErr) {
          const err = iaErr as Error;
          etiquetasIA = 'ERROR_IA: ' + err.message;
        }
      }
    }

    const body: EventoRequest = { modo, distanciaCm: distancia, etiquetasIA };
    const res = await fetch(EP_EVENTOS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as RegistroEvento;
    simResult.classList.add('success');
    const ia = data.etiquetasIA && data.etiquetasIA !== 'SIN_IMAGEN'
      ? ' | IA: ' + data.etiquetasIA
      : '';
    simResult.textContent = `Evento #${data.id} - ${modo} | ${distancia} cm${ia}`;
    await cargarEventos();

  } catch (e) {
    const err = e as Error;
    simResult.classList.add('error');
    simResult.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Enviar evento';
  }
}

function toggleAuto(): void {
  const btn = getEl('btn-sim-auto');
  if (autoRunning) {
    if (autoInterval !== null) clearInterval(autoInterval);
    autoRunning     = false;
    btn.textContent = 'Auto (5s)';
    btn.classList.remove('btn-danger');
  } else {
    autoRunning     = true;
    btn.textContent = 'Detener auto';
    btn.classList.add('btn-danger');
    void enviarSimulacion();
    autoInterval = window.setInterval(() => {
      const modos = ['PASIVO', 'ACTIVO'];
      const sel   = getEl('sim-modo') as HTMLSelectElement;
      sel.value   = modos[Math.floor(Math.random() * modos.length)];
      const d     = Math.floor(Math.random() * 150) + 10;
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
  const u = new SpeechSynthesisUtterance(`Obstaculo identificado: ${texto}`);
  u.lang  = 'es-ES';
  u.rate  = 0.9;
  u.onstart = (): void => { btn.textContent = '⏹'; };
  u.onend   = (): void => { btn.textContent = '🔊'; };
  u.onerror = (): void => { btn.textContent = '🔊'; };
  synth.speak(u);
}

// ----------------------------------------------------------------
// UI HELPERS
// ----------------------------------------------------------------
function mostrarCargando(visible: boolean): void {
  loading.classList.toggle('hidden', !visible);
  loading.setAttribute('aria-busy', visible ? 'true' : 'false');
}

function mostrarError(msg: string): void {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function ocultarError(): void {
  errorBanner.classList.add('hidden');
}

function formatFecha(iso?: string): string {
  if (!iso) return '--';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}