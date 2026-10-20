// `duckhunt-runner run … "<prompt>"` (t#495, M7): un run en esta máquina sin ningún server, por la plataforma local
// (platforms/local.ts). con el daemon en marcha va por local.sock (local/socket.ts) y comparte sus slots, su cuota y
// su lock de git; sin él, arranca el mismo núcleo solo con la plataforma local y con el lock del daemon tomado
// mientras dura (`start` se niega entre tanto).
// decisiones:
// - salida: el feed a stderr y la respuesta a stdout (`$(duckhunt-runner run …)` captura solo la respuesta); con
//   --json, ndjson en stdout de lo que se oye de la conversación (claim, event, question, result).
// - política y consentimiento (local/policy.ts): lo que el techo de la plataforma local recortaría, o una clave que no
//   se le expone, se niega antes de lanzar (77). una escalada (más que lectura) se pregunta en una tty (--yes la da
//   por buena) y sin tty necesita --yes Y `unattendedEscalation` en la plataforma local (77 si no). quien evalúa es
//   quien aloja la plataforma (el daemon o este proceso): lo que se pregunta es lo que se aplicará.
// - una pregunta del agente: con tty (y sin --json) se contesta aquí y la conversación sigue en el mismo proceso; si
//   no, se imprime y sale con 3, y `--resume <conv> "<respuesta>"` sigue después.
// - señales: la primera cancela por el latido (el run muere en el siguiente, ≤ 5 s) y sale con 130/143 al cerrarse;
//   la segunda sale en el acto.
// - --wait <duración>: sin un slot en ese tiempo (el run no se reclama), se cancela y sale con 75. sin él, espera.

import { format } from 'node:util';
import readline from 'node:readline/promises';
import { loadStoredConfig, type StoredConfig } from './config.js';
import { acquireDaemonLock } from './daemon-lock.js';
import { RunnerDaemon } from './daemon.js';
import type { SeqEvent } from './event-uploader.js';
import { FEED_KIND } from './feed.js';
import { escalationOf, parseGrant, RequestRefusedError, type LocalRequest } from './local/policy.js';
import { connectLocal, SOCKET_OP, type LocalConnection, type LocalEvaluation, type ServerMessage } from './local/socket.js';
import { CONVERSATION_ID_RE, CONVERSATION_STATUS, QUESTION_KIND, type LocalQuestion } from './local/store.js';
import type { LocalMessage, LocalPlatform } from './platforms/local.js';
import { PROMPT_PROFILE, type PromptProfile } from './claim.js';
import type { ToolsetGrant } from './vendor/runner-protocol/index.js';

/** exit codes de `run`. */
export const RUN_EXIT = {
  done: 0,
  failed: 1,
  blocker: 2,
  waiting: 3,
  usage: 64,
  noSlot: 75,
  refused: 77,
  sigint: 130,
  sigterm: 143,
} as const;

const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGINT: RUN_EXIT.sigint, SIGTERM: RUN_EXIT.sigterm };

export const RUN_USAGE = `uso:
  duckhunt-runner run [--repo <ws/slug> [--branch <rama>]] [--profile read|edit] [--push] [--grant <tipo:clave[:acceso]>]…
                      [--model <modelo>] [--yes] [--json] [--wait <duración>] [--verbose] "<prompt>"
  duckhunt-runner run --resume <conversación> [--json] [--wait <duración>] "<respuesta>"
exit: 0 hecho · 1 falló · 2 bloqueado · 3 espera respuesta · 64 uso · 75 sin slot · 77 negado · 130/143 señal
`;

