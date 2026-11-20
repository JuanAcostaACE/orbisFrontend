// Servidor estatico del benchmark en el puerto 3300. node bench/serve.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.BENCH_DATA || path.resolve(here, '../../bench-data');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.onnx': 'application/octet-stream' };
const roots = { '/img/': path.join(DATA, 'img'), '/models/': path.join(DATA, 'models'), '/lib/': path.join(here, 'lib'), '/': path.join(here, 'site') };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && u.startsWith('/save/')) {
    const name = path.basename(u); const chunks = [];
    req.on('data', c => chunks.push(c)).on('end', () => { fs.writeFileSync(path.join(here, 'results', name), Buffer.concat(chunks)); res.end('ok'); });
    return;
  }
  if (u === '/dataset.json') return fs.createReadStream(path.join(here, 'dataset.json')).pipe(res.writeHead(200, { 'Content-Type': 'application/json' }));
  for (const k of ['/img/', '/models/', '/lib/', '/']) if (u.startsWith(k)) {
    const f = path.join(roots[k], u === '/' ? 'bench.html' : u.slice(k.length));
    if (!f.startsWith(roots[k]) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) break;
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404).end('nf');
}).listen(3300, () => console.log('bench en http://localhost:3300'));
