// loop del daemon (contrato 42 + prompts libres t#378): reclama runs por poll, lanza `claude -p`
// headless en un worktree del checkout del repo (o en el scratch dir si no hay repo) con el mcp de
// duckhunt adjunto y el perfil de tools del claim, sube el feed de progreso y reporta el cierre. un
// run a la vez: el cómputo es la máquina del usuario. el server nunca ve paths ni perfiles — el mapa
// repo→checkout y cuenta→perfil vive en la config local.
// decisiones:
// - claude corre en su PROPIO grupo de procesos (detached): cancelar, el timeout o parar el daemon
//   matan también lo que lanzó la tool Bash (tests, servidores). por eso el daemon instala sus
//   handlers de SIGINT/SIGTERM: ctrl-c ya no le llega al hijo por la terminal.
// - kind=prompt usa un worktree POR CONVERSACIÓN que sobrevive entre segmentos (worktree.ts); lo
//   recoge conversation-gc.ts entre runs. los runs de reglas siguen con su worktree efímero.
// - el feed (event-uploader.ts) se vacía ANTES de reportar el status: el server rechaza eventos de
//   un run cerrado.
// - el segmento del claim viaja en heartbeat/progress/events/status: es lo que distingue a ESTE
//   proceso del siguiente turno de la misma fila. el latido mata claude en cuanto el run deja de ser
//   suyo (cancelado, re-encolado tras detenerlo, dado por fallido, borrado → 404, reclamado por otro
//   segmento), no solo con `cancel`: un proceso detenido no puede seguir 30 min con Bash.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { refreshAccess } from './oauth.js';
import { AccessTokenSource } from './access-token.js';
import { logsDir, scratchDir, type RepoConfig, type RunnerConfig } from './config.js';
import { consumeStreamLine, detectClaude, newStreamState, type ClaudeInfo } from './claude.js';
import { buildClaudeArgs, PROMPT_REQUIRED_FLAGS } from './claude-args.js';
import { claimRunId, EVENTS_DEFAULTS, parseClaim, RUN_KIND, RUNNER_CAPABILITY, type ClaimedRun, type ClaimResponse } from './claim.js';
import { EventUploader, type SeqEvent } from './event-uploader.js';
import { clip, feedEventsFromStream, systemEvent, type FeedContext } from './feed.js';
import { scrubEnv } from './scrub-env.js';
import { clampReport, reportFor, type Attempt, type KillReason, type StatusReport } from './status-report.js';
import { prepareConversationWorktree, prepareRunWorktree, removeRunWorktree, touchWorktree } from './worktree.js';
import { chunk, CONVERSATION_GC_INTERVAL_MS, listWorktreeCandidates, removeWorktrees, selectForRemoval } from './conversation-gc.js';
import { runnerVersion } from './version.js';

const execFileP = promisify(execFile);

const CLAIM_POLL_MS = 5_000;
// SIGTERM → SIGKILL (al grupo) si el proceso no muere en este margen.
const KILL_GRACE_MS = 10_000;
// tras la salida de claude, espera máxima a que se cierren sus pipes: un proceso en background que
// los heredó retendría el 'close' para siempre.
const EXIT_DRAIN_MS = 5_000;
// throttle del reporte de tool calls al server.
const PROGRESS_MIN_INTERVAL_MS = 5_000;
const PROGRESS_TICK_MS = 1_000;
const MIN_HEARTBEAT_MS = 5_000;
const MIN_RUN_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_CHARS = 4000;
// toda llamada al server: sin respuesta en este plazo cuenta como fallo de red.
const API_TIMEOUT_MS = 30_000;
// POST /status: intentos con backoff exponencial (2 s, 4 s, 8 s, 16 s).
const STATUS_POST_ATTEMPTS = 5;
const STATUS_POST_BACKOFF_MS = 2_000;
// tras SIGINT/SIGTERM: margen para cerrar el run en curso antes de salir a la fuerza.
const SHUTDOWN_GRACE_MS = 20_000;
const EXIT_CODE_SIGINT = 130;
const EXIT_CODE_SIGTERM = 143;
// topes de lo que el claim anuncia (RUNNER_CLAUDE_VERSION_MAX_CHARS) y de la nota de workdir.
const CLAUDE_VERSION_MAX_CHARS = 80;
const WORKDIR_MAX_CHARS = 300;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const HTTP_TIMEOUT = 408;
// estado del run que el latido espera mientras el proceso es su dueño.
const RUN_STATUS_RUNNING = 'running';
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

