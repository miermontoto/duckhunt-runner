// salud de las sesiones de navegador (t#495, M7): si la sesión que un run recibiría sirve para algo.
// - cada BROWSER_HEALTH_INTERVAL_MS, solo json (puro): sin fichero en el vault → missing; ilegible o sin forma de
//   storage state → invalid; con cookies en la allowlist y TODAS caducadas → expired.
// - logged_out, con `odysea probe` sobre la copia filtrada (la que vería el run) contra la url de probe de la sesión:
//   un 401/403 o acabar en la página de login. como mucho cada PROBE_INTERVAL_MS por sesión (abre un chromium), o
//   cuando se pide (`browser check`). un probe que no llegó a ejecutarse es unverifiable, que no bloquea.
// - sin odysea usable, tool_missing en todas.
// el detalle es local (cli y log): puede llevar rutas; lo que viaje a una plataforma será solo la clave y el tipo.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { originPatterns, vaultFileOf, type BrowserRef } from './config.js';
import { odyseaProbe, type OdyseaDetection, type ProbeResult } from './odysea-cli.js';
import { filterState, isExpired, parseStorageState, type StorageState } from './state-filter.js';

export const BROWSER_HEALTH = {
  missing: 'missing',
  invalid: 'invalid',
  expired: 'expired',
  loggedOut: 'logged_out',
  toolMissing: 'tool_missing',
  unverifiable: 'unverifiable',
} as const;
export type BrowserHealthKind = (typeof BROWSER_HEALTH)[keyof typeof BROWSER_HEALTH];

/** lo que deja a una sesión sin servir a un run. */
export const BLOCKING_BROWSER_HEALTH: ReadonlySet<BrowserHealthKind> = new Set([
  BROWSER_HEALTH.missing,
  BROWSER_HEALTH.invalid,
  BROWSER_HEALTH.expired,
  BROWSER_HEALTH.loggedOut,
  BROWSER_HEALTH.toolMissing,
]);

export const BROWSER_HEALTH_INTERVAL_MS = 10 * 60_000;
export const PROBE_INTERVAL_MS = 24 * 60 * 60_000;
const PROBE_COPY_PREFIX = '.probe-';
const PROBE_COPY_EXT = '.json';
const PROBE_RANDOM_BYTES = 4;
const PROBE_FILE_MODE = 0o600;

/** un aviso de la salud de una sesión (detalle solo local). */
export interface BrowserFinding {
  key: string;
  kind: BrowserHealthKind;
  detail: string;
}

/** cuándo probar una sesión: `force` siempre; si no, solo con probe y si toca. */
export const PROBE_MODE = { never: 'never', due: 'due', force: 'force' } as const;
export type ProbeMode = (typeof PROBE_MODE)[keyof typeof PROBE_MODE];

/** si toca el probe de una sesión (puro). */
export const probeDue = (lastAt: number | undefined, nowMs: number, mode: ProbeMode): boolean =>
  mode === PROBE_MODE.force || (mode === PROBE_MODE.due && (lastAt === undefined || nowMs - lastAt >= PROBE_INTERVAL_MS));

/** la salud de una sesión por su json (`text` null = sin fichero), y su copia filtrada si sirve. puro. */
export function stateHealth(key: string, ref: BrowserRef, text: string | null, nowMs: number): { findings: BrowserFinding[]; filtered: StorageState | null } {
  if (text === null) return { findings: [{ key, kind: BROWSER_HEALTH.missing, detail: `sin sesión guardada (\`duckhunt-runner browser login ${key} <url>\`)` }], filtered: null };
  let state: StorageState;
  try {
    state = parseStorageState(text);
  } catch (err) {
    return { findings: [{ key, kind: BROWSER_HEALTH.invalid, detail: `la sesión guardada no se puede leer: ${(err as Error).message}` }], filtered: null };
  }
  const patterns = originPatterns(ref);
  const inAllowlist = filterState(state, patterns, 0).cookies;
  const filtered = filterState(state, patterns, nowMs);
  const expired = inAllowlist.length > 0 && inAllowlist.every((c) => isExpired(c, nowMs));
  return {
    findings: expired ? [{ key, kind: BROWSER_HEALTH.expired, detail: `todas sus cookies de ${ref.origins.join(', ')} caducaron: vuelve a iniciar sesión` }] : [],
    filtered,
  };
}

// el probe de una sesión sobre su copia filtrada, en un fichero temporal del vault (privado) que se borra después.
async function probeFinding(key: string, ref: BrowserRef, filtered: StorageState, vaultDir: string, bin: string): Promise<BrowserFinding | null> {
  const probe = ref.probe!;
  const file = path.join(vaultDir, `${PROBE_COPY_PREFIX}${key}-${crypto.randomBytes(PROBE_RANDOM_BYTES).toString('hex')}${PROBE_COPY_EXT}`);
  let result: ProbeResult;
  try {
    fs.writeFileSync(file, JSON.stringify(filtered), { mode: PROBE_FILE_MODE, flag: 'wx' });
    result = await odyseaProbe(bin, file, probe.url, probe.loginPattern);
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (!result.ok) return { key, kind: BROWSER_HEALTH.unverifiable, detail: `el probe no pudo comprobarla: ${result.reason ?? '?'}` };
  return result.loggedOut ? { key, kind: BROWSER_HEALTH.loggedOut, detail: `la sesión ya no vale (${result.reason ?? 'sin motivo'}): vuelve a iniciar sesión` } : null;
}

/** lo que hace falta para medir la salud de las sesiones. `lastProbe` (clave → ms) se actualiza con los probes hechos. */
export interface BrowserHealthInput {
  entries: Readonly<Record<string, BrowserRef>>;
  vaultDir: string;
  odysea: OdyseaDetection;
  probe: ProbeMode;
  lastProbe: Map<string, number>;
  nowMs: number;
}

/** la salud de cada sesión (ver cabecera). nunca lanza por una sesión: lo suyo es un aviso. */
export async function browserHealth(input: BrowserHealthInput): Promise<BrowserFinding[]> {
  const { entries, vaultDir, odysea, probe, lastProbe, nowMs } = input;
  // i/o secuencial: un probe abre un chromium; de uno en uno.
  const findings: BrowserFinding[] = [];
  for (const [key, ref] of Object.entries(entries)) {
    if (!odysea.ok) {
      findings.push({ key, kind: BROWSER_HEALTH.toolMissing, detail: odysea.reason });
      continue;
    }
    const file = vaultFileOf(vaultDir, ref.session);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    const json = stateHealth(key, ref, text, nowMs);
    findings.push(...json.findings);
    if (json.findings.length > 0 || json.filtered === null || ref.probe === undefined || !probeDue(lastProbe.get(key), nowMs, probe)) continue;
    lastProbe.set(key, nowMs);
    const probed = await probeFinding(key, ref, json.filtered, vaultDir, odysea.info.bin);
    if (probed) findings.push(probed);
  }
  return findings;
}
