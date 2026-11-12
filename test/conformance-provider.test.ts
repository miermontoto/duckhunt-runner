// el proveedor guionizado del arnés de conformidad (t#440 P6): los eventos sse de un mensaje del asistente en el orden
// de la Messages api, el servidor http que graba lo que recibe y contesta el guion, y sus barreras (una ruta sin guion
// es un 404 grabado; una salida a otro host se rechaza y se apunta). nada de esto gasta tokens ni sale a la red.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { anthropicDialect, messageEvents } from '../src/conformance/anthropic-dialect.js';
import { ROLE_MARKER, SCRIPT_ROLE, type ModelScript } from '../src/conformance/probe.js';
import { sseFrame, startScriptedProvider, type ScriptedProvider } from '../src/conformance/scripted-provider.js';

const MODEL = 'conformance';
const SCRIPT: ModelScript = { [SCRIPT_ROLE.main]: [{ tool: 'Read', input: { file_path: '/x' } }] };

test('sseFrame: `event:` + `data:` json en una línea y una línea en blanco', () => {
  assert.equal(sseFrame('message_stop', { type: 'message_stop' }), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

test('messageEvents de un tool_use: el orden de la api, con el input en el delta y stop_reason tool_use', () => {
  const evs = messageEvents(MODEL, { type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '/x' } });
  assert.deepEqual(evs.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const start = evs[1]!.data as { content_block: { type: string; name: string } };
  assert.deepEqual([start.content_block.type, start.content_block.name], ['tool_use', 'Read']);
  const delta = evs[2]!.data as { delta: { type: string; partial_json: string } };
  assert.deepEqual([delta.delta.type, delta.delta.partial_json], ['input_json_delta', '{"file_path":"/x"}']);
  const mdelta = evs[4]!.data as { delta: { stop_reason: string } };
  assert.equal(mdelta.delta.stop_reason, 'tool_use');
});

test('messageEvents de un texto: text_delta y stop_reason end_turn', () => {
  const evs = messageEvents(MODEL, { type: 'text', text: 'done' });
  const start = evs[1]!.data as { content_block: { type: string } };
  const delta = evs[2]!.data as { delta: { type: string; text: string } };
  const mdelta = evs[4]!.data as { delta: { stop_reason: string } };
  assert.deepEqual([start.content_block.type, delta.delta.type, delta.delta.text, mdelta.delta.stop_reason], ['text', 'text_delta', 'done', 'end_turn']);
});

// --- el servidor ---

let provider: ScriptedProvider;

before(async () => {
  provider = await startScriptedProvider(anthropicDialect, SCRIPT);
});
after(async () => {
  await provider.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${provider.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('el primer turno con la marca del rol devuelve la llamada del guion en streaming sse', async () => {
  const res = await post('/v1/messages', { model: MODEL, stream: true, max_tokens: 1, tools: [{ name: 'Read' }], messages: [{ role: 'user', content: `${ROLE_MARKER(SCRIPT_ROLE.main)} lee` }] });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const frames = (await res.text()).split('\n\n').filter(Boolean);
  assert.equal(frames[0]!.startsWith('event: message_start'), true);
  assert.match(frames.join('\n'), /"type":"tool_use","id":"toolu_cf_main_0_[0-9a-f]+","name":"Read"/);
});

test('count_tokens y /v1/models tienen respuesta; una conversación sin tools recibe texto inocuo', async () => {
  assert.equal((await post('/v1/messages/count_tokens', { messages: [] })).status, 200);
  assert.equal((await fetch(`${provider.url}/v1/models`)).status, 200);
  const res = await post('/v1/messages', { model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'resume esto' }] });
  const body = (await res.json()) as { content: { type: string; text: string }[] };
  assert.deepEqual([body.content[0]!.type, body.content[0]!.text], ['text', 'ok']);
});

test('una credencial de la cabecera no se graba, y una ruta sin guion es un 404 grabado como no atendida', async () => {
  await post('/v1/unknown', {}, { authorization: 'Bearer sk-secreto', 'x-api-key': 'clave' });
  const rec = provider.requests.find((r) => r.path === '/v1/unknown')!;
  assert.equal(rec.handled, false);
  assert.deepEqual([rec.headers.authorization, rec.headers['x-api-key']], ['[redacted]', '[redacted]']);
});

test('una petición a otro host se rechaza (403) y se apunta como salida: nada de la sonda sale a la red', async () => {
  const { hostname, port } = new URL(provider.url);
  const status = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(Number(port), hostname, () => sock.write('GET http://example.invalid/leak HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n'));
    // la primera línea de la respuesta basta: no esperamos al cierre (la conexión puede quedar viva con keep-alive).
    sock.once('data', (d) => {
      resolve(d.toString('utf8').split('\r\n')[0] ?? '');
      sock.destroy();
    });
    sock.on('error', reject);
  });
  assert.match(status, /^HTTP\/1\.1 403/);
  assert.equal(
    provider.egress.some((e) => e.includes('example.invalid/leak')),
    true,
  );
});
