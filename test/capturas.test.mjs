// Tests de las funciones puras de src/capturas.ts (se ejecutan sobre dist/ tras tsc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fechaRelativa } from '../dist/capturas.js';

const AHORA = Date.parse('2026-11-20T12:00:00Z');
const hace = (ms) => new Date(AHORA - ms).toISOString();

test('fechaRelativa: sin fecha devuelve "--"', () => {
  assert.equal(fechaRelativa(undefined, AHORA), '--');
  assert.equal(fechaRelativa(null, AHORA), '--');
  assert.equal(fechaRelativa('', AHORA), '--');
});

test('fechaRelativa: menos de 10 s es "justo ahora"', () => {
  assert.equal(fechaRelativa(hace(0), AHORA), 'justo ahora');
  assert.equal(fechaRelativa(hace(9_000), AHORA), 'justo ahora');
});

test('fechaRelativa: segundos, minutos y horas', () => {
  assert.equal(fechaRelativa(hace(10_000), AHORA), 'hace 10 s');
  assert.equal(fechaRelativa(hace(59_000), AHORA), 'hace 59 s');
  assert.equal(fechaRelativa(hace(60_000), AHORA), 'hace 1 min');
  assert.equal(fechaRelativa(hace(59 * 60_000), AHORA), 'hace 59 min');
  assert.equal(fechaRelativa(hace(60 * 60_000), AHORA), 'hace 1 h');
  assert.equal(fechaRelativa(hace(23 * 3_600_000), AHORA), 'hace 23 h');
});
