# Compilación y despliegue

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # tsc + scripts/minify.cjs → app.js
npm test            # tsc + tests de test/*.test.mjs con node:test
```

- `tsc` compila `src/` a `dist/` (modo `strict`, sin source maps).
- `scripts/minify.cjs` une `dist/vision.js`, `dist/capturas.js` y `dist/app.js` en `app.js` con Terser.
- `app.js` está versionado: tras cambiar `src/` hay que ejecutar `npm run build` y subir el resultado.
- La minificación reduce tamaño; **no** es una medida de seguridad.

## Vercel

`vercel.json` reescribe `/api/*`, `/auth/*` y `/health` hacia el backend en Railway, así el
navegador ve un solo origen y la cookie `SameSite=Strict` funciona.
