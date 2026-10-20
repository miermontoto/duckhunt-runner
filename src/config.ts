// config del daemon (~/.duckhunt-runner.json): credencial oauth + mapa repo→path local + mapa
// cuenta aws→perfil local + defaults. el server jamás ve estos paths ni perfiles — la resolución
// repo→checkout y cuenta→perfil vive SOLO aquí. ~/.duckhunt-runner/ guarda el scratch dir (runs
// sin repo, donde claude code acumula memoria), los logs opcionales, el lock del daemon y (0.10.2)
// los mcp-config de los runs en run-config/ (0700, run-mcp-config.ts). DUCKHUNT_RUNNER_CONFIG y
// DUCKHUNT_RUNNER_HOME los desvían (otra cuenta, otro server, pruebas e2e sin tocar la config real).
// desde t#495 (M1) las rutas de cada plataforma (scratch, logs, run-config, server-state, worktrees) salen
// de paths.ts; aquí quedan las de la máquina: el fichero de config y runnerHome.
// escritura (0.10.1): nadie reescribe el fichero con su copia en memoria. saveConfig relee el fichero,
// cambia SOLO las claves del que escribe y lo guarda atómico (tmp + fsync + rename, 600; en sitio si
// el directorio no lo permite): `login` la credencial, la cli y los comandos de repos de duckhunt sus
// entradas de los mapas, el refresh del daemon su refreshToken. antes el refresh (cada hora) volcaba
// la config entera de memoria y deshacía en silencio un `login`, `repos add` o `aws add` hechos con el
// daemon en marcha; ahora el daemon los recarga en cada vuelta de su loop. footgun aceptado: dos
// escritores en el mismo instante (relectura y escritura son síncronas, sub-milisegundo) se pisan y
// gana el último.
// identidad (0.11.0, t#465 P12): machineId + machineHost (machine.ts) y replacesClientId, el client_id
// del login anterior que viaja con la credencial hasta su primer claim. `logout` borra la credencial y
// deja el resto (mapas, defaults, la identidad de la máquina): loadStoredConfig la lee sin credencial.
// <runnerHome>/server-state.json guarda lo último que el server dijo de esta máquina (server-state.ts).
// config v2 (t#495, M2): el modelo con recursos por tipo y plataformas (RunnerConfigV2, loadConfigV2/saveConfigV2)
// sobre el MISMO fichero: las claves de siempre siguen siendo donde viven la credencial de duckhunt y sus repos y
// cuentas aws, y lo solo-v2 va aparte (config-legacy.ts). un fichero sin `version` es v1; uno de una versión que
// este runner no conoce no se lee (ni se escribe): interpretarlo a medias podría exponer lo que no debe.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filePatch, fromFile } from './config-legacy.js';
import type { PlatformConfig } from './platforms/types.js';

// permisos del fichero de config: lleva el refresh token.
const CONFIG_FILE_MODE = 0o600;
// errores del tmp + rename con los que la escritura cae a en sitio (writeAtomic).
const IN_PLACE_FALLBACK_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EBUSY', 'EXDEV']);

// instancia por defecto de `login`: la pública. otra instancia se pasa como primer argumento.
export const DEFAULT_BASE_URL = 'https://duckhunt.info';

export interface RepoConfig {
  // path absoluto al checkout local del repo.
  path: string;
  // DEPRECADO (0.11.0, se retira en una versión posterior): opt-in per-repo a
  // --dangerously-skip-permissions. solo los kinds de reglas heredados (investigate/resume) de un server
  // anterior a t#465 P6: desde P6 toda conversación, las de reglas incluidas, es un prompt run y cumple
  // el perfil read|edit del server. `repos add` y `status` avisan de que se ignora.
  dangerouslySkipPermissions?: boolean;
  // DEPRECADO (ídem): aislar cada run en un git worktree (default true). false = correr en el
  // checkout. mismo alcance que el anterior: un prompt run usa siempre el worktree de su conversación
  // (o el checkout si el usuario lo eligió al abrirla).
  worktree?: boolean;
}

