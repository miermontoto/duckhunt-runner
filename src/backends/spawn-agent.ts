// el proceso de un agente bajo vigilancia del daemon (t#440 P1): la mitad neutral de lo que era spawnClaude. el driver
// decide el ejecutable, sus argumentos, su env y si quiere stdin; aquí se lanza en su propio grupo de procesos, se ata
// al lease del run (cancelar, el timeout o parar el daemon matan también lo que lanzaron sus tools), se guarda la cola
// del stderr, se bombea el progreso y, con --verbose, se escribe el log crudo del run. lo que dice por stdout lo lee la
// sesión que abre el driver.
// decisiones:
// - si el run ya murió (cancelado o parado mientras esperaba turno) no se lanza nada.
// - el proceso que sale con algo en segundo plano reteniendo sus pipes deja de esperarse a los EXIT_DRAIN_MS.
// - resuelve siempre (nunca rechaza): un fallo al lanzar es un exit sin código con su motivo en el stderr.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { clip } from '../feed.js';
import { signalGroup, type RunLease } from '../run-lease.js';
import type { KillReason } from '../status-report.js';
import type { AgentStdin } from './agent-driver.js';

const KILL_GRACE_MS = 10_000;
// tras el exit, cuánto se espera a que cierren los pipes (algo en segundo plano puede retenerlos).
const EXIT_DRAIN_MS = 5_000;
const PROGRESS_MIN_INTERVAL_MS = 5_000;
const PROGRESS_TICK_MS = 1_000;
const MIN_RUN_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_CHARS = 4000;
// la nota de workdir del primer progreso de cada proceso.
const WORKDIR_MAX_CHARS = 300;

/** lo que el driver lanza. */
export interface AgentProcess {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  // stdin en pipe (sesión viva); si no, cerrado.
  stdin: boolean;
  timeoutMs: number;
}

/** lo que el driver hace con el proceso mientras vive. */
export interface ProcessSession {
  // una línea de stdout.
  line(text: string): void;
  // las tool calls que lleva el proceso (para el progreso).
  toolCalls(): number;
  // el proceso cerró sus pipes: lo último antes de resolver.
  closed(): void;
}

/** cómo acabó el proceso. */
export interface ProcessExit {
  exitCode: number | null;
  killedBy: KillReason | null;
  stderrTail: string;
}

/** lo del daemon que necesita la vigilancia. */
export interface ProcessIo {
  // prefijo del log del daemon (`[runner]` o `[runner:<plataforma>]`).
  readonly log: string;
  readonly runId: string;
  // la ruta del log crudo (--verbose), calculada al abrirlo; null = sin log.
  readonly verboseLog: (() => string) | null;
  // la nota de dónde trabaja el run (el primer progreso la lleva recortada).
  readonly workdir: string;
  progress(toolCalls: number, workdir?: string): void;
  // las tool calls con que empezó el turno en curso.
  toolCallsAt(): number;
}

/** lanza `proc` atado al lease y lo vigila hasta que cierra; `open` recibe su stdin y devuelve la sesión que lo lee. */
export function spawnAgent(proc: AgentProcess, lease: RunLease, io: ProcessIo, open: (stdin: AgentStdin) => ProcessSession): Promise<ProcessExit> {
  if (lease.killedBy) return Promise.resolve({ exitCode: null, killedBy: lease.killedBy, stderrTail: '' });
  return new Promise((resolve) => {
    const stderrTail: string[] = [];
    let killedBy: KillReason | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    let logFile: number | null = null;
    if (io.verboseLog !== null) {
      try {
        logFile = fs.openSync(io.verboseLog(), 'a');
      } catch (err) {
        console.error(`${io.log} no se pudo abrir el log del run: ${(err as Error).message}`);
      }
    }

    let child: ChildProcess;
    try {
      child = spawn(proc.command, proc.args, { cwd: proc.cwd, env: proc.env, stdio: [proc.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      if (logFile !== null) fs.closeSync(logFile);
      resolve({ exitCode: null, killedBy: null, stderrTail: `no se pudo lanzar ${proc.command}: ${(err as Error).message}` });
      return;
    }

    const kill = (reason: KillReason): void => {
      if (killedBy) return;
      killedBy = reason;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    lease.attach(child, kill);

    const session = open(proc.stdin ? (child.stdin ?? null) : null);
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      session.line(line);
      if (logFile !== null) fs.writeSync(logFile, `${line}\n`);
    });
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      if (logFile !== null) fs.writeSync(logFile, `${JSON.stringify({ type: 'stderr', line })}\n`);
    });

    // progreso: tool calls del segmento (throttled) + la nota de workdir en el primer envío.
    io.progress(0, clip(io.workdir, WORKDIR_MAX_CHARS));
    let reportedToolCalls = 0;
    let lastProgressAt = Date.now();
    const progress = setInterval(() => {
      const now = Date.now();
      // las del turno en curso (t#636, fase 3: el proceso puede haber partido turnos).
      const turnCalls = session.toolCalls() - io.toolCallsAt();
      if (turnCalls === reportedToolCalls || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
      reportedToolCalls = turnCalls;
      lastProgressAt = now;
      io.progress(reportedToolCalls);
    }, PROGRESS_TICK_MS);

    const timeout = setTimeout(
      () => {
        console.log(`${io.log} run ${io.runId} superó ${Math.round(proc.timeoutMs / 1000)}s; deteniendo ${proc.command}`);
        kill('timeout');
      },
      Math.max(MIN_RUN_TIMEOUT_MS, proc.timeoutMs),
    );

    child.on('error', (err) => {
      stderrTail.push(`[runner] no se pudo lanzar ${proc.command}: ${err.message}`);
    });
    child.on('exit', () => {
      // el proceso salió: si algo en background retiene sus pipes, se dejan de esperar.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, EXIT_DRAIN_MS);
    });
    child.on('close', (code) => {
      session.closed();
      clearInterval(progress);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (logFile !== null) fs.closeSync(logFile);
      lease.detach();
      resolve({ exitCode: code, killedBy, stderrTail: stderrTail.join('\n').slice(-STDERR_TAIL_MAX_CHARS) });
    });
  });
}
