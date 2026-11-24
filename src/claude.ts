// integración con el cli de claude code: detección de flags soportados (el cli cambia entre
// versiones; los flags opcionales se pasan solo si `claude --help` los lista) y parseo del
// stream-json de un run headless (contadores de tool calls, objeto result final). el evento
// parseado se devuelve para que el feed de progreso (feed.ts) lo lea sin volver a parsear.
// modelo reportado (0.12.0, t#465): el del evento `system/init` (el que eligió el cli para el bucle
// principal, tras --model si lo hubo) y, sin init, la clave de modelUsage con más coste. antes era la
// primera clave de modelUsage, que suele ser el haiku auxiliar del cli (títulos, resúmenes): prod tenía
// 30 runs reportados como claude-haiku-4-5.
// catálogo de slash commands (t#555): del mismo init se guarda lo que el segmento cargó (slash_commands, skills y
// plugins), que slash-commands.ts resuelve a ficheros con su descripción.
// volver atrás (0.17.0, t#564): el `uuid` del último evento assistant del segmento es el punto donde duckhunt puede
// retomar la conversación más tarde (--resume-session-at); un fork conserva los uuid de lo que copia (verificado con
// 2.1.311), así que un punto de antes de un fork sigue valiendo en la sesión nueva.
// uso de contexto (t#682, usage.ts del protocolo): lo que ocupa el hilo principal es el `message.usage` de su último
// `assistant` (input + cache_read + cache_creation + output: el input de anthropic no cuenta la caché), nunca el de un
// subagente ni el `result.usage`/los tokens de `modelUsage` (suman todas las llamadas de la sesión). la ventana solo llega
// en el `result` (`modelUsage[modelo].contextWindow`, misma clave que el modelo del init: verificado con 2.1.326) y se
// guarda por modelo para el progreso en vivo de los turnos siguientes. las compactaciones son los `system/compact_boundary`
// del hilo principal, contadas en todo el proceso: cada informe resta la base de su tramo.
// límites de la suscripción (usage-limits.ts del protocolo): el evento `rate_limit_event` trae en `unifiedWindows` la
// fracción gastada y el reinicio (en segundos) de la ventana de 5 h y la semanal. es de la cuenta, no del hilo: se toma
// con o sin parent_tool_use_id y el último visto se queda en el proceso (a diferencia del contexto, no es por turno).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseInitCatalog, type InitCatalog } from './slash-commands.js';
import {
  REWIND_CLI_MIN_VERSION,
  RUN_CONTEXT_COMPACTIONS_MAX,
  RUN_CONTEXT_TOKENS_MAX,
  RUN_MESSAGE_UUID_RE,
  RUNNER_BACKEND,
  USAGE_LIMIT_RATIO_MAX,
  USAGE_LIMIT_STATUS,
  USAGE_LIMIT_WINDOW,
  USAGE_LIMIT_WINDOW_ID_RE,
  USAGE_LIMIT_WINDOWS_MAX,
  type BackendUsageLimits,
  type RunContextUsage,
  type UsageLimitStatus,
  type UsageLimitWindow,
} from './vendor/runner-protocol/index.js';

const execFileP = promisify(execFile);

// nombre con el que se cuenta un tool_use sin nombre (salida rara del cli).
const UNNAMED_TOOL = '?';
// los campos de `message.usage` que suman lo que ocupa el contexto en una llamada (t#682).
const CONTEXT_FILL_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'] as const;
// el evento system con el que el cli marca una compactación del contexto.
const COMPACT_BOUNDARY = 'compact_boundary';
// el evento con el que el cli informa del estado de los límites de la suscripción.
const RATE_LIMIT_EVENT = 'rate_limit_event';
const MS_PER_SECOND = 1000;
// duración de cada ventana que el cli no da (minutos); un id que no conoce queda en null.
const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const SEVEN_DAY_WINDOW_MINS = 7 * 24 * 60;
// lo que el cli dice de una ventana → el status del protocolo; lo demás se omite.
const LIMIT_STATUS_BY_CLI: Readonly<Record<string, UsageLimitStatus>> = {
  allowed: USAGE_LIMIT_STATUS.allowed,
  allowed_warning: USAGE_LIMIT_STATUS.warning,
  rejected: USAGE_LIMIT_STATUS.rejected,
};

