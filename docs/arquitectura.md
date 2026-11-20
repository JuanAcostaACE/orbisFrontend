# Arquitectura del frontend

```
index.html ── app.js (bundle minificado)
                 ├─ src/app.ts       orquestación: auth, dashboard, cámara, tabla, polling
                 ├─ src/vision.ts    proveedores de IA (COCO-SSD, MobileNet) + GestorVision
                 ├─ src/alertas.ts   lógica pura de histéresis y cooldown
                 └─ src/capturas.ts  listado de capturas del bastón
```

- `alertas.ts` y la parte de `vision.ts` sin DOM son lógica pura y se pueden probar aislados.
- Toda llamada HTTP pasa por `apiFetch` (en `app.ts`), que añade `credentials: "include"`.
- En local la API es `http://localhost:8080`; en producción es relativa y Vercel la reenvía a Railway.
