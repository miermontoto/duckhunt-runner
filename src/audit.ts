// auditoría local por plataforma (t#495, M6.6): qué le corrió esta máquina a cada plataforma, para el usuario y no
// para nadie más. <runnerHome>/audit/<id>/YYYY-MM.jsonl (mes local), ficheros 0600 en un directorio 0700, una línea
// por registro escrita con O_APPEND (< AUDIT_LINE_MAX_BYTES: el append de una línea no se intercala con otro).
// - registros: `claimed` (el run reclamado: tipo, modelo pedido, sha256 del prompt, grants, servidores mcp, toolset
//   pedido y aplicado con lo que el techo recortó, lo que el runner atestigua), `rejected` (un claim que no se
//   aceptó, con el código) y `closed` (cada segmento al cerrar: tiempos, espera de turno, lo materializado, modelo,
//   tool calls por nombre, coste y resultado con un código).
// - NUNCA el texto del prompt, el resultado, los argumentos de las tools, paths ni tokens: solo ids, claves de
//   recurso (ws/slug, cuenta aws), nombres (modelo, tools, servidores mcp) y números. test/audit.test.ts lo
//   comprueba contra un run de verdad.
// - retención: defaults.auditRetentionDays (por defecto AUDIT_RETENTION_DAYS_DEFAULT) y un tope de
//   AUDIT_PLATFORM_MAX_BYTES por plataforma (se van los meses más viejos; el actual nunca). se poda al arrancar y
//   una vez al día.
// - la cuota diaria de una plataforma (budgetUsdPerDay, runsPerDay) sale de aquí: los `claimed` y el coste de los
//   `closed` del día local. una sola fuente de verdad, también para `status --platforms` y `audit`.
// - escribir la auditoría nunca tumba un run: un fallo se dice en el log y el run sigue.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ClaimResponse } from './claim.js';
import { auditDir, auditPath, auditRoot, PLATFORM_ID_RE } from './paths.js';
import type { MaterializedSummary } from './resources/lifecycle.js';
import { ACCESS, type ResourceRequest } from './resources/types.js';
import type { StatusReport } from './status-report.js';
import type { ToolsetV1 } from './vendor/runner-protocol/index.js';

export const AUDIT_VERSION = 1;
export const AUDIT_EVENT = {
  claimed: 'claimed',
  rejected: 'rejected',
  closed: 'closed',
} as const;
export type AuditEvent = (typeof AUDIT_EVENT)[keyof typeof AUDIT_EVENT];

/** por qué acabó un segmento que no terminó bien (el `error` del status lleva texto libre: aquí solo el código). */
export const AUDIT_OUTCOME = {
  canceled: 'canceled',
  timeout: 'timeout',
  shutdown: 'shutdown',
  maxBudget: 'max_budget',
  backendError: 'backend_error',
  exitCode: 'exit_code',
  resourceUnavailable: 'resource_unavailable',
  runnerError: 'runner_error',
} as const;

export const AUDIT_LINE_MAX_BYTES = 4096;
export const AUDIT_RETENTION_DAYS_DEFAULT = 180;
export const AUDIT_PLATFORM_MAX_BYTES = 50 * 1024 * 1024;
export const DAY_MS = 86_400_000;
const AUDIT_FILE_MODE = 0o600;
const AUDIT_FILE_RE = /^(\d{4})-(\d{2})\.jsonl$/;
const AUDIT_FILE_EXT = '.jsonl';
const DATE_PART_PAD = 2;
// topes de lo que va en una línea: tools por nombre, elementos de una lista y largo de un nombre.
const BY_TOOL_MAX = 20;
const LIST_MAX = 16;
const NAME_MAX_CHARS = 80;
const PROMPT_HASH = 'sha256';
const BUDGET_EXHAUSTED_SUBTYPE = 'error_max_budget_usd';

export interface AuditGrant {
  type: string;
  key: string | null;
  access: string;
}

/** un toolset en la auditoría: sus flags y grants; de las tools de la plataforma, solo cuántas. */
export interface ToolsetSummary {
  shell: string;
  fsWrite: boolean;
  memory: boolean;
  web: boolean;
  vcsPush: boolean;
  grants: AuditGrant[];
  platformTools: number;
}

interface AuditBase {
  v: typeof AUDIT_VERSION;
  at: number;
  platform: string;
  protocol: string;
  runId: string | null;
  segment: number | null;
}

