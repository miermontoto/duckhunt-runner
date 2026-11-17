// cerrar el turno al responder (t#690, end-turn.ts): lo que el hook decide con lo que le pasa el cli, los settings que lo
// enganchan, el bloque endTurn del claim, el --settings del argv y el fichero del segmento.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs } from '../src/claude-args.js';
import { parseClaim } from '../src/claim.js';
import { OPTIONAL_FLAGS } from '../src/claude.js';
import { announcedCapabilities } from '../src/announced-capabilities.js';
import { endTurnOutput, endTurnSettings } from '../src/end-turn.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { clearRunMcpConfigs, writeRunSettings } from '../src/run-mcp-config.js';
import { RUN_END_TURN_FIELD } from '../src/vendor/runner-protocol/index.js';

const REPLY = 'mcp__duckhunt__duckhunt-run-reply';
const ASK = 'mcp__duckhunt__duckhunt-ask-user';
const HOOK_ENTRY = fileURLToPath(new URL('../src/end-turn-hook.js', import.meta.url));
// lo que el cli pasa al hook de una tool mcp (verificado con 2.1.326): el resultado como sus bloques de contenido.
const hookInput = (result: unknown, event = 'PostToolUse'): string =>
  JSON.stringify({ hook_event_name: event, tool_name: REPLY, tool_input: {}, tool_response: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
const STOP = { continue: false, stopReason: 'turno cerrado tras la respuesta' };

const rawClaim = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  run: { id: 88, kind: 'prompt', entryId: 5, workspaceId: 1, repo: 'org/app', branch: 'feat/x', repoSource: 'explicit', repoAvailable: true, aws: null, sessionId: null, parentRunId: null, profile: 'edit' },
  prompt: 'haz algo',
  fallbackPrompt: null,
  tier: 'act',
  tools: { allowed: ['Read', REPLY, ASK], disallowed: ['NotebookEdit'] },
  permissionMode: 'dontAsk',
  maxTurns: null,
  maxBudgetUsd: null,
  timeoutMs: 1_800_000,
  heartbeatMs: 20_000,
  events: { enabled: true, nextSeq: 7, flushMs: 1000, flushCount: 20, batchMax: 50, bodyMaxChars: 4000, toolArgMaxChars: 200 },
  mcp: { serverName: 'duckhunt', url: 'https://duckhunt.info/mcp', token: 'dho_x', expiresAt: 1 },
  ...extra,
});

test('el hook cierra el turno solo si el resultado lleva la marca; lo demás, nada', () => {
  assert.equal(RUN_END_TURN_FIELD, 'endTurn');
  assert.deepEqual(JSON.parse(endTurnOutput(hookInput({ id: 1, instruction: 'respuesta enviada', endTurn: true }))!), STOP);
  // una respuesta que pide otra llamada (el veredicto que falta) no la lleva.
  assert.equal(endTurnOutput(hookInput({ id: 1, instruction: 'falta el veredicto: llama con verdictFor' })), null);
  assert.equal(endTurnOutput(hookInput({ endTurn: 'true' })), null, 'solo true cuenta');
  // otra forma del resultado (texto suelto o el objeto tal cual) también vale.
  assert.ok(endTurnOutput(JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: JSON.stringify({ endTurn: true }) })));
  assert.ok(endTurnOutput(JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: { endTurn: true } })));
  // otro evento, texto que no es json o una entrada ilegible: el turno sigue.
  assert.equal(endTurnOutput(hookInput({ endTurn: true }, 'PreToolUse')), null);
  assert.equal(endTurnOutput(JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: [{ type: 'text', text: 'hecho' }] })), null);
  assert.equal(endTurnOutput('no es json'), null);
});

test('los settings enganchan el hook a esas tools exactas, con node y la entrada mínima entre comillas', () => {
  const settings = endTurnSettings([REPLY, 'mcp__a.b__x']) as { hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } };
  const [entry] = settings.hooks.PostToolUse;
  assert.equal(entry!.matcher, `^(${REPLY}|mcp__a\\.b__x)$`);
  const re = new RegExp(entry!.matcher);
  assert.ok(re.test(REPLY) && !re.test(`${REPLY}-2`) && !re.test('mcp__aXb__x'), 'nombres enteros, sin comodines');
  assert.deepEqual(entry!.hooks, [{ type: 'command', command: `'${process.execPath}' '${HOOK_ENTRY}'` }]);
});

