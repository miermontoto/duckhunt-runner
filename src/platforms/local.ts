// la plataforma local (t#495, M7): `runner run` encarga runs a este daemon sin ningún server. vive dentro del proceso
// que aloja el núcleo (el daemon, que la sirve por local.sock, o un `runner run` sin daemon) y pasa por lo mismo que
// cualquier plataforma: slots y cuota del scheduler, el lock de git, la auditoría y, sobre todo, la MISMA aplicación
// del claim v0 (platforms/claim-v0.ts) con el techo y la exposición de `platforms.local`. no se salta nada por ser
// local: el claim se construye como json, se serializa y se vuelve a leer como uno de un server.
// decisiones:
// - una conversación es un run (su id `l-<ulid>`); cada turno, un segmento. la cola es de esta plataforma: reclamar
//   da el primero que espera; sin nada, idle.
// - la cancelación va SOLO por el latido (cancel), como en v0: ctrl-c en `runner run` la marca y el siguiente latido
//   mata el grupo de procesos.
// - ask_user y reply (local/mcp.ts) solo anotan en la conversación; el turno lo cierra el agente y el result decide:
//   pregunta pendiente → waiting; reply blocker → blocked; si no, done. el texto es el body del reply o, sin él, el
//   resultado final del cli.
// - una reanudación (`--resume <conv> "<respuesta>"`) es un segmento nuevo con la sesión del anterior y la respuesta
//   como prompt; su prompt de respaldo, el original con las preguntas y respuestas, por si la sesión no se reanuda.
// - sin server: no hay machine id, comandos de repos ni desvincular; las conversaciones abiertas son las que esperan
//   o trabajan (el gc de worktrees no las toca).

import type { RunnerCredential } from '../config.js';
import type { SeqEvent } from '../event-uploader.js';
import { LocalMcpServer, type TokenSubject } from '../local/mcp.js';
import { LOCAL_MCP_SERVER, LOCAL_TOOL, type LocalRequest } from '../local/policy.js';
import {
  appendEvents,
  CONVERSATION_STATUS,
  loadConversation,
  newConversationId,
  pruneEvents,
  QUESTION_KIND,
  REPLY_KIND,
  saveConversation,
  type Conversation,
  type ConversationStatus,
  type LocalQuestion,
  type LocalReply,
} from '../local/store.js';
import { LOCAL_PLATFORM_ID } from '../paths.js';
import { REPO_PARAM } from '../resources/repo/provider.js';
import { RESOURCE_TYPE } from '../resources/types.js';
import type { StatusReport } from '../status-report.js';
import { EVENTS_DEFAULTS, RUN_ISOLATION } from '../claim.js';
import { V0_BACKEND, type RunV0, type ToolsetV1 } from '../vendor/runner-protocol/index.js';
import { claimOfV0, ClaimRejectedError } from './claim-v0.js';
import { CLAIM_RESULT, PROTOCOL, type ClaimResult, type HeartbeatVerdict, type Platform, type PlatformContext, type RunSegment, type UnpairOutcome } from './platform.js';

// latido de los runs locales: el mínimo del daemon, así un ctrl-c llega en ≤ 5 s.
const LOCAL_HEARTBEAT_MS = 5_000;
// tope de un turno (el del claim legacy por defecto).
const LOCAL_TIMEOUT_MS = 30 * 60_000;
const HTTP_OK = 200;
const KEEP: HeartbeatVerdict = { stop: false };
const IDLE: ClaimResult = { kind: CLAIM_RESULT.idle, said: { state: null, runner: null }, commandsPending: false };
// topes de lo que anotan las tools.
const QUESTION_MAX_CHARS = 4_000;
const FORM_QUESTIONS_MAX = 10;
const FORM_OPTIONS_MAX = 20;
const REPLY_MAX_CHARS = 20_000;
const SUMMARY_MAX_CHARS = 500;
const ASK_USER_ACK = 'pregunta anotada: termina tu turno sin seguir; la respuesta del usuario llegará como el siguiente mensaje';
const REPLY_ACK = 'respuesta anotada';
// conversaciones que no se recogen: las que esperan o trabajan.
const OPEN_STATUSES: ReadonlySet<ConversationStatus> = new Set([CONVERSATION_STATUS.queued, CONVERSATION_STATUS.running, CONVERSATION_STATUS.waiting]);

