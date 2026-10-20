// estado de la plataforma local (t#495, M7) en <runnerHome>/platforms/local/: una conversación por fichero
// (conversations/<id>.json) y su feed (events/<id>.ndjson). lo leen y escriben el daemon y un `runner run` sin daemon
// (nunca a la vez: los dos toman el lock del daemon), así que cada operación va al disco, sin caché.
// decisiones:
// - id `l-<ulid>`: válido como id de run de v0 (RUN_ID_V0_RE) y ordenable por fecha.
// - ficheros 0600 en directorios 0700 (llevan el prompt y las respuestas del usuario), escritos con tmp + rename.
// - el feed se borra a los EVENTS_TTL_MS sin tocarse (al arrancar la plataforma); la conversación se queda: su
//   worktree lo recoge el gc de siempre (resources/repo/gc.ts).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SeqEvent } from '../event-uploader.js';
import { LOCAL_PLATFORM_ID, platformHome } from '../paths.js';
import type { ToolsetV1 } from '../vendor/runner-protocol/index.js';
import type { LocalRequest } from './policy.js';

const CONVERSATIONS_SUBDIR = 'conversations';
const EVENTS_SUBDIR = 'events';
const JSON_SUFFIX = '.json';
const EVENTS_SUFFIX = '.ndjson';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TMP_RANDOM_BYTES = 4;
/** el feed de una conversación sin tocar se borra a los 7 días. */
export const EVENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ulid: 48 bits de tiempo (10 caracteres) + 80 de azar (16), en base32 de crockford.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_CHARS = 10;
const ULID_RANDOM_CHARS = 16;
const BASE32 = 32;
const CONVERSATION_PREFIX = 'l-';
export const CONVERSATION_ID_RE = /^l-[0-9A-HJKMNP-TV-Z]{26}$/;

export const CONVERSATION_STATUS = {
  queued: 'queued',
  running: 'running',
  // el agente preguntó (ask_user): espera la respuesta (`--resume`).
  waiting: 'waiting',
  done: 'done',
  // el agente cerró con un reply de tipo blocker.
  blocked: 'blocked',
  failed: 'failed',
  canceled: 'canceled',
  // el daemon no aceptó el claim (techo, exposición).
  refused: 'refused',
} as const;
export type ConversationStatus = (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];

/** estados en los que la conversación ya no tiene trabajo en marcha. */
export const SETTLED_STATUSES: ReadonlySet<ConversationStatus> = new Set([
  CONVERSATION_STATUS.waiting,
  CONVERSATION_STATUS.done,
  CONVERSATION_STATUS.blocked,
  CONVERSATION_STATUS.failed,
  CONVERSATION_STATUS.canceled,
  CONVERSATION_STATUS.refused,
]);

export const QUESTION_KIND = { yesNo: 'yes_no', text: 'text', form: 'form' } as const;
export type QuestionKind = (typeof QUESTION_KIND)[keyof typeof QUESTION_KIND];

/** lo que pregunta el agente con ask_user. un form son varias preguntas, cada una con sus opciones si las tiene. */
export interface LocalQuestion {
  kind: QuestionKind;
  question: string;
  questions?: { question: string; options?: string[] }[];
}

export const REPLY_KIND = { result: 'result', blocker: 'blocker' } as const;
export type ReplyKind = (typeof REPLY_KIND)[keyof typeof REPLY_KIND];

/** lo que contesta el agente con reply. */
export interface LocalReply {
  kind: ReplyKind;
  body: string;
  summary?: string;
}

export interface Conversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  // la petición que la abrió (su prompt es el del primer segmento).
  request: LocalRequest;
  // el toolset con el que se aceptó: el de todos sus segmentos.
  toolset: ToolsetV1;
  // último segmento lanzado (0 = ninguno aún).
  segment: number;
  status: ConversationStatus;
  // sesión del backend para reanudar (la del último segmento que la reportó).
  sessionId: string | null;
  // siguiente seq del feed (continúa entre segmentos).
  nextSeq: number;
  // preguntas ya contestadas, para el prompt de respaldo de una reanudación que no se pueda reanudar.
  transcript: { question: LocalQuestion; answer: string }[];
  // la pregunta pendiente (status waiting).
  question: LocalQuestion | null;
  // el último reply del agente.
  reply: LocalReply | null;
  // el texto final del último segmento (el resultado del cli si no hubo reply).
  result: string | null;
  // el error del último segmento que falló.
  error: string | null;
}

/** un id nuevo de conversación (ver cabecera). */
export function newConversationId(nowMs: number = Date.now()): string {
  const time = Array.from({ length: ULID_TIME_CHARS }, (_, i) => CROCKFORD[Math.floor(nowMs / BASE32 ** (ULID_TIME_CHARS - 1 - i)) % BASE32]).join('');
  const random = [...crypto.randomBytes(ULID_RANDOM_CHARS)].map((b) => CROCKFORD[b % BASE32]).join('');
  return `${CONVERSATION_PREFIX}${time}${random}`;
}

const ensureDir = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  return dir;
};

const conversationsDir = (): string => ensureDir(path.join(platformHome(LOCAL_PLATFORM_ID), CONVERSATIONS_SUBDIR));
const eventsDir = (): string => ensureDir(path.join(platformHome(LOCAL_PLATFORM_ID), EVENTS_SUBDIR));

function checkedId(id: string): string {
  if (!CONVERSATION_ID_RE.test(id)) throw new Error(`id de conversación inválido: ${JSON.stringify(id)}`);
  return id;
}

/** guarda la conversación (tmp + rename, 0600). */
export function saveConversation(c: Conversation): void {
  const file = path.join(conversationsDir(), `${checkedId(c.id)}${JSON_SUFFIX}`);
  const tmp = `${file}.${crypto.randomBytes(TMP_RANDOM_BYTES).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c)}\n`, { mode: FILE_MODE, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** la conversación de ese id, o null si no existe (o el id no lo es). */
export function loadConversation(id: string): Conversation | null {
  if (!CONVERSATION_ID_RE.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(conversationsDir(), `${id}${JSON_SUFFIX}`), 'utf8')) as Conversation;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** añade un lote del feed de un segmento (una línea por evento). */
export function appendEvents(id: string, segment: number, events: readonly SeqEvent[]): void {
  if (events.length === 0) return;
  const lines = events.map((e) => JSON.stringify({ segment, ...e })).join('\n');
  fs.appendFileSync(path.join(eventsDir(), `${checkedId(id)}${EVENTS_SUFFIX}`), `${lines}\n`, { mode: FILE_MODE });
}

/** borra el feed que no se toca desde hace EVENTS_TTL_MS. devuelve cuántos ficheros. */
export function pruneEvents(nowMs: number): number {
  const root = path.join(platformHome(LOCAL_PLATFORM_ID), EVENTS_SUBDIR);
  if (!fs.existsSync(root)) return 0;
  const stale = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(EVENTS_SUFFIX))
    .filter((name) => nowMs - fs.statSync(path.join(root, name)).mtimeMs >= EVENTS_TTL_MS);
  stale.forEach((name) => fs.rmSync(path.join(root, name), { force: true }));
  return stale.length;
}
