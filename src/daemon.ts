// loop del runner: reclama runs por poll, lanza `claude -p` headless con el mcp de
// duckhunt adjunto y relaya su stream-json como log append-only. un run a la vez
// (secuencial): el cómputo es la máquina del usuario, no un cluster. el server nunca
// ve paths — el mapa repo→checkout vive en la config local.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readlineSync from 'node:readline';
import { promisify } from 'node:util';
import { refreshAccess, type AccessState } from './oauth.js';
import type { RepoConfig, RunnerConfig } from './config.js';

const execFileP = promisify(execFile);

const CLAIM_POLL_MS = 5_000;
// margen para refrescar el access token del runner antes de que caduque.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// batching del log: flush por tamaño o por ventana.
const LOG_BATCH_MAX_LINES = 500;
const LOG_FLUSH_MS = 1_000;

interface ClaimedRun {
  id: number;
  targetId: number;
  workspaceId: number;
  repo: string | null;
  spec: string | null;
}

interface ClaimResponse {
  run: ClaimedRun;
  prompt: string;
  mcp: { url: string; token: string; expiresAt: number };
  heartbeatIntervalMs: number;
}

export class RunnerDaemon {
  private access: AccessState | null = null;

  constructor(private readonly cfg: RunnerConfig) {}

  private async accessToken(): Promise<string> {
    if (!this.access || this.access.expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      this.access = await refreshAccess(this.cfg);
    }
    return this.access.token;
  }

  // fetch autenticado contra /api/runner con un reintento tras refresh en 401
  // (token revocado o caducado fuera del margen).
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