/** lo que oye quien sigue una conversación (el cli por local.sock o en el mismo proceso), en orden. */
export type LocalMessage =
  | { type: 'claim'; conversation: string; segment: number; toolset: ToolsetV1 }
  | { type: 'event'; conversation: string; segment: number; event: SeqEvent }
  | { type: 'question'; conversation: string; segment: number; question: LocalQuestion }
  | {
      type: 'result';
      conversation: string;
      segment: number;
      status: ConversationStatus;
      text: string | null;
      error: string | null;
      question: LocalQuestion | null;
      reply: LocalReply | null;
    };

type Listener = (m: LocalMessage) => void;
type Obj = Record<string, unknown>;

// un turno en cola: la conversación, su segmento y su prompt.
interface Queued {
  conversation: string;
  segment: number;
  prompt: string;
}

const clip = (text: string, max: number): string => text.slice(0, max);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function questionOf(args: Obj): LocalQuestion {
  const kinds: readonly unknown[] = Object.values(QUESTION_KIND);
  if (!kinds.includes(args.kind)) throw new Error(`kind: ${kinds.join(' | ')}`);
  if (!nonEmpty(args.question)) throw new Error('question vacía');
  const kind = args.kind as LocalQuestion['kind'];
  if (kind !== QUESTION_KIND.form) return { kind, question: clip(args.question, QUESTION_MAX_CHARS) };
  if (!Array.isArray(args.questions) || args.questions.length === 0) throw new Error('un form necesita `questions`');
  const questions = args.questions.slice(0, FORM_QUESTIONS_MAX).map((q, i) => {
    const item = q as Obj;
    if (typeof item !== 'object' || item === null || !nonEmpty(item.question)) throw new Error(`questions[${i}].question vacía`);
    const options = Array.isArray(item.options) ? item.options.filter(nonEmpty).slice(0, FORM_OPTIONS_MAX).map((o) => clip(o, QUESTION_MAX_CHARS)) : undefined;
    return { question: clip(item.question, QUESTION_MAX_CHARS), ...(options && options.length > 0 ? { options } : {}) };
  });
  return { kind, question: clip(args.question, QUESTION_MAX_CHARS), questions };
}

function replyOf(args: Obj): LocalReply {
  const kinds: readonly unknown[] = Object.values(REPLY_KIND);
  if (!kinds.includes(args.kind)) throw new Error(`kind: ${kinds.join(' | ')}`);
  if (!nonEmpty(args.body)) throw new Error('body vacío');
  return { kind: args.kind as LocalReply['kind'], body: clip(args.body, REPLY_MAX_CHARS), ...(nonEmpty(args.summary) ? { summary: clip(args.summary, SUMMARY_MAX_CHARS) } : {}) };
}

// el prompt de respaldo de una reanudación: el original y lo preguntado y contestado desde entonces.
const fallbackOf = (c: Conversation, answer: string): string =>
  [
    c.request.prompt,
    ...c.transcript.flatMap((t) => [`pregunta: ${t.question.question}`, `respuesta: ${t.answer}`]),
    ...(c.question ? [`pregunta: ${c.question.question}`, `respuesta: ${answer}`] : []),
  ].join('\n\n');

export class LocalPlatform implements Platform {
  readonly id = LOCAL_PLATFORM_ID;
  readonly protocol = PROTOCOL.local;
  // quien aloja la plataforma la despierta al llegar trabajo (el poll de su supervisor).
  onWork: (() => void) | null = null;
  private readonly queue: Queued[] = [];
  private readonly cancels = new Set<string>();
  // conversaciones cuyo último claim no se aceptó (su result se cierra como refused, no como failed).
  private readonly refused = new Set<string>();
  // prompt de respaldo del turno en curso de cada conversación.
  private readonly fallbacks = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly mcp: LocalMcpServer;

  constructor(private readonly ctx: PlatformContext) {
    this.mcp = new LocalMcpServer((subject, tool, args) => this.onTool(subject, tool, args));
  }

