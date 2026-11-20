# Arquitectura del frontend

```
index.html ── app.js (bundle minificado)
                 ├─ src/app.ts       orquestación: auth, dashboard, cámara, tabla, polling
                 ├─ src/vision.ts    proveedores de IA (COCO-SSD, MobileNet) + GestorVision
                 └─ src/capturas.ts  listado de capturas del bastón
```

- `GestorVision` (en `vision.ts`) y los helpers de `capturas.ts` no tocan el DOM: se prueban en Node
  con `npm test` (carpeta `test/`).
- Toda llamada HTTP pasa por `apiFetch` (en `app.ts`), que añade `credentials: "include"`.
- En local la API es `http://localhost:8080`; en producción es relativa y Vercel la reenvía a Railway.