export interface ClaimedRecord extends AuditBase {
  event: typeof AUDIT_EVENT.claimed;
  kind: string;
  seed: string | null;
  profile: string | null;
  model: string | null;
  promptSha256: string;
  grants: AuditGrant[];
  mcpServers: string[];
  toolset: { requested: ToolsetSummary; effective: ToolsetSummary; narrowed: string[] } | null;
  attestations: string[];
}

export interface RejectedRecord extends AuditBase {
  event: typeof AUDIT_EVENT.rejected;
  code: string;
}

export interface ClosedRecord extends AuditBase {
  event: typeof AUDIT_EVENT.closed;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  lockWaitMs: number;
  materialized: MaterializedSummary[];
  model: string | null;
  toolCalls: { total: number; byTool: Record<string, number> };
  costUsd: number | null;
  numTurns: number | null;
  outcome: { status: string; code: string | null };
}

export type AuditRecord = ClaimedRecord | RejectedRecord | ClosedRecord;

const name = (s: string): string => s.slice(0, NAME_MAX_CHARS);
const grantOf = (g: { type: string; key: string | null; access?: string }): AuditGrant => ({ type: name(g.type), key: g.key === null ? null : name(g.key), access: g.access ?? ACCESS.read });

/** el resumen de un toolset para la auditoría. */
export const toolsetSummary = (t: ToolsetV1): ToolsetSummary => ({
  shell: t.shell,
  fsWrite: t.fsWrite,
  memory: t.memory,
  web: t.web,
  vcsPush: t.vcsPush,
  grants: t.grants.slice(0, LIST_MAX).map(grantOf),
  platformTools: t.platformTools.length,
});

/** lo que identifica a una plataforma y a su run en cada registro. */
export interface AuditSubject {
  platform: string;
  protocol: string;
  at: number;
}

const base = (s: AuditSubject, runId: string | null, segment: number | null): AuditBase => ({ v: AUDIT_VERSION, at: s.at, platform: s.platform, protocol: s.protocol, runId, segment });

/** registro de un run reclamado (ver cabecera: ni el prompt ni el token del mcp, solo el hash y los nombres). */
export function claimedRecord(
  s: AuditSubject,
  claim: ClaimResponse,
  a: { grants: readonly ResourceRequest[]; toolset: ClaimedRecord['toolset']; attestations: readonly string[] },
): ClaimedRecord {
  const { run } = claim;
  return {
    ...base(s, run.id, run.segment),
    event: AUDIT_EVENT.claimed,
    kind: name(run.kind),
    seed: run.seed,
    profile: run.profile,
    model: run.model === null ? null : name(run.model),
    promptSha256: createHash(PROMPT_HASH).update(claim.prompt).digest('hex'),
    grants: a.grants.slice(0, LIST_MAX).map(grantOf),
    mcpServers: [claim.mcp, ...(claim.extraMcp ?? [])].slice(0, LIST_MAX).map((m) => name(m.serverName)),
    toolset: a.toolset,
    attestations: a.attestations.slice(0, LIST_MAX).map(name),
  };
}

/** registro de un claim que no se aceptó. */
export const rejectedRecord = (s: AuditSubject, runId: string | null, code: string): RejectedRecord => ({ ...base(s, runId, null), event: AUDIT_EVENT.rejected, code: name(code) });

/** lo que se sabe del intento que cerró un segmento (claude.ts / status-report.ts), sin su salida. */
export interface AttemptFacts {
  killedBy: string | null;
  exitCode: number | null;
  isError: boolean;
  subtype: string | null;
}

/** el código de un segmento que no terminó bien (null si terminó bien). */
export function outcomeCode(status: StatusReport['status'], attempt: AttemptFacts | null): string | null {
  if (status === 'done') return null;
  if (status === 'canceled') return AUDIT_OUTCOME.canceled;
  if (attempt === null) return AUDIT_OUTCOME.runnerError;
  if (attempt.killedBy === 'timeout') return AUDIT_OUTCOME.timeout;
  if (attempt.killedBy === 'shutdown') return AUDIT_OUTCOME.shutdown;
  if (attempt.subtype === BUDGET_EXHAUSTED_SUBTYPE) return AUDIT_OUTCOME.maxBudget;
  return attempt.isError ? AUDIT_OUTCOME.backendError : AUDIT_OUTCOME.exitCode;
}