// aviso de los flags de repo que ya no aplica nada (se retiran en una versión posterior).
export const REPO_FLAGS_DEPRECATED = 'ignorado: duckhunt ejecuta las investigaciones en el sandbox de lectura (se retira en una versión posterior)';

/** flags deprecados de un repo del mapa, con su nombre en la config (`repos add`, `repos list` y `status` los avisan). */
export function deprecatedRepoFlags(repo: RepoConfig): string[] {
  return [...(repo.worktree === false ? ['worktree: false'] : []), ...(repo.dangerouslySkipPermissions ? ['dangerouslySkipPermissions'] : [])];
}

export interface AwsAccountConfig {
  // perfil de ~/.aws/config que la aws cli usa para esa cuenta.
  profile: string;
  region?: string;
}

export interface RunnerDefaults {
  // modelo de esta máquina (--model) cuando duckhunt no pide ninguno: desde 0.12.0 el del claim (la
  // elección de la persona para esa conversación) manda sobre este. ausente = el default del cli.
  model?: string;
  // runs en paralelo (slots). ausente = 1, el comportamiento de siempre: un run a la vez.
  maxConcurrent?: number;
  // presupuesto por run (--max-budget-usd). ausente = automático: el flag solo se pasa si el
  // daemon corre con ANTHROPIC_API_KEY (coste real); con login de suscripción el coste es
  // nominal y el guard contra loops es el timeout. un número lo fuerza; 0 lo desactiva siempre.
  maxBudgetUsd?: number;
  // cambios del mapa de repos pedidos desde duckhunt (quitar un repo, elegir su carpeta entre las
  // que este daemon encontró; repo-commands.ts). ausente = permitidos; false = solo por la cli.
  remoteRepoEdits?: boolean;
}

/** credencial oauth del runner: la escribe `login` y su refreshToken lo rota el daemon (oauth.ts). */
export interface RunnerCredential {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  // client_id del login anterior de esta máquina, hasta el primer claim con éste (0.11.0): duckhunt
  // adopta su fila y revoca la credencial vieja.
  replacesClientId?: string;
  // token endpoint de una plataforma cuyo oauth no lo tiene en <baseUrl>/oauth/token (su metadata rfc 8414, t#495
  // M6.4). la de duckhunt nunca lo lleva.
  tokenEndpoint?: string;
}

export interface RunnerConfig extends RunnerCredential {
  // etiqueta del runner en agent_run.runner_label (default: hostname).
  label?: string;
  // uuid estable de esta máquina (machine.ts) y el hostname con el que se generó.
  machineId?: string;
  machineHost?: string;
  // mapa clave ws/slug → checkout local.
  repos: Record<string, RepoConfig>;
  // mapa id de cuenta aws (12 dígitos) → perfil local.
  aws: Record<string, AwsAccountConfig>;
  defaults: RunnerDefaults;
}

/** versión del modelo de config que este runner lee y escribe (un fichero sin `version` es v1). */
export const CONFIG_VERSION = 2;

/** tipo de recurso → clave → su entrada en esta máquina (checkout, perfil aws…). */
export type ResourcesConfig = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** el modelo v2: los recursos de la máquina por tipo y cada plataforma con su credencial, su exposición y su techo. */
export interface RunnerConfigV2 {
  version: typeof CONFIG_VERSION;
  label?: string;
  machineId?: string;
  machineHost?: string;
  resources: ResourcesConfig;
  platforms: Readonly<Record<string, PlatformConfig>>;
  defaults: RunnerDefaults;
}

/** lo que el daemon recarga en caliente en cada vuelta de su loop: todo menos la credencial. */
export type LocalConfig = Omit<RunnerConfig, keyof RunnerCredential>;

/** el fichero tal cual, con los mapas ausentes vacíos: la credencial puede faltar (sin `login` aún). */
export type StoredConfig = Partial<RunnerCredential> & LocalConfig;