// flags que el daemon quiere pasar pero que no todas las versiones del cli aceptan; un flag
// desconocido aborta el proceso, así que se detectan una vez por arranque.
export const OPTIONAL_FLAGS = [
  '--max-turns',
  '--max-budget-usd',
  '--strict-mcp-config',
  '--permission-mode',
  '--disallowedTools',
  '--verbose',
  '--setting-sources',
  // 0.12.0: el modelo que pide duckhunt por run (capability `model`).
  '--model',
  // 0.31.0 (r#563): el esfuerzo de razonamiento que pide duckhunt por segmento (capability `effort`).
  '--effort',
  // t#597: los repos adicionales de una conversación como directorios de trabajo (capability `multi_repo`).
  '--add-dir',
  // t#636: lo que dicen los subagentes, con su parent_tool_use_id (capability `subagents`).
  '--forward-subagent-text',
  // t#636, fase 2: stdin en stream-json, el proceso vivo atiende el buzón (capability `live_input`).
  '--input-format',
  // t#636, fase 3: el cli devuelve el mensaje de stdin al tomarlo (el acuse; capability `live_turns`).
  '--replay-user-messages',
  // t#690: los settings del segmento con el hook que cierra el turno al responder (capability `end_turn`).
  '--settings',
] as const;
export type OptionalFlag = (typeof OPTIONAL_FLAGS)[number];

// --permission-prompt-tool (t#527) no sale en `claude --help` (solo lo nombra la descripción de --permission-prompts):
// no se puede detectar como los de arriba y se decide por versión. 2.1.302 = la primera en la que -p arranca en
// manual y documenta el camino de la tool de permisos (verificado con 2.1.309).
export const PERMISSION_PROMPT_TOOL_MIN_VERSION = '2.1.302';
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;

/** ¿la versión del cli (`claude --version`, p. ej. `2.1.309 (Claude Code)`) llega a `min` (x.y.z)? null o ilegible = no. */
export function claudeAtLeast(version: string | null, min: string): boolean {
  const [have, want] = [version ?? '', min].map((v) => VERSION_RE.exec(v.trim())?.slice(1).map(Number) ?? null);
  if (!have || !want) return false;
  const i = have.findIndex((n, k) => n !== want[k]);
  return i === -1 || have[i]! > want[i]!;
}

/** ¿acepta el cli --permission-prompt-tool? (ver PERMISSION_PROMPT_TOOL_MIN_VERSION). */
export const supportsPermissionPromptTool = (version: string | null): boolean => claudeAtLeast(version, PERMISSION_PROMPT_TOOL_MIN_VERSION);

// Monitor en headless (t#743): verificado en 2.1.319 (t#636, la lista de tools de -p) y con un run real en 2.1.331 (cada
// evento despierta al agente con su propio `result`). no sale en --help: se decide por versión.
export const MONITOR_CLI_MIN_VERSION = '2.1.319';

/** ¿tiene el cli la tool Monitor en headless? (ver MONITOR_CLI_MIN_VERSION). */
export const supportsMonitor = (version: string | null): boolean => claudeAtLeast(version, MONITOR_CLI_MIN_VERSION);

/** ¿acepta el cli --resume-session-at + --fork-session? flags ocultos del --help: se decide por versión (protocolo). */
export const supportsRewind = (version: string | null): boolean => claudeAtLeast(version, REWIND_CLI_MIN_VERSION);

export interface ClaudeInfo {
  version: string | null;
  supported: Set<OptionalFlag>;
}

// un flag cuenta solo si aparece entero, no como trozo de otro más largo: `--fallback-model` no
// lista `--model`, ni lo listaría un `--model-x` futuro.
const flagListed = (help: string, flag: string): boolean => new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(help);

