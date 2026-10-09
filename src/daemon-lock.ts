// un solo daemon por directorio de estado: lock en <runnerHome>/daemon.lock con el pid y la config de
// su dueño. dos daemons sobre la misma config se revocan la credencial (el refresh token rota en cada
// uso y duckhunt trata uno viejo como replay) y compartirían scratch y logs. `start` lo toma o se
// niega; `login` y `status` lo leen para avisar. un lock huérfano (su pid ya no vive: kill -9, corte,
// reinicio) se reemplaza; el pid propio también cuenta como huérfano (en un contenedor el daemon
// arranca siempre con el mismo pid), y en linux también el de otro arranque del sistema (boot_id):
// tras un reinicio los pids se reutilizan y un servicio con Restart=always quedaría en bucle. otra
// cuenta en la misma máquina necesita su DUCKHUNT_RUNNER_HOME además de su DUCKHUNT_RUNNER_CONFIG.
// non-goals: dos arranques en el mismo instante sobre un lock huérfano pueden ganar los dos; un pid
// huérfano reutilizado por otro proceso en el MISMO arranque bloquea el arranque (el error dice qué
// fichero borrar).

import fs from 'node:fs';
import path from 'node:path';
import { configPath, runnerHome } from './config.js';

const DAEMON_LOCK_FILE = 'daemon.lock';
const LOCK_FILE_MODE = 0o600;
// id del arranque actual del sistema (solo linux; en un contenedor, el del host).
const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
// intentos de crear el lock: el segundo, tras quitar uno huérfano.
const ACQUIRE_ATTEMPTS = 2;

export interface DaemonLockHolder {
  pid: number;
  // config del daemon, absoluta: `login` solo avisa si es la suya.
  config: string;
  startedAt: string;
  // arranque del sistema en el que se tomó (ausente fuera de linux).
  bootId?: string;
}

// id del arranque en curso; null donde no existe (macos).
function currentBootId(): string | null {
  try {
    return fs.readFileSync(BOOT_ID_FILE, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** fichero del lock del daemon. */
export function daemonLockPath(): string {
  return path.join(runnerHome(), DAEMON_LOCK_FILE);
}

// contenido del lock; null si no existe o está ilegible (un arranque cortado a medias: huérfano).
function readHolder(file: string): DaemonLockHolder | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: Partial<DaemonLockHolder>;
  try {
    parsed = JSON.parse(text) as Partial<DaemonLockHolder>;
  } catch {
    // json ilegible = lock huérfano: el contenido se escribe en el mismo open exclusivo que lo crea.
    return null;
  }
  const { pid, config, startedAt, bootId } = parsed ?? {};
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof config === 'string'
    ? { pid, config, startedAt: typeof startedAt === 'string' ? startedAt : '?', ...(typeof bootId === 'string' ? { bootId } : {}) }
    : null;
}

// EPERM = existe pero es de otro usuario: vivo (mejor no arrancar que revocar la credencial).
function alive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** daemon vivo que tiene el lock; null = libre o huérfano. */
export function daemonLockHolder(): DaemonLockHolder | null {
  const holder = readHolder(daemonLockPath());
  if (!holder) return null;
  const boot = currentBootId();
  // de otro arranque: su pid puede ser ahora cualquier otro proceso.
  if (holder.bootId !== undefined && boot !== null && holder.bootId !== boot) return null;
  return alive(holder.pid) ? holder : null;
}

/** toma el lock o lanza diciendo quién lo tiene; devuelve con qué soltarlo (solo si sigue siendo suyo). */
export function acquireDaemonLock(): () => void {
  const file = daemonLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const boot = currentBootId();
  const mine: DaemonLockHolder = {
    pid: process.pid,
    config: path.resolve(configPath()),
    startedAt: new Date().toISOString(),
    ...(boot !== null ? { bootId: boot } : {}),
  };
  const release = (): void => {
    if (readHolder(file)?.pid === process.pid) fs.rmSync(file, { force: true });
  };
  const attempt = (n: number): (() => void) => {
    try {
      fs.writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: 'wx', mode: LOCK_FILE_MODE });
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = daemonLockHolder();
    if (holder) {
      throw new Error(
        `ya hay un daemon en marcha (pid ${holder.pid}, config ${holder.config}, desde ${holder.startedAt}). uno solo por config: el refresh token rota en cada uso y duckhunt revoca la credencial si ve uno viejo (sube defaults.maxConcurrent en vez de arrancar otro); otra cuenta necesita su DUCKHUNT_RUNNER_HOME y su DUCKHUNT_RUNNER_CONFIG. si ese pid no es un duckhunt-runner, borra ${file}`,
      );
    }
    if (n >= ACQUIRE_ATTEMPTS) throw new Error(`no se pudo tomar ${file}: otro arranque lo creó a la vez`);
    fs.rmSync(file, { force: true });
    return attempt(n + 1);
  };
  return attempt(1);
}
