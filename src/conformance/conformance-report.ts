// el informe del arnés de conformidad (t#440 P6): lo que imprime `duckhunt-runner conformance <backend>`. una cabecera
// con qué se midió, la tabla sonda · esperado · observado · veredicto, el estado de cada atestación con sus sondas y los
// avisos. sin rutas del canario: cada fichero sale por su etiqueta (~/.codex/auth.json), así se puede pegar en un informe.

import { ATTESTATION_STATUS, type AttestationStatus } from '../backends/attestation-evidence.js';
import type { ConformanceRecord } from './run-conformance.js';
import { VERDICT, type ProbeOutcome } from './verdict.js';

const COLUMNS = ['sonda', 'esperado', 'observado', 'veredicto'] as const;
const COLUMN_GAP = '  ';
const SHA_SHOWN_CHARS = 12;
const STATUS_TEXT: Readonly<Record<AttestationStatus, string>> = {
  [ATTESTATION_STATUS.proven]: 'demostrada',
  [ATTESTATION_STATUS.refuted]: 'refutada',
  [ATTESTATION_STATUS.unmeasured]: 'sin medir',
  [ATTESTATION_STATUS.unprobed]: 'sin sonda',
};

/** las filas de la tabla en columnas alineadas (la última sin relleno). */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join(COLUMN_GAP).trimEnd());
}

const row = (o: ProbeOutcome): string[] => [o.id, o.expected, o.observed, o.verdict];

/** ¿hay algo que no cuadra? un FAIL (garantía rota sin hueco conocido) o un ERROR (no se pudo medir). */
export const hasProblems = (results: readonly ProbeOutcome[]): boolean => results.some((r) => r.verdict === VERDICT.fail || r.verdict === VERDICT.error);

/** las líneas del informe de un registro (ver cabecera). `cached` = la medida salió de la caché. */
export function reportLines(r: ConformanceRecord, cached: boolean): string[] {
  const when = new Date(r.at).toISOString();
  const attWidth = Math.max(...r.attestations.map((a) => a.id.length));
  const statusWidth = Math.max(...Object.values(STATUS_TEXT).map((s) => s.length));
  const xpass = r.results.filter((o) => o.verdict === VERDICT.xpass);
  return [
    `${r.backend} ${r.cli.version} · sha256 ${r.cli.sha256.slice(0, SHA_SHOWN_CHARS)}… · ${r.os} · arnés ${r.harness} · ${when}${cached ? ' (de la caché: --refresh para volver a medir)' : ''}`,
    '',
    ...table([COLUMNS, ...r.results.map(row)]),
    '',
    'atestaciones:',
    ...r.attestations.map((a) => `  ${a.id.padEnd(attWidth)}  ${STATUS_TEXT[a.status].padEnd(statusWidth)}${a.probes.length > 0 ? `  ${a.probes.join(', ')}` : ''}`.trimEnd()),
    ...(xpass.length > 0 ? ['', `hueco conocido que ya no se abre (¿se cerró? revisa su expectativa): ${xpass.map((o) => `${o.id} (${o.gap})`).join(', ')}`] : []),
    ...(r.notes.length > 0 ? ['', 'avisos:', ...r.notes.map((n) => `  - ${n}`)] : []),
  ];
}
