// integración con el cli de claude code: detección de flags soportados (el cli cambia entre
// versiones; los flags opcionales se pasan solo si `claude --help` los lista) y parseo del
// stream-json de un run headless (contadores de tool calls, objeto result final). el evento
// parseado se devuelve para que el feed de progreso (feed.ts) lo lea sin volver a parsear.
// modelo reportado (0.12.0, t#465): el del evento `system/init` (el que eligió el cli para el bucle
// principal, tras --model si lo hubo) y, sin init, la clave de modelUsage con más coste. antes era la
// primera clave de modelUsage, que suele ser el haiku auxiliar del cli (títulos, resúmenes): prod tenía
// 30 runs reportados como claude-haiku-4-5.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// nombre con el que se cuenta un tool_use sin nombre (salida rara del cli).
const UNNAMED_TOOL = '?';

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
  result: StreamResult | null;
}

export function newStreamState(): StreamState {
  return { toolCalls: 0, toolsByName: {}, sawAssistant: false, sessionId: null, initModel: null, result: null };
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
  // solo en system/init.
  model?: unknown;
  message?: { content?: StreamContent[] | string };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// costUSD de una entrada de modelUsage (null si no es un objeto con un número).
const usageCost = (u: unknown): number | null => (typeof u === 'object' && u !== null ? num((u as { costUSD?: unknown }).costUSD) : null);

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
  if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string' && ev.model) state.initModel = ev.model;
  if (ev.type === 'assistant') {
    state.sawAssistant = true;
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
