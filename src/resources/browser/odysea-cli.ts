// odysea desde el runner (t#495, M7): el navegador de los runs es el binario `odysea`, nunca playwright importado aquí
// (el daemon sigue sin dependencias de runtime). de su cli se usa:
// - `odysea --identify`: una línea json {name, tool, protocol, version}. solo se usa un binario que dice ser
//   ODYSEA_PACKAGE (en npm, `odysea` a secas es otro proyecto), con un protocolo (el contrato de las env vars y de
//   `login`/`probe`) que este runner habla y al menos MIN_ODYSEA_VERSION. evita coger por accidente otro `odysea`
//   del PATH; no protege de un binario hecho a propósito para hacerse pasar por él (lo del PATH ya corre como tú).
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
// el paquete de npm y la tool que contesta `--identify` (odysea/src/constants.ts::PACKAGE_NAME, TOOL_NAME).
export const ODYSEA_PACKAGE = '@miermontoto/odysea';
export const ODYSEA_TOOL = 'odysea';
// contrato de cara al runner (ODYSEA_STATE_FILE, ODYSEA_ALLOWED_ORIGINS, ODYSEA_SESSION_TOOL, ODYSEA_AUTOSAVE_MS, login
// y probe): el mínimo que este runner habla (odysea/src/constants.ts::PROTOCOL).
export const ODYSEA_PROTOCOL_MIN = 1;
// la primera con `--identify` (y con todo lo del contrato 1).
export const MIN_ODYSEA_VERSION = '0.5.1';
// exit codes de `odysea login` (odysea/src/constants.ts::EXIT_CODE).
export const ODYSEA_LOGIN_EXIT = { ok: 0, aborted: 3 } as const;
const IDENTIFY_FLAG = '--identify';
const IDENTIFY_TIMEOUT_MS = 10_000;
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

/** lo que contesta `odysea --identify`. */
interface OdyseaIdentity {
  name: string;
  tool: string;
  protocol: number;
  version: string;
}

const isIdentity = (v: unknown): v is OdyseaIdentity => {
  const o = v as Partial<OdyseaIdentity> | null;
  return typeof o === 'object' && o !== null && typeof o.name === 'string' && typeof o.tool === 'string' && Number.isInteger(o.protocol) && typeof o.version === 'string';
};

// la identidad de la última línea de la salida de `--identify`, o null si no la hay.
function identityOf(stdout: string): OdyseaIdentity | null {
  const line = stdout.trim().split('\n').at(-1);
  try {
    const parsed: unknown = line ? JSON.parse(line) : null;
    return isIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** busca odysea y comprueba que es el nuestro (`--identify`): paquete, tool, protocolo y versión. */
export async function detectOdysea(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<OdyseaDetection> {
  const bin = findOdysea(configured, env);
  if (bin === null) return { ok: false, reason: configured !== undefined ? `${configured} no es un ejecutable` : `\`${ODYSEA_BIN}\` no está en el PATH` };
  const notOurs = `${bin} no es ${ODYSEA_PACKAGE}, o es anterior a ${MIN_ODYSEA_VERSION}`;
  // un binario que no conoce --identify (odysea 0.5.0, u otro programa que se llame odysea) sale con error o sin json.
  const id = await execFileP(bin, [IDENTIFY_FLAG], { encoding: 'utf-8', timeout: IDENTIFY_TIMEOUT_MS }).then(
    ({ stdout }) => identityOf(stdout),
    () => null,
  );
  if (id === null || id.name !== ODYSEA_PACKAGE || id.tool !== ODYSEA_TOOL) return { ok: false, reason: notOurs };
  if (id.protocol < ODYSEA_PROTOCOL_MIN) return { ok: false, reason: `odysea con protocolo ${id.protocol}: este runner necesita ${ODYSEA_PROTOCOL_MIN} o posterior` };
  if (!versionAtLeast(id.version, MIN_ODYSEA_VERSION)) return { ok: false, reason: `odysea ${id.version || '?'}: hace falta ${MIN_ODYSEA_VERSION} o posterior` };
  return { ok: true, info: { bin, version: id.version } };
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
