# Sesión y llamadas a la API

- Al cargar, `verificarSesion()` llama a `GET /auth/me`; si responde 200 se muestra el panel.
- `login()` y `registro()` usan `POST /auth/login` y `POST /auth/registro`.
- `logout()` llama a `POST /auth/logout` y detiene el polling y la cámara.
- La cookie de sesión es HttpOnly: el código del frontend nunca la lee ni la guarda.
- Un `401` en cualquier llamada se trata como sesión expirada.

No se guardan tokens ni contraseñas en `localStorage` ni `sessionStorage`.
