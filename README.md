# Orbis Frontend

Panel de monitoreo web para **Orbis** — sistema de tecnologia asistiva IoT para personas con discapacidad visual (bastón inteligente con IA).

> Este repositorio es el **frontend** del proyecto Orbis.
> El backend se encuentra en: [orbisBackend](https://github.com/JuanAcostaACE/orbisBackend)

---

## Descripcion

Orbis Frontend es una aplicacion web estatica (HTML + CSS + TypeScript compilado, sin frameworks) que muestra en tiempo real los eventos detectados por el bastón inteligente. Permite iniciar sesión, ver los eventos y las capturas analizadas, detectar objetos con la cámara directamente en el navegador (COCO-SSD) y escuchar los resultados por voz (Web Speech API).

---

## Tecnologias

- HTML5 semantico
- CSS3 (variables, grid, animaciones)
- TypeScript 5 (modo `strict`) compilado a un único `app.js` minificado con Terser
- TensorFlow.js con COCO-SSD (y MobileNet de respaldo) para detección de objetos en el navegador
- Chart.js para la gráfica de eventos
- Web Speech API (sintesis de voz)
- Google Fonts (Inter)

---

## Instalacion

El sitio publicado es estatico, pero el codigo fuente esta en TypeScript y se compila con Node 20 o superior.

1. Clona el repositorio e instala las dependencias de desarrollo:
   ```bash
   git clone https://github.com/JuanAcostaACE/orbisFrontend.git
   cd orbisFrontend
   npm ci
   ```

2. Compila y ejecuta los tests:
   ```bash
   npm run build   # src/*.ts -> app.js
   npm test        # tests unitarios de test/
   ```

3. Sirve la carpeta con un servidor HTTP (ver "Ejecutar localmente").
---

## Configuracion de la URL del backend

Edita la linea 13 de `app.js`:

```javascript
// ANTES (placeholder):
: 'REEMPLAZAR_CON_URL_RAILWAY';

// DESPUES (tu URL real de Railway):
: 'https://tu-proyecto.railway.app';
```

En desarrollo local, el frontend detecta automaticamente localhost y apunta a http://localhost:8080.

---

## Variables de entorno

Este proyecto **no usa variables de entorno** al ser estatico puro.
La URL del backend se configura directamente en `app.js` como se explica arriba.

---

## Ejecutar localmente

Opcion 1 — Directamente en el navegador:
```bash
# Abre el archivo directamente
start index.html   # Windows
open index.html    # macOS
```

Opcion 2 — Con un servidor HTTP simple (recomendado para evitar CORS en fetch):
```bash
# Python 3
python -m http.server 3000

# Luego abre: http://localhost:3000
```

---

## Despliegue en Vercel

1. Importa este repositorio en [vercel.com](https://vercel.com)
2. Framework Preset: **Other** (es estatico puro)
3. No requiere variables de entorno en Vercel
4. Vercel desplegara automaticamente con cada push a main

---

## Estructura del proyecto

```
orbisFrontend/
├── index.html    # Interfaz principal
├── style.css     # Estilos (dark mode, responsive)
├── app.js        # Logica: fetch API, render, Web Speech
├── .gitignore
└── README.md
```

---

## Como se comunica con el backend

- **GET** /api/v1/eventos — Obtiene la lista de eventos (se refresca cada 10 segundos automaticamente)
- El backend debe estar configurado con CORS para aceptar el origen de Vercel (*.vercel.app)

---

## Seguridad

- Cabeceras de seguridad y CSP (modo Report-Only) configuradas en `vercel.json`.
- Librerías de CDN con versión fija y SRI.
- Sin `innerHTML` con datos del backend; sin tokens en `localStorage`.
- CI con `npm audit`, Dependabot y CodeQL.

Detalles y cómo reportar vulnerabilidades: [SECURITY.md](SECURITY.md).

## Parte del proyecto Orbis

| Repositorio | Descripcion |
|---|---|
| [orbisFrontend](https://github.com/JuanAcostaACE/orbisFrontend) | Este repositorio — Panel web |
| [orbisBackend](https://github.com/JuanAcostaACE/orbisBackend) | API REST Java/Spring Boot |

---

## Integrantes

- Juan David Acosta Urbano
- Matias Castaño Raigoza
- Valentina Artega Realpe
