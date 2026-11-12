// el veredicto de una sonda de conformidad (t#440 P6): de lo que el cli le contó al proveedor y de lo que quedó en
// disco (nunca del texto del modelo), si la garantía se cumplió. las pruebas cubren los cinco veredictos con
// observaciones sintéticas y, sobre todo, la prueba de mutación: la MISMA sonda y el MISMO proveedor con un cli falso
// que filtra el canario frente a uno que lo niega tienen que dar FAIL frente a PASS (y XFAIL frente a XPASS en un hueco
// conocido). un arnés que no los distingue no vale.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { anthropicDialect } from '../src/conformance/anthropic-dialect.js';
import { buildCanaryHome, removeCanaryHome, type CanaryHome } from '../src/conformance/canary-home.js';
import { ROLE_MARKER, SCRIPT_ROLE, type Probe } from '../src/conformance/probe.js';
import { startScriptedProvider } from '../src/conformance/scripted-provider.js';
import { judgeProbe, VERDICT, type FileView, type LaunchSummary } from '../src/conformance/verdict.js';
import type { ProviderObservation } from '../src/conformance/provider-dialect.js';
import { BACKEND_ATTESTATION } from '../src/backends/attestation-evidence.js';

const MARKER = 'MARK';
const NO_FILES: FileView = { exists: () => false, read: () => null };
const OK: LaunchSummary = { error: null };
const STUB = {} as CanaryHome;

// una sonda que ignora el canario: lee en el paso 0 y comprueba que su resultado no trae `LEAK`.
const fakeProbe = (gap: string | null): Probe => ({
  id: gap === null ? 'fake_holds' : 'fake_gap',
  title: 'una garantía de mentira',
  attestations: [BACKEND_ATTESTATION.ownCredentialConfined],
  gap,
  run: { profile: 'read', cwd: 'repo', toolset: {} as Probe['run']['toolset'] },
  script: () => ({ [SCRIPT_ROLE.main]: [{ tool: 'probe', input: {} }] }),
  controls: () => [{ kind: 'result_has', role: SCRIPT_ROLE.main, step: 0, value: MARKER, label: 'leyó' }],
  checks: () => [{ kind: 'result_lacks', role: SCRIPT_ROLE.main, step: 0, value: 'LEAK', label: 'no filtró' }],
});

const obs = (text: string | null): ProviderObservation => ({
  roles: text === null ? [] : [SCRIPT_ROLE.main],
  results: text === null ? [] : [{ role: SCRIPT_ROLE.main, step: 0, text, isError: false }],
  offeredTools: ['probe'],
  context: '',
});

test('cumplida sin hueco = PASS; filtrada = FAIL', () => {
  assert.equal(judgeProbe(fakeProbe(null), STUB, obs(MARKER), OK, NO_FILES).verdict, VERDICT.pass);
  assert.equal(judgeProbe(fakeProbe(null), STUB, obs(`${MARKER} LEAK`), OK, NO_FILES).verdict, VERDICT.fail);
});

test('un hueco conocido invierte lo esperado: roto = XFAIL, cumplido = XPASS', () => {
  assert.equal(judgeProbe(fakeProbe('t-x'), STUB, obs(`${MARKER} LEAK`), OK, NO_FILES).verdict, VERDICT.xfail);
  assert.equal(judgeProbe(fakeProbe('t-x'), STUB, obs(MARKER), OK, NO_FILES).verdict, VERDICT.xpass);
});

test('la medida no vale = ERROR, nunca un pass: no se lanzó, un rol que no llegó, un paso sin contestar, un control roto', () => {
  assert.match(judgeProbe(fakeProbe(null), STUB, obs(MARKER), { error: 'no arrancó' }, NO_FILES).observed, /no se lanzó/);
  assert.match(judgeProbe(fakeProbe(null), STUB, obs(null), OK, NO_FILES).observed, /main nunca llegó/);
  assert.match(judgeProbe(fakeProbe(null), STUB, { ...obs(MARKER), results: [] }, OK, NO_FILES).observed, /nunca devolvió el resultado del paso 0/);
  const noControl = judgeProbe(fakeProbe(null), STUB, obs('otra cosa'), OK, NO_FILES);
  assert.deepEqual([noControl.verdict, /control fallido/.test(noControl.observed)], [VERDICT.error, true]);
});

// --- prueba de mutación: un cli falso que filtra frente a uno que niega, contra el proveedor de verdad ---

// un cli de mentira: trabaja contra el proveedor guionizado (Messages api, sin streaming) y ejecuta cada llamada. en
// modo `leak` devuelve el contenido del secreto canario que un run no debería leer; si no, solo la marca.
async function driveFakeCli(url: string, canary: CanaryHome, opts: { leak: boolean }): Promise<void> {
  const tools = [{ name: 'probe', description: '', input_schema: { type: 'object' } }];
  const messages: unknown[] = [{ role: 'user', content: `${ROLE_MARKER(SCRIPT_ROLE.main)} lee el control` }];
  for (let turn = 0; turn < 8; turn++) {
    const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'dummy' }, body: JSON.stringify({ model: 'conformance', max_tokens: 1, tools, messages }) });
    const body = (await res.json()) as { content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[] };
    const block = body.content[0]!;
    if (block.type === 'text') return;
    messages.push({ role: 'assistant', content: [block] });
    const leaked = opts.leak ? ` ${fs.readFileSync(canary.secrets.codexAuth.path, 'utf8')}` : '';
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: `${MARKER}${leaked}` }] });
  }
}

// la sonda real de la mutación: comprueba que el resultado del paso 0 no trae el secreto de codex del canario.
const leakProbe = (gap: string | null): Probe => ({
  ...fakeProbe(gap),
  id: gap === null ? 'mut_holds' : 'mut_gap',
  checks: (c) => [{ kind: 'result_lacks', role: SCRIPT_ROLE.main, step: 0, value: c.secrets.codexAuth.value, label: 'no filtró la credencial de codex' }],
});

let parent = '';
before(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-mutation-'));
});
after(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

async function judgeFakeCli(gap: string | null, leak: boolean): Promise<string> {
  const canary = buildCanaryHome(parent);
  const probe = leakProbe(gap);
  const provider = await startScriptedProvider(anthropicDialect, probe.script(canary));
  try {
    await driveFakeCli(provider.url, canary, { leak });
    return judgeProbe(probe, canary, anthropicDialect.observe(provider.requests), OK).verdict;
  } finally {
    await provider.close();
    removeCanaryHome(canary);
  }
}

test('mutación: el mismo montaje con un cli que niega da PASS y con uno que filtra da FAIL', async () => {
  assert.equal(await judgeFakeCli(null, false), VERDICT.pass);
  assert.equal(await judgeFakeCli(null, true), VERDICT.fail);
});

test('mutación en un hueco conocido: el que niega da XPASS y el que filtra da XFAIL', async () => {
  assert.equal(await judgeFakeCli('t-652', false), VERDICT.xpass);
  assert.equal(await judgeFakeCli('t-652', true), VERDICT.xfail);
});