const FLAG = {
  repo: '--repo',
  branch: '--branch',
  profile: '--profile',
  push: '--push',
  grant: '--grant',
  model: '--model',
  yes: '--yes',
  json: '--json',
  wait: '--wait',
  resume: '--resume',
  verbose: '--verbose',
} as const;
const VALUE_FLAGS: ReadonlySet<string> = new Set([FLAG.repo, FLAG.branch, FLAG.profile, FLAG.grant, FLAG.model, FLAG.wait, FLAG.resume]);
const BOOL_FLAGS: ReadonlySet<string> = new Set([FLAG.push, FLAG.yes, FLAG.json, FLAG.verbose]);
// las de política: con --resume no caben (una reanudación sigue con el toolset que se aceptó).
const POLICY_FLAGS: readonly string[] = [FLAG.repo, FLAG.branch, FLAG.profile, FLAG.push, FLAG.grant, FLAG.model, FLAG.yes];
const PROFILES: readonly string[] = Object.values(PROMPT_PROFILE);
// duración de --wait: un número con unidad (s, m, h) o milisegundos a secas.
const DURATION_RE = /^(\d+)(ms|s|m|h)?$/;
const MS_PER: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const YES_RE = /^(s|si|sí|y|yes)$/i;
const ANSWER_YES = 'sí';
const ANSWER_NO = 'no';
const EVENT_PREFIX: Readonly<Record<string, string>> = { [FEED_KIND.text]: '', [FEED_KIND.tool]: '→ ', [FEED_KIND.system]: '· ' };

/** la entrada y salida del comando (las pruebas pasan las suyas). */
export interface RunIo {
  stdout(text: string): void;
  stderr(text: string): void;
  isTTY: boolean;
  ask(prompt: string): Promise<string>;
  // engancha SIGINT/SIGTERM; devuelve con qué soltarlos.
  onSignal(handler: (signal: NodeJS.Signals) => void): () => void;
}

export function processIo(): RunIo {
  return {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
    ask: async (prompt) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    onSignal: (handler) => {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
  };
}

interface Parsed {
  text: string;
  json: boolean;
  yes: boolean;
  verbose: boolean;
  waitMs: number | null;
  resume: string | null;
  request: LocalRequest | null;
}

class UsageError extends Error {}

function parseArgs(args: readonly string[]): Parsed {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positional: string[] = [];
  // i/o secuencial: los argumentos en orden (un flag con valor consume el siguiente).
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} sin valor`);
      values.set(a, [...(values.get(a) ?? []), v]);
    } else if (BOOL_FLAGS.has(a)) flags.add(a);
    else if (a.startsWith('--')) throw new UsageError(`flag desconocido: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1 || !positional[0]!.trim()) throw new UsageError('falta el prompt (uno, entre comillas)');
  const one = (flag: string): string | null => {
    const v = values.get(flag);
    if (v && v.length > 1) throw new UsageError(`${flag} solo una vez`);
    return v?.[0] ?? null;
  };
  const wait = one(FLAG.wait);
  const m = wait === null ? null : DURATION_RE.exec(wait);
  if (wait !== null && !m) throw new UsageError(`${FLAG.wait}: una duración (30s, 5m, 1h)`);
  const base = { text: positional[0]!, json: flags.has(FLAG.json), yes: flags.has(FLAG.yes), verbose: flags.has(FLAG.verbose), waitMs: m ? Number(m[1]) * MS_PER[m[2] ?? 'ms']! : null };
  const resume = one(FLAG.resume);
  if (resume !== null) {
    if (!CONVERSATION_ID_RE.test(resume)) throw new UsageError(`${FLAG.resume}: id de conversación inválido (l-…)`);
    const extra = POLICY_FLAGS.filter((f) => values.has(f) || flags.has(f));
    if (extra.length > 0) throw new UsageError(`con ${FLAG.resume} no van ${extra.join(', ')}: la conversación sigue con la política que se aceptó`);
    return { ...base, resume, request: null };
  }
  const profile = one(FLAG.profile) ?? PROMPT_PROFILE.read;
  if (!PROFILES.includes(profile)) throw new UsageError(`${FLAG.profile}: ${PROFILES.join(' | ')}`);
  const branch = one(FLAG.branch);
  const repo = one(FLAG.repo);
  if (branch !== null && repo === null) throw new UsageError(`${FLAG.branch} necesita ${FLAG.repo}`);
  const grants = (values.get(FLAG.grant) ?? []).map((raw): ToolsetGrant => {
    const g = parseGrant(raw);
    if (!g) throw new UsageError(`${FLAG.grant} ${raw}: tipo:clave[:read|interact|full]`);
    return g;
  });
  const request: LocalRequest = { prompt: base.text, profile: profile as PromptProfile, repo, branch, push: flags.has(FLAG.push), grants, model: one(FLAG.model) };
  return { ...base, resume: null, request };
}

// --- con quién se habla: el daemon por local.sock o la plataforma en este proceso ---