// tope de defaults.maxConcurrent: cada claude son ~300-450 MB y todos gastan la misma ventana del plan.
export const MAX_CONCURRENT_LIMIT = 8;

/** slots del daemon: defaults.maxConcurrent entero en [1, MAX_CONCURRENT_LIMIT]; ausente o inválido = 1. */
export function concurrency(defaults: RunnerDefaults): number {
  const n = defaults.maxConcurrent;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_CONCURRENT_LIMIT) : 1;
}

/** fichero de config: DUCKHUNT_RUNNER_CONFIG o ~/.duckhunt-runner.json. */
export function configPath(): string {
  return process.env.DUCKHUNT_RUNNER_CONFIG ?? path.join(os.homedir(), '.duckhunt-runner.json');
}

/** directorio de estado del daemon (el lock y el estado de cada plataforma: paths.ts). */
export function runnerHome(): string {
  return process.env.DUCKHUNT_RUNNER_HOME ?? path.join(os.homedir(), '.duckhunt-runner');
}

/** texto del fichero de config, o null si no existe. el daemon lo compara para recargar solo si cambió. */
export function readConfigText(): string | null {
  try {
    return fs.readFileSync(configPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// objeto json del fichero (claves desconocidas incluidas: se conservan al escribir).
function parseObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config inválida en ${configPath()}: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config inválida en ${configPath()}: no es un objeto json`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    throw new Error(`config en ${configPath()} de otra versión (version ${JSON.stringify(raw.version)}): este runner lee hasta la ${CONFIG_VERSION}, actualízalo`);
  }
  return raw;
}

const stored = (raw: Record<string, unknown>): StoredConfig => {
  const cfg = raw as Partial<RunnerConfig>;
  return { ...cfg, repos: cfg.repos ?? {}, aws: cfg.aws ?? {}, defaults: cfg.defaults ?? {} };
};

/** config a partir del texto del fichero; lanza si el json es inválido o le falta la credencial. */
export function parseConfig(text: string): RunnerConfig {
  const cfg = stored(parseObject(text));
  if (!cfg.baseUrl || !cfg.clientId || !cfg.refreshToken) {
    throw new Error(`config incompleta en ${configPath()}: ejecuta \`duckhunt-runner login <base-url>\``);
  }
  return {
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId,
    refreshToken: cfg.refreshToken,
    ...(typeof cfg.replacesClientId === 'string' && cfg.replacesClientId ? { replacesClientId: cfg.replacesClientId } : {}),
    label: cfg.label,
    ...(typeof cfg.machineId === 'string' ? { machineId: cfg.machineId } : {}),
    ...(typeof cfg.machineHost === 'string' ? { machineHost: cfg.machineHost } : {}),
    repos: cfg.repos,
    aws: cfg.aws,
    defaults: cfg.defaults,
  };
}

/** separa la credencial (la rota el daemon) de lo que recarga en caliente (mapas, etiqueta, defaults, máquina). */
export function splitConfig(cfg: RunnerConfig): { credential: RunnerCredential; local: LocalConfig } {
  const { baseUrl, clientId, refreshToken, replacesClientId, ...local } = cfg;
  return { credential: { baseUrl, clientId, refreshToken, ...(replacesClientId ? { replacesClientId } : {}) }, local };
}

/** carga la config; null si no existe (login pendiente). lanza si el json es inválido. */
export function loadConfig(): RunnerConfig | null {
  const text = readConfigText();
  return text === null ? null : parseConfig(text);
}

/** el fichero tal cual, también sin credencial (tras `logout`); null si no existe. lanza si el json es inválido. */
export function loadStoredConfig(): StoredConfig | null {
  const text = readConfigText();
  return text === null ? null : stored(parseObject(text));
}