/** flags opcionales que lista la salida de `claude --help`. */
export function supportedFlags(help: string): Set<OptionalFlag> {
  return new Set(OPTIONAL_FLAGS.filter((f) => flagListed(help, f)));
}

/** `claude --version` + flags soportados según `claude --help`. version null si el cli no arranca. */
export async function detectClaude(): Promise<ClaudeInfo> {
  let version: string | null = null;
  try {
    version = (await execFileP('claude', ['--version'], { encoding: 'utf-8' })).stdout.trim() || null;
  } catch {
    return { version: null, supported: new Set() };
  }
  try {
    const help = (await execFileP('claude', ['--help'], { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 })).stdout;
    return { version, supported: supportedFlags(help) };
  } catch (err) {
    console.error(`[runner] claude --help falló (se asumen flags mínimos): ${(err as Error).message}`);
    return { version, supported: new Set() };
  }
}

// objeto `type: 'result'` final del stream-json (solo los campos que el daemon reporta).
export interface StreamResult {
  subtype: string | null;
  isError: boolean;
  result: string | null;
  costUsd: number | null;
  numTurns: number | null;
  sessionId: string | null;
  model: string | null;
}

export interface StreamState {
  toolCalls: number;
  // tool calls por nombre de tool (la auditoría local, audit.ts): solo nombres, nunca sus argumentos.
  toolsByName: Record<string, number>;
  // se vio algún mensaje del asistente: distingue un fallo de arranque (sesión inexistente al
  // reanudar, mcp caído) de un fallo a mitad de run.
  sawAssistant: boolean;
  sessionId: string | null;
  // modelo del evento system/init: el del bucle principal de este proceso.
  initModel: string | null;
  // slash commands, skills y plugins que cargó (system/init; null = sin init o un cli que no los anuncia).
  initCatalog: InitCatalog | null;
  // uuid del último mensaje del asistente (t#564): dónde retomar más tarde. null = ninguno con un uuid válido.
  lastAssistantUuid: string | null;
  // contexto del hilo principal (t#682): lo que ocupaba en su última llamada (null = ninguna aún), las compactaciones del
  // proceso y la ventana de cada modelo que dijo un `result`.
  contextTokens: number | null;
  compactions: number;
  contextWindows: Record<string, number>;
  // los últimos límites de la suscripción vistos en el proceso (null = ninguno).
  usageLimits: BackendUsageLimits | null;
  result: StreamResult | null;
}

export function newStreamState(): StreamState {
  return { toolCalls: 0, toolsByName: {}, sawAssistant: false, sessionId: null, initModel: null, initCatalog: null, lastAssistantUuid: null, contextTokens: null, compactions: 0, contextWindows: {}, usageLimits: null, result: null };
}

// bloque de contenido de un mensaje del stream: text (prosa), tool_use (name + input),
// tool_result, thinking… solo se tipan los campos que el daemon lee.
export interface StreamContent {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  // id de la tool call (tool_use): el padre de lo que haga un subagente que lance (t#636).
  id?: string;
}

export interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  // id del mensaje en la sesión (assistant, user…).
  uuid?: unknown;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  modelUsage?: Record<string, unknown>;
  // solo en system/init.
  model?: unknown;
  slash_commands?: unknown;
  skills?: unknown;
  plugins?: unknown;
  // usage: los tokens de esa llamada al modelo (t#682).
  message?: { content?: StreamContent[] | string; usage?: unknown; model?: unknown };
  // t#636: la tool call de la que cuelga un mensaje hecho dentro de un subagente (null o ausente = el agente principal).
  parent_tool_use_id?: unknown;
  // t#636, fase 3: un mensaje de stdin que el cli devuelve al tomarlo (--replay-user-messages).
  isReplay?: unknown;
  // system task_started / task_progress / task_notification (subagentes, workflows y comandos en segundo plano).
  task_id?: unknown;
  task_type?: unknown;
  tool_use_id?: unknown;
  status?: unknown;
  description?: unknown;
  summary?: unknown;
  workflow_name?: unknown;
  // usage de un hito de tarea: {total_tokens, tool_uses, duration_ms}.
  usage?: unknown;
  // solo en rate_limit_event.
  rate_limit_info?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// un campo numérico de un objeto del stream (una entrada de modelUsage, un message.usage); null si no lo es.
