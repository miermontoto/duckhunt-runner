// rutas reales de las credenciales de ESTA máquina que todo kit de lectura niega a Read (0.11.0,
// capability secret_paths, t#465 P12). el server ya manda AGENT_SECRET_READ_DENY, una lista genérica y
// relativa a ~ (~/.aws/**, ~/.duckhunt-runner.json, ~/.claude/.credentials.json…) porque nunca ve paths
// del usuario; lo que esa lista no puede saber lo añade aquí el daemon, sin mandarlo a ningún sitio:
// - su config de verdad (DUCKHUNT_RUNNER_CONFIG si la desvía) y su estado (DUCKHUNT_RUNNER_HOME): logs
//   de los runs, lock, server-state y los mcp-config (ya negados por run-mcp-config.ts). el scratch NO: es
//   el cwd de los runs sin repo (negarlo dejaría a uno de lectura sin poder leer su propio directorio) y la
//   shell de lectura no sale de su cwd, así que el resto del estado solo lo alcanzaría la tool Read.
// - el estado de cada plataforma no legacy (t#495, <runnerHome>/platforms/<id>/): sus logs, run-config y
//   server-state, nunca su scratch (el cwd de sus runs sin repo, por la misma razón que el de arriba).
// - $CLAUDE_CONFIG_DIR/.credentials.json y AWS_SHARED_CREDENTIALS_FILE / AWS_CONFIG_FILE si están.
// - el realpath de cada una y de las de la lista genérica cuando difiere (dotfiles: ~/.aws enlazado a otro
//   sitio deja ~/.aws/** sin efecto sobre la ruta real).
// una ruta que no cabe en una regla de claude (comas, paréntesis, comodines) se salta y se avisa al
// arrancar: es defensa en profundidad sobre la lista del server, no la única barrera.
// verificado con el cli 2.1.296 (sondas de t#465 P6, el mismo cli que el de esta versión): Read, Grep y
// Glob honran estos deny, también en búsquedas recursivas y a través de symlinks; la shell de solo lectura
// no aprueba nada fuera de su cwd (vetado o no) y dentro honra una ruta nombrada, pero no una lectura
// recursiva (`grep -r`), que read-shell-guard.ts cierra quitando la shell si un symlink sale del cwd.
// el scratch de las OTRAS plataformas (t#495, M6.3, otherScratchDeny): no va en secretPathsDeny porque es de
// cada run (el propio es su cwd) y se calcula en cada segmento, como el run-config de todas.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, runnerHome } from './config.js';
import { readDenyRule } from './run-mcp-config.js';
import { LEGACY_PLATFORM_ID, PLATFORM_ID_RE, PLATFORM_PRIVATE_ENTRIES, PLATFORM_SCRATCH_SUBDIR, PLATFORMS_DIR_NAME, scratchPath } from './paths.js';

// lo que el daemon escribe en su estado aunque aún no exista al arrancar (logs con --verbose, el lock y
// lo último que dijo el server): directorios con `/` final.
const RUNNER_HOME_PRIVATE = ['logs/', 'daemon.lock', 'server-state.json'];
// la lista genérica del server (AGENT_SECRET_READ_DENY), relativa a ~: aquí solo cuenta su realpath.
const HOME_SECRETS = ['.aws/', '.ssh/', '.duckhunt-runner.json', '.claude/.credentials.json', '.config/gh/', '.netrc', '.git-credentials', '.docker/config.json'];
const CLAUDE_CREDENTIALS = '.credentials.json';

/** las reglas que se añaden al deny de lectura y las rutas que no cupieron en una regla (para avisar). */
export interface SecretPathsDeny {
  rules: string[];
  skipped: string[];
}

interface Candidate {
  path: string;
  dir: boolean;
}

const entry = (base: string, rel: string): Candidate => ({ path: path.join(base, rel.replace(/\/$/, '')), dir: rel.endsWith('/') });