// cwd del run y lo que hay que hacer con él al terminar.
interface Workdir {
  workdir: string;
  repoCfg: RepoConfig | null;
  // worktree creado o reutilizado por el daemon (null = scratch o checkout directo).
  worktree: string | null;
  // conv-<id> de un prompt run: se conserva siempre.
  conversation: boolean;
  // nota para agent_run.workdir y el feed (sin paths absolutos).
  note: string;
  warnings: string[];
}

export interface DaemonOptions {
  verboseLog?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isTransient = (status: number): boolean => status === HTTP_TIMEOUT || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR;

// señal a todo el grupo de procesos del hijo (spawn detached → pgid = pid del hijo).
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    // ESRCH: el grupo ya no existe. cualquier otro fallo: al menos al hijo directo.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

export class RunnerDaemon {
  private readonly auth: AccessTokenSource;
  private claude: ClaudeInfo = { version: null, supported: new Set() };
  private hasAws = false;
  // hijo en curso (un run a la vez) y su kill con motivo.
  private active: ChildProcess | null = null;
  private killActive: ((reason: KillReason) => void) | null = null;
  private stopping = false;
  private exitCode = 0;
  private wake: (() => void) | null = null;
  private lastGcAt = 0;

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly opts: DaemonOptions = {},
  ) {
    this.auth = new AccessTokenSource(() => refreshAccess(cfg));
  }

