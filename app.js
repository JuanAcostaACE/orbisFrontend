/* ================================================================
   ORBIS app.js - Panel IoT con grafica, tabla, simulador y camara
   ================================================================ */

const RAILWAY_URL = 'https://orbisbackend-production.up.railway.app';
const API_BASE    = window.location.hostname === 'localhost' ? 'http://localhost:8080' : RAILWAY_URL;
const EP_EVENTOS  = `${API_BASE}/api/v1/eventos`;
const REFRESH_MS  = 10000;

const $  = id => document.getElementById(id);

// DOM
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

// Estado
let todosEventos = [];
let chart        = null;
let chartType    = 'bar';
let autoInterval = null;
let autoRunning  = false;
let synth        = window.speechSynthesis || null;
let streamActivo = null;
let fuenteImagen = 'cam'; // 'cam' o 'file'

// ================================================================
// INIT
// ================================================================
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

  // Modo ACTIVO/PASIVO - mostrar/ocultar seccion camara
  $('sim-modo').addEventListener('change', function() {
    const grupo = $('grupo-camara');
    if (grupo) grupo.classList.toggle('hidden', this.value !== 'ACTIVO');
  });
  // Mostrar si ACTIVO ya esta seleccionado al cargar
  if ($('sim-modo').value === 'ACTIVO' && $('grupo-camara')) {
    $('grupo-camara').classList.remove('hidden');
  }

  // Tabs fuente imagen
  $('btn-src-cam').addEventListener('click', () => cambiarFuente('cam'));
  $('btn-src-file').addEventListener('click', () => cambiarFuente('file'));

  // Camara
  $('btn-cam-start').addEventListener('click', iniciarCamara);
  $('btn-cam-stop').addEventListener('click', detenerCamara);

  // Preview archivo
  $('sim-imagen').addEventListener('change', function() {
    const p = $('sim-preview');
    if (p && this.files[0]) { p.src = URL.createObjectURL(this.files[0]); p.classList.remove('hidden'); }
  });
});

// ================================================================
// CAMARA
// ================================================================
function cambiarFuente(fuente) {
  fuenteImagen = fuente;
  $('btn-src-cam').classList.toggle('active', fuente === 'cam');
  $('btn-src-file').classList.toggle('active', fuente === 'file');
  $('panel-cam').classList.toggle('hidden', fuente !== 'cam');
  $('panel-file').classList.toggle('hidden', fuente !== 'file');
  if (fuente !== 'cam') detenerCamara();
}

async function iniciarCamara() {
  try {
    streamActivo = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false
    });
    $('cam-video').srcObject = streamActivo;
    $('btn-cam-start').classList.add('hidden');
    $('btn-cam-stop').classList.remove('hidden');
    $('cam-status').textContent = 'Camara activa - lista para capturar';
    $('cam-status').className = 'cam-status active';
  } catch (e) {
    alert('No se pudo acceder a la camara: ' + e.message);
  }
}

function detenerCamara() {
  if (streamActivo) { streamActivo.getTracks().forEach(t => t.stop()); streamActivo = null; }
  $('cam-video').srcObject = null;
  $('btn-cam-start').classList.remove('hidden');
  $('btn-cam-stop').classList.add('hidden');
  $('cam-status').textContent = 'Camara inactiva';
  $('cam-status').className = 'cam-status';
}

function capturarFrame() {
  const video  = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  if (!streamActivo || !video || !canvas) return null;
  const MAX = 480;
  const w = video.videoWidth  || 640;
  const h = video.videoHeight || 480;
  const ratio = Math.min(MAX/w, MAX/h, 1);
  canvas.width  = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.5);
}

// ================================================================
// FETCH
// ================================================================
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
  } catch (e) {
    mostrarError(`Sin conexion: ${e.message}`);
  } finally {
    mostrarCargando(false);
  }
}

// ================================================================
// KPIs
// ================================================================
function actualizarKPIs(eventos) {
  const pasivos = eventos.filter(e => e.modo?.toUpperCase() === 'PASIVO');
  const activos = eventos.filter(e => e.modo?.toUpperCase() === 'ACTIVO');
  const dists   = eventos.filter(e => e.distanciaCm != null).map(e => e.distanciaCm);
  const prom    = dists.length ? (dists.reduce((a,b) => a+b,0)/dists.length).toFixed(1)+' cm' : '--';
  countTotal.textContent  = eventos.length;
  countPasivo.textContent = pasivos.length;
  countActivo.textContent = activos.length;
  avgDist.textContent     = prom;
}

