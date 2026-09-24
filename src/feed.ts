// feed de progreso de un run (t#378): traduce el stream-json de `claude -p` a eventos cortos que el
// daemon sube a POST /api/runner/runs/:id/events. `text` = prosa del asistente; `tool` = una línea
// por tool call (nombre + argumento corto: ruta relativa, patrón, primera línea del comando, refs de
// una tool mcp); `system` = notas del propio daemon (worktree, rama, fallback).
// non-goals a propósito: NUNCA tool_result, contenido de ficheros ni salida de comandos, y ninguna
// ruta absoluta (el worktree pasa a `.`, el home a `~`, un fichero fuera del worktree a `…/nombre`).
// todo cuerpo pasa por redactar rutas → enmascarar secretos → recortar, en ese orden (recortar antes
// de enmascarar podría dejar medio secreto sin reconocer).

import path from 'node:path';
import type { StreamContent, StreamLine } from './claude.js';
import { maskSecrets } from './secret-mask.js';

export const FEED_KIND = {
  text: 'text',
  tool: 'tool',
  system: 'system',
} as const;
export type FeedKind = (typeof FEED_KIND)[keyof typeof FEED_KIND];

export interface FeedEvent {
  kind: FeedKind;
  tool?: string;
  body: string;
}

export interface FeedContext {
  // cwd del run (worktree o scratch): las rutas dentro se muestran relativas.
  cwd: string;
  home: string;
  bodyMaxChars: number;
  toolArgMaxChars: number;
}

// tope del nombre de la tool (AGENT_RUN_EVENT_TOOL_MAX_CHARS del server).
const TOOL_NAME_MAX_CHARS = 120;
const ELLIPSIS = '…';
// prefijo de una ruta fuera del worktree (solo se enseña el nombre del fichero).
const OUTSIDE_PREFIX = `${ELLIPSIS}/`;
// resumen genérico de argumentos (tools mcp y desconocidas): cuántos campos y cuán largos.
const ARG_FIELDS_MAX = 4;
const ARG_VALUE_MAX_CHARS = 40;
// claves de argumentos mcp que son referencias a filas de duckhunt → t#N / e#N / r#N.
const REF_PREFIX_BY_KEY: ReadonlyMap<string, string> = new Map([
  ['targetId', 't#'],
  ['target_id', 't#'],
  ['entryId', 'e#'],
  ['entry_id', 'e#'],
  ['runId', 'r#'],
  ['run_id', 'r#'],
]);
// campos de texto largo (cuerpos de notas, descripciones…) que no aportan a una línea de resumen.
const LONG_TEXT_KEYS = new Set(['body', 'text', 'content', 'description', 'note', 'summary', 'markdown', 'message', 'prompt', 'data', 'context', 'answer', 'instruction']);
// tools cuyo argumento principal es una ruta.
const PATH_KEY_BY_TOOL: ReadonlyMap<string, string> = new Map([
  ['Read', 'file_path'],
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
  ['NotebookRead', 'notebook_path'],
]);

// tools internas del cli (carga diferida de otras tools): no son trabajo del agente, fuera del feed.
const INTERNAL_TOOLS: ReadonlySet<string> = new Set(['ToolSearch']);

type Args = Record<string, unknown>;

