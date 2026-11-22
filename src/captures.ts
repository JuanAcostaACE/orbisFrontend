/* ================================================================
   ORBIS captures.ts — Sección "Capturas analizadas"
   Lista paginada de las fotos analizadas (sin imágenes: el backend
   las elimina). Refresco automático cada 10 s.
   Se concatena con app.ts en el bundle: los nombres llevan prefijo
   "cap" para no colisionar con los del resto del panel.
   ================================================================ */

export type CaptureStatus = 'RECEIVED' | 'PROCESSING' | 'DESCRIBED' | 'FAILED' | 'DELIVERED';

export interface CaptureResponse {
  captureId: string | number;
  status: string;
  description?: string | null;
  labels?: string[] | null;
  failureReason?: string | null;
  receivedAt?: string | null;
}

export interface CapturesPage {
  content: CaptureResponse[];
  currentPage: number;
  pageSize: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
}

export interface CapturesConfig {
  /** Base de la API ('' en producción por los rewrites de Vercel; backend local en desarrollo). */
  apiBase: string;
  /** fetch con credentials:'include' (mismo helper que el resto del panel). */
  fetchApi: (url: string, opts?: RequestInit) => Promise<Response>;
  /** Se invoca si el backend responde 401 (sesión expirada). */
  onSessionExpired: () => void;
}

export const CAP_REFRESH_MS = 10000;
export const CAP_PAGE_SIZE = 20;

/** Texto, glifo y clase de cada estado: nunca se comunica solo con color. */
const CAP_STATUSES: Record<CaptureStatus, { text: string; glyph: string }> = {
  RECEIVED:   { text: 'Recibida',   glyph: '○' },
  PROCESSING: { text: 'En proceso', glyph: '◐' },
  DESCRIBED:   { text: 'Descrita',   glyph: '✓' },
  FAILED:    { text: 'Fallida',    glyph: '✕' },
  DELIVERED:  { text: 'Entregada',  glyph: '➤' }
};

/** Fecha relativa en español ("hace 5 min"). Fuera de rango o inválida devuelve '--'. */
export function relativeDate(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return '--';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '--';
  const secs = Math.round((now - t) / 1000);
  if (secs < -60) return capAbsoluteDate(iso);       // reloj desfasado: mejor la fecha exacta
  if (secs < 10) return 'justo ahora';
  if (secs < 60) return `hace ${secs} s`;
  const min = Math.floor(secs / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? 'hace 1 día' : `hace ${d} días`;
  return capAbsoluteDate(iso);
}

function capAbsoluteDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  } catch { return iso; }
}

// ----------------------------------------------------------------
// ESTADO DEL MÓDULO
// ----------------------------------------------------------------
let capCfg: CapturesConfig | null = null;
let capPage = 0;
let capTotalPages = 1;
let capInProgress = false;
let capTimer: number | null = null;
let capListenersReady = false;
let capHasData = false;

function capEl(id: string): HTMLElement | null { return document.getElementById(id); }

function capShowView(view: 'loading' | 'empty' | 'error' | 'list'): void {
  capEl('cap-loading')?.classList.toggle('hidden', view !== 'loading');
  capEl('cap-empty')?.classList.toggle('hidden', view !== 'empty');
  capEl('cap-error')?.classList.toggle('hidden', view !== 'error');
  capEl('cap-list')?.classList.toggle('hidden', view !== 'list');
  capEl('cap-nav')?.classList.toggle('hidden', view !== 'list');
  capEl('cap-content')?.setAttribute('aria-busy', view === 'loading' ? 'true' : 'false');
}

export function capErrorMessage(status: number | null, e?: unknown): string {
  if (status === 403) return 'No tienes permiso para ver las capturas.';
  if (status === 404) return 'El servicio de capturas no está disponible todavía.';
  if (status !== null && status >= 500) return `El servidor tuvo un problema al listar las capturas (error ${status}). Se reintentará automáticamente.`;
  if (status !== null) return `No se pudieron cargar las capturas (error ${status}).`;
  const detail = e instanceof Error && e.message ? ` (${e.message})` : '';
  return `Sin conexión con el servidor${detail}. Se reintentará automáticamente.`;
}

function capShowError(msg: string): void {
  const el = capEl('cap-error-msg');
  if (el) el.textContent = msg;
  // Con datos ya visibles, el error no los reemplaza: se muestra como aviso sobre la lista.
  capEl('cap-error')?.classList.remove('hidden');
  if (!capHasData) {
    capEl('cap-loading')?.classList.add('hidden');
    capEl('cap-empty')?.classList.add('hidden');
    capEl('cap-list')?.classList.add('hidden');
    capEl('cap-nav')?.classList.add('hidden');
    capEl('cap-content')?.setAttribute('aria-busy', 'false');
  }
}

export function capShortId(id: string | number): string {
  const s = String(id);
  return s.length > 8 ? s.slice(0, 8) : s;
}

