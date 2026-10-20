// odysea desde el runner (t#495, M7): el navegador de los runs es el binario `odysea`, nunca playwright importado aquí
// (el daemon sigue sin dependencias de runtime). de su cli se usa:
// - `odysea --version`: la versión, que tiene que ser al menos MIN_ODYSEA_VERSION (la del modo fichero único, la
//   allowlist de orígenes, el autosave y `login`/`probe`).
// - `odysea login --state-file <f> --url <u>`: un navegador visible para que la persona inicie sesión; guarda al pulsar
//   enter (exit 0) o deja el último autosave si cierra la ventana antes (exit LOGIN_ABORTED).
// - `odysea probe --state-file <f> --url <u> [--login-pattern <re>]`: headless, sin escribir el fichero; una línea
//   json en stdout (ok, status, finalUrl, loggedOut, reason). finalUrl puede llevar query: nunca se enseña.
// el binario sale de providers.browser.bin o, sin él, del PATH.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const ODYSEA_BIN = 'odysea';
// la primera con ODYSEA_STATE_FILE, ODYSEA_ALLOWED_ORIGINS, ODYSEA_SESSION_TOOL, ODYSEA_AUTOSAVE_MS, login y probe.
export const MIN_ODYSEA_VERSION = '0.5.0';
// exit codes de `odysea login` (odysea/src/constants.ts::EXIT_CODE).
export const ODYSEA_LOGIN_EXIT = { ok: 0, aborted: 3 } as const;
const VERSION_FLAG = '--version';
const VERSION_TIMEOUT_MS = 10_000;
// el probe arranca un chromium headless y navega: margen amplio, pero acotado.
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_MAX_BUFFER = 1024 * 1024;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

/** odysea encontrado y con versión suficiente. */
export interface OdyseaInfo {
  bin: string;
  version: string;
}

/** por qué no hay odysea usable (para `browser check` y la salud). */
export type OdyseaDetection = { ok: true; info: OdyseaInfo } | { ok: false; reason: string };

/** lo que contesta `odysea probe`. */
export interface ProbeResult {
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  loggedOut: boolean;
  reason: string | null;
}

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** la ruta del binario: el de la config si es ejecutable, o el primero del PATH; null si no hay. */
export function findOdysea(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (configured !== undefined) return isExecutable(configured) ? configured : null;
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, ODYSEA_BIN)).find(isExecutable) ?? null;
}

/** `a` es al menos `min` (x.y.z; lo que no lo parece, nunca). */
export function versionAtLeast(a: string, min: string): boolean {
  const [va, vm] = [SEMVER_RE.exec(a.trim()), SEMVER_RE.exec(min)];
  if (!va || !vm) return false;
  const diff = [1, 2, 3].map((i) => Number(va[i]) - Number(vm[i])).find((d) => d !== 0) ?? 0;
  return diff >= 0;
}

/** busca odysea y comprueba su versión. */
export async function detectOdysea(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<OdyseaDetection> {
  const bin = findOdysea(configured, env);
  if (bin === null) return { ok: false, reason: configured !== undefined ? `${configured} no es un ejecutable` : `\`${ODYSEA_BIN}\` no está en el PATH` };
  let version: string;
  try {
    version = (await execFileP(bin, [VERSION_FLAG], { encoding: 'utf-8', timeout: VERSION_TIMEOUT_MS })).stdout.trim();
  } catch (err) {
    return { ok: false, reason: `${bin} ${VERSION_FLAG} falló: ${(err as Error).message}` };
  }
  if (!versionAtLeast(version, MIN_ODYSEA_VERSION)) return { ok: false, reason: `odysea ${version || '?'}: hace falta ${MIN_ODYSEA_VERSION} o posterior` };
  return { ok: true, info: { bin, version } };
}

/** `odysea login` con la terminal de la persona; devuelve su exit code (null si no se pudo lanzar o murió por señal). */
export function odyseaLogin(bin: string, stateFile: string, url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['login', '--state-file', stateFile, '--url', url], { stdio: 'inherit' });
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
}

const isProbeResult = (v: unknown): v is ProbeResult =>
  typeof v === 'object' && v !== null && typeof (v as ProbeResult).ok === 'boolean' && typeof (v as ProbeResult).loggedOut === 'boolean';

// la última línea json de la salida del probe, o null.
function probeLine(stdout: string): ProbeResult | null {
  const line = stdout.trim().split('\n').at(-1);
  try {
    const parsed: unknown = line ? JSON.parse(line) : null;
    return isProbeResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `odysea probe` sobre un storage state; un probe que no pudo ejecutarse sale con ok:false y su motivo. */
export async function odyseaProbe(bin: string, stateFile: string, url: string, loginPattern?: string): Promise<ProbeResult> {
  const args = ['probe', '--state-file', stateFile, '--url', url, ...(loginPattern !== undefined ? ['--login-pattern', loginPattern] : [])];
  const failed = (reason: string): ProbeResult => ({ ok: false, status: null, finalUrl: null, loggedOut: false, reason });
  try {
    const { stdout } = await execFileP(bin, args, { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER });
    return probeLine(stdout) ?? failed('el probe no devolvió una línea json');
  } catch (err) {
    // exit != 0: odysea igual imprime su línea (ok:false con el motivo).
    const stdout = (err as { stdout?: string }).stdout;
    return (typeof stdout === 'string' ? probeLine(stdout) : null) ?? failed((err as Error).message);
  }
}