// la ruta tal cual y su realpath si existe y difiere (un symlink, o uno de sus padres).
function withRealpath(c: Candidate): Candidate[] {
  try {
    const real = fs.realpathSync.native(c.path);
    return real === c.path ? [c] : [c, { path: real, dir: c.dir }];
  } catch (err) {
    // no existe (aún): queda la ruta lógica. cualquier otro fallo, también, sin tumbar el arranque.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[runner] secret_paths: ${c.path}: ${(err as Error).message}`);
    return [c];
  }
}

// entradas de `dir` (directorios con `/` final), vacío si no existe.
function listed(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
}

// lo que hay en `dir` salvo `skip`, más lo que se escribirá aunque aún no exista (`always`).
function privateEntries(dir: string, always: readonly string[], skip: readonly string[]): Candidate[] {
  const present = listed(dir)
    .filter((d) => !skip.includes(d.name))
    .map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`);
  return Array.from(new Set([...present, ...always])).map((rel) => entry(dir, rel));
}

// lo que hay en el estado del daemon, salvo el scratch, más lo que escribirá. platforms/ no se niega entero:
// dentro está el scratch de cada plataforma, que es el cwd de sus runs; se niega lo privado de cada una.
function runnerHomeEntries(home: string): Candidate[] {
  const platforms = path.join(home, PLATFORMS_DIR_NAME);
  return [
    ...privateEntries(home, RUNNER_HOME_PRIVATE, [PLATFORM_SCRATCH_SUBDIR, PLATFORMS_DIR_NAME]),
    ...listed(platforms)
      .filter((d) => d.isDirectory())
      .flatMap((d) => privateEntries(path.join(platforms, d.name), PLATFORM_PRIVATE_ENTRIES, [PLATFORM_SCRATCH_SUBDIR])),
  ];
}

/** deny de Read de las rutas reales de las credenciales de esta máquina (ver cabecera), con `env` el del daemon. */
export function secretPathsDeny(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): SecretPathsDeny {
  const fromEnv = [
    env.CLAUDE_CONFIG_DIR ? entry(env.CLAUDE_CONFIG_DIR, CLAUDE_CREDENTIALS) : null,
    env.AWS_SHARED_CREDENTIALS_FILE ? { path: env.AWS_SHARED_CREDENTIALS_FILE, dir: false } : null,
    env.AWS_CONFIG_FILE ? { path: env.AWS_CONFIG_FILE, dir: false } : null,
  ].filter((c): c is Candidate => c !== null);
  const own = [{ path: configPath(), dir: false }, ...runnerHomeEntries(runnerHome()), ...fromEnv]
    .map((c) => ({ ...c, path: path.resolve(c.path) }))
    .flatMap(withRealpath);
  // de la lista genérica solo el realpath distinto: la ruta lógica ya la niega el server.
  const generic = HOME_SECRETS.map((rel) => entry(home, rel)).flatMap((c) => withRealpath(c).slice(1));
  const candidates = [...own, ...generic];
  const rules = candidates.map((c) => readDenyRule(c.path, c.dir));
  return {
    rules: Array.from(new Set(rules.filter((r): r is string => r !== null))),
    skipped: candidates.filter((_, i) => rules[i] === null).map((c) => c.path),
  };
}

/** deny de Read del scratch de las plataformas que no son `own` (el cwd de sus runs sin repo y la auto-memory de su
 *  cli): las de la config (`configured`) y las que tienen estado en disco, con su realpath si difiere. vacío con
 *  una sola plataforma. */
export function otherScratchDeny(own: string, configured: readonly string[]): string[] {
  const onDisk = listed(path.join(runnerHome(), PLATFORMS_DIR_NAME))
    .filter((d) => d.isDirectory() && PLATFORM_ID_RE.test(d.name))
    .map((d) => d.name);
  const others = Array.from(new Set([LEGACY_PLATFORM_ID, ...configured, ...onDisk])).filter((id) => id !== own);
  const rules = others.flatMap((id) => withRealpath({ path: path.resolve(scratchPath(id)), dir: true })).map((c) => readDenyRule(c.path, c.dir));
  return Array.from(new Set(rules.filter((r): r is string => r !== null)));
}