  // fetch autenticado contra /api/runner con timeout y un reintento tras refresh en 401.
  private async api(pathname: string, body?: unknown): Promise<Response> {
    const call = async (token: string): Promise<Response> =>
      fetch(`${this.cfg.baseUrl}/api/runner${pathname}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? '{}' : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    const token = await this.auth.token();
    const first = await call(token);
    if (first.status !== 401) return first;
    this.auth.invalidate(token);
    return call(await this.auth.token());
  }

  private label(): string {
    return this.cfg.label ?? os.hostname();
  }

  // capacidades que se anuncian: prompt solo si el cli puede cumplir su perfil (permission mode
  // explícito, sin mcp del repo, deny list y settings solo del usuario en lectura).
  private capabilities(): string[] {
    return [
      ...(this.hasAws ? [RUNNER_CAPABILITY.aws] : []),
      ...(PROMPT_REQUIRED_FLAGS.every((f) => this.claude.supported.has(f)) ? [RUNNER_CAPABILITY.prompt] : []),
      RUNNER_CAPABILITY.events,
    ];
  }

  /** loop principal: gc → claim → ejecutar → repetir, hasta SIGINT/SIGTERM. devuelve el exit code. */
  async run(): Promise<number> {
    this.claude = await detectClaude();
    if (!this.claude.version) {
      throw new Error('no se encuentra `claude` en el PATH: instala claude code y haz login antes de arrancar el daemon');
    }
    this.hasAws = await execFileP('aws', ['--version']).then(
      () => true,
      () => false,
    );
    this.installSignalHandlers();
    console.log(
      `[runner] duckhunt-runner ${runnerVersion() ?? '?'} · ${this.label()} → ${this.cfg.baseUrl} (claude ${this.claude.version}, aws cli ${this.hasAws ? 'sí' : 'no'}, ${Object.keys(this.cfg.repos).length} repos, ${Object.keys(this.cfg.aws).length} cuentas aws, capacidades ${this.capabilities().join(',')}, poll ${CLAIM_POLL_MS / 1000}s)`,
    );
    while (!this.stopping) {
      await this.collectWorktrees();
      const claim = this.stopping ? null : await this.claim();
      if (claim) {
        await this.executeRun(claim).catch((err) => {
          console.error(`[runner] run ${claim.run.id} reventó: ${(err as Error).message}`);
        });
      } else if (!this.stopping) {
        await this.idle(CLAIM_POLL_MS);
      }
    }
    console.log('[runner] detenido');
    return this.exitCode;
  }

  // espera interrumpible por una señal de parada.
  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  // primera señal: parar tras cerrar el run en curso (se mata su grupo y se reporta); segunda
  // señal o margen agotado: salida inmediata matando el grupo.
  private installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals, code: number): void => {
      const forceExit = (): never => {
        if (this.active) signalGroup(this.active, 'SIGKILL');
        process.exit(code);
      };
      if (this.stopping) forceExit();
      this.stopping = true;
      this.exitCode = code;
      console.log(`[runner] ${signal}: deteniendo${this.killActive ? ' el run en curso' : ''} (otra señal fuerza la salida)`);
      this.killActive?.('shutdown');
      this.wake?.();
      setTimeout(forceExit, SHUTDOWN_GRACE_MS).unref();
    };
    process.on('SIGINT', () => onSignal('SIGINT', EXIT_CODE_SIGINT));
    process.on('SIGTERM', () => onSignal('SIGTERM', EXIT_CODE_SIGTERM));
  }

  // --- claim ---

  private async claim(): Promise<ClaimResponse | null> {
    let res: Response;
    try {
      res = await this.api('/claim', {
        runnerLabel: this.label(),
        repos: Object.keys(this.cfg.repos),
        awsAccounts: Object.keys(this.cfg.aws),
        capabilities: this.capabilities(),
        ...(runnerVersion() ? { version: runnerVersion() } : {}),
        ...(this.claude.version ? { claudeVersion: this.claude.version.slice(0, CLAUDE_VERSION_MAX_CHARS) } : {}),
      });
    } catch (err) {
      console.error(`[runner] claim inaccesible: ${(err as Error).message}`);
      return null;
    }
    // 204 = nada que hacer (o runner pausado desde /settings/agents).
    if (res.status === 204) return null;
    if (res.status !== 200) {
      console.error(`[runner] claim falló: http ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const raw: unknown = await res.json().catch((err: Error) => {
      console.error(`[runner] claim con json ilegible: ${err.message}`);
      return null;
    });
    try {
      return parseClaim(raw);
    } catch (err) {
      // el run ya está reclamado (running): si su id es usable se cierra con el motivo; si no, lo
      // cerrará el sweeper del server.
      const message = (err as Error).message;
      console.error(`[runner] ${message}`);
      const id = claimRunId(raw);
      if (id !== null) await this.postStatus(id, { status: 'failed', error: message });
      return null;
    }
  }

  // --- gc de worktrees (entre runs, throttled) ---

  // conversaciones abiertas según el server. si no contesta (o es anterior a t#378), todas se dan
  // por abiertas: entonces solo actúa el ttl de inactividad, que nunca pierde trabajo.
  private async openConversations(runIds: number[]): Promise<Set<number>> {
    const open = new Set<number>();
    // i/o secuencial: pocas llamadas, en orden.
    for (const ids of chunk(runIds)) {
      const res = await this.api('/conversations', { runIds: ids }).catch((err: Error) => {
        console.error(`[runner] gc: /conversations inaccesible: ${err.message}`);
        return null;
      });
      const body = res?.ok ? ((await res.json().catch(() => null)) as { open?: unknown } | null) : null;
      if (!body || !Array.isArray(body.open)) {
        if (res && !res.ok) console.error(`[runner] gc: /conversations respondió http ${res.status}: solo se aplica el ttl`);
        ids.forEach((id) => open.add(id));
        continue;
      }
      body.open.filter((id): id is number => Number.isSafeInteger(id)).forEach((id) => open.add(id));
    }
    return open;
  }

  private async collectWorktrees(): Promise<void> {
    if (Date.now() - this.lastGcAt < CONVERSATION_GC_INTERVAL_MS) return;
    this.lastGcAt = Date.now();
    try {
      const candidates = listWorktreeCandidates(Object.values(this.cfg.repos).map((r) => r.path));
      if (candidates.length === 0) return;
      const open = await this.openConversations(candidates.filter((c) => c.kind === 'conversation').map((c) => c.runId));
      const targets = selectForRemoval(candidates, open, Date.now());
      if (targets.length === 0) return;
      const removed = await removeWorktrees(targets, scrubEnv(process.env));
      if (removed > 0) console.log(`[runner] gc: ${removed} worktree(s) recogido(s)`);
    } catch (err) {
      console.error(`[runner] gc de worktrees falló: ${(err as Error).message}`);
    }
  }

  // --- cwd del run: worktree de conversación, worktree por run, checkout o scratch ---

  private async prepareWorkdir(run: ClaimedRun, env: NodeJS.ProcessEnv): Promise<Workdir> {
    const repoCfg = run.repo && Object.hasOwn(this.cfg.repos, run.repo) ? this.cfg.repos[run.repo]! : null;
    const scratch = (note: string, warnings: string[] = []): Workdir => ({ workdir: scratchDir(), repoCfg: null, worktree: null, conversation: false, note, warnings });
    if (!run.repo) return scratch('scratch · sin repo');
    if (!repoCfg) return scratch('scratch · sin repo mapeado', [`repo ${run.repo} no mapeado en este runner: corriendo en scratch`]);
    if (!fs.existsSync(repoCfg.path)) {
      console.log(`[runner] run ${run.id}: el checkout ${repoCfg.path} no existe`);
      return scratch('scratch · checkout no encontrado', [`el checkout de ${run.repo} no existe en este runner: corriendo en scratch`]);
    }
    if (run.kind === RUN_KIND.prompt) {
      // worktree siempre: `worktree: false` y skip-permissions del repo son solo para runs de reglas.
      const wt = await prepareConversationWorktree(repoCfg.path, run.id, run.branch, env);
      return { ...wt, repoCfg, worktree: wt.workdir, conversation: true };
    }
    if (repoCfg.worktree === false) return { workdir: repoCfg.path, repoCfg, worktree: null, conversation: false, note: 'checkout · sin worktree', warnings: [] };
    const wt = await prepareRunWorktree(repoCfg.path, run.id, run.branch, env);
    return { ...wt, repoCfg, worktree: wt.workdir, conversation: false };
  }

  // --- env del run: el del usuario saneado + perfil aws mapeado ---

  private envFor(run: ClaimedRun): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...scrubEnv(process.env), AWS_PAGER: '' };
    const accountId = run.aws?.accountId;
    const account = accountId && Object.hasOwn(this.cfg.aws, accountId) ? this.cfg.aws[accountId] : undefined;
    if (account) {
      env.AWS_PROFILE = account.profile;
      const region = account.region ?? run.aws?.region ?? undefined;
      if (region) env.AWS_DEFAULT_REGION = region;
    } else if (run.aws?.region) {
      env.AWS_DEFAULT_REGION = run.aws.region;
    }
    return env;
  }

  // --- ejecución ---

  private async executeRun(claim: ClaimResponse): Promise<void> {
    const { run } = claim;
    const tag = `run ${run.id}`;
    console.log(
      `[runner] ${tag} reclamado (${run.kind}${run.profile ? `, perfil ${run.profile}` : ''}, entry ${run.entryId}${claim.tier ? `, tier ${claim.tier}` : ''}${run.repo ? `, repo ${run.repo}${run.branch ? `@${run.branch}` : ''}` : ''}${run.sessionId ? `, sesión ${run.sessionId}` : ''})`,
    );
    const env = this.envFor(run);
    // identidad del proceso en cada llamada del run (servers anteriores a los segmentos: nada).
    const seg = run.segment !== null ? { segment: run.segment } : {};
    const feed = claim.events?.enabled ? new EventUploader((events) => this.postEvents(run.id, events, seg), claim.events, tag) : null;

    let prepared: Workdir;
    try {
      prepared = await this.prepareWorkdir(run, env);
    } catch (err) {
      await feed?.close();
      await this.postStatus(run.id, { status: 'failed', error: `no se pudo preparar el directorio del run: ${(err as Error).message}`, ...seg });
      return;
    }
    const ctx: FeedContext = {
      cwd: prepared.workdir,
      home: os.homedir(),
      bodyMaxChars: claim.events?.bodyMaxChars ?? EVENTS_DEFAULTS.bodyMaxChars,
      toolArgMaxChars: claim.events?.toolArgMaxChars ?? EVENTS_DEFAULTS.toolArgMaxChars,
    };
    const note = (text: string): void => {
      console.log(`[runner] ${tag}: ${text}`);
      feed?.push(systemEvent(text, ctx));
    };
    note(prepared.note);
    [...claim.warnings, ...prepared.warnings].forEach(note);

    // mcp-config temporal con el token per-run (0600; se borra al terminar).
    const mcpFile = path.join(os.tmpdir(), `duckhunt-runner-${run.id}-${crypto.randomBytes(4).toString('hex')}.json`);
    let report: StatusReport;
    try {
      fs.writeFileSync(
        mcpFile,
        JSON.stringify({
          mcpServers: {
            [claim.mcp.serverName]: { type: 'http', url: claim.mcp.url, headers: { Authorization: `Bearer ${claim.mcp.token}` } },
          },
        }),
        { mode: 0o600 },
      );
      report = await this.runAttempts(claim, prepared, env, mcpFile, feed, ctx, note);
    } catch (err) {
      report = { status: 'failed', error: (err as Error).message };
    } finally {
      fs.rmSync(mcpFile, { force: true });
    }

    await feed?.close();
    await this.postStatus(run.id, { ...report, ...seg });
    if (prepared.worktree && prepared.conversation) {
      touchWorktree(prepared.worktree);
    } else if (prepared.worktree && prepared.repoCfg) {
      if (report.status === 'done') await removeRunWorktree(prepared.repoCfg.path, prepared.worktree, env);
      else console.log(`[runner] worktree conservado para autopsia: ${prepared.worktree}`);
    }
    console.log(`[runner] ${tag} terminado (${report.status}${report.error ? `: ${report.error}` : ''})`);
  }

  // uno o dos intentos: reanudación fallida antes de que el asistente hablara (sesión inexistente
  // en esta máquina, borrada, de otro daemon) → un solo reintento desde cero con el prompt de respaldo.
  private async runAttempts(
    claim: ClaimResponse,
    prepared: Workdir,
    env: NodeJS.ProcessEnv,
    mcpFile: string,
    feed: EventUploader | null,
    ctx: FeedContext,
    note: (text: string) => void,
  ): Promise<StatusReport> {
    const { run } = claim;
    const args = (prompt: string, resumeSessionId: string | null): string[] =>
      buildClaudeArgs({
        claim,
        prompt,
        mcpConfigFile: mcpFile,
        supported: this.claude.supported,
        resumeSessionId,
        model: this.cfg.defaults.model,
        configBudgetUsd: this.cfg.defaults.maxBudgetUsd,
        skipPermissions: prepared.repoCfg?.dangerouslySkipPermissions === true,
        payingWithApiKey: !!process.env.ANTHROPIC_API_KEY,
      });
    // reanudar o no lo decide el server: manda sessionId solo cuando hay sesión que retomar.
    const resume = run.sessionId;
    let attempt = await this.spawnClaude(claim, args(claim.prompt, resume), prepared, env, feed, ctx);
    let resumed: boolean | undefined = resume ? true : undefined;
    if (resume && attempt.killedBy === null && attempt.exitCode !== 0 && !attempt.stream.sawAssistant && claim.fallbackPrompt) {
      console.log(`[runner] run ${run.id}: la sesión ${resume} no se pudo reanudar`);
      note('la sesión anterior no se pudo reanudar en este runner: reintento desde cero');
      attempt = await this.spawnClaude(claim, args(claim.fallbackPrompt, null), prepared, env, feed, ctx);
      resumed = false;
    }
    return reportFor(attempt, resumed);
  }

  // spawnea claude en su propio grupo de procesos, consume stdout (stream-json → contadores + feed)
  // y stderr (tail), bombea heartbeat (soft-cancel) y progreso, y aplica el timeout wall-clock.
  // resuelve siempre (nunca rechaza).
  private spawnClaude(claim: ClaimResponse, args: string[], prepared: Workdir, env: NodeJS.ProcessEnv, feed: EventUploader | null, ctx: FeedContext): Promise<Attempt> {
    const runId = claim.run.id;
    const seg = claim.run.segment !== null ? { segment: claim.run.segment } : {};
    return new Promise((resolve) => {
      const stream = newStreamState();
      const stderrTail: string[] = [];
      let killedBy: KillReason | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let drainTimer: NodeJS.Timeout | null = null;
      let logFile: number | null = null;
      if (this.opts.verboseLog) {
        try {
          logFile = fs.openSync(path.join(logsDir(), `${runId}.jsonl`), 'a');
        } catch (err) {
          console.error(`[runner] no se pudo abrir el log del run: ${(err as Error).message}`);
        }
      }

      let child: ChildProcess;
      try {
        child = spawn('claude', args, { cwd: prepared.workdir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        if (logFile !== null) fs.closeSync(logFile);
        resolve({ exitCode: null, killedBy: null, stream, stderrTail: `no se pudo lanzar claude: ${(err as Error).message}` });
        return;
      }

      const kill = (reason: KillReason): void => {
        if (killedBy) return;
        killedBy = reason;
        signalGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      };
      this.active = child;
      this.killActive = kill;
      if (this.stopping) kill('shutdown');

      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        const ev = consumeStreamLine(stream, line);
        if (ev && feed) feedEventsFromStream(ev, ctx).forEach((e) => feed.push(e));
        if (logFile !== null) fs.writeSync(logFile, `${line}\n`);
      });
      readline.createInterface({ input: child.stderr! }).on('line', (line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        if (logFile !== null) fs.writeSync(logFile, `${JSON.stringify({ type: 'stderr', line })}\n`);
      });

      // heartbeat: transporta el soft-cancel del server (y refresca la presencia del runner). el
      // proceso muere si el run ya no es suyo: cancel, un estado que no es running, o el run no existe.
      const heartbeat = setInterval(() => {
        void this.api(`/runs/${runId}/heartbeat`, seg)
          .then(async (res) => {
            if (res.status === HTTP_NOT_FOUND) {
              console.log(`[runner] run ${runId} ya no existe en el server; deteniendo claude`);
              kill('cancel');
              return;
            }
            if (!res.ok) return;
            const body = (await res.json().catch(() => null)) as { cancel?: boolean; status?: string } | null;
            if (body?.cancel || (typeof body?.status === 'string' && body.status !== RUN_STATUS_RUNNING)) {
              console.log(`[runner] run ${runId} ya no es de este proceso (${body?.status ?? 'cancelado'}); deteniendo claude`);
              kill('cancel');
            }
          })
          .catch((err) => console.error(`[runner] heartbeat falló: ${(err as Error).message}`));
      }, Math.max(MIN_HEARTBEAT_MS, claim.heartbeatMs));

      // progreso: tool calls del segmento (throttled) + la nota de workdir en el primer envío.
      const postProgress = (toolCalls: number, workdir?: string): void => {
        void this.api(`/runs/${runId}/progress`, { toolCalls, ...(workdir ? { workdir } : {}), ...seg }).catch((err) =>
          console.error(`[runner] progress falló: ${(err as Error).message}`),
        );
      };
      postProgress(0, clip(prepared.note, WORKDIR_MAX_CHARS));
      let reportedToolCalls = 0;
      let lastProgressAt = Date.now();
      const progress = setInterval(() => {
        const now = Date.now();
        if (stream.toolCalls === reportedToolCalls || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
        reportedToolCalls = stream.toolCalls;
        lastProgressAt = now;
        postProgress(reportedToolCalls);
      }, PROGRESS_TICK_MS);

      const timeout = setTimeout(() => {
        console.log(`[runner] run ${runId} superó ${Math.round(claim.timeoutMs / 1000)}s; deteniendo claude`);
        kill('timeout');
      }, Math.max(MIN_RUN_TIMEOUT_MS, claim.timeoutMs));

      child.on('error', (err) => {
        stderrTail.push(`[runner] no se pudo lanzar claude: ${err.message}`);
      });
      child.on('exit', () => {
        // claude salió: si algo en background retiene sus pipes, se dejan de esperar.
        drainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, EXIT_DRAIN_MS);
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
        clearInterval(progress);
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (logFile !== null) fs.closeSync(logFile);
        this.active = null;
        this.killActive = null;
        resolve({ exitCode: code, killedBy, stream, stderrTail: stderrTail.join('\n').slice(-STDERR_TAIL_MAX_CHARS) });
      });
    });
  }

  private async postEvents(runId: number, events: SeqEvent[], seg: { segment?: number }): Promise<number> {
    const res = await this.api(`/runs/${runId}/events`, { events, ...seg });
    return res.status;
  }

  // cierre con reintento acotado: es lo único del run que el server no puede reconstruir.
  private async postStatus(runId: number, report: StatusReport): Promise<void> {
    const body = clampReport(report);
    // i/o secuencial con backoff exponencial.
    for (let attempt = 1; attempt <= STATUS_POST_ATTEMPTS; attempt++) {
      const res = await this.api(`/runs/${runId}/status`, body).catch((err: Error) => {
        console.error(`[runner] status post falló (intento ${attempt}/${STATUS_POST_ATTEMPTS}): ${err.message}`);
        return null;
      });
      // 409 = el server ya cerró el run (cancel del usuario, sweeper): benigno.
      if (res && (res.ok || res.status === HTTP_CONFLICT)) return;
      if (res && !isTransient(res.status)) {
        console.error(`[runner] status post rechazado: http ${res.status} ${await res.text().catch(() => '')}`);
        return;
      }
      if (res) console.error(`[runner] status post: http ${res.status} (intento ${attempt}/${STATUS_POST_ATTEMPTS})`);
      if (attempt < STATUS_POST_ATTEMPTS) await sleep(STATUS_POST_BACKOFF_MS * 2 ** (attempt - 1));
    }
    console.error(`[runner] status del run ${runId} sin entregar: el server lo cerrará por inactividad`);
  }
}
