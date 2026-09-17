// loop del daemon (contrato 42): reclama runs por poll, lanza `claude -p` headless en el
// checkout del repo (o en el scratch dir si no hay repo) con el mcp de duckhunt adjunto y el
// perfil de tools del claim, y reporta el cierre. un run a la vez: el cómputo es la máquina del
// usuario. el server nunca ve paths ni perfiles — el mapa repo→checkout y cuenta→perfil vive
// en la config local.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { refreshAccess, type AccessState } from './oauth.js';
import { logsDir, scratchDir, type RepoConfig, type RunnerConfig } from './config.js';
import { consumeStreamLine, detectClaude, newStreamState, type ClaudeInfo, type StreamState } from './claude.js';

const execFileP = promisify(execFile);

const CLAIM_POLL_MS = 5_000;
// margen para refrescar el access token del daemon antes de que caduque.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// SIGTERM → SIGKILL si el proceso no muere en este margen.
const KILL_GRACE_MS = 10_000;
// throttle del reporte de tool calls al server.
const PROGRESS_MIN_INTERVAL_MS = 5_000;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_CHARS = 4000;

interface ClaimedRun {
  id: number;
  kind: 'investigate' | 'resume';
  entryId: number;
  workspaceId: number;
  repo: string | null;
  branch: string | null;
  repoSource: string;
  repoAvailable: boolean;
  aws: { accountId: string | null; region: string | null } | null;
  sessionId: string | null;
  parentRunId: number | null;
}

interface ClaimResponse {
  run: ClaimedRun;
  prompt: string;
  fallbackPrompt: string | null;
  // tier del perfil que compuso el server (investigate|act|world). informativo: quien acota de
  // verdad es tools.allowed, pero saberlo en el log explica por qué un run no pudo escribir.
  tier?: string;
  tools: { allowed: string[]; disallowed: string[] };
  permissionMode: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  heartbeatMs: number;
  mcp: { serverName: string; url: string; token: string; expiresAt: number };
}

type RunStatus = 'done' | 'failed' | 'canceled';

interface StatusReport {
  status: RunStatus;
  result?: string;
  error?: string;
  costUsd?: number;
  numTurns?: number;
  toolCalls?: number;
  sessionId?: string;
  model?: string;
  resumed?: boolean;
  stderrTail?: string;
}

// resultado de una ejecución de claude (un intento).
interface Attempt {
  exitCode: number | null;
  killedBy: 'cancel' | 'timeout' | null;
  stream: StreamState;
  stderrTail: string;
}

export interface DaemonOptions {
  verboseLog?: boolean;
}

