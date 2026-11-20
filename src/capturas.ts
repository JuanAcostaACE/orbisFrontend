/* ================================================================
   ORBIS capturas.ts — Sección "Capturas analizadas"
   Lista paginada de las fotos analizadas (sin imágenes: el backend
   las elimina). Refresco automático cada 10 s.
   Se concatena con app.ts en el bundle: los nombres llevan prefijo
   "cap" para no colisionar con los del resto del panel.
   ================================================================ */

export type EstadoCaptura = 'RECIBIDA' | 'EN_PROCESO' | 'DESCRITA' | 'FALLIDA' | 'ENTREGADA';

export interface CapturaResponse {
  captureId: string | number;
  estado: string;
  descripcion?: string | null;
  etiquetas?: string[] | null;
  motivoFallo?: string | null;
  recibidaEn?: string | null;
}

export interface PaginaCapturas {
  contenido: CapturaResponse[];
  paginaActual: number;
  tamanioPagina: number;
  totalElementos: number;
  totalPaginas: number;
  primera: boolean;
  ultima: boolean;
}

export interface ConfigCapturas {
  /** Base de la API ('' en producción por los rewrites de Vercel; backend local en desarrollo). */
  apiBase: string;
  /** fetch con credentials:'include' (mismo helper que el resto del panel). */
  fetchApi: (url: string, opts?: RequestInit) => Promise<Response>;
  /** Se invoca si el backend responde 401 (sesión expirada). */
  alExpirarSesion: () => void;
}

export const CAP_REFRESH_MS = 10000;
export const CAP_PAGE_SIZE = 20;

/** Texto, glifo y clase de cada estado: nunca se comunica solo con color. */
const CAP_ESTADOS: Record<EstadoCaptura, { texto: string; glifo: string }> = {
  RECIBIDA:   { texto: 'Recibida',   glifo: '○' },
  EN_PROCESO: { texto: 'En proceso', glifo: '◐' },
  DESCRITA:   { texto: 'Descrita',   glifo: '✓' },
  FALLIDA:    { texto: 'Fallida',    glifo: '✕' },
  ENTREGADA:  { texto: 'Entregada',  glifo: '➤' }
};

/** Fecha relativa en español ("hace 5 min"). Fuera de rango o inválida devuelve '--'. */
export function fechaRelativa(iso?: string | null, ahora: number = Date.now()): string {
  if (!iso) return '--';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '--';
  const seg = Math.round((ahora - t) / 1000);
  if (seg < -60) return capFechaAbsoluta(iso);       // reloj desfasado: mejor la fecha exacta
  if (seg < 10) return 'justo ahora';
  if (seg < 60) return `hace ${seg} s`;
  const min = Math.floor(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? 'hace 1 día' : `hace ${d} días`;
  return capFechaAbsoluta(iso);
}

function capFechaAbsoluta(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  } catch { return iso; }
}

// ----------------------------------------------------------------
// ESTADO DEL MÓDULO
// ----------------------------------------------------------------
let capCfg: ConfigCapturas | null = null;
let capPagina = 0;
let capTotalPaginas = 1;
let capEnCurso = false;
let capTimer: number | null = null;
let capListenersListos = false;
let capHayDatos = false;

function capEl(id: string): HTMLElement | null { return document.getElementById(id); }

function capMostrarVista(vista: 'cargando' | 'vacio' | 'error' | 'lista'): void {
  capEl('cap-cargando')?.classList.toggle('hidden', vista !== 'cargando');
  capEl('cap-vacio')?.classList.toggle('hidden', vista !== 'vacio');
  capEl('cap-error')?.classList.toggle('hidden', vista !== 'error');
  capEl('cap-lista')?.classList.toggle('hidden', vista !== 'lista');
  capEl('cap-nav')?.classList.toggle('hidden', vista !== 'lista');
  capEl('cap-contenido')?.setAttribute('aria-busy', vista === 'cargando' ? 'true' : 'false');
}