type Listener = (m: LocalMessage) => void;

// el listener se engancha ANTES de pedir el turno: lo que llegue a la vez que la respuesta no se pierde.
interface Session {
  evaluate(request: LocalRequest): Promise<LocalEvaluation>;
  submit(request: LocalRequest, listener: Listener): Promise<string>;
  answer(conversation: string, text: string, listener: Listener): Promise<void>;
  cancel(conversation: string): void;
  close(): Promise<void>;
  // la segunda señal: matar ya.
  forceStop(): void;
}

// un mensaje del daemon que contesta a una petición (no de la conversación).
type Reply = Extract<ServerMessage, { type: 'evaluated' | 'accepted' | 'refused' | 'error' }>;
const isReply = (m: ServerMessage): m is Reply => m.type === 'evaluated' || m.type === 'accepted' || m.type === 'refused' || m.type === 'error';

function socketSession(conn: LocalConnection): Session {
  const waiting: ((m: Reply) => void)[] = [];
  const listeners = new Set<Listener>();
  conn.onMessage((m) => {
    if (isReply(m)) waiting.shift()?.(m);
    else listeners.forEach((l) => l(m));
  });
  const ask = (m: Parameters<LocalConnection['send']>[0]): Promise<Reply> =>
    new Promise((resolve, reject) => {
      waiting.push(resolve);
      conn.send(m);
      void conn.closed.then(() => reject(new Error('el daemon cerró la conexión')));
    });
  const fail = (m: Reply): never => {
    if (m.type === 'refused') throw new RequestRefusedError(m.message);
    throw new Error(m.type === 'error' ? m.message : `respuesta inesperada del daemon: ${m.type}`);
  };
  return {
    evaluate: async (request) => {
      const m = await ask({ op: SOCKET_OP.evaluate, request });
      return m.type === 'evaluated' ? m.evaluation : fail(m);
    },
    submit: async (request, listener) => {
      listeners.add(listener);
      const m = await ask({ op: SOCKET_OP.submit, request });
      return m.type === 'accepted' ? m.conversation : fail(m);
    },
    answer: async (conversation, text, listener) => {
      listeners.add(listener);
      const m = await ask({ op: SOCKET_OP.answer, conversation, text });
      if (m.type !== 'accepted') fail(m);
    },
    cancel: (conversation) => conn.send({ op: SOCKET_OP.cancel, conversation }),
    close: async () => conn.close(),
    forceStop: () => conn.close(),
  };
}

// sin daemon: el núcleo en este proceso con la plataforma local, mientras dure el comando.
async function inProcessSession(cfg: StoredConfig, verbose: boolean, io: RunIo): Promise<Session> {
  const daemon = new RunnerDaemon(cfg, { localOnly: true, verboseLog: verbose });
  await daemon.refreshConfig();
  const local: LocalPlatform | null = await daemon.hostLocal();
  if (!local) throw new Error('la plataforma local no arranca (ver el aviso de arriba)');
  let running: Promise<number> | null = null;
  // una conversación se sigue una vez (sus turnos siguientes llegan al mismo listener).
  const followed = new Map<string, () => void>();
  const follow = (conversation: string, listener: Listener): void => {
    if (!followed.has(conversation)) followed.set(conversation, local.subscribe(conversation, listener));
  };
  const boot = (): void => {
    running ??= daemon.run().catch((err: Error) => {
      io.stderr(`${err.message}\n`);
      return RUN_EXIT.failed;
    });
  };
  return {
    evaluate: async (request) => daemon.evaluateLocal(request),
    submit: async (request, listener) => {
      // la plataforma la sigue desde antes de encolarla; su listener vive hasta que el núcleo se cierra.
      const conversation = local.submit(request, daemon.evaluateLocal(request).toolset, listener);
      followed.set(conversation, () => {});
      boot();
      return conversation;
    },
    answer: async (conversation, text, listener) => {
      follow(conversation, listener);
      local.answer(conversation, text);
      boot();
    },
    cancel: (conversation) => local.cancel(conversation),
    close: async () => {
      followed.forEach((off) => off());
      daemon.stop();
      await running;
      await local.close();
    },
    forceStop: () => daemon.forceStop(),
  };
}

