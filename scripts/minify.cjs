#!/usr/bin/env node
/**
 * scripts/minify.cjs
 *
 * Bundle + minificación con Terser.
 * Combina dist/vision.js + dist/app.js en un único app.js en la raíz.
 * El import('dist/vision.js') en app.ts se resuelve inlineando el módulo.
 *
 * SEGURIDAD Y TRANSPARENCIA:
 *   Esta minificación reduce tamaño y dificulta lectura casual (no es cifrado).
 *   La seguridad REAL reside en el servidor: Spring Security, cookies HttpOnly,
 *   validación de entradas, aislamiento por propietario, secrets en Railway.
 *   Lo que protege la minificación:
 *     ✅ Reduce tamaño ~40-60%
 *     ✅ Elimina comentarios y nombres legibles
 *     ✅ Dificulta ingeniería inversa casual
 *   Lo que NO protege:
 *     ❌ No oculta lógica de un atacante determinado
 *     ❌ No protege datos en tránsito (eso es HTTPS)
 *     ❌ No reemplaza auth/authz en el servidor
 */

const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const DIST   = path.join(__dirname, '..', 'dist');
const OUTPUT = path.join(__dirname, '..', 'app.js');

// Orden de concatenación: vision primero (lo importa app)
const FILES = ['vision.js', 'captures.js', 'app.js'];

async function run() {
  const missing = FILES.filter(f => !fs.existsSync(path.join(DIST, f)));
  if (missing.length > 0) {
    console.error(`[minify] ERROR: No encontrado en dist/: ${missing.join(', ')}`);
    console.error('         Ejecuta tsc primero.');
    process.exit(1);
  }

  // Concatenar módulos, eliminando import/export para compatibilidad IIFE
  let sources = '';
  for (const fileName of FILES) {
    let content = fs.readFileSync(path.join(DIST, fileName), 'utf-8');
    // Eliminar imports/exports inter-módulos (ya concatenados)
    content = content
      .replace(/^import\s+[^;\n]*?from\s+['"]\.\/[\w-]+\.js['"]\s*;?[ \t]*\r?\n?/gm, '')
      .replace(/^export\s+(const|let|var|class|function|interface|type)\s+/gm, '$1 ')
      .replace(/^export\s+\{[^}]+\}\s*;?\s*/gm, '')
      .replace(/^export\s+default\s+/gm, 'const _default = ');
    sources += `\n// ── ${fileName} ──\n` + content + '\n';
  }

  const sizeBefore = Buffer.byteLength(sources, 'utf-8');

  const result = await minify(sources, {
    compress: {
      drop_console: false,
      passes: 2
    },
    mangle: {
      toplevel: false
    },
    format: {
      comments: false
    }
  });

  if (!result.code) {
    console.error('[minify] ERROR: terser no generó código.');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT, result.code, 'utf-8');

  const sizeAfter = Buffer.byteLength(result.code, 'utf-8');
  const reduction   = (((sizeBefore - sizeAfter) / sizeBefore) * 100).toFixed(1);

  console.log(`[minify] OK: dist/{vision,captures,app}.js → app.js (bundle)`);
  console.log(`         Antes:   ${(sizeBefore / 1024).toFixed(1)} KB`);
  console.log(`         Después: ${(sizeAfter / 1024).toFixed(1)} KB`);
  console.log(`         Reducción: ${reduction}%`);
}

run().catch(e => { console.error('[minify] ERROR:', e.message); process.exit(1); });