function capMensajeError(status: number | null, e?: unknown): string {
  if (status === 403) return 'No tienes permiso para ver las capturas.';
  if (status === 404) return 'El servicio de capturas no está disponible todavía.';
  if (status !== null && status >= 500) return `El servidor tuvo un problema al listar las capturas (error ${status}). Se reintentará automáticamente.`;
  if (status !== null) return `No se pudieron cargar las capturas (error ${status}).`;
  const detalle = e instanceof Error && e.message ? ` (${e.message})` : '';
  return `Sin conexión con el servidor${detalle}. Se reintentará automáticamente.`;
}

function capMostrarError(msg: string): void {
  const el = capEl('cap-error-msg');
  if (el) el.textContent = msg;
  // Con datos ya visibles, el error no los reemplaza: se muestra como aviso sobre la lista.
  capEl('cap-error')?.classList.remove('hidden');
  if (!capHayDatos) {
    capEl('cap-cargando')?.classList.add('hidden');
    capEl('cap-vacio')?.classList.add('hidden');
    capEl('cap-lista')?.classList.add('hidden');
    capEl('cap-nav')?.classList.add('hidden');
    capEl('cap-contenido')?.setAttribute('aria-busy', 'false');
  }
}

function capIdCorto(id: string | number): string {
  const s = String(id);
  return s.length > 8 ? s.slice(0, 8) : s;
}

function capCrearItem(c: CapturaResponse, ahora: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'captura';

  const estadoClave = (c.estado ?? '').toUpperCase() as EstadoCaptura;
  const info = CAP_ESTADOS[estadoClave];

  // Cabecera: estado (texto + glifo + color), id y fecha relativa
  const cab = document.createElement('div');
  cab.className = 'captura-cab';

  const badge = document.createElement('span');
  badge.className = 'badge-captura';
  badge.setAttribute('data-estado', info ? estadoClave : 'DESCONOCIDO');
  const glifo = document.createElement('span');
  glifo.className = 'badge-captura-glifo';
  glifo.setAttribute('aria-hidden', 'true');
  glifo.textContent = info ? info.glifo : '?';
  badge.appendChild(glifo);
  badge.appendChild(document.createTextNode(info ? info.texto : (c.estado || 'Estado desconocido')));
  cab.appendChild(badge);

  const id = document.createElement('span');
  id.className = 'captura-id';
  id.textContent = `Captura ${capIdCorto(c.captureId)}`;
  id.title = String(c.captureId);
  cab.appendChild(id);

  const time = document.createElement('time');
  time.className = 'captura-fecha';
  if (c.recibidaEn) {
    time.dateTime = c.recibidaEn;
    time.title = capFechaAbsoluta(c.recibidaEn);
  }
  time.textContent = `Recibida ${fechaRelativa(c.recibidaEn, ahora)}`.replace('Recibida --', 'Fecha desconocida');
  cab.appendChild(time);
  li.appendChild(cab);

  // Descripción (o motivo del fallo / estado pendiente)
  const desc = document.createElement('p');
  const texto = c.descripcion?.trim();
  if (texto) {
    desc.className = 'captura-desc';
    desc.textContent = texto;
  } else if (estadoClave === 'FALLIDA') {
    desc.className = 'captura-desc captura-desc--vacia';
    desc.textContent = 'No se generó una descripción.';
  } else if (estadoClave === 'RECIBIDA' || estadoClave === 'EN_PROCESO') {
    desc.className = 'captura-desc captura-desc--vacia';
    desc.textContent = 'La descripción aún no está disponible.';
  } else {
    desc.className = 'captura-desc captura-desc--vacia';
    desc.textContent = 'Sin descripción.';
  }
  li.appendChild(desc);

  if (estadoClave === 'FALLIDA') {
    const motivo = document.createElement('p');
    motivo.className = 'captura-fallo';
    motivo.textContent = `Motivo del fallo: ${c.motivoFallo?.trim() || 'no informado'}`;
    li.appendChild(motivo);
  }

  // Etiquetas como chips
  const etiquetas = (c.etiquetas ?? []).filter(t => typeof t === 'string' && t.trim() !== '');
  if (etiquetas.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'chips';
    ul.setAttribute('aria-label', 'Etiquetas');
    etiquetas.forEach(t => {
      const chip = document.createElement('li');
      chip.className = 'chip';
      chip.textContent = t;
      ul.appendChild(chip);
    });
    li.appendChild(ul);
  }
  return li;
}