// en standalone el log del núcleo no debe ensuciar stdout: a stderr con --verbose, si no, fuera.
function muteCoreLog(verbose: boolean, io: RunIo): () => void {
  const original = console.log;
  console.log = verbose ? (...args: unknown[]) => io.stderr(`${format(...args)}\n`) : () => {};
  return () => {
    console.log = original;
  };
}

// --- conversación ---

const eventLine = (e: SeqEvent): string => `${EVENT_PREFIX[e.kind] ?? ''}${e.tool ? `${e.tool} ` : ''}${e.body}\n`;

function questionLines(q: LocalQuestion): string {
  const items = (q.questions ?? []).flatMap((item, i) => [`  ${i + 1}. ${item.question}`, ...(item.options ?? []).map((o, j) => `     ${j + 1}) ${o}`)]);
  return [q.question, ...items].join('\n');
}

// la respuesta del usuario a una pregunta en la tty.
async function askQuestion(q: LocalQuestion, io: RunIo): Promise<string> {
  if (q.kind === QUESTION_KIND.yesNo) return YES_RE.test((await io.ask(`${q.question} [s/n] `)).trim()) ? ANSWER_YES : ANSWER_NO;
  if (q.kind === QUESTION_KIND.text || !q.questions) return (await io.ask(`${q.question}\n> `)).trim();
  io.stderr(`${q.question}\n`);
  const answers: string[] = [];
  // i/o secuencial: una pregunta tras otra.
  for (const item of q.questions) {
    const options = item.options ?? [];
    const raw = (await io.ask(`${item.question}${options.length > 0 ? `\n${options.map((o, j) => `  ${j + 1}) ${o}`).join('\n')}` : ''}\n> `)).trim();
    const n = Number(raw);
    answers.push(`${item.question}: ${Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : raw}`);
  }
  return answers.join('\n');
}

const EXIT_BY_STATUS: Readonly<Record<string, number>> = {
  [CONVERSATION_STATUS.done]: RUN_EXIT.done,
  [CONVERSATION_STATUS.blocked]: RUN_EXIT.blocker,
  [CONVERSATION_STATUS.waiting]: RUN_EXIT.waiting,
  [CONVERSATION_STATUS.failed]: RUN_EXIT.failed,
  [CONVERSATION_STATUS.refused]: RUN_EXIT.refused,
  [CONVERSATION_STATUS.canceled]: RUN_EXIT.failed,
};

interface Drive {
  session: Session;
  io: RunIo;
  json: boolean;
  waitMs: number | null;
  // pide el primer turno con el listener ya enganchado; devuelve la conversación.
  start: (listener: Listener) => Promise<string>;
}

// sigue la conversación turno a turno hasta un final (o una pregunta que no se contesta aquí). devuelve el exit code.
async function drive({ session, io, json, waitMs, start }: Drive): Promise<number> {
  let conversation: string | null = null;
  let signal: NodeJS.Signals | null = null;
  let waitExpired = false;
  let claimed = false;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (finish = resolve));
  const offSignal = io.onSignal((s) => {
    if (signal !== null) {
      session.forceStop();
      return finish(SIGNAL_EXIT[s] ?? RUN_EXIT.sigint);
    }
    signal = s;
    io.stderr(`${s}: cancelando (otra señal sale en el acto)\n`);
    if (conversation !== null) session.cancel(conversation);
  });
  const timer =
    waitMs === null
      ? null
      : setTimeout(() => {
          if (claimed || conversation === null) return;
          waitExpired = true;
          session.cancel(conversation);
        }, waitMs);
  const onMessage = (m: LocalMessage): void => {
    if (json) io.stdout(`${JSON.stringify(m)}\n`);
    if (m.type === 'claim') {
      claimed = true;
      if (timer) clearTimeout(timer);
    }
    if (m.type === 'event' && !json) io.stderr(eventLine(m.event));
    if (m.type === 'result') void settle(m);
  };
  const settle = async (m: Extract<LocalMessage, { type: 'result' }>): Promise<void> => {
    if (waitExpired && !claimed) return finish(RUN_EXIT.noSlot);
    if (signal !== null && m.status === CONVERSATION_STATUS.canceled) return finish(SIGNAL_EXIT[signal] ?? RUN_EXIT.sigint);
    if (m.status === CONVERSATION_STATUS.waiting && m.question && io.isTTY && !json && signal === null) {
      const answer = await askQuestion(m.question, io);
      await session.answer(m.conversation, answer, onMessage);
      return;
    }
    if (!json) {
      if (m.status === CONVERSATION_STATUS.waiting && m.question) {
        io.stderr(`${questionLines(m.question)}\n\ncontesta con: duckhunt-runner run --resume ${m.conversation} "<respuesta>"\n`);
      } else if (m.error) io.stderr(`${m.error}\n`);
      if (m.text && (m.status === CONVERSATION_STATUS.done || m.status === CONVERSATION_STATUS.blocked)) io.stdout(m.text.endsWith('\n') ? m.text : `${m.text}\n`);
    }
    finish(EXIT_BY_STATUS[m.status] ?? RUN_EXIT.failed);
  };
  try {
    conversation = await start(onMessage);
    if (signal !== null) session.cancel(conversation);
    if (!json) io.stderr(`conversación ${conversation}\n`);
    return await done;
  } finally {
    if (timer) clearTimeout(timer);
    offSignal();
  }
}

