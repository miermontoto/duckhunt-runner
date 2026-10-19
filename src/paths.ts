// rutas del runner por plataforma (t#495, M1): todo directorio o fichero que un run o su plataforma usan sale
// de aquí, en función del id de la plataforma. con varias plataformas cada una tiene su estado (scratch, logs,
// mcp-config de sus runs, lo último que dijo su server) y su espacio de worktrees dentro de cada checkout.
// decisiones:
// - LEGACY_PLATFORM_ID ('duckhunt') son las rutas EXACTAS de hoy: <runnerHome>/{scratch,run-config,logs},
//   <runnerHome>/server-state.json y <checkout>/.duckhunt/worktrees/. una instalación existente no mueve nada.
// - cualquier otra plataforma vive en <runnerHome>/platforms/<id>/{scratch,run-config,logs,server-state.json}
//   y <checkout>/.runner/worktrees/<id>/ (todas bajo un mismo .runner/, que va una vez a info/exclude).
// - el id es la clave local e inmutable de la plataforma (PLATFORM_ID_RE: minúsculas, dígitos y '-'): acaba
//   en rutas, así que se valida al construirlas y uno inválido lanza.
// - la config, el lock del daemon y runnerHome son de la máquina, no de una plataforma: siguen en config.ts.
// - los directorios se crean al pedirlos (como antes en config.ts); run-config, 0700 aunque ya existiera.

import fs from 'node:fs';
import path from 'node:path';
import { runnerHome } from './config.js';

export const LEGACY_PLATFORM_ID = 'duckhunt';
export const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const PLATFORMS_SUBDIR = 'platforms';
const SCRATCH_SUBDIR = 'scratch';
const LOGS_SUBDIR = 'logs';
const RUN_CONFIG_SUBDIR = 'run-config';
const SERVER_STATE_FILE = 'server-state.json';
// permisos del directorio de los mcp-config de los runs: llevan el token per-run.
const RUN_CONFIG_DIR_MODE = 0o700;
// dentro de un checkout: el directorio del daemon legacy y el de toda otra plataforma.
const LEGACY_CHECKOUT_DIR = '.duckhunt';
const CHECKOUT_DIR = '.runner';
const WORKTREES_SUBDIR = 'worktrees';

function checkedId(platform: string): string {
  if (!PLATFORM_ID_RE.test(platform)) throw new Error(`id de plataforma inválido: ${JSON.stringify(platform)}`);
  return platform;
}

const isLegacy = (platform: string): boolean => checkedId(platform) === LEGACY_PLATFORM_ID;

/** directorio con todas las plataformas no legacy (<runnerHome>/platforms). */
export function platformsRoot(): string {
  return path.join(runnerHome(), PLATFORMS_SUBDIR);
}

/** raíz del estado de una plataforma: runnerHome para la legacy, <runnerHome>/platforms/<id> para el resto. */
export function platformHome(platform: string): string {
  return isLegacy(platform) ? runnerHome() : path.join(platformsRoot(), platform);
}

const ensureDir = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** cwd FIJO de los runs sin repo de una plataforma: la auto-memory de claude code se indexa por ruta, así el
 *  conocimiento de infra (alarmas sin código) acumula entre runs, y no se mezcla con el de otra plataforma. */
export function scratchDir(platform: string): string {
  return ensureDir(path.join(platformHome(platform), SCRATCH_SUBDIR));
}

/** logs de los runs con --verbose. */
export function logsDir(platform: string): string {
  return ensureDir(path.join(platformHome(platform), LOGS_SUBDIR));
}

/** directorio 0700 de los mcp-config de los runs (run-mcp-config.ts) y de su aws vacía (resources/aws.ts). hermano
 *  del scratch: fuera de todo cwd de un run. un directorio que ya existía con otros permisos se cierra. */
export function runConfigDir(platform: string): string {
  const dir = path.join(platformHome(platform), RUN_CONFIG_SUBDIR);
  fs.mkdirSync(dir, { recursive: true, mode: RUN_CONFIG_DIR_MODE });
  fs.chmodSync(dir, RUN_CONFIG_DIR_MODE);
  return dir;
}

/** los run-config de TODAS las plataformas con estado en disco (la legacy siempre): el deny de Read de todo kit
 *  los cubre todos, así el run de una plataforma no lee los tokens per-run de otra. */
export function allRunConfigDirs(): string[] {
  const others = fs.existsSync(platformsRoot())
    ? fs
        .readdirSync(platformsRoot(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && PLATFORM_ID_RE.test(d.name) && d.name !== LEGACY_PLATFORM_ID)
        .map((d) => path.join(platformsRoot(), d.name, RUN_CONFIG_SUBDIR))
        .filter((dir) => fs.existsSync(dir))
    : [];
  return [runConfigDir(LEGACY_PLATFORM_ID), ...others];
}

/** fichero con lo último que el server de la plataforma dijo de esta máquina (server-state.ts). */
export function serverStatePath(platform: string): string {
  return path.join(platformHome(platform), SERVER_STATE_FILE);
}

/** directorio de los worktrees de una plataforma dentro de un checkout. */
export function worktreesDir(repoPath: string, platform: string): string {
  return isLegacy(platform)
    ? path.join(repoPath, LEGACY_CHECKOUT_DIR, WORKTREES_SUBDIR)
    : path.join(repoPath, CHECKOUT_DIR, WORKTREES_SUBDIR, platform);
}

/** patrón de .git/info/exclude (anclado a la raíz del checkout) que esconde los worktrees de la plataforma. */
export function checkoutExcludePattern(platform: string): string {
  return `/${isLegacy(platform) ? LEGACY_CHECKOUT_DIR : CHECKOUT_DIR}/`;
}

/** entradas privadas del estado de una plataforma, relativas a su raíz (directorios con `/` final): todo salvo
 *  el scratch, que es el cwd de sus runs sin repo. lo que aún no existe también (lo escribirá). */
export const PLATFORM_PRIVATE_ENTRIES: readonly string[] = [`${LOGS_SUBDIR}/`, `${RUN_CONFIG_SUBDIR}/`, SERVER_STATE_FILE];
export const PLATFORM_SCRATCH_SUBDIR = SCRATCH_SUBDIR;
export const PLATFORMS_DIR_NAME = PLATFORMS_SUBDIR;
