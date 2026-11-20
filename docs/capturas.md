# Capturas analizadas (`src/capturas.ts`)

Muestra las fotos que envía el bastón y su estado de análisis.

| Estado | Texto | Glifo |
|---|---|---|
| `RECIBIDA` | Recibida | ○ |
| `EN_PROCESO` | En proceso | ◐ |
| `DESCRITA` | Descrita | ✓ |
| `FALLIDA` | Fallida | ✕ |
| `ENTREGADA` | Entregada | ➤ |

El estado nunca se comunica solo con color: siempre lleva texto y glifo.

- Refresco cada `CAP_REFRESH_MS` = 10 s, páginas de `CAP_PAGE_SIZE` = 20.
- Un `401` del backend llama a `alExpirarSesion` y vuelve a la pantalla de login.
- Funciones públicas: `iniciarCapturas`, `cargarCapturas`, `iniciarPollingCapturas`,
  `detenerPollingCapturas`, `reiniciarCapturas`.
