// trinquete del README (t#440 P0): los comandos que copia quien instala el daemon fijan la versión que se publica con
// él. el README sale en el tarball de npm, así que el `chore: X.Y.Z` de cada release sube también sus pins.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const README = new URL('../../README.md', import.meta.url);
const PACKAGE = new URL('../../package.json', import.meta.url);

test('cada `duckhunt-runner@x.y.z` del README es la versión del package', () => {
  const { version } = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')) as { version: string };
  const pins = Array.from(fs.readFileSync(README, 'utf8').matchAll(/duckhunt-runner@(\d+\.\d+\.\d+)/g), (m) => m[1]);
  assert.ok(pins.length > 0, 'el README sin comandos fijados');
  assert.deepEqual(Array.from(new Set(pins)), [version], `pins del README: ${Array.from(new Set(pins)).join(', ')}; package: ${version}`);
});
