/* ══════════════════════════════════════
   SmartCane AI — app.js
   Consume el backend y usa Web Speech API
   ══════════════════════════════════════ */

// ─────────────────────────────────────
//  CONFIGURACIÓN
// ─────────────────────────────────────
// En desarrollo: Spring Boot corre en localhost:8080.
// En producción (Railway): reemplaza con tu URL de Railway.
const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8080'
  : 'REEMPLAZAR_CON_URL_RAILWAY'; // <- Actualiza esto con tu URL de Railway antes de desplegar en Vercel

const ENDPOINT_EVENTOS = `${API_BASE_URL}/api/v1/eventos`;
const INTERVALO_AUTO_REFRESH_MS = 10000; // Refresca cada 10 segundos automáticamente

// ─────────────────────────────────────
//  REFERENCIAS AL DOM
// ─────────────────────────────────────
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const errorBanner   = document.getElementById('error-banner');
const loading       = document.getElementById('loading');
const eventosList   = document.getElementById('eventos-list');
const emptyState    = document.getElementById('empty-state');
const btnRefresh    = document.getElementById('btn-refresh');
const countTotal    = document.getElementById('count-total');
const countPasivo   = document.getElementById('count-pasivo');
const countActivo   = document.getElementById('count-activo');
const template      = document.getElementById('evento-template');

// ─────────────────────────────────────
//  ESTADO
// ─────────────────────────────────────
let eventosCache = [];
let synth = window.speechSynthesis || null;

// ─────────────────────────────────────
//  INICIO
// ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  cargarEventos();
  btnRefresh.addEventListener('click', cargarEventos);
  setInterval(cargarEventos, INTERVALO_AUTO_REFRESH_MS);
});

// ─────────────────────────────────────
//  FETCH DE EVENTOS
// ─────────────────────────────────────
async function cargarEventos() {
  mostrarCargando(true);
  ocultarError();

  try {
    const response = await fetch(ENDPOINT_EVENTOS, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ mensaje: 'Error desconocido' }));
      throw new Error(`${response.status}: ${errorData.mensaje || response.statusText}`);
    }

    eventosCache = await response.json();
    renderizarEventos(eventosCache);
    actualizarEstadoConexion(true);

  } catch (error) {
    console.error('[SmartCane] Error al cargar eventos:', error);
    mostrarError(`No se pudo conectar con el backend: ${error.message}`);
    actualizarEstadoConexion(false);
  } finally {
    mostrarCargando(false);
  }
}

// ─────────────────────────────────────
//  RENDER
// ─────────────────────────────────────
function renderizarEventos(eventos) {
  eventosList.innerHTML = '';

  if (!eventos || eventos.length === 0) {
    emptyState.classList.remove('hidden');
    actualizarContadores([]);
    return;
  }

  emptyState.classList.add('hidden');

  // Ordenar: más reciente primero
  const ordenados = [...eventos].sort((a, b) =>
    new Date(b.fechaHora) - new Date(a.fechaHora)
  );

  ordenados.forEach(evento => {
    const card = crearTarjetaEvento(evento);
    eventosList.appendChild(card);
  });

  actualizarContadores(eventos);
}

function crearTarjetaEvento(evento) {
  const clone = template.content.cloneNode(true);
  const card  = clone.querySelector('.evento-card');

  // ID único para accesibilidad
  card.setAttribute('aria-label', `Evento ${evento.modo} del ${formatearFecha(evento.fechaHora)}`);

  // Badge de modo
  const badge = clone.querySelector('.evento-modo-badge');
  badge.textContent = evento.modo;
  badge.setAttribute('data-modo', evento.modo?.toUpperCase());

  // Fecha
  clone.querySelector('.evento-fecha').textContent = formatearFecha(evento.fechaHora);

  // Distancia
  const distanciaValor = clone.querySelector('.distancia-valor');
  if (evento.distanciaCm != null) {
    distanciaValor.textContent = evento.distanciaCm.toFixed(1);
  } else {
    distanciaValor.textContent = 'N/A';
    distanciaValor.style.setProperty('--content', '');
    distanciaValor.style.cssText += ' --after-content: ""; ';
    // Override el pseudo-elemento en este caso
    distanciaValor.classList.add('sin-unidad');
  }

  // Resultado IA (solo modo ACTIVO)
  const eventoIa = clone.querySelector('.evento-ia');
  if (evento.modo?.toUpperCase() === 'ACTIVO' && evento.etiquetasIA) {
    eventoIa.classList.remove('hidden');
    clone.querySelector('.ia-valor').textContent = evento.etiquetasIA;

    const btnEscuchar = clone.querySelector('.btn-escuchar');
    btnEscuchar.addEventListener('click', () => {
      leerEnVozAlta(evento.etiquetasIA, btnEscuchar);
    });
  }

  return clone;
}

function actualizarContadores(eventos) {
  const total  = eventos.length;
  const pasivo = eventos.filter(e => e.modo?.toUpperCase() === 'PASIVO').length;
  const activo = eventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO').length;

  countTotal.textContent  = total;
  countPasivo.textContent = pasivo;
  countActivo.textContent = activo;
}

// ─────────────────────────────────────
//  WEB SPEECH API
// ─────────────────────────────────────
function leerEnVozAlta(texto, boton) {
  if (!synth) {
    alert('Tu navegador no soporta la API de síntesis de voz.');
    return;
  }

  // Cancelar lectura anterior si está en curso
  if (synth.speaking) {
    synth.cancel();
    boton.textContent = '🔊 Escuchar';
    return;
  }

  // Limpiar errores conocidos del resultado antes de leer
  const textoLimpio = texto
    .replace('ERROR_VISION: ', 'Error en análisis visual: ')
    .replace('SIN_IMAGEN', 'Sin imagen disponible');

  const utterance = new SpeechSynthesisUtterance(
    `Obstáculo identificado. Análisis de inteligencia artificial: ${textoLimpio}`
  );
  utterance.lang  = 'es-ES';
  utterance.rate  = 0.9;
  utterance.pitch = 1.0;

  utterance.onstart = () => {
    boton.textContent = '⏹ Detener';
    boton.setAttribute('aria-label', 'Detener lectura en voz alta');
  };
  utterance.onend = utterance.onerror = () => {
    boton.textContent = '🔊 Escuchar';
    boton.setAttribute('aria-label', 'Escuchar resultado en voz alta');
  };

  synth.speak(utterance);
}

// ─────────────────────────────────────
//  UI HELPERS
// ─────────────────────────────────────
function mostrarCargando(mostrar) {
  loading.classList.toggle('hidden', !mostrar);
  loading.setAttribute('aria-busy', mostrar ? 'true' : 'false');
}

function mostrarError(mensaje) {
  errorBanner.textContent = `⚠ ${mensaje}`;
  errorBanner.classList.remove('hidden');
}

function ocultarError() {
  errorBanner.classList.add('hidden');
  errorBanner.textContent = '';
}

function actualizarEstadoConexion(online) {
  statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  statusText.textContent = online ? 'Backend conectado' : 'Sin conexión';
}

function formatearFecha(isoString) {
  if (!isoString) return '—';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}