/** registro del cierre de un segmento. */
export function closedRecord(
  s: AuditSubject,
  claim: ClaimResponse,
  c: { startedAt: number; lockWaitMs: number; materialized: readonly MaterializedSummary[]; report: StatusReport; toolsByName: Readonly<Record<string, number>>; code: string | null },
): ClosedRecord {
  const byTool = Object.fromEntries(
    Object.entries(c.toolsByName)
      .sort(([, a], [, b]) => b - a)
      .slice(0, BY_TOOL_MAX)
      .map(([tool, n]) => [name(tool), n]),
  );
  return {
    ...base(s, claim.run.id, claim.run.segment),
    event: AUDIT_EVENT.closed,
    startedAt: c.startedAt,
    endedAt: s.at,
    durationMs: Math.max(0, s.at - c.startedAt),
    lockWaitMs: c.lockWaitMs,
    materialized: c.materialized.slice(0, LIST_MAX).map((m) => ({ ...m, type: name(m.type), key: m.key === null ? null : name(m.key) })),
    model: c.report.model === undefined ? null : name(c.report.model),
    toolCalls: { total: c.report.toolCalls ?? 0, byTool },
    costUsd: c.report.costUsd ?? null,
    numTurns: c.report.numTurns ?? null,
    outcome: { status: c.report.status, code: c.code },
  };
}

// lo que se va recortando, en orden, si una línea no cabe en AUDIT_LINE_MAX_BYTES.
const SHRINK: readonly ((r: AuditRecord) => AuditRecord)[] = [
  (r) => (r.event === AUDIT_EVENT.closed ? { ...r, toolCalls: { ...r.toolCalls, byTool: {} } } : r),
  (r) => (r.event === AUDIT_EVENT.claimed && r.toolset ? { ...r, toolset: { ...r.toolset, requested: { ...r.toolset.requested, grants: [] }, effective: { ...r.toolset.effective, grants: [] } } } : r),
  (r) => (r.event === AUDIT_EVENT.claimed ? { ...r, grants: [], mcpServers: [], attestations: [] } : r.event === AUDIT_EVENT.closed ? { ...r, materialized: [] } : r),
  (r) => (r.event === AUDIT_EVENT.claimed ? { ...r, toolset: null } : r),
];

/** la línea jsonl de un registro, recortada hasta caber en AUDIT_LINE_MAX_BYTES (nunca se parte). */
export function auditLine(record: AuditRecord): string {
  const fits = (r: AuditRecord): boolean => Buffer.byteLength(`${JSON.stringify(r)}\n`) <= AUDIT_LINE_MAX_BYTES;
  const shrunk = SHRINK.reduce((r, step) => (fits(r) ? r : step(r)), record);
  return `${JSON.stringify(shrunk)}\n`;
}

const pad = (n: number): string => String(n).padStart(DATE_PART_PAD, '0');
/** el mes local de un instante (el nombre de su fichero). */
export const monthOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
/** el día local de un instante (la cuota diaria). */
export const dayOf = (at: number): string => `${monthOf(at)}-${pad(new Date(at).getDate())}`;
/** la siguiente medianoche local tras un instante. */
export const nextMidnight = (at: number): number => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/** lo gastado por una plataforma en un día: segmentos reclamados y coste de los cerrados. */
export interface DayUsage {
  runs: number;
  costUsd: number;
}

const usageOf = (records: readonly AuditRecord[]): DayUsage => ({
  runs: records.filter((r) => r.event === AUDIT_EVENT.claimed).length,
  costUsd: records.reduce((sum, r) => sum + (r.event === AUDIT_EVENT.closed ? (r.costUsd ?? 0) : 0), 0),
});

// los registros de un fichero (las líneas que no son un registro se saltan: un fichero a medio escribir).
function readFile(file: string): AuditRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').flatMap((line) => {
    if (!line) return [];
    try {
      const r = JSON.parse(line) as AuditRecord;
      return r && r.v === AUDIT_VERSION && typeof r.at === 'number' ? [r] : [];
    } catch {
      return [];
    }
  });
}

