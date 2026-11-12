// trinquete del seam de drivers (t#440 P0): cuántas veces toca daemon.ts lo que sabe del cli de claude
// (`this.claude.`). solo puede bajar: el seam AgentDriver (P1) lo lleva a 0 y desde entonces el tope es 0. subir el
// tope es acoplar otra vez el daemon a un cli concreto; lo nuevo va tras la interfaz del driver.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// lo que había al fijar el trinquete (runner 0.26.0).
const CLAUDE_COUPLING_MAX = 11;
const DAEMON = new URL('../../src/daemon.ts', import.meta.url);

test('daemon.ts no toca el cli de claude más veces que el tope del trinquete', () => {
  const uses = fs.readFileSync(DAEMON, 'utf8').match(/\bthis\.claude\./g)?.length ?? 0;
  assert.ok(uses <= CLAUDE_COUPLING_MAX, `daemon.ts usa this.claude. ${uses} veces (tope ${CLAUDE_COUPLING_MAX}): va tras el driver`);
});