function capCreateItem(c: CaptureResponse, now: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'capture';

  const statusKey = (c.status ?? '').toUpperCase() as CaptureStatus;
  const info = CAP_STATUSES[statusKey];

  // Cabecera: estado (texto + glifo + color), id y fecha relativa
  const header = document.createElement('div');
  header.className = 'capture-header';

  const badge = document.createElement('span');
  badge.className = 'badge-capture';
  badge.setAttribute('data-status', info ? statusKey : 'UNKNOWN');
  const glyph = document.createElement('span');
  glyph.className = 'badge-capture-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = info ? info.glyph : '?';
  badge.appendChild(glyph);
  badge.appendChild(document.createTextNode(info ? info.text : (c.status || 'Estado desconocido')));
  header.appendChild(badge);

  const id = document.createElement('span');
  id.className = 'capture-id';
  id.textContent = `Captura ${capShortId(c.captureId)}`;
  id.title = String(c.captureId);
  header.appendChild(id);

  const time = document.createElement('time');
  time.className = 'capture-date';
  if (c.receivedAt) {
    time.dateTime = c.receivedAt;
    time.title = capAbsoluteDate(c.receivedAt);
  }
  time.textContent = `Recibida ${relativeDate(c.receivedAt, now)}`.replace('Recibida --', 'Fecha desconocida');
  header.appendChild(time);
  li.appendChild(header);

  // Descripción (o motivo del fallo / estado pendiente)
  const desc = document.createElement('p');
  const text = c.description?.trim();
  if (text) {
    desc.className = 'capture-desc';
    desc.textContent = text;
  } else if (statusKey === 'FAILED') {
    desc.className = 'capture-desc capture-desc--empty';
    desc.textContent = 'No se generó una descripción.';
  } else if (statusKey === 'RECEIVED' || statusKey === 'PROCESSING') {
    desc.className = 'capture-desc capture-desc--empty';
    desc.textContent = 'La descripción aún no está disponible.';
  } else {
    desc.className = 'capture-desc capture-desc--empty';
    desc.textContent = 'Sin descripción.';
  }
  li.appendChild(desc);

  if (statusKey === 'FAILED') {
    const reason = document.createElement('p');
    reason.className = 'capture-failure';
    reason.textContent = `Motivo del fallo: ${c.failureReason?.trim() || 'no informado'}`;
    li.appendChild(reason);
  }

  // Etiquetas como chips
  const labels = (c.labels ?? []).filter(t => typeof t === 'string' && t.trim() !== '');
  if (labels.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'chips';
    ul.setAttribute('aria-label', 'Etiquetas');
    labels.forEach(t => {
      const chip = document.createElement('li');
      chip.className = 'chip';
      chip.textContent = t;
      ul.appendChild(chip);
    });
    li.appendChild(ul);
  }
  return li;
}

function capRender(p: CapturesPage): void {
  const list = capEl('cap-list');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  const now = Date.now();
  p.content.forEach(c => list.appendChild(capCreateItem(c, now)));

  const info = capEl('cap-pag-info');
  if (info) {
    info.textContent = `Página ${p.currentPage + 1} de ${Math.max(p.totalPages, 1)} · ${p.totalElements} captura${p.totalElements !== 1 ? 's' : ''}`;
  }
  const prev = capEl('cap-prev') as HTMLButtonElement | null;
  const next = capEl('cap-next') as HTMLButtonElement | null;
  if (prev) prev.disabled = p.first;
  if (next) next.disabled = p.last;
}

function capUpdateTime(): void {
  const el = capEl('cap-updated');
  if (el) {
    el.textContent = 'Actualizado a las ' + new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date());
  }
}

/** Carga la página actual. `silencioso` = refresco automático (sin spinner). */
export async function loadCaptures(silent = false): Promise<void> {
  if (!capCfg || capInProgress) return;
  capInProgress = true;
  if (!silent && !capHasData) capShowView('loading');
  try {
    const res = await capCfg.fetchApi(
      `${capCfg.apiBase}/api/v1/devices/captures?page=${capPage}&size=${CAP_PAGE_SIZE}`
    );
    if (res.status === 401) { capCfg.onSessionExpired(); return; }
    if (!res.ok) { capShowError(capErrorMessage(res.status)); return; }

    const p = await res.json() as CapturesPage;
    capTotalPages = p.totalPages;
    capEl('cap-error')?.classList.add('hidden');

    // La página pedida ya no existe (bajó el total): volver a la última disponible
    if (p.content.length === 0 && p.totalElements > 0 && capPage > 0) {
      capPage = Math.max(p.totalPages - 1, 0);
      capInProgress = false;
      await loadCaptures(true);
      return;
    }

    capPage = p.currentPage;
    capUpdateTime();
    if (p.content.length === 0) {
      capHasData = false;
      capShowView('empty');
      return;
    }
    capHasData = true;
    capRender(p);
    capShowView('list');
  } catch (e) {
    capShowError(capErrorMessage(null, e));
  } finally {
    capInProgress = false;
  }
}

export function startCapturesPolling(): void {
  stopCapturesPolling();
  capTimer = window.setInterval(() => {
    if (document.hidden) return;
    void loadCaptures(true);
  }, CAP_REFRESH_MS);
}

export function stopCapturesPolling(): void {
  if (capTimer !== null) { clearInterval(capTimer); capTimer = null; }
}

/** Reinicia el estado (p. ej. tras cerrar sesión) y limpia la lista. */
export function resetCaptures(): void {
  stopCapturesPolling();
  capPage = 0;
  capHasData = false;
  const list = capEl('cap-list');
  if (list) while (list.firstChild) list.removeChild(list.firstChild);
}

/** Registra listeners (una sola vez), carga la primera página y arranca el refresco. */
export function startCaptures(cfg: CapturesConfig, withPolling: boolean): void {
  capCfg = cfg;
  capPage = 0;
  capHasData = false;
  if (!capListenersReady) {
    capListenersReady = true;
    capEl('cap-prev')?.addEventListener('click', () => {
      if (capPage > 0) { capPage--; void loadCaptures(); }
    });
    capEl('cap-next')?.addEventListener('click', () => {
      if (capPage < capTotalPages - 1) { capPage++; void loadCaptures(); }
    });
    capEl('cap-retry')?.addEventListener('click', () => { void loadCaptures(); });
  }
  void loadCaptures();
  if (withPolling) startCapturesPolling();
}
