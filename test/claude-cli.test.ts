// integración con el cli de claude (0.12.0, t#465): qué flags cuenta como soportados según `claude
// --help` (un flag entero, nunca un trozo de otro), qué capacidades anuncia el daemon con ese kit
// (`model` solo con --model, `effort` desde 0.31.0 solo con --effort) y qué modelo reporta un run: el
// del evento init (el bucle principal) y, sin él, el de modelUsage que más costó, nunca el haiku
// auxiliar por ir primero. uso de contexto (t#682): lo que ocupa el hilo principal, su ventana y las compactaciones de
// cada tramo, en el status y en el informe de un turno.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeStreamLine, contextWindows, newStreamState, OPTIONAL_FLAGS, reportedModel, streamContext, supportedFlags } from '../src/claude.js';
import { turnEndedOf } from '../src/backends/claude/claude-driver.js';
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
  assert.deepEqual(full.slice(-6), ['model', 'toolset_v1', 'toolset_render', 'turn_changes', 'run_changes', 'attachments'], 'al final: las de antes no cambian de orden');
  assert.ok(['aws', 'prompt', 'read_shell', 'native_memory', 'events', 'checkout', 'repo_edit', 'secret_paths', 'seed_budget', 'aws_strict', 'worktree_report', 'logout'].every((c) => full.includes(c)));
  // sin --model, exactamente lo que anunciaba 0.11.0 más toolset_v1 y toolset_render (t#495, M5), turn_changes (t#514),
  // run_changes (t#642) y attachments (t#680) al final.
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
    'turn_changes',
    'run_changes',
    'attachments',
  ]);
  // el interruptor del flip (defaults.toolsetRender: false): las de la sombra, sin toolset_render.
  assert.deepEqual(caps(HELP, { toolsetRender: false }), full.filter((c) => c !== 'toolset_render'));
  const old = caps('  --model <model>\n  --permission-mode <mode>', { hasAws: false, remoteRepoEdits: false });
  assert.ok(old.includes('model') && !old.includes('prompt') && !old.includes('aws') && !old.includes('repo_edit'));
});

test('capacidades (0.31.0, r#563): effort solo si el cli lista --effort, tras las de antes', () => {
  // la línea tal cual sale en `claude --help` de 2.1.326.
  const withEffort = `${HELP}\n  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)`;
  assert.ok(OPTIONAL_FLAGS.includes('--effort'));
  assert.ok(supportedFlags(withEffort).has('--effort'));
  assert.ok(!supportedFlags(HELP).has('--effort'));
  assert.ok(!supportedFlags('  --effort-budget <n>').has('--effort'), 'un flag futuro más largo');
  const caps = (help: string): string[] => announcedCapabilities({ hasAws: true, supported: supportedFlags(help) });
  assert.ok(!caps(HELP).includes('effort'), 'sin el flag el server no manda run.effort ni run.subagents');
  assert.deepEqual(caps(withEffort), [...caps(HELP), 'effort'], 'las de antes no cambian de orden');
  // no depende del perfil prompt (como model): un cli con --effort y sin los flags de prompt la anuncia igual.
  assert.ok(caps('  --effort <level>\n  --permission-mode <mode>').includes('effort'));
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

test('el punto de retomar es del agente principal: un mensaje de un subagente no lo mueve (t#636)', () => {
  const state = newStreamState();
  const main = '11111111-1111-4111-8111-111111111111';
  consumeStreamLine(state, line({ type: 'assistant', uuid: main, message: { content: [{ type: 'tool_use', id: 'toolu_01A', name: 'Agent' }] } }));
  consumeStreamLine(state, line({ type: 'assistant', uuid: '22222222-2222-4222-8222-222222222222', parent_tool_use_id: 'toolu_01A', message: { content: [{ type: 'text', text: 'sub' }] } }));
  assert.equal(state.lastAssistantUuid, main);
  assert.equal(state.toolCalls, 1, 'las tool calls cuentan igual');
});


// --- uso de contexto (t#682) ---

const MAIN_MODEL = 'claude-opus-5-5';
const WINDOW = 1_000_000;
// una llamada al modelo: input sin caché, lo leído y lo escrito en caché, y la salida (el formato de 2.1.326).
const callUsage = (input: number, read: number, created: number, output: number): Record<string, unknown> => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: created,
  output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: created },
  service_tier: 'standard',
});
const said = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  line({ type: 'assistant', parent_tool_use_id: null, message: { model: MAIN_MODEL, content: [{ type: 'text', text: 'x' }], usage }, ...extra });
const compacted = (extra: Record<string, unknown> = {}): string => line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000 }, ...extra });
// el result de una sesión: sus tokens suman TODAS las llamadas (no sirven para el contexto); la ventana, por modelo.
const sessionResult = (window: unknown): string =>
  line({
    ...RESULT,
    usage: { input_tokens: 999_999, cache_read_input_tokens: 999_999, output_tokens: 999_999 },
    modelUsage: { [MAIN_MODEL]: { inputTokens: 999_999, outputTokens: 999_999, costUSD: 1.4, contextWindow: window, maxOutputTokens: 128_000 }, 'claude-haiku-5-5': { costUSD: 0.01, contextWindow: 200_000 } },
  });
const attempt = (stream: ReturnType<typeof newStreamState>, exitCode: number | null = 0) => ({ exitCode, killedBy: null, stream, stderrTail: '' });

