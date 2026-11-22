# Política de seguridad — ORBIS Frontend

## Reportar una vulnerabilidad

No abras un issue público. Escribe a cualquiera de los integrantes del equipo
(ver README) con la descripción, los pasos para reproducirlo y el impacto.
Respondemos en un plazo de 5 días hábiles.

## Medidas actuales

| Área | Medida |
|---|---|
| XSS | La tabla de eventos usa `textContent`/`createElement`, nunca `innerHTML` con datos |
| Scripts externos | Versiones fijas con Subresource Integrity (SRI) |
| Cabeceras (Vercel) | nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy (cámara solo propia), HSTS |
| CSP | En modo `Report-Only` mientras se validan los orígenes de los modelos de IA |
| Sesión | Cookie HttpOnly del backend; el frontend nunca guarda tokens en `localStorage` |
| Red | `apiFetch` con timeout de 15 s y `cache: no-store` |
| Formularios | Límites de longitud alineados con el backend (contraseña ≤ 72 bytes) |
| Dependencias | `npm audit` en CI y CodeQL |

## Pasar la CSP a modo estricto

1. Abrir la app desplegada con la consola del navegador abierta.
2. Usar cámara, detección y panel; anotar los reportes de `Content-Security-Policy-Report-Only`.
3. Agregar los orígenes que falten en `vercel.json`.
4. Renombrar la cabecera a `Content-Security-Policy`.
