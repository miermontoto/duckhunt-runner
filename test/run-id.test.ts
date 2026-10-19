// ids de run opacos (t#495, M1): qué vale como id, la ida y vuelta con el cable legacy (entero positivo) y que
// el gc sigue reconociendo los conv-<n> de siempre además de los opacos.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareRunIds, isLegacyRunId, legacyWireRunId, RUN_ID_RE, runIdFromLegacy } from '../src/run-id.js';
import { listWorktreeCandidates } from '../src/conversation-gc.js';
import { worktreesDir } from '../src/worktree.js';

test('RUN_ID_RE: texto apto para nombres de fichero, nunca rutas ni espacios', () => {
  ['1', '88', 'l-01HZXK9Q', 'abc_DEF-9', 'x'.repeat(64)].forEach((id) => assert.ok(RUN_ID_RE.test(id), id));
  ['', 'a/b', '..', 'a.b', 'a b', 'ñ', 'x'.repeat(65), '88\n'].forEach((id) => assert.ok(!RUN_ID_RE.test(id), JSON.stringify(id)));
});

test('cable legacy: el entero positivo entra como texto y vuelve como el mismo número', () => {
  assert.equal(runIdFromLegacy(88), '88');
  [0, -1, 1.5, '88', Number.NaN, 2 ** 53, null].forEach((v) => assert.equal(runIdFromLegacy(v), null, String(v)));
  assert.equal(legacyWireRunId('88'), 88);
  assert.ok(isLegacyRunId('9007199254740991'));
  ['088', '0', '9007199254740993', 'l-01HZ', ''].forEach((id) => assert.equal(isLegacyRunId(id), false, id));
});

test('un id opaco nunca llega al cable legacy: legacyWireRunId lanza en vez de mandar un NaN', () => {
  assert.throws(() => legacyWireRunId('l-01HZ'), /no cabe en el cable legacy/);
  assert.throws(() => legacyWireRunId('088'), /no cabe en el cable legacy/);
});

test('orden: los numéricos por valor, como ya los mandaba el cable; los opacos detrás por texto', () => {
  assert.deepEqual(['12', 'b', '3', 'a', '100'].sort(compareRunIds), ['3', '12', '100', 'a', 'b']);
});

test('gc: los conv-<n> de siempre siguen casando, los opacos también, y nada que no sea un id', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-run-id-'));
  try {
    ['conv-123', 'conv-l-01ab_c', 'run-7', 'conv-a.b', 'conv-', 'otro'].forEach((name) => fs.mkdirSync(path.join(worktreesDir(repo), name), { recursive: true }));
    assert.deepEqual(
      listWorktreeCandidates([repo]).map((c) => `${c.kind}:${c.runId}`).sort(),
      ['conversation:123', 'conversation:l-01ab_c', 'run:7'],
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