export class RunnerDaemon {
  private access: AccessState | null = null;
  private claude: ClaudeInfo = { version: null, supported: new Set() };
  private hasAws = false;

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly opts: DaemonOptions = {},
  ) {}

  private async accessToken(): Promise<string> {
    if (!this.access || this.access.expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      this.access = await refreshAccess(this.cfg);
    }
    return this.access.token;
  }

  // fetch autenticado contra /api/runner con un reintento tras refresh en 401.
  private async api(pathname: string, body?: unknown): Promise<Response> {
    const call = async (): Promise<Response> =>
      fetch(`${this.cfg.baseUrl}/api/runner${pathname}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? '{}' : JSON.stringify(body),
      });
    const first = await call();
    if (first.status !== 401) return first;
    this.access = null;
    return call();
  }

  private label(): string {
    return this.cfg.label ?? os.hostname();
  }

  /** loop principal: claim → ejecutar → repetir. nunca retorna (ctrl-c para salir). */
  async run(): Promise<never> {
    this.claude = await detectClaude();
    if (!this.claude.version) {
      throw new Error('no se encuentra `claude` en el PATH: instala claude code y haz login antes de arrancar el daemon');
    }
    this.hasAws = await execFileP('aws', ['--version']).then(() => true).catch(() => false);
    console.log(
      `[runner] ${this.label()} → ${this.cfg.baseUrl} (claude ${this.claude.version}, aws cli ${this.hasAws ? 'sí' : 'no'}, ${Object.keys(this.cfg.repos).length} repos, ${Object.keys(this.cfg.aws).length} cuentas aws, poll ${CLAIM_POLL_MS / 1000}s)`,
    );
    for (;;) {
      let claim: ClaimResponse | null = null;
      try {
        const res = await this.api('/claim', {
          runnerLabel: this.label(),
          repos: Object.keys(this.cfg.repos),
          awsAccounts: Object.keys(this.cfg.aws),
          capabilities: this.hasAws ? ['aws'] : [],
        });
        if (res.status === 200) claim = (await res.json()) as ClaimResponse;
        else if (res.status !== 204) {
          console.error(`[runner] claim falló: http ${res.status} ${await res.text().catch(() => '')}`);
        }
      } catch (err) {
        console.error(`[runner] claim inaccesible: ${(err as Error).message}`);
      }
      if (claim) {
        await this.executeRun(claim).catch((err) => {
          console.error(`[runner] run ${claim.run.id} reventó: ${(err as Error).message}`);
        });
      } else {
        await new Promise((r) => setTimeout(r, CLAIM_POLL_MS));
      }
    }
  }

  // --- cwd del run: checkout mapeado (worktree opcional) o scratch fijo ---

  private async prepareWorkdir(run: ClaimedRun): Promise<{ workdir: string; repoCfg: RepoConfig | null; worktree: string | null; note: string | null }> {
    const repoCfg = run.repo ? this.cfg.repos[run.repo] ?? null : null;
    if (!repoCfg) {
      const note = run.repo ? `repo ${run.repo} no mapeado en este runner: corriendo en scratch` : null;
      return { workdir: scratchDir(), repoCfg: null, worktree: null, note };
    }
    if (!fs.existsSync(repoCfg.path)) {
      return { workdir: scratchDir(), repoCfg: null, worktree: null, note: `checkout de ${run.repo} no existe (${repoCfg.path}): corriendo en scratch` };
    }
    if (repoCfg.worktree === false) return { workdir: repoCfg.path, repoCfg, worktree: null, note: null };
    // aislamiento: worktree git detached por run. la branch del run si existe (local u origin);
    // si no, HEAD. en done se borra; en failed se conserva para autopsia.
    const worktree = path.join(repoCfg.path, '.duckhunt', 'worktrees', `run-${run.id}`);
    const refs = run.branch ? [run.branch, `origin/${run.branch}`, 'HEAD'] : ['HEAD'];
    let lastErr: Error | null = null;
    for (const ref of refs) {
      try {
        await execFileP('git', ['worktree', 'add', '--detach', worktree, ref], { cwd: repoCfg.path });
        const note = run.branch && ref === 'HEAD' ? `branch ${run.branch} no existe localmente: worktree sobre HEAD` : null;
        return { workdir: worktree, repoCfg, worktree, note };
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw new Error(`git worktree add falló: ${lastErr?.message ?? 'desconocido'}`);
  }

  private async removeWorktree(repoPath: string, worktree: string): Promise<void> {
    await execFileP('git', ['worktree', 'remove', '--force', worktree], { cwd: repoPath }).catch((err) => {
      console.error(`[runner] limpieza del worktree falló: ${(err as Error).message}`);
    });
  }

  // --- env del run: el del usuario + perfil aws mapeado ---

  private envFor(run: ClaimedRun): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_PAGER: '' };
    const account = run.aws?.accountId ? this.cfg.aws[run.aws.accountId] : undefined;
    if (account) {
      env.AWS_PROFILE = account.profile;
      const region = account.region ?? run.aws?.region ?? undefined;
      if (region) env.AWS_DEFAULT_REGION = region;
    } else if (run.aws?.region) {
      env.AWS_DEFAULT_REGION = run.aws.region;
    }
    return env;
  }

  // --- args de claude ---

  private claudeArgs(claim: ClaimResponse, prompt: string, mcpFile: string, repoCfg: RepoConfig | null, resumeSessionId: string | null): string[] {
    const has = (f: string): boolean => this.claude.supported.has(f as never);
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (has('--verbose')) args.push('--verbose');
    args.push('--mcp-config', mcpFile);
    if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (claim.tools.allowed.length > 0) args.push('--allowedTools', claim.tools.allowed.join(','));
    if (has('--disallowedTools') && claim.tools.disallowed.length > 0) args.push('--disallowedTools', claim.tools.disallowed.join(','));
    if (has('--permission-mode') && claim.permissionMode) args.push('--permission-mode', claim.permissionMode);
    if (has('--max-turns') && claim.maxTurns > 0) args.push('--max-turns', String(claim.maxTurns));
    // presupuesto: solo tiene sentido cuando el coste es REAL (api key). con login de
    // suscripción el cli lo aplicaría sobre un coste nominal que nadie paga y mata runs
    // legítimos (el guard contra loops es el timeout). config manda: número = forzar, 0 = nunca.
    const payingWithApiKey = !!process.env.ANTHROPIC_API_KEY;
    const budget = this.cfg.defaults.maxBudgetUsd ?? (payingWithApiKey ? claim.maxBudgetUsd : 0);
    if (has('--max-budget-usd') && budget > 0) args.push('--max-budget-usd', String(budget));
    if (this.cfg.defaults.model) args.push('--model', this.cfg.defaults.model);
    if (repoCfg?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    return args;
  }

  // --- ejecución ---

  private async executeRun(claim: ClaimResponse): Promise<void> {
    const { run } = claim;
    console.log(
      `[runner] run ${run.id} reclamado (${run.kind}, entry ${run.entryId}${claim.tier ? `, tier ${claim.tier}` : ''}${run.repo ? `, repo ${run.repo}` : ''}${run.sessionId ? `, sesión ${run.sessionId}` : ''})`,
    );

    let prepared: Awaited<ReturnType<RunnerDaemon['prepareWorkdir']>>;
    try {
      prepared = await this.prepareWorkdir(run);
    } catch (err) {
      await this.postStatus(run.id, { status: 'failed', error: (err as Error).message });
      return;
    }
    if (prepared.note) console.log(`[runner] run ${run.id}: ${prepared.note}`);

    // mcp-config temporal con el token per-run (0600; se borra al terminar).
    const mcpFile = path.join(os.tmpdir(), `duckhunt-runner-${run.id}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          [claim.mcp.serverName]: { type: 'http', url: claim.mcp.url, headers: { Authorization: `Bearer ${claim.mcp.token}` } },
        },
      }),
      { mode: 0o600 },
    );

    const env = this.envFor(run);
    let report: StatusReport;
    try {
      // reanudar o no lo decide el server: manda sessionId solo cuando hay sesión que retomar
      // (el run preguntó y ya le respondieron, o es la instrucción sobre un resultado anterior).
      const resume = run.sessionId;
      let attempt = await this.spawnClaude(claim, this.claudeArgs(claim, claim.prompt, mcpFile, prepared.repoCfg, resume), prepared.workdir, env);
      let resumed: boolean | undefined = resume ? true : undefined;
      // reanudación fallida antes de que el asistente hablara (sesión inexistente en esta
      // máquina, borrada, de otro daemon): un solo reintento desde cero con el prompt de respaldo.
      if (resume && attempt.killedBy === null && attempt.exitCode !== 0 && !attempt.stream.sawAssistant && claim.fallbackPrompt) {
        console.log(`[runner] run ${run.id}: la sesión ${resume} no se pudo reanudar; reintento sin --resume`);
        attempt = await this.spawnClaude(claim, this.claudeArgs(claim, claim.fallbackPrompt, mcpFile, prepared.repoCfg, null), prepared.workdir, env);
        resumed = false;
      }
      report = this.reportFor(attempt, resumed);
    } finally {
      fs.rmSync(mcpFile, { force: true });
    }

    await this.postStatus(run.id, report);
    if (prepared.worktree && prepared.repoCfg) {
      if (report.status === 'done') await this.removeWorktree(prepared.repoCfg.path, prepared.worktree);
      else console.log(`[runner] worktree conservado para autopsia: ${prepared.worktree}`);
    }
    console.log(`[runner] run ${run.id} terminado (${report.status}${report.error ? `: ${report.error}` : ''})`);
  }

  private reportFor(attempt: Attempt, resumed: boolean | undefined): StatusReport {
    const s = attempt.stream;
    const base: StatusReport = {
      status: 'failed',
      toolCalls: s.toolCalls,
      ...(s.result?.costUsd !== null && s.result?.costUsd !== undefined ? { costUsd: s.result.costUsd } : {}),
      ...(s.result?.numTurns !== null && s.result?.numTurns !== undefined ? { numTurns: s.result.numTurns } : {}),
      ...(s.result?.sessionId ?? s.sessionId ? { sessionId: (s.result?.sessionId ?? s.sessionId) as string } : {}),
      ...(s.result?.model ? { model: s.result.model } : {}),
      ...(resumed !== undefined ? { resumed } : {}),
      ...(attempt.stderrTail ? { stderrTail: attempt.stderrTail } : {}),
    };
    if (attempt.killedBy === 'cancel') return { ...base, status: 'canceled', error: 'cancelado desde el server' };
    if (attempt.killedBy === 'timeout') return { ...base, status: 'failed', error: 'timeout: el run superó el tiempo máximo' };
    if (attempt.exitCode === 0 && s.result && !s.result.isError) {
      return { ...base, status: 'done', ...(s.result.result ? { result: s.result.result } : {}) };
    }
    const budgetHit = s.result?.subtype === 'error_max_budget_usd';
    const reason = s.result?.isError
      ? `claude terminó con error (${s.result.subtype ?? 'error'})${budgetHit ? ' — presupuesto nominal agotado: sube defaults.maxBudgetUsd en ~/.duckhunt-runner.json (0 = sin límite)' : ''}${s.result.result ? `: ${s.result.result.slice(0, 500)}` : ''}`
      : `claude terminó con exit code ${attempt.exitCode}`;
    return { ...base, status: 'failed', error: reason };
  }

  // spawnea claude, consume stdout (stream-json) y stderr (tail), bombea heartbeat (soft-cancel)
  // y progreso, y aplica el timeout wall-clock. resuelve siempre (nunca rechaza).
  private spawnClaude(claim: ClaimResponse, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Attempt> {
    const runId = claim.run.id;
    return new Promise((resolve) => {
      const stream = newStreamState();
      const stderrTail: string[] = [];
      let killedBy: Attempt['killedBy'] = null;
      let killTimer: NodeJS.Timeout | null = null;
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
        child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ exitCode: null, killedBy: null, stream, stderrTail: `no se pudo lanzar claude: ${(err as Error).message}` });
        return;
      }

      const kill = (reason: NonNullable<Attempt['killedBy']>): void => {
        if (killedBy) return;
        killedBy = reason;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
      };

      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        consumeStreamLine(stream, line);
        if (logFile !== null) fs.writeSync(logFile, `${line}\n`);
      });
      readline.createInterface({ input: child.stderr! }).on('line', (line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        if (logFile !== null) fs.writeSync(logFile, `${JSON.stringify({ type: 'stderr', line })}\n`);
      });

      // heartbeat: transporta el soft-cancel del server.
      const heartbeat = setInterval(() => {
        void this.api(`/runs/${runId}/heartbeat`)
          .then(async (res) => {
            if (!res.ok) return;
            const body = (await res.json().catch(() => null)) as { cancel?: boolean } | null;
            if (body?.cancel) {
              console.log(`[runner] run ${runId} cancelado desde el server; deteniendo claude`);
              kill('cancel');
            }
          })
          .catch((err) => console.error(`[runner] heartbeat falló: ${(err as Error).message}`));
      }, Math.max(5_000, claim.heartbeatMs));

      // progreso: tool calls al server, throttled.
      let reportedToolCalls = 0;
      let lastProgressAt = 0;
      const progress = setInterval(() => {
        const now = Date.now();
        if (stream.toolCalls === reportedToolCalls || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
        reportedToolCalls = stream.toolCalls;
        lastProgressAt = now;
        void this.api(`/runs/${runId}/progress`, { toolCalls: reportedToolCalls }).catch((err) =>
          console.error(`[runner] progress falló: ${(err as Error).message}`),
        );
      }, 1_000);

      const timeout = setTimeout(() => {
        console.log(`[runner] run ${runId} superó ${Math.round(claim.timeoutMs / 1000)}s; deteniendo claude`);
        kill('timeout');
      }, Math.max(60_000, claim.timeoutMs));

      child.on('error', (err) => {
        stderrTail.push(`[runner] no se pudo lanzar claude: ${err.message}`);
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
        clearInterval(progress);
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (logFile !== null) fs.closeSync(logFile);
        resolve({ exitCode: code, killedBy, stream, stderrTail: stderrTail.join('\n').slice(-STDERR_TAIL_MAX_CHARS) });
      });
    });
  }

  private async postStatus(runId: number, report: StatusReport): Promise<void> {
    const res = await this.api(`/runs/${runId}/status`, report).catch((err) => {
      console.error(`[runner] status post falló: ${(err as Error).message}`);
      return null;
    });
    // 409 = el server ya cerró el run (cancel del usuario, sweeper): benigno.
    if (res && !res.ok && res.status !== 409) {
      console.error(`[runner] status post rechazado: http ${res.status} ${await res.text().catch(() => '')}`);
    }
  }
}