const isArgs = (v: unknown): v is Args => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** recorta a `max` caracteres con elipsis final. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}` : text;
}

/** sustituye las rutas absolutas conocidas: el cwd del run por `.` y el home por `~`. */
export function redactPaths(text: string, ctx: Pick<FeedContext, 'cwd' | 'home'>): string {
  // el cwd suele vivir bajo el home: primero el más largo.
  return [
    [ctx.cwd, '.'],
    [ctx.home, '~'],
  ].reduce((acc, [abs, short]) => (abs && abs.length > 1 ? acc.split(abs).join(short) : acc), text);
}

const sanitize = (text: string, ctx: FeedContext, max: number): string => clip(maskSecrets(redactPaths(text, ctx)), max);

// ruta para mostrar: relativa al worktree si cae dentro; si no, solo el nombre del fichero.
function displayPath(p: string, ctx: FeedContext): string {
  const abs = path.resolve(ctx.cwd, p);
  const rel = path.relative(ctx.cwd, abs);
  if (rel === '') return '.';
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return outside ? `${OUTSIDE_PREFIX}${path.basename(abs)}` : rel;
}

function lineRange(args: Args): string {
  const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : null;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : null;
  if (offset === null && limit === null) return '';
  const start = offset ?? 1;
  return limit === null ? `:${start}-` : `:${start}-${start + limit - 1}`;
}

// resumen genérico: refs primero (t#318), luego campos escalares cortos `clave=valor`.
function summarizeArgs(args: Args): string {
  const refs = Object.entries(args).flatMap(([k, v]) => {
    const prefix = REF_PREFIX_BY_KEY.get(k);
    return prefix && (typeof v === 'number' || typeof v === 'string') && String(v) ? [`${prefix}${v}`] : [];
  });
  const fields = Object.entries(args)
    .filter(([k, v]) => !REF_PREFIX_BY_KEY.has(k) && !LONG_TEXT_KEYS.has(k) && ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => [k, oneLine(String(v))] as const)
    .filter(([, v]) => v.length > 0)
    .slice(0, ARG_FIELDS_MAX)
    .map(([k, v]) => `${k}=${clip(v, ARG_VALUE_MAX_CHARS)}`);
  return [...refs, ...fields].join(' ');
}

/** una línea que resume una tool call SIN su resultado: ruta, patrón, comando o argumentos cortos. */
export function summarizeToolUse(name: string, input: unknown, ctx: FeedContext): string {
  const args = isArgs(input) ? input : {};
  const pathKey = PATH_KEY_BY_TOOL.get(name);
  const str = (k: string): string | null => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string) : null);
  const raw = ((): string => {
    if (pathKey) {
      const p = str(pathKey);
      return p ? `${displayPath(p, ctx)}${name === 'Read' ? lineRange(args) : ''}` : '';
    }
    if (name === 'Grep' || name === 'Glob') {
      const where = str('path');
      return [str('pattern'), where ? displayPath(where, ctx) : null, str('glob')].filter(Boolean).join(' · ');
    }
    if (name === 'Bash') {
      const lines = (str('command') ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      return lines.length > 1 ? `${lines[0]} ${ELLIPSIS}` : lines[0] ?? '';
    }
    if (name === 'WebFetch') return str('url') ?? '';
    if (name === 'WebSearch') return str('query') ?? '';
    if (name === 'Task' || name === 'Agent') return str('description') ?? '';
    if (name === 'TodoWrite') return Array.isArray(args.todos) ? `${args.todos.length} tareas` : '';
    return summarizeArgs(args);
  })();
  return sanitize(oneLine(raw), ctx, ctx.toolArgMaxChars);
}

function eventFromContent(c: StreamContent, ctx: FeedContext): FeedEvent | null {
  if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
    return { kind: FEED_KIND.text, body: sanitize(c.text.trim(), ctx, ctx.bodyMaxChars) };
  }
  if (c.type === 'tool_use' && typeof c.name === 'string' && c.name && !INTERNAL_TOOLS.has(c.name)) {
    return { kind: FEED_KIND.tool, tool: clip(c.name, TOOL_NAME_MAX_CHARS), body: summarizeToolUse(c.name, c.input, ctx) };
  }
  // thinking, tool_result, imágenes…: fuera del feed a propósito.
  return null;
}

/** eventos de feed de un evento del stream-json. solo los mensajes del asistente producen alguno. */
export function feedEventsFromStream(ev: StreamLine, ctx: FeedContext): FeedEvent[] {
  if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return [];
  return ev.message.content.map((c) => eventFromContent(c, ctx)).filter((e): e is FeedEvent => e !== null);
}

/** nota del daemon para el feed (worktree, rama, reintentos), saneada como el resto. */
export function systemEvent(text: string, ctx: FeedContext): FeedEvent {
  return { kind: FEED_KIND.system, body: sanitize(text, ctx, ctx.bodyMaxChars) };
}