// path real del fichero: el tmp va a su lado y un symlink (dotfiles) sigue siendo symlink, también
// uno colgante (su destino aún no existe: se crea, como hacía writeFileSync).
function realConfigPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    return path.resolve(path.dirname(file), fs.readlinkSync(file));
  } catch (err) {
    // ENOENT = no existe; EINVAL = existe pero no es un symlink.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EINVAL') return file;
    throw err;
  }
}

// tmp + fsync + rename: un lector (el daemon recargando, otro comando) nunca ve un json a medias y un
// corte no deja el fichero vacío (perder el refresh token rotado obliga a un `login` nuevo). si el tmp
// no se puede crear a su lado o renombrar encima (directorio sin escritura, fichero montado suelto en
// un contenedor), se escribe en sitio como antes de 0.10.1: sin atomicidad, pero sin perder el refresh.
function writeAtomic(file: string, content: string): void {
  const target = realConfigPath(file);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', CONFIG_FILE_MODE);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (!IN_PLACE_FALLBACK_CODES.has((err as NodeJS.ErrnoException).code ?? '') || !fs.existsSync(target)) throw err;
    fs.writeFileSync(target, content, { mode: CONFIG_FILE_MODE });
  }
}

/** claves que cambia una escritura: las v1 y, desde la v2, las solo-v2 del fichero (config-legacy.ts::fileOf). */
export type ConfigPatch = Partial<RunnerConfig> & Partial<Record<'version' | 'platforms' | 'resources', unknown>>;

/**
 * cambia en la config SOLO las claves que devuelve `change`, calculadas sobre lo que hay AHORA en el
 * fichero (nunca sobre una copia en memoria); el resto, claves desconocidas incluidas, queda como
 * estaba. null = nada que escribir. devuelve la config que queda en el fichero.
 */
export function saveConfig(change: (current: StoredConfig) => ConfigPatch | null): StoredConfig {
  const text = readConfigText();
  const raw = text === null ? {} : parseObject(text);
  const patch = change(stored(raw));
  if (patch === null) return stored(raw);
  const next = { ...raw, ...patch };
  writeAtomic(configPath(), `${JSON.stringify(next, null, 2)}\n`);
  return stored(next);
}

/**
 * lleva al mapa del fichero (`current`) lo que cambió en memoria de `before` a `after`: quita las
 * claves quitadas y pone las añadidas o cambiadas. lo demás del fichero (lo que la cli añadió o quitó
 * mientras tanto) se conserva.
 */
export function mergeEntries<T>(current: Record<string, T>, before: Record<string, T>, after: Record<string, T>): Record<string, T> {
  const removed = new Set(Object.keys(before).filter((key) => !Object.hasOwn(after, key)));
  const changed = Object.entries(after).filter(([key, value]) => !Object.hasOwn(before, key) || JSON.stringify(before[key]) !== JSON.stringify(value));
  return { ...Object.fromEntries(Object.entries(current).filter(([key]) => !removed.has(key))), ...Object.fromEntries(changed) };
}

/** el modelo v2 a partir del texto del fichero (también un v1, vía fromLegacy). lanza si es inválido. */
export function parseConfigV2(text: string): RunnerConfigV2 {
  return fromFile(parseObject(text));
}

/** el fichero como modelo v2; null si no existe. lanza si es inválido. */
export function loadConfigV2(): RunnerConfigV2 | null {
  const text = readConfigText();
  return text === null ? null : parseConfigV2(text);
}

/**
 * saveConfig en el modelo v2: `change` recibe el fichero de AHORA como v2 y devuelve el v2 que debe quedar (null =
 * nada). solo se escriben las claves del fichero que cambian, así que lo que otro escritor (un daemon ≤ 0.12, la
 * cli) toque mientras tanto en otras claves se conserva. devuelve el v2 que queda en el fichero.
 */
export function saveConfigV2(change: (current: RunnerConfigV2) => RunnerConfigV2 | null): RunnerConfigV2 {
  const saved = saveConfig((current) => {
    const before = fromFile(current);
    const after = change(before);
    return after === null ? null : filePatch(before, after);
  });
  return fromFile(saved);
}