const field = (o: unknown, key: string): number | null => (typeof o === 'object' && o !== null ? num((o as Record<string, unknown>)[key]) : null);
// costUSD de una entrada de modelUsage.
const usageCost = (u: unknown): number | null => field(u, 'costUSD');
// un recuento de tokens: entero ≥ 0 (lo que no lo es cuenta 0).
const tokens = (v: number | null): number => (v !== null && v > 0 ? Math.floor(v) : 0);
// lo que ocupa el contexto en una llamada; 0 = sin usage (un mensaje sintético del cli lo trae a cero).
const contextFill = (usage: unknown): number => CONTEXT_FILL_FIELDS.reduce((sum, k) => sum + tokens(field(usage, k)), 0);
// el hilo principal: sin parent_tool_use_id (t#636); lo de un subagente tiene su propio contexto.
const onMainThread = (ev: StreamLine): boolean => ev.parent_tool_use_id === undefined || ev.parent_tool_use_id === null;

/** modelo de un run: el del init y, sin él, el de modelUsage que más costó (la primera clave si ninguna trae coste). */
export function reportedModel(initModel: string | null, modelUsage: Record<string, unknown> | undefined): string | null {
  if (initModel) return initModel;
  const entries = Object.entries(modelUsage ?? {});
  const costly = entries
    .map(([model, usage]) => ({ model, cost: usageCost(usage) }))
    .filter((e): e is { model: string; cost: number } => e.cost !== null)
    .reduce<{ model: string; cost: number } | null>((best, e) => (best === null || e.cost > best.cost ? e : best), null);
  return costly?.model ?? entries[0]?.[0] ?? null;
}

/** las ventanas de contexto que dice un `modelUsage` (t#682), por modelo: solo enteros ≥ 1 (nunca una ventana 0). */
export function contextWindows(modelUsage: Record<string, unknown> | undefined): Record<string, number> {
  return Object.fromEntries(
    Object.entries(modelUsage ?? {})
      .map(([model, u]) => [model, tokens(field(u, 'contextWindow'))] as const)
      .filter(([, w]) => w > 0),
  );
}

/**
 * el contexto del hilo principal para un informe (t#682): lo que ocupaba en su última llamada, la ventana de `model`
 * (null = ningún `result` la dijo) y las compactaciones desde `compactionsAt` (el inicio del tramo que cubre el informe).
 * undefined = el agente principal aún no llamó al modelo en este proceso.
 */
