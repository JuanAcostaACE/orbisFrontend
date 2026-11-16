// Instrumentacion de tiempos DENTRO de la pagina. Todos los instantes son performance.now() de la
// propia pagina: las comparaciones entre marcas y POST se hacen solo con reloj de pagina (Playwright
// no es fiable como reloj cuando el hilo principal esta ocupado por COCO-SSD).
// Registra en window.__t:
//  - fetches: cada POST a /api/v1/eventos en el instante en que la app llama a fetch (con body).
//  - marks:   parar-camara (click #btn-cam-stop), parar-auto / iniciar-auto (click #btn-sim-auto segun
//             su texto antes del click), cambio-camara (change de #cam-select), desconexion (dispatchEvent
//             'ended' sobre una MediaStreamTrack), auto-texto (cada cambio de texto de #btn-sim-auto,
//             observado con MutationObserver) y estado-camara (cada cambio de data-estado de #cam-status).
// Se ejecuta antes que cualquier script de la app (addInitScript).
export function tiemposInit() {
  window.__t = { fetches: [], marks: [] };
  const ahora = () => performance.now();
  const marcar = (tipo, extra) => window.__t.marks.push(Object.assign({ tipo, t: ahora() }, extra || {}));

  const f = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (m === 'POST' && url.includes('/api/v1/eventos')) {
      window.__t.fetches.push({ t: ahora(), body: init && init.body ? String(init.body) : null });
    }
    return f(input, init);
  };

  // Captura: se ejecuta antes que los manejadores de la app, por eso el texto leido es el previo al click.
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('#btn-cam-stop, #btn-sim-auto') : null;
    if (!el) return;
    if (el.id === 'btn-cam-stop') marcar('parar-camara');
    else if (/Detener/.test(el.textContent)) marcar('parar-auto');
    else marcar('iniciar-auto');
  }, true);
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'cam-select') marcar('cambio-camara', { valor: e.target.value });
  }, true);

  const d = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    if (ev && ev.type === 'ended' && typeof MediaStreamTrack !== 'undefined' && this instanceof MediaStreamTrack) {
      marcar('desconexion');
    }
    return d.call(this, ev);
  };

  // Transiciones de estado observadas en la pagina (no dependen de la latencia de Playwright).
  let textoAuto = null, estadoCam = null;
  const observar = () => {
    const b = document.getElementById('btn-sim-auto');
    const c = document.getElementById('cam-status');
    const tx = b ? b.textContent.trim() : null;
    const est = c ? c.getAttribute('data-estado') : null;
    if (tx !== null && tx !== textoAuto) { textoAuto = tx; marcar('auto-texto', { texto: tx }); }
    if (est !== null && est !== estadoCam) { estadoCam = est; marcar('estado-camara', { estado: est }); }
  };
  new MutationObserver(observar).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-estado'] });
}

// Vuelca los tiempos de la pagina a un JSON por test y repeticion.
export async function volcarTiempos(page, ti, OUT) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const datos = await page.evaluate(() => window.__t);
    const nombre = ti.title.slice(0, 4).replace(/\W/g, '');
    fs.writeFileSync(path.join(OUT, `TIEMPOS-${nombre}-r${ti.repeatEachIndex}.json`), JSON.stringify(datos, null, 2));
  } catch (e) { /* la pagina pudo cerrarse */ }
}