// las plataformas con auditoría en disco.
function auditedPlatforms(): string[] {
  try {
    return fs
      .readdirSync(auditRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && PLATFORM_ID_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// los ficheros de mes de una plataforma, del más viejo al más nuevo.
function monthFiles(platform: string): string[] {
  try {
    return fs
      .readdirSync(auditPath(platform))
      .filter((f) => AUDIT_FILE_RE.test(f))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** los registros desde `since` (de una plataforma o de todas), en orden de tiempo. solo lee. */
export function readAudit(since: number, platform?: string): AuditRecord[] {
  const fromMonth = monthOf(since);
  return (platform === undefined ? auditedPlatforms() : [platform])
    .flatMap((id) => monthFiles(id).filter((f) => f.slice(0, -AUDIT_FILE_EXT.length) >= fromMonth).flatMap((f) => readFile(path.join(auditPath(id), f))))
    .filter((r) => r.at >= since)
    .sort((a, b) => a.at - b.at);
}

/** lo gastado por una plataforma el día local de `now`, leído de su auditoría. */
export const dayUsage = (platform: string, now: number): DayUsage => {
  const day = dayOf(now);
  return usageOf(readFile(path.join(auditPath(platform), `${monthOf(now)}${AUDIT_FILE_EXT}`)).filter((r) => dayOf(r.at) === day));
};

/** días de retención: defaults.auditRetentionDays si es un entero positivo; si no, el de por defecto. */
export const retentionDays = (configured: unknown): number => (typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0 ? configured : AUDIT_RETENTION_DAYS_DEFAULT);

/**
 * poda la auditoría de todas las plataformas: los meses que acabaron antes de `retention` días y, por encima de
 * `maxBytes` por plataforma, los más viejos (el mes más nuevo nunca). devuelve cuántos ficheros borró.
 */
export function pruneAudit(now: number, retention: number, maxBytes = AUDIT_PLATFORM_MAX_BYTES): number {
  const cutoff = now - retention * DAY_MS;
  // el primer instante del mes siguiente al de un fichero: si ya pasó el corte, el mes entero caducó.
  const monthEnd = (file: string): number => {
    const [, year, month] = AUDIT_FILE_RE.exec(file)!;
    return new Date(Number(year), Number(month), 1).getTime();
  };
  return auditedPlatforms().reduce((removed, id) => {
    const dir = auditPath(id);
    const expired = monthFiles(id).filter((f, i, all) => i < all.length - 1 && monthEnd(f) <= cutoff);
    expired.forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
    const kept = monthFiles(id).map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }));
    const total = kept.reduce((n, k) => n + k.size, 0);
    // los más viejos fuera mientras se pase del tope, sin tocar el último.
    const overflow = kept.slice(0, -1).reduce<{ left: number; files: string[] }>((acc, k) => (acc.left > maxBytes ? { left: acc.left - k.size, files: [...acc.files, k.f] } : acc), { left: total, files: [] });
    overflow.files.forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
    return removed + expired.length + overflow.files.length;
  }, 0);
}

/**
 * escritor de la auditoría del daemon, con lo gastado hoy por plataforma en memoria (se lee del fichero una vez por
 * día y se suma con cada registro que escribe este proceso).
 */
export class AuditLog {
  private readonly today = new Map<string, { day: string; usage: DayUsage }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** añade un registro a la auditoría de su plataforma (0600, O_APPEND). nunca lanza. */
  append(record: AuditRecord): void {
    try {
      const file = path.join(auditDir(record.platform), `${monthOf(record.at)}${AUDIT_FILE_EXT}`);
      fs.appendFileSync(file, auditLine(record), { mode: AUDIT_FILE_MODE });
      const cached = this.today.get(record.platform);
      if (cached && cached.day === dayOf(record.at)) {
        const added = usageOf([record]);
        cached.usage = { runs: cached.usage.runs + added.runs, costUsd: cached.usage.costUsd + added.costUsd };
      }
    } catch (err) {
      console.error(`[runner] auditoría de ${record.platform}: no se pudo escribir: ${(err as Error).message}`);
    }
  }

  /** lo gastado hoy (día local) por una plataforma. */
  usageToday(platform: string): DayUsage {
    const now = this.now();
    const day = dayOf(now);
    const cached = this.today.get(platform);
    if (cached && cached.day === day) return cached.usage;
    let usage: DayUsage;
    try {
      usage = dayUsage(platform, now);
    } catch (err) {
      console.error(`[runner] auditoría de ${platform}: no se pudo leer: ${(err as Error).message}`);
      usage = { runs: 0, costUsd: 0 };
    }
    this.today.set(platform, { day, usage });
    return usage;
  }
}
