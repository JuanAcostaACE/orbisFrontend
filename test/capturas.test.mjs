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
