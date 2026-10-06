/* ══════════════════════════════════════
   ORBIS — app.js
   Consume el backend Railway y usa Web Speech API
   ══════════════════════════════════════ */

// ─── CONFIGURACION ───────────────────────────────────────────
// INSTRUCCION: Cuando Railway te de la URL del backend, pegalа aqui:
const RAILWAY_URL = 'https://orbisbackend-production.up.railway.app'; // <-- ACTUALIZAR CON URL DE RAILWAY

const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8080'   // Desarrollo local
  : RAILWAY_URL;              // Produccion (Vercel -> Railway)

const ENDPOINT_EVENTOS = `${API_BASE_URL}/api/v1/eventos`;
const INTERVALO_AUTO_REFRESH_MS = 10000;

// ─── DOM ─────────────────────────────────────────────────────
const statusDot   = document.getElementById('status-dot');
const statusText  = document.getElementById('status-text');
const errorBanner = document.getElementById('error-banner');
const loading     = document.getElementById('loading');
const eventosList = document.getElementById('eventos-list');
const emptyState  = document.getElementById('empty-state');
const btnRefresh  = document.getElementById('btn-refresh');
const countTotal  = document.getElementById('count-total');
const countPasivo = document.getElementById('count-pasivo');
const countActivo = document.getElementById('count-activo');
const template    = document.getElementById('evento-template');

// ─── ESTADO ──────────────────────────────────────────────────
let synth = window.speechSynthesis || null;

// ─── INICIO ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  cargarEventos();
  btnRefresh.addEventListener('click', cargarEventos);
  setInterval(cargarEventos, INTERVALO_AUTO_REFRESH_MS);
});

// ─── FETCH ───────────────────────────────────────────────────
async function cargarEventos() {
  mostrarCargando(true);
  ocultarError();
  try {
    const response = await fetch(ENDPOINT_EVENTOS, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ mensaje: 'Error desconocido' }));
      throw new Error(`${response.status}: ${err.mensaje || response.statusText}`);
    }
    const eventos = await response.json();
    renderizarEventos(eventos);
    actualizarEstadoConexion(true);
  } catch (error) {
    console.error('[ORBIS] Error:', error);
    mostrarError(`Sin conexion con el backend: ${error.message}`);
    actualizarEstadoConexion(false);
  } finally {
    mostrarCargando(false);
  }
}

// ─── RENDER ──────────────────────────────────────────────────
function renderizarEventos(eventos) {
  eventosList.innerHTML = '';
  if (!eventos || eventos.length === 0) {
    emptyState.classList.remove('hidden');
    actualizarContadores([]);
    return;
  }
  emptyState.classList.add('hidden');
  const ordenados = [...eventos].sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora));
  ordenados.forEach(e => eventosList.appendChild(crearTarjeta(e)));
  actualizarContadores(eventos);
}

function crearTarjeta(evento) {
  const clone = template.content.cloneNode(true);

  const badge = clone.querySelector('.evento-modo-badge');
  badge.textContent = evento.modo;
  badge.setAttribute('data-modo', evento.modo?.toUpperCase());

  clone.querySelector('.evento-fecha').textContent = formatearFecha(evento.fechaHora);

  const distVal = clone.querySelector('.distancia-valor');
  distVal.textContent = evento.distanciaCm != null ? `${evento.distanciaCm.toFixed(1)} cm` : 'N/A';

  const eventoIa = clone.querySelector('.evento-ia');
  if (evento.modo?.toUpperCase() === 'ACTIVO' && evento.etiquetasIA) {
    eventoIa.classList.remove('hidden');
    clone.querySelector('.ia-valor').textContent = evento.etiquetasIA;
    clone.querySelector('.btn-escuchar').addEventListener('click', function() {
      leerEnVozAlta(evento.etiquetasIA, this);
    });
  }
  return clone;
}

function actualizarContadores(eventos) {
  countTotal.textContent  = eventos.length;
  countPasivo.textContent = eventos.filter(e => e.modo?.toUpperCase() === 'PASIVO').length;
  countActivo.textContent = eventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO').length;
}

// ─── WEB SPEECH API ──────────────────────────────────────────
function leerEnVozAlta(texto, boton) {
  if (!synth) { alert('Tu navegador no soporta sintesis de voz.'); return; }
  if (synth.speaking) { synth.cancel(); boton.textContent = '🔊 Escuchar'; return; }
  const limpio = texto.replace('ERROR_VISION: ', 'Error visual: ').replace('SIN_IMAGEN', 'Sin imagen');
  const u = new SpeechSynthesisUtterance(`Obstaculo identificado: ${limpio}`);
  u.lang = 'es-ES'; u.rate = 0.9;
  u.onstart = () => { boton.textContent = '⏹ Detener'; };
  u.onend = u.onerror = () => { boton.textContent = '🔊 Escuchar'; };
  synth.speak(u);
}

// ─── UI HELPERS ──────────────────────────────────────────────
function mostrarCargando(v) {
  loading.classList.toggle('hidden', !v);
  loading.setAttribute('aria-busy', v ? 'true' : 'false');
}
function mostrarError(msg) {
  errorBanner.textContent = `⚠ ${msg}`;
  errorBanner.classList.remove('hidden');
}
function ocultarError() {
  errorBanner.classList.add('hidden');
  errorBanner.textContent = '';
}
function actualizarEstadoConexion(online) {
  statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  statusText.textContent = online ? 'Backend conectado' : 'Sin conexion';
}
function formatearFecha(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      year:'numeric', month:'short', day:'numeric',
      hour:'2-digit', minute:'2-digit', second:'2-digit'
    }).format(new Date(iso));
  } catch { return iso; }
}