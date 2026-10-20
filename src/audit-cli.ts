// `duckhunt-runner audit [--platform <id>] [--since 7d|<fecha>] [--json]` (t#495, M6.6): la auditoría local de lo
// que esta máquina corrió para cada plataforma (audit.ts), en una tabla o en jsonl. solo lee: ni el daemon ni el
// server se enteran.

import { AUDIT_EVENT, DAY_MS, readAudit, type AuditRecord } from './audit.js';
import { PLATFORM_ID_RE } from './paths.js';

const FLAG = { platform: '--platform', since: '--since', json: '--json' } as const;
// flags que llevan un valor detrás.
const VALUED: ReadonlySet<string> = new Set([FLAG.platform, FLAG.since]);
const DEFAULT_SINCE_DAYS = 7;

const USAGE = `uso:
  duckhunt-runner audit [--platform <id>] [--since 7d|<fecha>] [--json]
  (por defecto los últimos ${DEFAULT_SINCE_DAYS} días de todas las plataformas; --since acepta <n>d o una fecha como 2026-10-01)
`;
const DAYS_RE = /^(\d+)d$/;
// herramientas que se enseñan por cierre en la tabla.
const TOP_TOOLS = 3;
const COLUMN_GAP = '  ';
const NONE = '—';
const USD_DECIMALS = 2;
const DATE_PART_PAD = 2;

/** desde cuándo: `<n>d` hacia atrás desde `now` o una fecha (local). null si no se entiende. */
export function parseSince(raw: string, now: number): number | null {
  const days = DAYS_RE.exec(raw);
  if (days) return now - Number(days[1]) * DAY_MS;
  const at = new Date(raw.includes('T') ? raw : `${raw}T00:00:00`).getTime();
  return Number.isNaN(at) ? null : at;
}

const pad = (n: number): string => String(n).padStart(DATE_PART_PAD, '0');
const when = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

// una fila de la tabla por registro: hora, plataforma, run, qué pasó, duración, grants, recortes, tools y coste.
function row(r: AuditRecord): string[] {
  const head = [when(r.at), r.platform, r.runId ?? NONE];
  if (r.event === AUDIT_EVENT.rejected) return [...head, `rechazado (${r.code})`, NONE, NONE, NONE, NONE, NONE];
  if (r.event === AUDIT_EVENT.claimed) {
    const grants = r.grants.map((g) => `${g.type}:${g.key ?? NONE}(${g.access})`).join(',') || NONE;
    return [...head, `reclamado${r.model ? ` · ${r.model}` : ''}`, NONE, grants, r.toolset?.narrowed.join(',') || NONE, NONE, NONE];
  }
  const tools =
    Object.entries(r.toolCalls.byTool)
      .slice(0, TOP_TOOLS)
      .map(([tool, n]) => `${tool}×${n}`)
      .join(',') || NONE;
  const outcome = `${r.outcome.status}${r.outcome.code ? ` (${r.outcome.code})` : ''}`;
  return [...head, outcome, seconds(r.durationMs), NONE, NONE, tools, r.costUsd === null ? NONE : r.costUsd.toFixed(USD_DECIMALS)];
}

/** la tabla de unos registros, con su cabecera y columnas alineadas. */
export function auditTable(records: readonly AuditRecord[]): string[] {
  const rows = [['hora', 'plataforma', 'run', 'qué', 'duración', 'grants', 'recortado', 'tools', 'usd'], ...records.map(row)];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join(COLUMN_GAP).trimEnd());
}

export function auditCommand(args: string[], now = Date.now()): void {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const known = new Set<string>(Object.values(FLAG));
  const platform = value(FLAG.platform);
  const sinceRaw = value(FLAG.since);
  const since = sinceRaw === undefined ? now - DEFAULT_SINCE_DAYS * DAY_MS : parseSince(sinceRaw, now);
  // un flag que no existe, o un valor suelto que no va detrás de un flag que lo lleve.
  const stray = args.filter((a, i) => (a.startsWith('--') ? !known.has(a) : !VALUED.has(args[i - 1] ?? '')));
  if (stray.length > 0 || since === null || (args.includes(FLAG.platform) && (platform === undefined || !PLATFORM_ID_RE.test(platform)))) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const records = readAudit(since, platform);
  if (args.includes(FLAG.json)) {
    records.forEach((r) => console.log(JSON.stringify(r)));
    return;
  }
  if (records.length === 0) {
    console.log('auditoría: nada en ese intervalo');
    return;
  }
  auditTable(records).forEach((line) => console.log(line));
}
