// cierre de un segmento: traduce el resultado de un intento de `claude -p` al body de
// POST /api/runner/runs/:id/status y lo recorta a los topes del server (un result de más de 20k
// daba 400 y el run se quedaba colgado en running → lost → failed).

import { configPath } from './config.js';
import { maskSecrets } from './secret-mask.js';
import type { StreamState } from './claude.js';

// por qué el daemon mató al proceso: cancel del server, timeout wall clock o parada del daemon.
export type KillReason = 'cancel' | 'timeout' | 'shutdown';

export type RunStatus = 'done' | 'failed' | 'canceled';

export interface StatusReport {
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
  // segmento del claim: el server rechaza (409) el informe de un segmento que ya no es el suyo.
  segment?: number;
}

// resultado de una ejecución de claude (un intento).
export interface Attempt {
  exitCode: number | null;
  killedBy: KillReason | null;
  stream: StreamState;
  stderrTail: string;
}

// topes del zod de /status en el server (result 20k, error AGENT_RUN_ERROR_MAX_CHARS, sesión, modelo,
// stderr RUNNER_STDERR_TAIL_MAX_CHARS).
const RESULT_MAX_CHARS = 20_000;
const ERROR_MAX_CHARS = 2_000;
const SESSION_MAX_CHARS = 128;
const MODEL_MAX_CHARS = 80;
const STDERR_MAX_CHARS = 4_000;
// extracto del result de claude que acompaña a un error.
const ERROR_RESULT_EXCERPT_CHARS = 500;
const ELLIPSIS = '…';

const clipEnd = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}${ELLIPSIS}` : s);

/** body de /status para un intento; `resumed` = el segmento corrió con --resume (undefined = sin sesión). */
export function reportFor(attempt: Attempt, resumed: boolean | undefined): StatusReport {
  const s = attempt.stream;
  const sessionId = s.result?.sessionId ?? s.sessionId;
  const base: StatusReport = {
    status: 'failed',
    toolCalls: s.toolCalls,
    ...(s.result?.costUsd != null ? { costUsd: s.result.costUsd } : {}),
    ...(s.result?.numTurns != null ? { numTurns: s.result.numTurns } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(s.result?.model ? { model: s.result.model } : {}),
    ...(resumed !== undefined ? { resumed } : {}),
    ...(attempt.stderrTail ? { stderrTail: attempt.stderrTail } : {}),
  };
  if (attempt.killedBy === 'cancel') return { ...base, status: 'canceled', error: 'cancelado desde el server' };
  if (attempt.killedBy === 'timeout') return { ...base, status: 'failed', error: 'timeout: el run superó el tiempo máximo' };
  if (attempt.killedBy === 'shutdown') return { ...base, status: 'failed', error: 'el daemon se detuvo durante el run' };
  if (attempt.exitCode === 0 && s.result && !s.result.isError) {
    return { ...base, status: 'done', ...(s.result.result ? { result: s.result.result } : {}) };
  }
  const budgetHit = s.result?.subtype === 'error_max_budget_usd';
  const reason = s.result?.isError
    ? `claude terminó con error (${s.result.subtype ?? 'error'})${budgetHit ? ` — presupuesto nominal agotado: sube defaults.maxBudgetUsd en ${configPath()} (0 = sin límite)` : ''}${s.result.result ? `: ${s.result.result.slice(0, ERROR_RESULT_EXCERPT_CHARS)}` : ''}`
    : `claude terminó con exit code ${attempt.exitCode}`;
  return { ...base, status: 'failed', error: reason };
}

/**
 * enmascara secretos (el result, el error y el stderr acaban en notas y pushes; el server vuelve a
 * enmascarar) y recorta cada campo al tope del server: un 400 por longitud dejaría el run sin cerrar.
 */
export function clampReport(report: StatusReport): StatusReport {
  return {
    ...report,
    ...(report.result !== undefined ? { result: clipEnd(maskSecrets(report.result), RESULT_MAX_CHARS) } : {}),
    ...(report.error !== undefined ? { error: clipEnd(maskSecrets(report.error), ERROR_MAX_CHARS) || 'error' } : {}),
    ...(report.sessionId !== undefined ? { sessionId: report.sessionId.slice(0, SESSION_MAX_CHARS) } : {}),
    ...(report.model !== undefined ? { model: report.model.slice(0, MODEL_MAX_CHARS) } : {}),
    // del stderr interesa el final (donde está el error).
    ...(report.stderrTail !== undefined ? { stderrTail: maskSecrets(report.stderrTail).slice(-STDERR_MAX_CHARS) } : {}),
  };
}
