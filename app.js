/* ============================================================
   ORBIS app.js — Panel IoT con grafica, tabla y simulador
   ============================================================ */

// ── CONFIG ──────────────────────────────────────────────────
const RAILWAY_URL = 'https://orbisbackend-production.up.railway.app';
const API_BASE    = window.location.hostname === 'localhost' ? 'http://localhost:8080' : RAILWAY_URL;
const EP_EVENTOS  = `${API_BASE}/api/v1/eventos`;
const REFRESH_MS  = 10000;

// ── DOM ──────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const statusDot    = $('status-dot');
const statusText   = $('status-text');
const errorBanner  = $('error-banner');
const loading      = $('loading');
const emptyState   = $('empty-state');
const tbody        = $('eventos-tbody');
const tableCount   = $('table-count');
const countTotal   = $('count-total');
const countPasivo  = $('count-pasivo');
const countActivo  = $('count-activo');
const avgDist      = $('avg-distancia');
const filtroModo   = $('filtro-modo');
const filtroBuscar = $('filtro-buscar');
const simResult    = $('sim-result');

// ── ESTADO ───────────────────────────────────────────────────
let todosEventos = [];
let chart        = null;
let chartType    = 'bar';
let autoInterval = null;
let synth        = window.speechSynthesis || null;

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  cargarEventos();
  setInterval(cargarEventos, REFRESH_MS);

  $('btn-refresh').addEventListener('click', cargarEventos);
  $('btn-chart-bar').addEventListener('click', () => cambiarChart('bar'));
  $('btn-chart-line').addEventListener('click', () => cambiarChart('line'));

  $('sim-distancia').addEventListener('input', function() {
    $('sim-distancia-val').textContent = `${this.value} cm`;
  });
  $('btn-sim-enviar').addEventListener('click', enviarSimulacion);
  $('btn-sim-auto').addEventListener('click', toggleAuto);

  filtroModo.addEventListener('change', renderTabla);
  filtroBuscar.addEventListener('input', renderTabla);
});

