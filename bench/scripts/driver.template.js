// Se pega en browser_run_code_unsafe (Playwright). Reemplazar MODEL por ssd|nano|s. Contexto nuevo por modelo.
async (page) => {
  const MODEL = '__MODEL__';
  const b = page.context().browser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const net = [], fails = [];
  p.on('response', async r => { try { const u = r.url(); if (!u.includes('/img/') && !u.includes('/dataset.json')) { const len = (await r.body()).length; net.push({ url: u, status: r.status(), bytes: len }); } } catch (e) {} });
  p.on('requestfailed', r => fails.push({ url: r.url(), err: r.failure()?.errorText }));
  const cons = []; p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') cons.push(m.text().slice(0, 200)); });
  await p.goto('http://localhost:3300/');
  await p.waitForFunction(() => window.benchReady && window.ort && window.tf && window.cocoSsd, null, { timeout: 60000 });
  const res = await p.evaluate(m => window.runBench(m, 3, 5, 60), MODEL);
  res.meta = { browser: b.browserType().name(), version: b.version(), viewport: { width: 1280, height: 800 },
    ua: await p.evaluate(() => navigator.userAgent), cores: await p.evaluate(() => navigator.hardwareConcurrency), deviceMemoryGB: await p.evaluate(() => navigator.deviceMemory),
    red: net, fallosRed: fails, consola: cons.slice(0, 20), fecha: new Date().toISOString() };
  await p.evaluate(async ([m, r]) => { await fetch('/save/raw_' + m + '.json', { method: 'POST', body: JSON.stringify(r) }); }, [MODEL, res]);
  await ctx.close();
  return { model: MODEL, info: res.info, red: net.filter(n => n.bytes > 100000), fallos: fails, consola: cons.slice(0, 5) };
}
