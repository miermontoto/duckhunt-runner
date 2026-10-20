// integración con el cli de claude (0.12.0, t#465): qué flags cuenta como soportados según `claude
// --help` (un flag entero, nunca un trozo de otro), qué capacidades anuncia el daemon con ese kit
// (`model` solo con --model) y qué modelo reporta un run: el del evento init (el bucle principal) y,
// sin él, el de modelUsage que más costó, nunca el haiku auxiliar por ir primero.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeStreamLine, newStreamState, OPTIONAL_FLAGS, reportedModel, supportedFlags } from '../src/claude.js';
import { announcedCapabilities } from '../src/announced-capabilities.js';
import { reportFor } from '../src/status-report.js';

// extracto con la forma de `claude --help` de 2.1.299.
const HELP = [
  'Options:',
  '  --disallowedTools, --disallowed-tools <tools...>',
  '  --fallback-model <model>              Enable automatic fallback to specified',
  '  --max-budget-usd <amount>             Maximum dollar amount to spend on API',
  '  --model <model>                       Model for the current session. Provide',
  "                                        an alias for the latest model (e.g.",
  '  --permission-mode <mode>              Permission mode to use for the session',
  '  --setting-sources <sources>           Comma-separated list of setting sources',
  '  --strict-mcp-config                   Only use MCP servers from --mcp-config,',
  '  --verbose                             Override verbose mode setting from',
].join('\n');
const withoutModel = HELP.split('\n')
  .filter((l) => !l.startsWith('  --model '))
  .join('\n');

test('flags del cli: cuenta un flag entero, no un trozo de otro (--fallback-model no es --model)', () => {
  const all = supportedFlags(HELP);
  assert.deepEqual(
    [...all].sort(),
    ['--disallowedTools', '--max-budget-usd', '--model', '--permission-mode', '--setting-sources', '--strict-mcp-config', '--verbose'].sort(),
  );
  assert.ok(!supportedFlags(withoutModel).has('--model'), 'solo --fallback-model');
  assert.ok(!supportedFlags('  --model-config <file>').has('--model'), 'un flag futuro más largo');
  assert.ok(supportedFlags('--model=<m>').has('--model'));
  assert.ok(OPTIONAL_FLAGS.includes('--model'));
});

test('capacidades: model solo si el cli lista --model; prompt y las suyas solo con sus flags', () => {
  const caps = (help: string, over: Partial<Parameters<typeof announcedCapabilities>[0]> = {}): string[] =>
    announcedCapabilities({ hasAws: true, supported: supportedFlags(help), ...over });
  const full = caps(HELP);
  assert.ok(full.includes('model'));
  assert.deepEqual(full.slice(-3), ['model', 'toolset_v1', 'toolset_render'], 'al final: las de antes no cambian de orden');
  assert.ok(['aws', 'prompt', 'read_shell', 'native_memory', 'events', 'checkout', 'repo_edit', 'secret_paths', 'seed_budget', 'aws_strict', 'worktree_report', 'logout'].every((c) => full.includes(c)));
  // sin --model, exactamente lo que anunciaba 0.11.0 más toolset_v1 y toolset_render al final (t#495, M5).
  assert.deepEqual(caps(withoutModel), [
    'aws',
    'prompt',
    'read_shell',
    'native_memory',
    'events',
    'checkout',
    'repo_edit',
    'secret_paths',
    'seed_budget',
    'aws_strict',
    'worktree_report',
    'logout',
    'toolset_v1',
    'toolset_render',
  ]);
  // el interruptor del flip (defaults.toolsetRender: false): las de 0.13.0, sin toolset_render.
  assert.deepEqual(caps(HELP, { toolsetRender: false }), full.filter((c) => c !== 'toolset_render'));
  const old = caps('  --model <model>\n  --permission-mode <mode>', { hasAws: false, remoteRepoEdits: false });
  assert.ok(old.includes('model') && !old.includes('prompt') && !old.includes('aws') && !old.includes('repo_edit'));
});

const line = (o: object): string => JSON.stringify(o);
const USAGE = {
  'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 40, costUSD: 0.0011 },
  'claude-opus-5-5': { inputTokens: 30000, outputTokens: 2000, costUSD: 1.42 },
};
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'hecho', total_cost_usd: 1.4211, num_turns: 6, session_id: 's1', modelUsage: USAGE };

test('modelo reportado: el del init manda sobre modelUsage', () => {
  const state = newStreamState();
  consumeStreamLine(state, line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-4-5', tools: [] }));
  assert.equal(state.initModel, 'claude-sonnet-4-5');
  consumeStreamLine(state, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }] } }));
  consumeStreamLine(state, line(RESULT));
  assert.equal(state.result?.model, 'claude-sonnet-4-5');
  assert.equal(reportFor({ exitCode: 0, killedBy: null, stream: state, stderrTail: '' }, undefined).model, 'claude-sonnet-4-5');
  // otro system (hooks, compactación) no lo toca, ni un init sin modelo.
  const other = newStreamState();
  consumeStreamLine(other, line({ type: 'system', subtype: 'hook_response', model: 'x' }));
  consumeStreamLine(other, line({ type: 'system', subtype: 'init', model: 7 }));
  assert.equal(other.initModel, null);
});

test('modelo reportado: sin init, la clave de modelUsage con más coste (no la primera, que suele ser el haiku auxiliar)', () => {
  const state = newStreamState();
  consumeStreamLine(state, line(RESULT));
  assert.equal(state.result?.model, 'claude-opus-5-5');
  assert.equal(reportedModel(null, { a: { inputTokens: 1 }, b: { costUSD: 'x' } }), 'a', 'sin costes: la primera');
  assert.equal(reportedModel(null, { a: { costUSD: 0 }, b: { costUSD: 0.5 }, c: null }), 'b');
  assert.equal(reportedModel(null, {}), null);
  assert.equal(reportedModel(null, undefined), null);
  assert.equal(reportedModel('claude-opus-5-5', {}), 'claude-opus-5-5');
});