// --- el comando ---

// consentimiento de una escalada (ver cabecera). true = lanzar.
async function consent(escalation: readonly string[], parsed: Parsed, evaluation: LocalEvaluation, io: RunIo): Promise<boolean> {
  if (escalation.length === 0) return true;
  if (!io.isTTY) {
    if (parsed.yes && evaluation.unattendedEscalation) return true;
    io.stderr(
      `la petición pide más que lectura (${escalation.join(', ')}) y no hay tty: ${parsed.yes ? '--yes sin tty necesita `unattendedEscalation: true` en platforms.local' : 'confírmala con --yes (y `unattendedEscalation: true` en platforms.local)'}\n`,
    );
    return false;
  }
  if (parsed.yes) return true;
  io.stderr(`la petición pide más que lectura:\n${escalation.map((e) => `  + ${e}`).join('\n')}\n`);
  return YES_RE.test((await io.ask('¿lanzar? [s/N] ')).trim());
}

/** `run` (ver cabecera). devuelve el exit code. */
export async function runCommand(args: readonly string[], io: RunIo = processIo()): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr(`${err.message}\n\n${RUN_USAGE}`);
    return RUN_EXIT.usage;
  }
  const cfg: StoredConfig = loadStoredConfig() ?? { repos: {}, aws: {}, defaults: {} };
  if (parsed.request?.repo && !Object.hasOwn(cfg.repos, parsed.request.repo)) {
    io.stderr(`repo ${parsed.request.repo} no mapeado en esta máquina (\`duckhunt-runner repos add ${parsed.request.repo} <path>\`)\n`);
    return RUN_EXIT.usage;
  }
  let session: Session;
  let releaseLock: (() => void) | null = null;
  let restoreLog: (() => void) | null = null;
  const conn = await connectLocal();
  if (conn) session = socketSession(conn);
  else {
    try {
      releaseLock = acquireDaemonLock();
    } catch (err) {
      io.stderr(`sin local.sock y con el lock del daemon tomado: ${(err as Error).message}\n`);
      return RUN_EXIT.noSlot;
    }
    restoreLog = muteCoreLog(parsed.verbose, io);
    try {
      session = await inProcessSession(cfg, parsed.verbose, io);
    } catch (err) {
      restoreLog();
      releaseLock();
      io.stderr(`${(err as Error).message}\n`);
      return RUN_EXIT.failed;
    }
  }
  try {
    if (parsed.resume !== null) {
      const conversation = parsed.resume;
      return await drive({ session, io, json: parsed.json, waitMs: parsed.waitMs, start: async (listener) => (await session.answer(conversation, parsed.text, listener), conversation) });
    }
    const request = parsed.request!;
    const evaluation = await session.evaluate(request);
    if (!(await consent(escalationOf(evaluation.toolset), parsed, evaluation, io))) return RUN_EXIT.refused;
    return await drive({ session, io, json: parsed.json, waitMs: parsed.waitMs, start: (listener) => session.submit(request, listener) });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return err instanceof RequestRefusedError ? RUN_EXIT.refused : RUN_EXIT.failed;
  } finally {
    await session.close();
    restoreLog?.();
    releaseLock?.();
  }
}
