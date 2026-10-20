// proveedor de sesiones de navegador (t#495, M7, fase 1): lo que un run necesitará de una sesión guardada, sin
// enchufarlo aún al ciclo de vida (fase 2: la fase mcp de lifecycle.ts, el mcp-config del run y el render de tools).
// - la sesión llega al run como un servidor mcp stdio propio, `res_browser_<clave>` (el prefijo `res_` lo reserva
//   el daemon: ninguna plataforma puede usarlo), que es el binario de odysea con su copia filtrada del vault en modo
//   fichero único, la allowlist de orígenes de la sesión y sin la tool `session`.
// - nivel de acceso → tools de odysea (BROWSER_TOOLS, acumulativas): read mira, interact además teclea y pulsa, full
//   además ejecuta js y lee las cabeceras de red (Cookie/Authorization). `session` nunca: cargaría o guardaría otras
//   sesiones del vault.
// - la copia va al run-config de la plataforma (0700, ya negado a Read en todo kit): browser-<run>-<rand>/state.json,
//   0600. sin exclusive se tira al cerrar; con exclusive odysea la autoguarda (un kill del grupo de procesos se salta
//   el guardado al cerrar) y al soltar vuelve al vault con mergeBack, bajo el turno de la sesión y el mutex de su
//   fichero, en todo cierre salvo `aborted`: el sitio puede haber rotado ya el token, tirarla mataría la sesión.
// - la que dejó un daemon muerto se borra al arrancar (sweep).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KeyedMutex } from '../../keyed-mutex.js';
import { runConfigDir } from '../../paths.js';
import { ACCESS, RESOURCE_TYPE, type Access } from '../types.js';
import { originPatterns, type BrowserRef } from './config.js';
import { filterState, mergeBack, parseStorageState, writeStateAtomic } from './state-filter.js';

export const BROWSER_TYPE = RESOURCE_TYPE.browser;
// servidor mcp de una sesión en el run: res_browser_<clave>.
export const BROWSER_SERVER_PREFIX = `res_${BROWSER_TYPE}_`;

const READ_TOOLS = [
  'navigate',
  'reload',
  'back',
  'tabs',
  'resize',
  'scroll',
  'hover',
  'wait_for',
  'screenshot',
  'dom_snapshot',
  'dom_query',
  'console_messages',
  'network_requests',
] as const;
const INTERACT_TOOLS = [...READ_TOOLS, 'click', 'fill', 'press_key', 'select_option', 'handle_dialog'] as const;
const FULL_TOOLS = [...INTERACT_TOOLS, 'evaluate', 'network_details'] as const;

/** tools de odysea por nivel de acceso (acumulativas). */
export const BROWSER_TOOLS: Readonly<Record<Access, readonly string[]>> = {
  [ACCESS.read]: READ_TOOLS,
  [ACCESS.interact]: INTERACT_TOOLS,
  [ACCESS.full]: FULL_TOOLS,
};
/** tools de odysea que ningún run recibe (y que van al deny). */
export const BROWSER_DENIED_TOOLS: readonly string[] = ['session'];

// cada cuánto odysea guarda la copia de una sesión exclusiva (lo que sobrevive a un kill).
export const BROWSER_AUTOSAVE_MS = 30_000;
const COPY_PREFIX = `${BROWSER_TYPE}-`;
const COPY_RANDOM_BYTES = 4;
const COPY_DIR_MODE = 0o700;
const COPY_FILE_MODE = 0o600;
const COPY_STATE_FILE = 'state.json';
const LOCK_PREFIX = `${BROWSER_TYPE}:`;
const ORIGINS_SEPARATOR = ',';
const SESSION_TOOL_OFF = '0';

/** el nombre del servidor mcp de una sesión en el run. */
export const browserServerName = (key: string): string => `${BROWSER_SERVER_PREFIX}${key}`;

/** las tools de odysea de un nivel de acceso. */
export const browserToolsFor = (access: Access): readonly string[] => BROWSER_TOOLS[access];

/** el turno de una sesión exclusiva (null = sin turno: cada run lleva su copia). */
export const browserLockKey = (key: string, ref: BrowserRef): string | null => (ref.exclusive ? `${LOCK_PREFIX}${key}` : null);

/** la copia de una sesión para un run. */
export interface BrowserCopy {
  dir: string;
  stateFile: string;
}

/** servidor mcp stdio de un run (la forma del mcp-config de claude). */
export interface McpStdioServer {
  type: 'stdio';
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

/** escribe la copia filtrada del vault para un run (lanza si el vault no existe o no tiene forma de storage state). */
export function materializeCopy(platform: string, runId: string, vaultFile: string, ref: BrowserRef, nowMs: number): BrowserCopy {
  const state = filterState(parseStorageState(fs.readFileSync(vaultFile, 'utf-8')), originPatterns(ref), nowMs);
  const dir = path.join(runConfigDir(platform), `${COPY_PREFIX}${runId}-${crypto.randomBytes(COPY_RANDOM_BYTES).toString('hex')}`);
  fs.mkdirSync(dir, { mode: COPY_DIR_MODE });
  const stateFile = path.join(dir, COPY_STATE_FILE);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: COPY_FILE_MODE, flag: 'wx' });
  return { dir, stateFile };
}

/** el servidor mcp de la sesión para el run: odysea en modo fichero único, con su allowlist y sin `session`. */
export function browserMcpServer(bin: string, copy: BrowserCopy, ref: BrowserRef): McpStdioServer {
  return {
    type: 'stdio',
    command: bin,
    args: [],
    env: {
      ODYSEA_STATE_FILE: copy.stateFile,
      ODYSEA_ALLOWED_ORIGINS: ref.origins.join(ORIGINS_SEPARATOR),
      ODYSEA_SESSION_TOOL: SESSION_TOOL_OFF,
      // sin exclusive la copia se tira: no hace falta guardarla.
      ...(ref.exclusive ? { ODYSEA_AUTOSAVE_MS: String(BROWSER_AUTOSAVE_MS) } : {}),
    },
  };
}

/** devuelve al vault lo que el run cambió de una sesión exclusiva (mergeBack), atómico y bajo el mutex del vault. */
export async function writeBack(vaultFile: string, copy: BrowserCopy, ref: BrowserRef, mutex: KeyedMutex, nowMs: number): Promise<void> {
  await mutex.run(path.resolve(vaultFile), async () => {
    const vault = parseStorageState(fs.readFileSync(vaultFile, 'utf-8'));
    const run = parseStorageState(fs.readFileSync(copy.stateFile, 'utf-8'));
    writeStateAtomic(vaultFile, mergeBack(vault, run, originPatterns(ref), nowMs));
  });
}

/** borra la copia de un run. */
export const dropCopy = (copy: BrowserCopy): void => fs.rmSync(copy.dir, { recursive: true, force: true });

/** al arrancar (con el lock del daemon): borra las copias que dejó un daemon muerto. devuelve cuántas. */
export function clearRunBrowserCopies(platform: string): number {
  const dir = runConfigDir(platform);
  const stale = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith(COPY_PREFIX));
  stale.forEach((d) => fs.rmSync(path.join(dir, d.name), { recursive: true, force: true }));
  return stale.length;
}