// ================================================================
// TABLA
// ================================================================
function renderTabla() {
  const modo   = filtroModo.value.toUpperCase();
  const buscar = filtroBuscar.value.toLowerCase();
  const filtrados = todosEventos.filter(e => {
    return (!modo || e.modo?.toUpperCase() === modo) &&
           (!buscar || (e.etiquetasIA||'').toLowerCase().includes(buscar));
  }).sort((a,b) => new Date(b.fechaHora)-new Date(a.fechaHora));

  tbody.innerHTML = '';
  if (filtrados.length === 0) { emptyState.classList.remove('hidden'); tableCount.textContent=''; return; }
  emptyState.classList.add('hidden');
  tableCount.textContent = `${filtrados.length} evento${filtrados.length!==1?'s':''}`;

  filtrados.forEach(e => {
    const tr = document.createElement('tr');
    const tieneIA = e.modo?.toUpperCase()==='ACTIVO' && e.etiquetasIA && e.etiquetasIA!=='SIN_IMAGEN';
    tr.innerHTML = `
      <td class="td-id">#${e.id??'--'}</td>
      <td><span class="badge-modo" data-modo="${e.modo?.toUpperCase()}">${e.modo??'--'}</span></td>
      <td class="td-dist">${e.distanciaCm!=null?e.distanciaCm.toFixed(1)+' cm':'--'}</td>
      <td class="td-ia">${e.etiquetasIA??'--'}</td>
      <td class="td-fecha">${formatFecha(e.fechaHora)}</td>
      <td>${tieneIA?`<button class="btn-voz" data-texto="${e.etiquetasIA}">🔊</button>`:'--'}</td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-voz').forEach(btn => {
    btn.addEventListener('click', () => leerVoz(btn.dataset.texto, btn));
  });
}

// ================================================================
// GRAFICA
// ================================================================
function renderChart(eventos) {
  const grupos = {};
  [...eventos].sort((a,b)=>new Date(a.fechaHora)-new Date(b.fechaHora)).slice(-20).forEach(e => {
    const dia = e.fechaHora ? new Date(e.fechaHora).toLocaleDateString('es-CO',{month:'short',day:'numeric'}) : '?';
    if (!grupos[dia]) grupos[dia] = {PASIVO:0, ACTIVO:0};
    grupos[dia][e.modo?.toUpperCase()==='ACTIVO'?'ACTIVO':'PASIVO']++;
  });
  const labels=Object.keys(grupos);
  const pasivos=labels.map(l=>grupos[l].PASIVO);
  const activos=labels.map(l=>grupos[l].ACTIVO);
  if (chart) chart.destroy();
  const ctx = $('eventos-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [
        { label:'Pasivo', data:pasivos, backgroundColor:'rgba(34,197,94,0.7)', borderColor:'rgba(34,197,94,1)', borderWidth:2, fill:chartType==='line', tension:0.4 },
        { label:'Activo', data:activos, backgroundColor:'rgba(99,102,241,0.7)', borderColor:'rgba(99,102,241,1)', borderWidth:2, fill:chartType==='line', tension:0.4 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins: { legend:{labels:{color:'#cbd5e1',font:{family:'Inter',size:12}}}, tooltip:{backgroundColor:'#1e293b',titleColor:'#f1f5f9',bodyColor:'#94a3b8'} },
      scales: { x:{ticks:{color:'#64748b'},grid:{color:'rgba(255,255,255,0.05)'}}, y:{ticks:{color:'#64748b',stepSize:1},grid:{color:'rgba(255,255,255,0.05)'},beginAtZero:true} }
    }
  });
}

function cambiarChart(tipo) {
  chartType = tipo;
  $('btn-chart-bar').classList.toggle('active', tipo==='bar');
  $('btn-chart-line').classList.toggle('active', tipo==='line');
  renderChart(todosEventos);
}

// ================================================================
// SIMULADOR
// ================================================================
async function imagenABase64(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ================================================================
// HUGGING FACE - llamada directa desde el navegador
// ================================================================
async function analizarConIA(dataUrl) {
  const HF_TOKEN = document.getElementById('hf-token-input') ? 
                   document.getElementById('hf-token-input').value : 
                   sessionStorage.getItem('hf_token') || '';
  if (!HF_TOKEN) throw new Error('Token HF no configurado');
  
  const blob = await (await fetch(dataUrl)).blob();
  const r = await fetch('https://api-inference.huggingface.co/models/microsoft/resnet-50', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HF_TOKEN },
    body: blob
  });
  if (r.status === 503) throw new Error('Modelo IA cargando, espere 20 seg y reintente');
  if (!r.ok) throw new Error('HF error ' + r.status);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return (data || []).slice(0,3).map(d => {
    let l = d.label || '';
    if (l.includes(',')) l = l.split(',').pop().trim();
    return l.charAt(0).toUpperCase() + l.slice(1);
  }).join(', ') || 'Objeto detectado';
}

async function enviarSimulacion() {
  const modo      = document.getElementById('sim-modo').value;
  const distancia = parseFloat(document.getElementById('sim-distancia').value);
  const btn       = document.getElementById('btn-sim-enviar');
  btn.disabled = true; btn.textContent = 'Procesando...';
  simResult.className = 'sim-result';
  simResult.classList.remove('hidden');
  simResult.textContent = 'Procesando...';

  try {
    let etiquetasIA = null;
    if (modo === 'ACTIVO') {
      let dataUrl = null;
      if (fuenteImagen === 'cam' && streamActivo) {
        dataUrl = capturarFrame();
        if (!dataUrl) throw new Error('No se pudo capturar la camara');
      } else if (fuenteImagen === 'file') {
        const fi = document.getElementById('sim-imagen');
        if (fi && fi.files[0]) dataUrl = await imagenABase64(fi.files[0]);
      }
      if (dataUrl) {
        simResult.textContent = 'Analizando con IA...';
        try { etiquetasIA = await analizarConIA(dataUrl); }
        catch(iaErr) { etiquetasIA = 'ERROR_IA: ' + iaErr.message; }
      }
    }

    const body = { modo, distanciaCm: distancia, etiquetasIA };
    const res = await fetch(EP_EVENTOS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    simResult.classList.add('success');
    const ia = data.etiquetasIA && data.etiquetasIA !== 'SIN_IMAGEN' ? ' | IA: ' + data.etiquetasIA : '';
    simResult.textContent = 'Evento #' + data.id + ' - ' + modo + ' | ' + distancia + ' cm' + ia;
    await cargarEventos();
  } catch(e) {
    simResult.classList.add('error');
    simResult.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Enviar evento';
  }
}
function toggleAuto() {
  const btn = $('btn-sim-auto');
  if (autoRunning) {
    clearInterval(autoInterval); autoRunning = false;
    btn.textContent = 'Auto (5s)'; btn.classList.remove('btn-danger');
  } else {
    autoRunning = true; btn.textContent = 'Detener auto'; btn.classList.add('btn-danger');
    enviarSimulacion();
    autoInterval = setInterval(() => {
      const modos = ['PASIVO','ACTIVO'];
      $('sim-modo').value = modos[Math.floor(Math.random()*modos.length)];
      const d = Math.floor(Math.random()*150)+10;
      $('sim-distancia').value = d;
      $('sim-distancia-val').textContent = d+' cm';
      enviarSimulacion();
    }, 5000);
  }
}

// ================================================================
// VOZ
// ================================================================
function leerVoz(texto, btn) {
  if (!synth) { alert('Tu navegador no soporta voz.'); return; }
  if (synth.speaking) { synth.cancel(); return; }
  const u = new SpeechSynthesisUtterance(`Obstaculo identificado: ${texto}`);
  u.lang='es-ES'; u.rate=0.9;
  u.onstart = () => btn.textContent='⏹';
  u.onend = u.onerror = () => btn.textContent='🔊';
  synth.speak(u);
}

// ================================================================
// UI HELPERS
// ================================================================
function mostrarCargando(v) {
  loading.classList.toggle('hidden',!v);
  loading.setAttribute('aria-busy',v?'true':'false');
}
function mostrarError(msg) { errorBanner.textContent=`${msg}`; errorBanner.classList.remove('hidden'); }
function ocultarError()    { errorBanner.classList.add('hidden'); }
function formatFecha(iso) {
  if (!iso) return '--';
  try { return new Intl.DateTimeFormat('es-CO',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(iso)); }
  catch { return iso; }
}