  /** loop principal: claim → ejecutar → repetir. nunca retorna (ctrl-c para salir). */
  async run(): Promise<never> {
    console.log(`[runner] ${this.cfg.label ?? os.hostname()} → ${this.cfg.baseUrl} (poll ${CLAIM_POLL_MS / 1000}s)`);
    for (;;) {
      let claim: ClaimResponse | null = null;
      try {
        const res = await this.api('/claim', { runnerLabel: this.cfg.label ?? os.hostname() });
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

  private async executeRun(claim: ClaimResponse): Promise<void> {
    const { run, prompt, mcp } = claim;
    console.log(`[runner] run ${run.id} reclamado (target ${run.targetId}${run.repo ? `, repo ${run.repo}` : ''})`);

    // resolución repo→checkout: sin mapeo no hay dónde correr — failed con error claro.
    const repoCfg: RepoConfig | null = run.repo ? this.cfg.repos[run.repo] ?? null : null;
    if (run.repo && !repoCfg) {
      await this.postStatus(run.id, 'failed', `repo ${run.repo} no mapeado en la config del runner`);
      return;
    }
    const baseDir = repoCfg?.path ?? process.cwd();
    if (!fs.existsSync(baseDir)) {
      await this.postStatus(run.id, 'failed', `checkout no existe: config del runner apunta a un path inexistente`);
      return;
    }

    // aislamiento: worktree git por run (default; opt-out per-repo). detached sobre HEAD —
    // el agente crea su propia branch si la necesita. en done se borra; en failed se
    // conserva para autopsia.
    const useWorktree = repoCfg !== null && repoCfg.worktree !== false;
    let workdir = baseDir;
    if (useWorktree) {
      workdir = path.join(baseDir, '.duckhunt', 'worktrees', `run-${run.id}`);
      try {
        await execFileP('git', ['worktree', 'add', '--detach', workdir], { cwd: baseDir });
      } catch (err) {
        await this.postStatus(run.id, 'failed', `git worktree add falló: ${(err as Error).message}`);
        return;
      }
    }

    // mcp-config temporal con el token per-run (0600; se borra al terminar).
    const mcpFile = path.join(os.tmpdir(), `duckhunt-runner-${run.id}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          duckhunt: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
        },
      }),
      { mode: 0o600 },
    );

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', mcpFile,
      ...(repoCfg?.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
    ];

    let exitCode: number | null = null;
    try {
      exitCode = await this.spawnAndStream(run.id, claim.heartbeatIntervalMs, args, workdir);
    } finally {
      fs.rmSync(mcpFile, { force: true });
    }

    if (exitCode === 0) {
      // backstop: si el agente ya cerró via duckhunt-run-update, el 409 es benigno.
      await this.postStatus(run.id, 'done');
      if (useWorktree) {
        await execFileP('git', ['worktree', 'remove', '--force', workdir], { cwd: baseDir }).catch((err) => {
          console.error(`[runner] limpieza del worktree falló: ${(err as Error).message}`);
        });
      }
    } else {
      await this.postStatus(run.id, 'failed', `claude terminó con exit code ${exitCode}`);
      if (useWorktree) console.log(`[runner] worktree conservado para autopsia: ${workdir}`);
    }
    console.log(`[runner] run ${run.id} terminado (exit ${exitCode})`);
  }

  // spawnea claude y bombea stdout (stream-json → 'event') y stderr → log batches.
  // el heartbeat corre en paralelo; una respuesta `canceled` mata el proceso.
  private spawnAndStream(runId: number, heartbeatMs: number, args: string[], cwd: string): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let seq = 0;
      let batch: { seq: number; stream: string; text: string }[] = [];
      let flushTimer: NodeJS.Timeout | null = null;
      let flushing = Promise.resolve();

      const flush = (): void => {
        if (batch.length === 0) return;
        const lines = batch;
        batch = [];
        // serializa los posts (orden de seq) encadenando sobre la promesa anterior.
        flushing = flushing.then(async () => {
          const res = await this.api(`/runs/${runId}/log`, { lines }).catch((err) => {
            console.error(`[runner] log post falló: ${(err as Error).message}`);
            return null;
          });
          if (res && !res.ok && res.status !== 409) {
            console.error(`[runner] log post rechazado: http ${res.status}`);
          }
        });
      };
      const push = (stream: string, text: string): void => {
        batch.push({ seq: seq++, stream, text });
        if (batch.length >= LOG_BATCH_MAX_LINES) flush();
      };
      flushTimer = setInterval(flush, LOG_FLUSH_MS);

      readlineSync.createInterface({ input: child.stdout }).on('line', (l) => push('event', l));
      readlineSync.createInterface({ input: child.stderr }).on('line', (l) => push('stderr', l));

      const heartbeat = setInterval(() => {
        void this.api(`/runs/${runId}/heartbeat`)
          .then(async (res) => {
            if (!res.ok) return;
            const body = (await res.json().catch(() => null)) as { status?: string } | null;
            // soft-cancel: el server marcó canceled; matamos el child y el loop sigue.
            if (body?.status === 'canceled') {
              console.log(`[runner] run ${runId} cancelado desde el server; deteniendo claude`);
              child.kill('SIGTERM');
            }
          })
          .catch((err) => console.error(`[runner] heartbeat falló: ${(err as Error).message}`));
      }, heartbeatMs);

      child.on('error', (err) => {
        // claude no está en el PATH o no arranca: al log y a failed via exit handler.
        push('stderr', `[runner] no se pudo lanzar claude: ${err.message}`);
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
        if (flushTimer) clearInterval(flushTimer);
        flush();
        void flushing.then(() => resolve(code));
      });
    });
  }

  private async postStatus(runId: number, status: 'done' | 'failed', error?: string): Promise<void> {
    const res = await this.api(`/runs/${runId}/status`, { status, ...(error ? { error } : {}) }).catch((err) => {
      console.error(`[runner] status post falló: ${(err as Error).message}`);
      return null;
    });
    // 409 = el agente ya cerró su run via duckhunt-run-update (o el server lo canceló): benigno.
    if (res && !res.ok && res.status !== 409) {
      console.error(`[runner] status post rechazado: http ${res.status} ${await res.text().catch(() => '')}`);
    }
  }
}