function capRenderizar(p: PaginaCapturas): void {
  const lista = capEl('cap-lista');
  if (!lista) return;
  while (lista.firstChild) lista.removeChild(lista.firstChild);
  const ahora = Date.now();
  p.contenido.forEach(c => lista.appendChild(capCrearItem(c, ahora)));

  const info = capEl('cap-pag-info');
  if (info) {
    info.textContent = `Página ${p.paginaActual + 1} de ${Math.max(p.totalPaginas, 1)} · ${p.totalElementos} captura${p.totalElementos !== 1 ? 's' : ''}`;
  }
  const prev = capEl('cap-prev') as HTMLButtonElement | null;
  const next = capEl('cap-next') as HTMLButtonElement | null;
  if (prev) prev.disabled = p.primera;
  if (next) next.disabled = p.ultima;
}

function capActualizarHora(): void {
  const el = capEl('cap-actualizado');
  if (el) {
    el.textContent = 'Actualizado a las ' + new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date());
  }
}

/** Carga la página actual. `silencioso` = refresco automático (sin spinner). */
export async function cargarCapturas(silencioso = false): Promise<void> {
  if (!capCfg || capEnCurso) return;
  capEnCurso = true;
  if (!silencioso && !capHayDatos) capMostrarVista('cargando');
  try {
    const res = await capCfg.fetchApi(
      `${capCfg.apiBase}/api/v1/dispositivos/capturas?page=${capPagina}&size=${CAP_PAGE_SIZE}`
    );
    if (res.status === 401) { capCfg.alExpirarSesion(); return; }
    if (!res.ok) { capMostrarError(capMensajeError(res.status)); return; }

    const p = await res.json() as PaginaCapturas;
    capTotalPaginas = p.totalPaginas;
    capEl('cap-error')?.classList.add('hidden');

    // La página pedida ya no existe (bajó el total): volver a la última disponible
    if (p.contenido.length === 0 && p.totalElementos > 0 && capPagina > 0) {
      capPagina = Math.max(p.totalPaginas - 1, 0);
      capEnCurso = false;
      await cargarCapturas(true);
      return;
    }

    capPagina = p.paginaActual;
    capActualizarHora();
    if (p.contenido.length === 0) {
      capHayDatos = false;
      capMostrarVista('vacio');
      return;
    }
    capHayDatos = true;
    capRenderizar(p);
    capMostrarVista('lista');
  } catch (e) {
    capMostrarError(capMensajeError(null, e));
  } finally {
    capEnCurso = false;
  }
}

export function iniciarPollingCapturas(): void {
  detenerPollingCapturas();
  capTimer = window.setInterval(() => {
    if (document.hidden) return;
    void cargarCapturas(true);
  }, CAP_REFRESH_MS);
}

export function detenerPollingCapturas(): void {
  if (capTimer !== null) { clearInterval(capTimer); capTimer = null; }
}

/** Reinicia el estado (p. ej. tras cerrar sesión) y limpia la lista. */
export function reiniciarCapturas(): void {
  detenerPollingCapturas();
  capPagina = 0;
  capHayDatos = false;
  const lista = capEl('cap-lista');
  if (lista) while (lista.firstChild) lista.removeChild(lista.firstChild);
}

/** Registra listeners (una sola vez), carga la primera página y arranca el refresco. */
export function iniciarCapturas(cfg: ConfigCapturas, conPolling: boolean): void {
  capCfg = cfg;
  capPagina = 0;
  capHayDatos = false;
  if (!capListenersListos) {
    capListenersListos = true;
    capEl('cap-prev')?.addEventListener('click', () => {
      if (capPagina > 0) { capPagina--; void cargarCapturas(); }
    });
    capEl('cap-next')?.addEventListener('click', () => {
      if (capPagina < capTotalPaginas - 1) { capPagina++; void cargarCapturas(); }
    });
    capEl('cap-reintentar')?.addEventListener('click', () => { void cargarCapturas(); });
  }
  void cargarCapturas();
  if (conPolling) iniciarPollingCapturas();
}
