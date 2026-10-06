# Orbis Frontend

Panel de monitoreo web para **Orbis** — sistema de tecnologia asistiva IoT para personas con discapacidad visual (bastón inteligente con IA).

> Este repositorio es el **frontend** del proyecto Orbis.
> El backend se encuentra en: [orbisBackend](https://github.com/JuanAcostaACE/orbisBackend)

---

## Descripcion

Orbis Frontend es una aplicacion web estatica (HTML + CSS + Vanilla JS) que muestra en tiempo real los eventos detectados por el bastón inteligente SmartCane AI. Permite visualizar obstaculos detectados, distancias, resultados del analisis de IA (Google Vision) y escuchar los resultados por voz (Web Speech API).

---

## Tecnologias

- HTML5 semantico
- CSS3 (variables, grid, animaciones)
- JavaScript ES2022 (Vanilla, sin frameworks ni npm)
- Web Speech API (sintesis de voz)
- Google Fonts (Inter)

---

## Instalacion

No requiere instalacion de dependencias. Es un sitio estatico puro.

1. Clona el repositorio:
   ```bash
   git clone https://github.com/JuanAcostaACE/orbisFrontend.git
   cd orbisFrontend
   ```

2. **Configura la URL del backend** (ver seccion siguiente).

3. Abre index.html en tu navegador, o deployalo en Vercel.

---

## Configuracion de la URL del backend

Edita la linea 13 de pp.js:

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
La URL del backend se configura directamente en pp.js como se explica arriba.

---

## Ejecutar localmente

Opcion 1 — Directamente en el navegador:
`ash
# Abre el archivo directamente
start index.html   # Windows
open index.html    # macOS
`

Opcion 2 — Con un servidor HTTP simple (recomendado para evitar CORS en fetch):
`ash
# Python 3
python -m http.server 3000

# Luego abre: http://localhost:3000
`

---

## Despliegue en Vercel

1. Importa este repositorio en [vercel.com](https://vercel.com)
2. Framework Preset: **Other** (es estatico puro)
3. No requiere variables de entorno en Vercel
4. Vercel desplegara automaticamente con cada push a main

---

## Estructura del proyecto

`
orbisFrontend/
├── index.html    # Interfaz principal
├── style.css     # Estilos (dark mode, responsive)
├── app.js        # Logica: fetch API, render, Web Speech
├── .gitignore
└── README.md
`

---

## Como se comunica con el backend

- **GET** /api/v1/eventos — Obtiene la lista de eventos (se refresca cada 10 segundos automaticamente)
- El backend debe estar configurado con CORS para aceptar el origen de Vercel (*.vercel.app)

---

## Parte del proyecto Orbis

| Repositorio | Descripcion |
|---|---|
| [orbisFrontend](https://github.com/JuanAcostaACE/orbisFrontend) | Este repositorio — Panel web |
| [orbisBackend](https://github.com/JuanAcostaACE/orbisBackend) | API REST Java/Spring Boot |