  /** arranca su servidor mcp y poda el feed viejo. */
  async start(): Promise<void> {
    await this.mcp.start();
    pruneEvents(Date.now());
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  identity(): { baseUrl: string; clientId: string } {
    return { baseUrl: this.mcp.origin, clientId: LOCAL_PLATFORM_ID };
  }

  observe(_credential: RunnerCredential): void {}

  // --- lo que piden `runner run` y local.sock ---

  /** abre una conversación con su primer turno en cola (siguiéndola antes con `listener`, si viene). devuelve su id. */
  submit(request: LocalRequest, toolset: ToolsetV1, listener?: Listener): string {
    const now = Date.now();
    const conversation: Conversation = {
      id: newConversationId(now),
      createdAt: now,
      updatedAt: now,
      request,
      toolset,
      segment: 0,
      status: CONVERSATION_STATUS.queued,
      sessionId: null,
      nextSeq: EVENTS_DEFAULTS.nextSeq,
      transcript: [],
      question: null,
      reply: null,
      result: null,
      error: null,
    };
    saveConversation(conversation);
    if (listener) this.subscribe(conversation.id, listener);
    this.enqueue({ conversation: conversation.id, segment: 1, prompt: request.prompt });
    return conversation.id;
  }

  /** contesta la pregunta pendiente de una conversación: su siguiente turno, en cola. lanza si no espera respuesta. */
  answer(id: string, text: string): number {
    const c = loadConversation(id);
    if (!c) throw new Error(`no hay ninguna conversación ${id}`);
    if (c.status !== CONVERSATION_STATUS.waiting || !c.question) throw new Error(`la conversación ${id} no espera respuesta (${c.status})`);
    const segment = c.segment + 1;
    this.fallbacks.set(id, fallbackOf(c, text));
    saveConversation({ ...c, updatedAt: Date.now(), status: CONVERSATION_STATUS.queued, transcript: [...c.transcript, { question: c.question, answer: text }], question: null });
    this.enqueue({ conversation: id, segment, prompt: text });
    return segment;
  }

  /** cancela una conversación: en cola, se cierra ya; en marcha, la para el siguiente latido. */
  cancel(id: string): void {
    const c = loadConversation(id);
    if (!c) return;
    const queued = this.queue.findIndex((q) => q.conversation === id);
    if (queued < 0) {
      // solo un turno en marcha: una marca para otra cosa pararía su siguiente reanudación.
      if (c.status === CONVERSATION_STATUS.running) this.cancels.add(id);
      return;
    }
    const [entry] = this.queue.splice(queued, 1);
    saveConversation({ ...c, updatedAt: Date.now(), status: CONVERSATION_STATUS.canceled });
    this.emit({ type: 'result', conversation: id, segment: entry!.segment, status: CONVERSATION_STATUS.canceled, text: null, error: null, question: null, reply: null });
  }

  /** sigue una conversación; devuelve con qué dejar de seguirla. */
  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  /** turnos en cola (sin reclamar). */
  get pending(): number {
    return this.queue.length;
  }

  private enqueue(q: Queued): void {
    this.queue.push(q);
    this.onWork?.();
  }

  private emit(m: LocalMessage): void {
    [...(this.listeners.get(m.conversation) ?? [])].forEach((listener) => listener(m));
  }

  // --- Platform ---

  async claim(): Promise<ClaimResult> {
    const next = this.queue.shift();
    if (!next) return IDLE;
    const c = loadConversation(next.conversation);
    if (!c) return IDLE;
    const subject: TokenSubject = { conversation: c.id, segment: next.segment };
    const run: RunV0 = {
      id: c.id,
      segment: next.segment,
      prompt: next.prompt,
      ...(this.fallbacks.has(c.id) ? { fallbackPrompt: this.fallbacks.get(c.id)! } : {}),
      profile: c.request.profile,
      isolation: RUN_ISOLATION.worktree,
      ...(c.request.model ? { model: c.request.model } : {}),
      ...(c.sessionId ? { session: { backend: V0_BACKEND.claudeCode, handle: c.sessionId } } : {}),
      resources: c.request.repo ? [{ type: RESOURCE_TYPE.repo, key: c.request.repo, params: { [REPO_PARAM.branch]: c.request.branch } }] : [],
      policy: { toolset: c.toolset, limits: { timeoutMs: LOCAL_TIMEOUT_MS } },
      mcpServers: [{ name: LOCAL_MCP_SERVER, url: this.mcp.url, token: this.mcp.issue(subject), expiresAt: 0 }],
      lease: { heartbeatMs: LOCAL_HEARTBEAT_MS },
      events: { ...EVENTS_DEFAULTS, enabled: true, nextSeq: c.nextSeq },
    };
    this.fallbacks.delete(c.id);
    // un turno nuevo: lo anotado por las tools en el anterior no vale para este.
    saveConversation({ ...c, updatedAt: Date.now(), segment: next.segment, status: CONVERSATION_STATUS.running, question: null, reply: null, error: null });
    const said = { state: null, runner: null };
    try {
      // el claim como lo mandaría un server (ver cabecera): json de ida y vuelta y la misma aplicación que v0.
      const { claim } = claimOfV0(JSON.parse(JSON.stringify(run)) as unknown, { ...this.ctx.enforcement(), platformBaseUrl: this.mcp.origin });
      this.emit({ type: 'claim', conversation: c.id, segment: next.segment, toolset: c.toolset });
      return { kind: CLAIM_RESULT.run, claim, said, commandsPending: false };
    } catch (err) {
      if (!(err instanceof ClaimRejectedError)) throw err;
      this.refused.add(c.id);
      return { kind: CLAIM_RESULT.invalid, runId: c.id, error: `claim rechazado por el runner (${err.message})`, said, commandsPending: false };
    }
  }

  async heartbeat(runId: string): Promise<HeartbeatVerdict> {
    return this.cancels.has(runId) ? { stop: true, reason: 'cancelado por el usuario' } : KEEP;
  }

  async progress(): Promise<void> {}

  async events(runId: string, events: SeqEvent[], seg: RunSegment): Promise<number> {
    const c = loadConversation(runId);
    if (!c) return HTTP_OK;
    const segment = seg.segment ?? c.segment;
    appendEvents(runId, segment, events);
    const top = events.reduce((n, e) => Math.max(n, e.seq), c.nextSeq - 1);
    saveConversation({ ...c, updatedAt: Date.now(), nextSeq: top + 1 });
    events.forEach((event) => this.emit({ type: 'event', conversation: runId, segment, event }));
    return HTTP_OK;
  }

  async result(runId: string, report: StatusReport): Promise<void> {
    const c = loadConversation(runId);
    if (!c) return;
    const segment = report.segment ?? c.segment;
    this.mcp.revoke({ conversation: runId, segment });
    this.cancels.delete(runId);
    const refused = this.refused.delete(runId);
    const status: ConversationStatus = refused
      ? CONVERSATION_STATUS.refused
      : report.status === 'canceled'
        ? CONVERSATION_STATUS.canceled
        : report.status === 'failed'
          ? CONVERSATION_STATUS.failed
          : c.question
            ? CONVERSATION_STATUS.waiting
            : c.reply?.kind === REPLY_KIND.blocker
              ? CONVERSATION_STATUS.blocked
              : CONVERSATION_STATUS.done;
    const error = report.status === 'failed' ? (report.error ?? null) : null;
    const next: Conversation = { ...c, updatedAt: Date.now(), status, sessionId: report.sessionId ?? c.sessionId, result: report.result ?? null, error };
    saveConversation(next);
    this.emit({
      type: 'result',
      conversation: runId,
      segment,
      status,
      text: c.reply?.body ?? report.result ?? null,
      error,
      question: status === CONVERSATION_STATUS.waiting ? c.question : null,
      reply: c.reply,
    });
  }

  async openConversations(runIds: string[]): Promise<Set<string>> {
    return new Set(runIds.filter((id) => OPEN_STATUSES.has(loadConversation(id)?.status ?? CONVERSATION_STATUS.done)));
  }

  async commands(): Promise<null> {
    return null;
  }

  async ackCommands(): Promise<void> {}

  async unpair(): Promise<UnpairOutcome> {
    return { kind: 'unsupported' };
  }

  // --- las tools de la plataforma (local/mcp.ts) ---

  private onTool(subject: TokenSubject, tool: string, args: Obj): string {
    const c = loadConversation(subject.conversation);
    if (!c || c.segment !== subject.segment || c.status !== CONVERSATION_STATUS.running) throw new Error('este turno ya se cerró');
    if (tool === LOCAL_TOOL.askUser) {
      const question = questionOf(args);
      saveConversation({ ...c, updatedAt: Date.now(), question });
      this.emit({ type: 'question', conversation: c.id, segment: subject.segment, question });
      return ASK_USER_ACK;
    }
    saveConversation({ ...c, updatedAt: Date.now(), reply: replyOf(args) });
    return REPLY_ACK;
  }
}
