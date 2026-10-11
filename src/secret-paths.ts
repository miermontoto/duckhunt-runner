// rutas reales de las credenciales de ESTA máquina que todo kit de lectura niega a Read (0.11.0,
// capability secret_paths, t#465 P12). el server ya manda AGENT_SECRET_READ_DENY, una lista genérica y
// relativa a ~ (~/.aws/**, ~/.duckhunt-runner.json, ~/.claude/.credentials.json…) porque nunca ve paths
// del usuario; lo que esa lista no puede saber lo añade aquí el daemon, sin mandarlo a ningún sitio:
// - su config de verdad (DUCKHUNT_RUNNER_CONFIG si la desvía) y su estado (DUCKHUNT_RUNNER_HOME): logs
//   de los runs, lock, server-state y los mcp-config (ya negados por run-mcp-config.ts). el scratch NO: es
//   el cwd de los runs sin repo (negarlo dejaría a uno de lectura sin poder leer su propio directorio) y la
//   shell de lectura no sale de su cwd, así que el resto del estado solo lo alcanzaría la tool Read.
// - $CLAUDE_CONFIG_DIR/.credentials.json y AWS_SHARED_CREDENTIALS_FILE / AWS_CONFIG_FILE si están.
// - el realpath de cada una y de las de la lista genérica cuando difiere (dotfiles: ~/.aws enlazado a otro
//   sitio deja ~/.aws/** sin efecto sobre la ruta real).
// una ruta que no cabe en una regla de claude (comas, paréntesis, comodines) se salta y se avisa al
// arrancar: es defensa en profundidad sobre la lista del server, no la única barrera.
// verificado con el cli 2.1.296 (sondas de t#465 P6, el mismo cli que el de esta versión): Read, Grep y
// Glob honran estos deny, también en búsquedas recursivas y a través de symlinks; la shell de solo lectura
// no aprueba nada fuera de su cwd (vetado o no) y dentro honra una ruta nombrada, pero no una lectura
// recursiva (`grep -r`), que read-shell-guard.ts cierra quitando la shell si un symlink sale del cwd.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, runnerHome } from './config.js';
import { readDenyRule } from './run-mcp-config.js';

// subdirectorio del estado que es el cwd de los runs sin repo (config.ts::scratchDir).
const SCRATCH_SUBDIR = 'scratch';
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

// lo que hay en el estado del daemon, salvo el scratch, más lo que escribirá.
function runnerHomeEntries(home: string): Candidate[] {
  let listed: fs.Dirent[] = [];
  try {
    listed = fs.readdirSync(home, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const present = listed.filter((d) => d.name !== SCRATCH_SUBDIR).map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`);
  return Array.from(new Set([...present, ...RUNNER_HOME_PRIVATE])).map((rel) => entry(home, rel));
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