test('contexto: el usage del último assistant del hilo principal, con la caché sumada; ni subagentes ni sintéticos a cero', () => {
  const state = newStreamState();
  consumeStreamLine(state, line({ type: 'system', subtype: 'init', model: MAIN_MODEL, tools: [] }));
  assert.equal(streamContext(state, MAIN_MODEL, 0), undefined, 'sin llamadas aún, nada que decir');
  consumeStreamLine(state, said(callUsage(2, 11_364, 22_286, 4)));
  assert.equal(state.contextTokens, 33_656, 'input + cache_read + cache_creation + output');
  // un subagente tiene su propio contexto: no mueve el del principal.
  consumeStreamLine(state, said(callUsage(5, 500_000, 0, 9), { parent_tool_use_id: 'toolu_sub' }));
  // el mensaje sintético del cli (tras un error de api) llega con todo a cero.
  consumeStreamLine(state, said(callUsage(0, 0, 0, 0)));
  // un assistant sin usage (cli viejo) tampoco.
  consumeStreamLine(state, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'y' }] } }));
  assert.equal(state.contextTokens, 33_656);
  consumeStreamLine(state, said({ input_tokens: 3, cache_read_input_tokens: 40_000, output_tokens: 'x' }));
  assert.equal(state.contextTokens, 40_003, 'lo que no es un número cuenta 0');
  // ni result.usage ni los tokens de modelUsage: suman toda la sesión.
  consumeStreamLine(state, sessionResult(WINDOW));
  assert.deepEqual(streamContext(state, MAIN_MODEL, 0), { usedTokens: 40_003, windowTokens: WINDOW });
});

test('ventana: la de modelUsage[modelo].contextWindow al llegar el result (nunca 0 ni inventada), y se recuerda por modelo', () => {
  assert.deepEqual(contextWindows({ a: { contextWindow: 200_000 }, b: { contextWindow: 0 }, c: { contextWindow: -1 }, d: { contextWindow: '1M' }, e: null, f: {} }), { a: 200_000 });
  assert.deepEqual(contextWindows(undefined), {});
  const state = newStreamState();
  consumeStreamLine(state, line({ type: 'system', subtype: 'init', model: MAIN_MODEL, tools: [] }));
  consumeStreamLine(state, said(callUsage(10, 20, 30, 40)));
  // a mitad del primer turno la ventana no se sabe: null, nunca 0.
  assert.deepEqual(streamContext(state, MAIN_MODEL, 0), { usedTokens: 100, windowTokens: null });
  consumeStreamLine(state, sessionResult(WINDOW));
  assert.deepEqual(reportFor(attempt(state), undefined).context, { usedTokens: 100, windowTokens: WINDOW });
  assert.equal(streamContext(state, 'otro-modelo', 0)?.windowTokens, null, 'la de otro modelo no se toma prestada');
  // un result que no la dice (o la dice a 0) no borra la aprendida; un modelo sin ella da null.
  consumeStreamLine(state, sessionResult(0));
  assert.equal(state.contextWindows[MAIN_MODEL], WINDOW);
  // sin result (el proceso cayó a mitad del segundo turno): la del mismo modelo que dijo el primero.
  const crashed = newStreamState();
  consumeStreamLine(crashed, line({ type: 'system', subtype: 'init', model: MAIN_MODEL, tools: [] }));
  consumeStreamLine(crashed, sessionResult(WINDOW));
  crashed.result = null;
  consumeStreamLine(crashed, said(callUsage(1, 2, 3, 4)));
  assert.deepEqual(reportFor(attempt(crashed, 1), undefined).context, { usedTokens: 10, windowTokens: WINDOW });
  assert.equal(reportFor(attempt(newStreamState(), 1), undefined).context, undefined, 'sin ninguna llamada, sin contexto');
});

test('compactaciones: las del hilo principal, contadas por tramo (el turno resta su base, el status las del proceso)', () => {
  const state = newStreamState();
  consumeStreamLine(state, line({ type: 'system', subtype: 'init', model: MAIN_MODEL, tools: [] }));
  consumeStreamLine(state, said(callUsage(1, 150_000, 0, 10)));
  consumeStreamLine(state, compacted());
  // la de un subagente compacta SU contexto.
  consumeStreamLine(state, compacted({ parent_tool_use_id: 'toolu_sub' }));
  consumeStreamLine(state, said(callUsage(1, 20_000, 0, 10)));
  const first = line({ ...JSON.parse(sessionResult(WINDOW)), num_turns: 2 });
  consumeStreamLine(state, first);
  assert.equal(state.compactions, 1);
  const turn1 = turnEndedOf(JSON.parse(first), state, { toolCalls: 0, compactions: 0 });
  assert.deepEqual(turn1.report.context, { usedTokens: 20_011, windowTokens: WINDOW, compactions: 1 });
  assert.deepEqual(turn1.totals, { toolCalls: 0, compactions: 1 });
  // el segundo turno del mismo proceso parte de la base del primero: sin compactar, no lleva ninguna.
  consumeStreamLine(state, said(callUsage(1, 30_000, 0, 10)));
  const second = JSON.parse(sessionResult(WINDOW)) as Parameters<typeof turnEndedOf>[0];
  consumeStreamLine(state, JSON.stringify(second));
  assert.deepEqual(turnEndedOf(second, state, turn1.totals).report.context, { usedTokens: 30_011, windowTokens: WINDOW });
  // en vivo, lo que va de turno; el status del driver cuenta todo el proceso (el daemon resta la base al cerrar).
  consumeStreamLine(state, compacted());
  assert.equal(streamContext(state, MAIN_MODEL, turn1.totals.compactions)?.compactions, 1);
  assert.equal(reportFor(attempt(state), undefined).context?.compactions, 2);
});
