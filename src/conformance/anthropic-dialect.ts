// el dialecto de la Messages api de anthropic para el proveedor guionizado (t#440 P6): lo justo para que claude code
// trabaje sin modelo de verdad (ANTHROPIC_BASE_URL hacia el arnés, una api key de mentira). contesta /v1/messages en
// streaming (sse) o en json, /v1/messages/count_tokens y /v1/models; lo demás no es suyo y queda grabado como ruta sin
// guion.
// decisiones:
// - una conversación sigue el guion si trae tools y la marca de su rol en el primer mensaje; su turno es cuántos turnos
//   del asistente trae el historial. todo lo demás (títulos, resúmenes, el modelo pequeño de las llamadas auxiliares)
//   recibe un texto inocuo y no avanza nada.
// - el input de una llamada que se calcula al contestar y lanza (la ruta que esperaba no existe) es un 500: el cli no
//   recibe la llamada, el paso queda sin contestar y el veredicto es un error, nunca un pass.
// - observar: solo lo que el cli manda; los turnos del asistente (texto del modelo e inputs de sus tools, que llevan
//   rutas y comandos del guion) nunca cuentan como contexto.

import crypto from 'node:crypto';
import { ROLE_MARKER_RE, SCRIPT_ROLE, type ModelScript, type ScriptCall, type ScriptRole } from './probe.js';
import { SCRIPT_CALL_ID_RE, scriptCallId, type ObservedToolResult, type ProviderDialect, type ProviderObservation, type ProviderReply, type RecordedRequest } from './provider-dialect.js';

const MESSAGES_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const MODELS_PATH = '/v1/models';
const TOOL_ID_PREFIX = 'toolu_';
const MESSAGE_ID_PREFIX = 'msg_';
const NONCE_BYTES = 6;
const DEFAULT_MODEL = 'conformance';
// lo que contesta una llamada auxiliar y lo que dice el modelo al acabar su guion.
const BENIGN_TEXT = 'ok';
const FINISH_TEXT = 'done';
const STOP_REASON = { endTurn: 'end_turn', toolUse: 'tool_use' } as const;
const USAGE = { input_tokens: 1, output_tokens: 1 };
const COUNTED_TOKENS = 1;
const HTTP = { ok: 200, badRequest: 400, serverError: 500 } as const;
const ROLES: ReadonlySet<string> = new Set(Object.values(SCRIPT_ROLE));

type Obj = Record<string, unknown>;
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonce = (): string => crypto.randomBytes(NONCE_BYTES).toString('hex');

// el cuerpo json de una petición, o null si no lo es.
function parsed(body: string): Obj | null {
  try {
    const v: unknown = JSON.parse(body);
    return isObj(v) ? v : null;
  } catch {
    // no es json: la petición no sigue el guion (se contesta 400 o se ignora al observar).
    return null;
  }
}

const messagesOf = (req: Obj): Obj[] => (Array.isArray(req.messages) ? req.messages.filter(isObj) : []);
const hasTools = (req: Obj): boolean => Array.isArray(req.tools) && req.tools.length > 0;

/** el rol de una conversación: la marca de su primer mensaje (null = no sigue el guion). */
export function roleOf(req: Obj): ScriptRole | null {
  const first = messagesOf(req)[0];
  const role = first === undefined ? undefined : ROLE_MARKER_RE.exec(JSON.stringify(first.content ?? ''))?.[1];
  return role !== undefined && ROLES.has(role) ? (role as ScriptRole) : null;
}

/** el turno de una conversación: cuántos turnos del asistente trae ya su historial. */
export const turnOf = (req: Obj): number => messagesOf(req).filter((m) => m.role === 'assistant').length;

