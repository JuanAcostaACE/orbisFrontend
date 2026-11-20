# Compilación y despliegue

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # tsc + scripts/minify.cjs → app.js
```

- `tsc` compila `src/` a `dist/` (modo `strict`, sin source maps).
- `scripts/minify.cjs` une `dist/vision.js` y `dist/app.js` en `app.js` con Terser.
- La minificación reduce tamaño; **no** es una medida de seguridad.

## Vercel

`vercel.json` reescribe `/api/*`, `/auth/*` y `/health` hacia el backend en Railway, así el
navegador ve un solo origen y la cookie `SameSite=Strict` funciona.