test('la entrada mínima del hook: escribe el cierre con la marca y nada sin ella, siempre con 0', () => {
  const run = (input: string): string => execFileSync(process.execPath, [HOOK_ENTRY], { input, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run(hookInput({ endTurn: true }))), STOP);
  assert.equal(run(hookInput({ instruction: 'sigue' })), '');
  assert.equal(run(''), '');
});

test('claim: endTurn solo con ids válidos del servidor mcp de la plataforma, sin repetir; sin ninguno, ni la clave', () => {
  const claim = parseClaim(rawClaim({ endTurn: { tools: [REPLY, ASK, REPLY, 'mcp__other__duckhunt-run-reply', 'Bash', 42, 'mcp__duckhunt__bad id'] } }));
  assert.deepEqual(claim.endTurn, { tools: [REPLY, ASK] });
  assert.equal('endTurn' in parseClaim(rawClaim()), false, 'un server sin end_turn');
  assert.equal('endTurn' in parseClaim(rawClaim({ endTurn: { tools: ['Bash'] } })), false);
  assert.equal('endTurn' in parseClaim(rawClaim({ endTurn: 'sí' })), false, 'un bloque raro no tumba el claim');
});

test('argv: --settings tras --mcp-config con su fichero, solo con un cli que lo lista; capability end_turn igual', () => {
  const args = (settingsFile: string | null, supported: ReadonlySet<(typeof OPTIONAL_FLAGS)[number]>): string[] =>
    buildClaudeArgs({
      claim: parseClaim(rawClaim()),
      prompt: 'haz algo',
      mcpConfigFile: '/r/mcp-88-abcd.json',
      settingsFile,
      supported,
      resumeSessionId: null,
      skipPermissions: false,
      payingWithApiKey: false,
      runConfigDeny: ['Read(//r/**)'],
    });
  const all = new Set(OPTIONAL_FLAGS);
  const withSettings = args('/r/settings-88-abcd.json', all);
  assert.deepEqual(withSettings.slice(withSettings.indexOf('--mcp-config'), withSettings.indexOf('--mcp-config') + 4), ['--mcp-config', '/r/mcp-88-abcd.json', '--settings', '/r/settings-88-abcd.json']);
  assert.ok(!args(null, all).includes('--settings'));
  const old = new Set(OPTIONAL_FLAGS.filter((f) => f !== '--settings'));
  assert.ok(!args('/r/settings-88-abcd.json', old).includes('--settings'), 'un cli que no lo lista abortaría con el flag');
  assert.ok(announcedCapabilities({ hasAws: false, supported: all }).includes('end_turn'));
  assert.ok(!announcedCapabilities({ hasAws: false, supported: old }).includes('end_turn'));
});

let home = '';
let prevHome: string | undefined;
before(() => {
  prevHome = process.env.DUCKHUNT_RUNNER_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-end-turn-')));
  process.env.DUCKHUNT_RUNNER_HOME = home;
});
after(() => {
  if (prevHome === undefined) delete process.env.DUCKHUNT_RUNNER_HOME;
  else process.env.DUCKHUNT_RUNNER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('los settings del segmento: 0600 en el run-config, uno por segmento, y el barrido de arranque los recoge', () => {
  const settings = endTurnSettings([REPLY]);
  const file = writeRunSettings('88', LEGACY_PLATFORM_ID, settings);
  assert.equal(path.dirname(file), path.join(home, 'run-config'));
  assert.match(path.basename(file), /^settings-88-[0-9a-f]{8}\.json$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), settings);
  assert.notEqual(writeRunSettings('88', LEGACY_PLATFORM_ID, settings), file);
  assert.equal(clearRunMcpConfigs(LEGACY_PLATFORM_ID), 2);
  assert.equal(fs.existsSync(file), false);
});
