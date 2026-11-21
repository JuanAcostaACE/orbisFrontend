# Capturas analizadas (`src/captures.ts`)

Muestra las fotos que envía el bastón y su estado de análisis.

| Estado | Texto | Glifo |
|---|---|---|
| `RECEIVED` | Recibida | ○ |
| `PROCESSING` | En proceso | ◐ |
| `DESCRIBED` | Descrita | ✓ |
| `FAILED` | Fallida | ✕ |
| `DELIVERED` | Entregada | ➤ |

El estado nunca se comunica solo con color: siempre lleva texto y glifo.

- Refresco cada `CAP_REFRESH_MS` = 10 s, páginas de `CAP_PAGE_SIZE` = 20.
- Un `401` del backend llama a `onSessionExpired` y vuelve a la pantalla de login.
- Funciones públicas: `startCaptures`, `loadCaptures`, `startCapturesPolling`,
  `stopCapturesPolling`, `resetCaptures`.
