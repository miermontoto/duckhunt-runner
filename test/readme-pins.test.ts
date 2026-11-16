// trinquete del README (t#440 P0; t#660): los comandos que copia quien instala el daemon van con `@latest`, que npm
// resuelve en cada ejecución, igual que el comando que enseña duckhunt. antes se fijaban a la versión del package y
// cada `chore: X.Y.Z` los subía; desde t#660 un pin numérico se quedaría viejo en la siguiente release. la única forma
// con versión es el `<version>` de la unidad de systemd escrita a mano: un servicio sí va fijado.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const README = new URL('../../README.md', import.meta.url);
const ALLOWED_TAGS = new Set(['latest', '<version>']);

test('cada `duckhunt-runner@…` del README es `@latest` (o el `<version>` de la unidad a mano), nunca un número', () => {
  const tags = Array.from(fs.readFileSync(README, 'utf8').matchAll(/duckhunt-runner@(\S+)/g), (m) => m[1]!.replace(/[`.,)]+$/, ''));
  assert.ok(tags.includes('latest'), 'el README sin comandos');
  assert.deepEqual(
    tags.filter((tag) => !ALLOWED_TAGS.has(tag)),
    [],
    'un pin numérico en el README',
  );
});
