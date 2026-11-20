# Product

<!-- impeccable:product-schema 1 -->

> Borrador generado a partir del README.md, index.html, src/app.ts, src/alertas.ts y src/vision.ts. Las secciones marcadas como **pendiente de revisión** son inferencias que deben confirmarse con el equipo antes de tomarse como verdad.

## Platform

web

## Users

- **Usuario directo (pendiente de revisión):** personas con discapacidad visual que usan el bastón inteligente SmartCane AI. Su relación con este panel es indirecta: el bastón es el que emite los eventos.
- **Usuario operador (pendiente de revisión):** familiares, cuidadores o personal de soporte que monitorean en tiempo real los eventos detectados desde el panel web, y simulan eventos desde el navegador cuando no hay hardware conectado.

## Product Purpose

Orbis es un sistema de tecnología asistiva IoT para personas con discapacidad visual. Este repositorio es el **panel web de monitoreo**: muestra en tiempo real los eventos del bastón (obstáculos detectados, distancias, resultados de análisis de IA), permite consultar el historial, y reproduce los resultados por voz mediante Web Speech API.

Éxito, según el código (pendiente de revisión): el operador ve con claridad qué detectó el bastón, cuándo y a qué distancia, sin tener que interpretar datos crudos.

## Positioning

Panel de monitoreo de un bastón inteligente que combina detección local (TensorFlow.js COCO-SSD / MobileNet en el navegador) con histéresis y cooldown para no saturar al backend, y que confirma la alerta localmente antes de enviar el evento al servidor.

## Operating Context

- Aplicación web estática (HTML, CSS y JavaScript compilado desde TypeScript), desplegada en Vercel.
- Consume la API REST del backend (orbisBackend, Java/Spring Boot) mediante rewrites de Vercel hacia Railway.
- Refresco automático de eventos cada 15 segundos (`REFRESH_MS = 15000` en `src/app.ts`, pausable cuando la pestaña está oculta). El README todavía indica 10 segundos; el código manda.
- Modo simulador del bastón con cámara o carga de imagen, para probar sin hardware.

## Capabilities and Constraints

- Autenticación con login y registro.
- Indicadores clave (KPI), gráfica de eventos por modo, historial paginado con filtro por modo y búsqueda por etiqueta de IA.
- Niveles de distancia: SEGURO, PELIGRO (<= 100 cm) y CRITICO (<= 30 cm), con histéresis de recuperación en 115 cm. Las insignias usan icono y texto, no solo color.
- Sin frameworks de UI ni dependencias de runtime; sin variables de entorno.
- Restricciones técnicas: en producción el frontend usa rutas relativas (`/api`, `/auth`) que `vercel.json` reescribe hacia el backend en Railway, por lo que no hay llamadas entre orígenes. En local (`localhost` / `127.0.0.1`) apunta directamente a `http://localhost:8080` (`src/app.ts`), y ese backend debe aceptar CORS desde el origen local. La URL de Railway se configura en `vercel.json`, no mediante variables de entorno.
- Idioma de la interfaz: español (`lang="es"`).

## Brand Commitments

- Nombre: **ORBIS** (título de la página: "ORBIS - Panel de Monitoreo IoT").
- Tipografía de referencia en el README: Inter (Google Fonts). Esto es evidencia del estado actual, no una decisión visual vinculante (pendiente de revisión).

## Evidence on Hand

- README.md con descripción, instalación y despliegue.
- index.html, style.css y app.js/src/*.ts como implementación actual.
- Sin casos de estudio, testimonios, métricas de uso ni datos de clientes en el repositorio. No se deben inventar.

## Product Principles

1. La alerta local debe ser inmediata; el envío al servidor es secundario y está limitado por cooldown.
2. Cada estado de peligro se comunica con icono y texto, además de color.
3. El panel debe funcionar sin hardware conectado, mediante el simulador.
4. Los datos sensibles de salud y ubicación de personas con discapacidad se tratan con cuidado (pendiente de revisión: política de privacidad no documentada en el repo).

## Accessibility & Inclusion

Pendiente de revisión. El producto está dirigido a personas con discapacidad visual y el panel incluye etiquetas ARIA, pero no hay un estándar de accesibilidad formalmente establecido en el repositorio. Se recomienda confirmar el nivel objetivo (por ejemplo WCAG 2.2 AA) con el equipo.

## Open Decisions

- Confirmar los usuarios primarios y el rol del operador.
- Confirmar el nivel de accesibilidad objetivo.
- Confirmar la política de privacidad para datos de eventos y ubicación.
- Confirmar la forma de construcción preferida (comp-first o code-first); no se registró en `.impeccable/config.json` porque la pregunta no fue respondida.