// ── FETCH ────────────────────────────────────────────────────
async function cargarEventos() {
  mostrarCargando(true);
  ocultarError();
  try {
    const res = await fetch(EP_EVENTOS, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    todosEventos = await res.json();
    actualizarKPIs(todosEventos);
    renderTabla();
    renderChart(todosEventos);
    setStatus(true);
  } catch (e) {
    mostrarError(`Sin conexion: ${e.message}`);
    setStatus(false);
  } finally {
    mostrarCargando(false);
  }
}

// ── KPIs ─────────────────────────────────────────────────────
function actualizarKPIs(eventos) {
  const pasivos = eventos.filter(e => e.modo?.toUpperCase() === 'PASIVO');
  const activos = eventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO');
  const dists   = eventos.filter(e => e.distanciaCm != null).map(e => e.distanciaCm);
  const prom    = dists.length ? (dists.reduce((a,b) => a+b, 0) / dists.length).toFixed(1) + ' cm' : '—';

  countTotal.textContent  = eventos.length;
  countPasivo.textContent = pasivos.length;
  countActivo.textContent = activos.length;
  avgDist.textContent     = prom;
}

// ── TABLA ────────────────────────────────────────────────────
function renderTabla() {
  const modo   = filtroModo.value.toUpperCase();
  const buscar = filtroBuscar.value.toLowerCase();

  const filtrados = todosEventos.filter(e => {
    const modoOk   = !modo || e.modo?.toUpperCase() === modo;
    const buscarOk = !buscar || (e.etiquetasIA || '').toLowerCase().includes(buscar);
    return modoOk && buscarOk;
  }).sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora));

  tbody.innerHTML = '';

  if (filtrados.length === 0) {
    emptyState.classList.remove('hidden');
    tableCount.textContent = '';
    return;
  }
  emptyState.classList.add('hidden');
  tableCount.textContent = `${filtrados.length} evento${filtrados.length !== 1 ? 's' : ''}`;

  filtrados.forEach(e => {
    const tr = document.createElement('tr');
    const tieneIA = e.modo?.toUpperCase() === 'ACTIVO' && e.etiquetasIA && e.etiquetasIA !== 'SIN_IMAGEN';
    tr.innerHTML = `
      <td class="td-id">#${e.id ?? '—'}</td>
      <td><span class="badge-modo" data-modo="${e.modo?.toUpperCase()}">${e.modo ?? '—'}</span></td>
      <td class="td-dist">${e.distanciaCm != null ? e.distanciaCm.toFixed(1) + ' cm' : '—'}</td>
      <td class="td-ia">${e.etiquetasIA ?? '—'}</td>
      <td class="td-fecha">${formatFecha(e.fechaHora)}</td>
      <td>${tieneIA ? `<button class="btn-voz" data-texto="${e.etiquetasIA}">🔊</button>` : '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-voz').forEach(btn => {
    btn.addEventListener('click', () => leerVoz(btn.dataset.texto, btn));
  });
}

// ── GRAFICA ──────────────────────────────────────────────────
function renderChart(eventos) {
  // Agrupar ultimos 10 eventos por fecha (dia)
  const grupos = {};
  [...eventos].sort((a,b) => new Date(a.fechaHora)-new Date(b.fechaHora)).slice(-20).forEach(e => {
    const dia = e.fechaHora ? new Date(e.fechaHora).toLocaleDateString('es-CO',{month:'short',day:'numeric'}) : '?';
    if (!grupos[dia]) grupos[dia] = { PASIVO: 0, ACTIVO: 0 };
    grupos[dia][e.modo?.toUpperCase() === 'ACTIVO' ? 'ACTIVO' : 'PASIVO']++;
  });

  const labels  = Object.keys(grupos);
  const pasivos = labels.map(l => grupos[l].PASIVO);
  const activos = labels.map(l => grupos[l].ACTIVO);

  if (chart) chart.destroy();

  const ctx = $('eventos-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [
        {
          label: 'Pasivo',
          data: pasivos,
          backgroundColor: chartType === 'bar' ? 'rgba(34,197,94,0.7)' : 'rgba(34,197,94,0)',
          borderColor: 'rgba(34,197,94,1)',
          borderWidth: 2,
          fill: chartType === 'line',
          tension: 0.4,
        },
        {
          label: 'Activo',
          data: activos,
          backgroundColor: chartType === 'bar' ? 'rgba(99,102,241,0.7)' : 'rgba(99,102,241,0)',
          borderColor: 'rgba(99,102,241,1)',
          borderWidth: 2,
          fill: chartType === 'line',
          tension: 0.4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { family: 'Inter', size: 12 } } },
        tooltip: { backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#94a3b8' }
      },
      scales: {
        x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#64748b', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
      }
    }
  });
}

function cambiarChart(tipo) {
  chartType = tipo;
  $('btn-chart-bar').classList.toggle('active', tipo === 'bar');
  $('btn-chart-line').classList.toggle('active', tipo === 'line');
  renderChart(todosEventos);
}

// ── SIMULADOR ────────────────────────────────────────────────
async function enviarSimulacion() {
  const modo       = $('sim-modo').value;
  const distancia  = parseFloat($('sim-distancia').value);
  const btn        = $('btn-sim-enviar');

  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  simResult.className = 'sim-result';
  simResult.classList.remove('hidden');
  simResult.textContent = 'Enviando al backend...';

  try {
    const body = { modo, distanciaCm: distancia };
    const res  = await fetch(EP_EVENTOS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    simResult.classList.add('success');
    simResult.textContent = `✅ Evento #${data.id} registrado — ${modo} | ${distancia} cm${data.etiquetasIA && data.etiquetasIA !== 'SIN_IMAGEN' ? ' | IA: ' + data.etiquetasIA : ''}`;
    await cargarEventos();
  } catch (e) {
    simResult.classList.add('error');
    simResult.textContent = `❌ Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📡 Enviar evento';
  }
}

let autoRunning = false;
function toggleAuto() {
  const btn = $('btn-sim-auto');
  if (autoRunning) {
    clearInterval(autoInterval);
    autoRunning = false;
    btn.textContent = '⚡ Auto (5s)';
    btn.classList.remove('btn-danger');
  } else {
    autoRunning = true;
    btn.textContent = '⛔ Detener auto';
    btn.classList.add('btn-danger');
    enviarSimulacion();
    autoInterval = setInterval(() => {
      // Variar distancia y modo aleatoriamente
      const modos = ['PASIVO', 'ACTIVO'];
      $('sim-modo').value = modos[Math.floor(Math.random() * modos.length)];
      const dist = Math.floor(Math.random() * 150) + 10;
      $('sim-distancia').value = dist;
      $('sim-distancia-val').textContent = `${dist} cm`;
      enviarSimulacion();
    }, 5000);
  }
}

// ── WEB SPEECH ───────────────────────────────────────────────
function leerVoz(texto, btn) {
  if (!synth) { alert('Tu navegador no soporta voz.'); return; }
  if (synth.speaking) { synth.cancel(); return; }
  const u = new SpeechSynthesisUtterance(`Obstaculo identificado: ${texto}`);
  u.lang = 'es-ES'; u.rate = 0.9;
  u.onstart = () => btn.textContent = '⏹';
  u.onend = u.onerror = () => btn.textContent = '🔊';
  synth.speak(u);
}

// ── UI HELPERS ───────────────────────────────────────────────
function mostrarCargando(v) {
  loading.classList.toggle('hidden', !v);
  loading.setAttribute('aria-busy', v ? 'true' : 'false');
}
function mostrarError(msg) {
  errorBanner.textContent = `⚠️ ${msg}`;
  errorBanner.classList.remove('hidden');
}
function ocultarError() {
  errorBanner.classList.add('hidden');
}
function setStatus(online) {
  statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  statusText.textContent = online ? 'Backend conectado' : 'Sin conexion';
}
function formatFecha(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(iso));
  } catch { return iso; }
}