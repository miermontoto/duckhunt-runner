// integración con el cli de claude code: detección de flags soportados (el cli cambia entre
// versiones; los flags opcionales se pasan solo si `claude --help` los lista) y parseo del
// stream-json de un run headless (contadores de tool calls, objeto result final). el evento
// parseado se devuelve para que el feed de progreso (feed.ts) lo lea sin volver a parsear.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// flags que el daemon quiere pasar pero que no todas las versiones del cli aceptan; un flag
// desconocido aborta el proceso, así que se detectan una vez por arranque.
export const OPTIONAL_FLAGS = ['--max-turns', '--max-budget-usd', '--strict-mcp-config', '--permission-mode', '--disallowedTools', '--verbose'] as const;
export type OptionalFlag = (typeof OPTIONAL_FLAGS)[number];

export interface ClaudeInfo {
  version: string | null;
  supported: Set<OptionalFlag>;
}

/** `claude --version` + flags soportados según `claude --help`. version null si el cli no arranca. */
export async function detectClaude(): Promise<ClaudeInfo> {
  const supported = new Set<OptionalFlag>();
  let version: string | null = null;
  try {
    version = (await execFileP('claude', ['--version'], { encoding: 'utf-8' })).stdout.trim() || null;
  } catch {
    return { version: null, supported };
  }
  try {
    const help = (await execFileP('claude', ['--help'], { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 })).stdout;
    OPTIONAL_FLAGS.filter((f) => help.includes(f)).forEach((f) => supported.add(f));
  } catch (err) {
    console.error(`[runner] claude --help falló (se asumen flags mínimos): ${(err as Error).message}`);
  }
  return { version, supported };
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
  // se vio algún mensaje del asistente: distingue un fallo de arranque (sesión inexistente al
  // reanudar, mcp caído) de un fallo a mitad de run.
  sawAssistant: boolean;
  sessionId: string | null;
  result: StreamResult | null;
}

export function newStreamState(): StreamState {
  return { toolCalls: 0, sawAssistant: false, sessionId: null, result: null };
}

// bloque de contenido de un mensaje del stream: text (prosa), tool_use (name + input),
// tool_result, thinking… solo se tipan los campos que el daemon lee.
export interface StreamContent {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  modelUsage?: Record<string, unknown>;
  message?: { content?: StreamContent[] | string };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** consume una línea de stdout (stream-json) y devuelve el evento parseado; null si no es json. */
export function consumeStreamLine(state: StreamState, line: string): StreamLine | null {
  if (!line.startsWith('{')) return null;
  let ev: StreamLine;
  try {
    ev = JSON.parse(line) as StreamLine;
  } catch {
    // línea que empieza por '{' pero no es json (salida corrupta o cortada): no es un evento.
    return null;
  }
  if (typeof ev.session_id === 'string' && ev.session_id) state.sessionId = ev.session_id;
  if (ev.type === 'assistant') {
    state.sawAssistant = true;
    const content = ev.message?.content;
    if (Array.isArray(content)) state.toolCalls += content.filter((c) => c?.type === 'tool_use').length;
    return ev;
  }
  if (ev.type === 'result') {
    const models = ev.modelUsage ? Object.keys(ev.modelUsage) : [];
    state.result = {
      subtype: ev.subtype ?? null,
      isError: ev.is_error === true,
      result: typeof ev.result === 'string' ? ev.result : null,
      costUsd: num(ev.total_cost_usd),
      numTurns: num(ev.num_turns),
      sessionId: typeof ev.session_id === 'string' ? ev.session_id : state.sessionId,
      model: models[0] ?? null,
    };
  }
  return ev;
}
