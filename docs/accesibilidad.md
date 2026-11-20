# Accesibilidad

ORBIS está pensado para personas con discapacidad visual y sus acompañantes, así que el panel sigue estas reglas:

- Los estados (distancia, capturas) se muestran con texto + icono, nunca solo con color.
- Los cambios importantes se anuncian con regiones `aria-live`.
- Todos los controles tienen foco visible (`:focus-visible`).
- Se respeta `prefers-reduced-motion`.
- El formulario de login se puede enviar con Enter.

## Pendiente

- Auditoría completa WCAG 2.1 AA (contraste y orden de tabulación).
- Probar con lector de pantalla (NVDA y TalkBack).
