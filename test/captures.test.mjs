// Tests de las funciones puras de src/capturas.ts (se ejecutan sobre dist/ tras tsc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeDate, capErrorMessage, capShortId } from '../dist/captures.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('relativeDate: sin fecha devuelve "--"', () => {
  assert.equal(relativeDate(undefined, NOW), '--');
  assert.equal(relativeDate(null, NOW), '--');
  assert.equal(relativeDate('', NOW), '--');
});

test('relativeDate: menos de 10 s es "justo ahora"', () => {
  assert.equal(relativeDate(ago(0), NOW), 'justo ahora');
  assert.equal(relativeDate(ago(9_000), NOW), 'justo ahora');
});

test('relativeDate: segundos, minutos y horas', () => {
  assert.equal(relativeDate(ago(10_000), NOW), 'hace 10 s');
  assert.equal(relativeDate(ago(59_000), NOW), 'hace 59 s');
  assert.equal(relativeDate(ago(60_000), NOW), 'hace 1 min');
  assert.equal(relativeDate(ago(59 * 60_000), NOW), 'hace 59 min');
  assert.equal(relativeDate(ago(60 * 60_000), NOW), 'hace 1 h');
  assert.equal(relativeDate(ago(23 * 3_600_000), NOW), 'hace 23 h');
});

test('relativeDate: días en singular y plural', () => {
  const DAY = 86_400_000;
  assert.equal(relativeDate(ago(DAY), NOW), 'hace 1 día');
  assert.equal(relativeDate(ago(2 * DAY), NOW), 'hace 2 días');
  assert.equal(relativeDate(ago(6 * DAY), NOW), 'hace 6 días');
});

test('relativeDate: una semana o más muestra la fecha absoluta', () => {
  const r = relativeDate(ago(7 * 86_400_000), NOW);
  assert.doesNotMatch(r, /^hace /);
  assert.match(r, /2026/);
});

test('relativeDate: fecha inválida devuelve "--"', () => {
  assert.equal(relativeDate('no-es-fecha', NOW), '--');
});

test('relativeDate: fecha futura (reloj desfasado) muestra la fecha absoluta', () => {
  const future = new Date(NOW + 5 * 60_000).toISOString();
  const r = relativeDate(future, NOW);
  assert.doesNotMatch(r, /^hace |justo ahora/);
  assert.match(r, /2026/);
});

test('relativeDate: un desfase menor de 1 min se trata como "justo ahora"', () => {
  const almost = new Date(NOW + 30_000).toISOString();
  assert.equal(relativeDate(almost, NOW), 'justo ahora');
});

test('capErrorMessage: mensajes específicos para 403, 404 y 5xx', () => {
  assert.equal(capErrorMessage(403), 'No tienes permiso para ver las capturas.');
  assert.equal(capErrorMessage(404), 'El servicio de capturas no está disponible todavía.');
  assert.match(capErrorMessage(500), /error 500\)\. Se reintentará/);
  assert.match(capErrorMessage(503), /error 503/);
});

test('capErrorMessage: otros códigos y fallos de red', () => {
  assert.equal(capErrorMessage(400), 'No se pudieron cargar las capturas (error 400).');
  assert.equal(capErrorMessage(null), 'Sin conexión con el servidor. Se reintentará automáticamente.');
  assert.equal(capErrorMessage(null, new Error('timeout')),
    'Sin conexión con el servidor (timeout). Se reintentará automáticamente.');
});

test('capShortId: recorta a 8 caracteres y acepta números', () => {
  assert.equal(capShortId('123e4567-e89b-12d3'), '123e4567');
  assert.equal(capShortId('abc'), 'abc');
  assert.equal(capShortId(42), '42');
});
