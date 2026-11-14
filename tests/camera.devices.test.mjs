// Pruebas (sin DOM) de la regla de camara predeterminada. Uso: npm test (tsc + dist/).
import assert from 'node:assert/strict';
import { construirListaCamaras, elegirPredeterminada, resolverSeleccion } from '../dist/camera/devices.js';

const v = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });
const sinPermiso = construirListaCamaras([v('a', ''), v('b', ''), v('c', ''), { kind: 'audioinput', deviceId: 'm', label: '' }]);
const conPermiso = construirListaCamaras([v('a', 'Integrated Camera'), v('b', 'OBS Virtual'), v('c', 'Logitech C920')]);

assert.deepEqual(sinPermiso.map(c => c.etiqueta), ['Camara 1', 'Camara 2', 'Camara 3']);
assert.equal(sinPermiso.length, 3); // solo videoinput

// Sin permiso: primera. Con etiquetas reales: C920 aunque este tercera.
assert.equal(resolverSeleccion(sinPermiso, null, false, null, null), 'a');
assert.equal(resolverSeleccion(conPermiso, 'a', false, null, null), 'c'); // reevalua (C2b)
// La preferencia guardada gana a C920; si ya no existe, cae a C920.
assert.equal(resolverSeleccion(conPermiso, 'a', false, null, 'b'), 'b');
assert.equal(elegirPredeterminada(conPermiso, 'zzz'), 'c');
// Eleccion manual y camara activa se respetan.
assert.equal(resolverSeleccion(conPermiso, 'b', true, null, null), 'b');
assert.equal(resolverSeleccion(conPermiso, 'a', false, 'b', null), 'b');
assert.equal(resolverSeleccion(conPermiso, 'x', true, null, null), 'c'); // manual ya no existe
assert.equal(elegirPredeterminada([], null), null);
console.log('OK: regla de camara predeterminada (8 casos)');