export function streamContext(state: StreamState, model: string | null, compactionsAt: number): RunContextUsage | undefined {
  if (state.contextTokens === null) return undefined;
  const window = model !== null ? state.contextWindows[model] : undefined;
  const compactions = Math.min(Math.max(0, state.compactions - compactionsAt), RUN_CONTEXT_COMPACTIONS_MAX);
  return {
    usedTokens: Math.min(state.contextTokens, RUN_CONTEXT_TOKENS_MAX),
    windowTokens: window !== undefined ? Math.min(window, RUN_CONTEXT_TOKENS_MAX) : null,
    ...(compactions > 0 ? { compactions } : {}),
  };
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

const windowMinsOf = (id: string): number | null =>
  id === USAGE_LIMIT_WINDOW.fiveHour ? FIVE_HOUR_WINDOW_MINS : id.startsWith(USAGE_LIMIT_WINDOW.sevenDay) ? SEVEN_DAY_WINDOW_MINS : null;

// una entrada de `unifiedWindows` → ventana del protocolo; null si no es válida (sin utilization numérica ≥ 0 o id raro).
function limitWindow(id: string, raw: unknown): UsageLimitWindow | null {
  const utilization = field(raw, 'utilization');
  if (!USAGE_LIMIT_WINDOW_ID_RE.test(id) || utilization === null || utilization < 0) return null;
  const resets = field(raw, 'resetsAt');
  const status = LIMIT_STATUS_BY_CLI[String(record(raw)?.status)];
  return {
    id,
    usedRatio: Math.min(utilization, USAGE_LIMIT_RATIO_MAX),
    resetsAt: resets !== null && resets > 0 ? resets * MS_PER_SECOND : null,
    windowMins: windowMinsOf(id),
    ...(status ? { status } : {}),
  };
}

/**
 * los límites de la suscripción que dice un `rate_limit_event` (usage-limits.ts), normalizados al protocolo; undefined si
 * no trae ninguna ventana válida (un evento roto nunca lanza ni borra lo ya visto).
 */
export function parseRateLimits(info: unknown, observedAt: number): BackendUsageLimits | undefined {
  const raw = record(info);
  const windows = Object.entries(record(raw?.unifiedWindows) ?? {})
    .map(([id, w]) => limitWindow(id, w))
    .filter((w): w is UsageLimitWindow => w !== null)
    .slice(0, USAGE_LIMIT_WINDOWS_MAX);
  if (windows.length === 0) return undefined;
  return { backend: RUNNER_BACKEND.claudeCode, observedAt, windows, ...(typeof raw?.isUsingOverage === 'boolean' ? { overage: raw.isUsingOverage } : {}) };
}

/** consume una línea de stdout (stream-json) y devuelve el evento parseado; null si no es json. */
export function consumeStreamLine(state: StreamState, line: string, now: () => number = Date.now): StreamLine | null {
  if (!line.startsWith('{')) return null;
  let ev: StreamLine;
  try {
    ev = JSON.parse(line) as StreamLine;
  } catch {
    // línea que empieza por '{' pero no es json (salida corrupta o cortada): no es un evento.
    return null;
  }
  if (typeof ev.session_id === 'string' && ev.session_id) state.sessionId = ev.session_id;
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (typeof ev.model === 'string' && ev.model) state.initModel = ev.model;
    state.initCatalog = parseInitCatalog(ev);
  }
  if (ev.type === 'system' && ev.subtype === COMPACT_BOUNDARY && onMainThread(ev)) state.compactions += 1;
  if (ev.type === RATE_LIMIT_EVENT) state.usageLimits = parseRateLimits(ev.rate_limit_info, now()) ?? state.usageLimits;
  if (ev.type === 'assistant') {
    state.sawAssistant = true;
    // el punto de retomar es del agente principal (t#636): el uuid de un mensaje de un subagente no es de la sesión.
    const main = onMainThread(ev);
    if (main && typeof ev.uuid === 'string' && RUN_MESSAGE_UUID_RE.test(ev.uuid)) state.lastAssistantUuid = ev.uuid;
    const fill = main ? contextFill(ev.message?.usage) : 0;
    if (fill > 0) state.contextTokens = fill;
    const content = ev.message?.content;
    const uses = Array.isArray(content) ? content.filter((c) => c?.type === 'tool_use') : [];
    state.toolCalls += uses.length;
    uses.forEach((c) => {
      const name = typeof c.name === 'string' && c.name ? c.name : UNNAMED_TOOL;
      state.toolsByName[name] = (state.toolsByName[name] ?? 0) + 1;
    });
    return ev;
  }
  if (ev.type === 'result') {
    state.contextWindows = { ...state.contextWindows, ...contextWindows(ev.modelUsage) };
    state.result = {
      subtype: ev.subtype ?? null,
      isError: ev.is_error === true,
      result: typeof ev.result === 'string' ? ev.result : null,
      costUsd: num(ev.total_cost_usd),
      numTurns: num(ev.num_turns),
      sessionId: typeof ev.session_id === 'string' ? ev.session_id : state.sessionId,
      model: reportedModel(state.initModel, ev.modelUsage),
    };
  }
  return ev;
}