/** los eventos sse de un mensaje del asistente con un solo bloque, en el orden de la api. */
export function messageEvents(model: string, block: Block): { event: string; data: unknown }[] {
  const tool = block.type === 'tool_use';
  const ev = (type: string, data: Obj): { event: string; data: unknown } => ({ event: type, data: { type, ...data } });
  return [
    ev('message_start', { message: { id: `${MESSAGE_ID_PREFIX}${nonce()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } }),
    ev('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: block.id, name: block.name, input: {} } : { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: tool ? STOP_REASON.toolUse : STOP_REASON.endTurn, stop_sequence: null }, usage: { output_tokens: USAGE.output_tokens } }),
    ev('message_stop', {}),
  ];
}

// el mismo mensaje sin streaming.
const messageJson = (model: string, block: Block): Obj => ({
  id: `${MESSAGE_ID_PREFIX}${nonce()}`,
  type: 'message',
  role: 'assistant',
  model,
  content: [block],
  stop_reason: block.type === 'tool_use' ? STOP_REASON.toolUse : STOP_REASON.endTurn,
  stop_sequence: null,
  usage: USAGE,
});

const apiError = (status: number, type: string, message: string): ProviderReply => ({ kind: 'json', status, body: { type: 'error', error: { type, message } } });

// el bloque del turno: la llamada del guion o el texto del final; el motivo si su input no se pudo calcular.
function blockFor(role: ScriptRole, turn: number, call: ScriptCall | undefined): Block | { error: string } {
  if (call === undefined) return { type: 'text', text: FINISH_TEXT };
  try {
    const input = typeof call.input === 'function' ? call.input() : { ...call.input };
    return { type: 'tool_use', id: scriptCallId(TOOL_ID_PREFIX, role, turn, nonce()), name: call.tool, input };
  } catch (err) {
    return { error: `el guion no pudo calcular el input del paso ${turn} de ${role}: ${(err as Error).message}` };
  }
}

// el texto de un tool_result (texto o lista de bloques; lo que no es texto, en json).
const resultText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n') : JSON.stringify(content ?? '');

// los resultados de las llamadas del guion de una petición.
function resultsOf(req: Obj): (ObservedToolResult & { id: string })[] {
  return messagesOf(req)
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => (m.content as unknown[]).filter(isObj))
    .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .flatMap((b) => {
      const id = b.tool_use_id as string;
      const m = SCRIPT_CALL_ID_RE.exec(id);
      return m && ROLES.has(m[1]!) ? [{ id, role: m[1] as ScriptRole, step: Number(m[2]), text: resultText(b.content), isError: b.is_error === true }] : [];
    });
}

/** el dialecto de la Messages api (ver cabecera). */
export const anthropicDialect: ProviderDialect = {
  id: 'anthropic-messages',

  answer(method: string, path: string, body: string, script: ModelScript): ProviderReply | null {
    if (method === 'POST' && path === COUNT_TOKENS_PATH) return { kind: 'json', status: HTTP.ok, body: { input_tokens: COUNTED_TOKENS } };
    if (method === 'GET' && path === MODELS_PATH) return { kind: 'json', status: HTTP.ok, body: { data: [], has_more: false, first_id: null, last_id: null } };
    if (method !== 'POST' || path !== MESSAGES_PATH) return null;
    const req = parsed(body);
    if (req === null) return apiError(HTTP.badRequest, 'invalid_request_error', 'el cuerpo no es un objeto json');
    const model = typeof req.model === 'string' && req.model ? req.model : DEFAULT_MODEL;
    const role = hasTools(req) ? roleOf(req) : null;
    const turn = turnOf(req);
    const block: Block | { error: string } = role === null ? { type: 'text', text: BENIGN_TEXT } : blockFor(role, turn, script[role]?.[turn]);
    if ('error' in block) return apiError(HTTP.serverError, 'api_error', block.error);
    return req.stream === true ? { kind: 'sse', events: messageEvents(model, block) } : { kind: 'json', status: HTTP.ok, body: messageJson(model, block) };
  },

  observe(requests: readonly RecordedRequest[]): ProviderObservation {
    const bodies = requests
      .filter((r) => r.method === 'POST' && r.path === MESSAGES_PATH)
      .map((r) => parsed(r.body))
      .filter((b): b is Obj => b !== null);
    const all = bodies.flatMap(resultsOf);
    // el primer resultado de cada llamada y, de cada paso, el de su primera llamada contestada.
    const results = all.filter((r, i) => all.findIndex((o) => o.role === r.role && o.step === r.step) === i).map(({ role, step, text, isError }) => ({ role, step, text, isError }));
    const roles = Array.from(new Set(bodies.filter(hasTools).map(roleOf).filter((r): r is ScriptRole => r !== null)));
    const offeredTools = Array.from(
      new Set(bodies.flatMap((b) => (Array.isArray(b.tools) ? b.tools : [])).flatMap((t) => (isObj(t) && typeof t.name === 'string' ? [t.name] : []))),
    );
    const context = bodies.map((b) => JSON.stringify([b.system ?? null, ...messagesOf(b).filter((m) => m.role !== 'assistant')])).join('\n');
    return { roles, results, offeredTools, context };
  },
};
