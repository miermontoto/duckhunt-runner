// config de las sesiones de navegador (t#495, M7), en la config v2: `resources.browser.<clave>` y
// `providers.browser`. puro: lo valida config-legacy.ts al leer el fichero (una entrada que no vale hace la config
// inválida, como toda parte v2) y lo usan la cli y el proveedor.
// - la clave cabe en ^[a-z0-9][a-z0-9-]{0,15}$: el servidor mcp del run es `res_browser_<clave>` y la tool más
//   larga de odysea (console_messages, network_requests) deja `mcp__res_browser_<clave>__<tool>` en 51 caracteres,
//   dentro del tope de 64 que se asume para un nombre de tool de la api.
// - `session` es el fichero del vault (<vault>/<session>.json): por defecto la clave; dos claves pueden compartir
//   sesión con orígenes distintos. mismo patrón que los nombres de sesión de odysea.
// - `origins`, la allowlist (origins.ts): lo único de la sesión que llega a un run, y lo único que el run puede
//   navegar.
// - `exclusive`: un run a la vez y lo que el sitio rote (tokens, cookies) vuelve al vault al cerrar. sin él cada run
//   lleva su copia y se tira.
// - `probe`: url que dice si la sesión sigue viva (`odysea probe`) y, opcional, la regex de la página de login.
// - `providers.browser.bin` (el binario de odysea; sin él, el del PATH) y `vaultDir` (sin él, el de runnerHome).

import path from 'node:path';
import { defaultBrowserVaultPath } from '../../paths.js';
import { originOf, parseOriginPattern, type OriginPattern } from './origins.js';

export const BROWSER_KEY_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
// el de odysea (SESSION_NAME_RE): sin rutas.
export const BROWSER_SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const STATE_FILE_EXT = '.json';

/** una sesión de navegador de esta máquina. */
export interface BrowserRef {
  session: string;
  origins: readonly string[];
  exclusive?: boolean;
  probe?: { url: string; loginPattern?: string };
}

/** dónde está odysea y el vault de sesiones. */
export interface BrowserProviderConfig {
  bin?: string;
  vaultDir?: string;
}

/** `providers` de la config v2 (hoy solo el navegador). */
export interface ProvidersConfig {
  browser?: BrowserProviderConfig;
}

type Raw = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** los patrones de una sesión (lanza si alguno no vale). */
export const originPatterns = (ref: Pick<BrowserRef, 'origins'>): OriginPattern[] => ref.origins.map(parseOriginPattern);

/** la entrada `resources.browser.<key>` validada; lanza con `where` en el mensaje. */
export function parseBrowserRef(key: string, raw: unknown, where: string): BrowserRef {
  if (!BROWSER_KEY_RE.test(key)) throw new Error(`${where}: clave de navegador no válida (${BROWSER_KEY_RE.source})`);
  if (!isObj(raw)) throw new Error(`${where} no es un objeto`);
  if (!isText(raw.session) || !BROWSER_SESSION_RE.test(raw.session)) throw new Error(`${where}.session no válida (${BROWSER_SESSION_RE.source})`);
  if (!Array.isArray(raw.origins) || raw.origins.length === 0 || !raw.origins.every(isText)) throw new Error(`${where}.origins: una lista no vacía de orígenes`);
  try {
    originPatterns({ origins: raw.origins });
  } catch (err) {
    throw new Error(`${where}.origins: ${(err as Error).message}`);
  }
  if (raw.exclusive !== undefined && typeof raw.exclusive !== 'boolean') throw new Error(`${where}.exclusive no es booleano`);
  if (raw.probe !== undefined) {
    if (!isObj(raw.probe) || !isText(raw.probe.url) || originOf(raw.probe.url) === null) throw new Error(`${where}.probe.url no es una url http(s)`);
    if (raw.probe.loginPattern !== undefined) {
      if (!isText(raw.probe.loginPattern)) throw new Error(`${where}.probe.loginPattern no es un texto`);
      try {
        new RegExp(raw.probe.loginPattern);
      } catch (err) {
        throw new Error(`${where}.probe.loginPattern no es una regex: ${(err as Error).message}`);
      }
    }
  }
  return {
    session: raw.session,
    origins: [...raw.origins],
    ...(raw.exclusive !== undefined ? { exclusive: raw.exclusive } : {}),
    ...(isObj(raw.probe)
      ? { probe: { url: raw.probe.url as string, ...(raw.probe.loginPattern !== undefined ? { loginPattern: raw.probe.loginPattern as string } : {}) } }
      : {}),
  };
}

/** `providers` validado (lanza). un proveedor sin claves no se guarda. */
export function parseProviders(raw: unknown): ProvidersConfig {
  if (!isObj(raw)) throw new Error('providers no es un objeto');
  if (raw.browser === undefined) return {};
  if (!isObj(raw.browser)) throw new Error('providers.browser no es un objeto');
  const { bin, vaultDir } = raw.browser;
  if (bin !== undefined && (!isText(bin) || !path.isAbsolute(bin))) throw new Error('providers.browser.bin: una ruta absoluta');
  if (vaultDir !== undefined && (!isText(vaultDir) || !path.isAbsolute(vaultDir))) throw new Error('providers.browser.vaultDir: una ruta absoluta');
  return { browser: { ...(bin !== undefined ? { bin } : {}), ...(vaultDir !== undefined ? { vaultDir } : {}) } };
}

/** el vault de sesiones: el de la config o el de runnerHome. */
export const vaultDirOf = (providers: ProvidersConfig | undefined): string => providers?.browser?.vaultDir ?? defaultBrowserVaultPath();

/** el fichero de una sesión dentro del vault. */
export const vaultFileOf = (vaultDir: string, session: string): string => path.join(vaultDir, `${session}${STATE_FILE_EXT}`);
