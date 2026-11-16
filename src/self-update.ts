// actualizarse desde duckhunt (t#670): la persona pide en la web la versión nueva y el bloque runner del claim la trae
// (`update`). el daemon (daemon.ts) deja de reclamar, espera a sus runs y aquí comprueba que esa versión arranca y se
// reinicia en ella. decisiones:
// - solo lanzado con npx (su caché, como lo instala `setup`): un paquete instalado (global o un checkout) se actualiza
//   con su gestor, y eso no lo decide el daemon.
// - en su servicio de systemd --user (service.ts) reescribe la unidad con la versión nueva y sale: Restart=always lo
//   arranca en ella. sin servicio (nohup, tmux, una terminal) lanza el relevo en segundo plano, en su propia sesión y
//   con la salida a <runnerHome>/daemon.log, y sale; el relevo espera a que este pid muera antes de tomar el lock
//   (HANDOFF_PID_ENV), así nunca hay dos daemons con la misma credencial.
// - bajo otro supervisor no lo intenta (selfUpdateMode null, sin la capability): launchd relanzaría la versión que
//   cargó (cambiar su plist pide un bootout, que mata a quien lo pide), y pm2, un contenedor (pid 1, /.dockerenv) o una
//   unidad de systemd ajena relanzarían la vieja junto al relevo: dos daemons con la misma credencial se la revocan.
// - antes de salir, `npx --yes duckhunt-runner@<versión> --version` tiene que contestar esa versión: una release que no
//   se puede bajar o no arranca deja el daemon como estaba, y el motivo (UpdateError, sin paths) va a duckhunt. corre en
//   el tmpdir: en un directorio con un package.json de duckhunt-runner (su checkout), npx ejecutaría ese y no el del
//   registro.
// - `defaults.remoteUpdate: false` lo apaga en la máquina (el daemon no anuncia la capability).

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { runnerHome } from './config.js';
import { pidAlive } from './daemon-lock.js';
import { DAEMON_LOG_FILE, LAUNCHD_LABEL_ID, SYSTEMD_UNIT_NAME, isEphemeralScript, npxRunner, pinSystemdUnit, systemdUnitPath } from './service.js';

const execFileP = promisify(execFile);

/** cómo se reinicia esta máquina en otra versión: su unidad de systemd, o un relevo en segundo plano. */
export const UPDATE_MODE = { systemd: 'systemd', detached: 'detached' } as const;
export type UpdateMode = (typeof UPDATE_MODE)[keyof typeof UPDATE_MODE];

/** el pid del daemon al que releva un arranque lanzado por una actualización. */
export const HANDOFF_PID_ENV = 'DUCKHUNT_RUNNER_HANDOFF_PID';
// lo que espera el relevo a que salga el daemon anterior, y cada cuánto lo mira.
const HANDOFF_WAIT_MS = 60_000;
const HANDOFF_POLL_MS = 250;
// lo que puede tardar npx en bajar y arrancar la versión nueva.
const VERIFY_TIMEOUT_MS = 180_000;
const CGROUP_FILE = '/proc/self/cgroup';
const CONTAINER_MARKER = '/.dockerenv';

/** un fallo que se puede contar a duckhunt tal cual: sin paths ni salida de comandos (eso va solo al log local). */
export class UpdateError extends Error {}

/** lo que decide si este proceso sabe reiniciarse solo (selfUpdateMode); processFacts() lee los de verdad. */
export interface ProcessFacts {
  // el script del daemon (process.argv[1]).
  script: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  // /proc/self/cgroup (null fuera de linux o ilegible).
  cgroup: string | null;
  inContainer: boolean;
  // la unidad de systemd --user del daemon existe donde la escribe service.ts.
  unitInstalled: boolean;
}

/** los hechos de este proceso. */
export function processFacts(): ProcessFacts {
  const read = (file: string): string | null => {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      // fuera de linux no existe: sin cgroup que mirar.
      return null;
    }
  };
  return {
    script: process.argv[1] ?? '',
    env: process.env,
    platform: process.platform,
    pid: process.pid,
    cgroup: process.platform === 'linux' ? read(CGROUP_FILE) : null,
    inContainer: fs.existsSync(CONTAINER_MARKER),
    unitInstalled: fs.existsSync(systemdUnitPath()),
  };
}

/** ¿este proceso corre dentro de la unidad de systemd del daemon? (su cgroup acaba en ella). */
export const inOwnSystemdUnit = (cgroup: string | null): boolean =>
  cgroup !== null && cgroup.split('\n').some((line) => line.trim().endsWith(`/${SYSTEMD_UNIT_NAME}`));

/** cómo se reinicia este daemon en otra versión, o null si no sabe hacerlo solo (ver cabecera). */
export function selfUpdateMode(f: ProcessFacts): UpdateMode | null {
  if (!isEphemeralScript(f.script) || f.platform === 'win32') return null;
  if (f.pid === 1 || f.inContainer || f.env.pm_id !== undefined) return null;
  // systemd pone INVOCATION_ID a todo lo que arranca: solo vale la unidad del daemon.
  if (f.env.INVOCATION_ID) return inOwnSystemdUnit(f.cgroup) && f.unitInstalled ? UPDATE_MODE.systemd : null;
  if (f.env.XPC_SERVICE_NAME === LAUNCHD_LABEL_ID) return null;
  return UPDATE_MODE.detached;
}

/** comprueba que duckhunt-runner@`version` se baja y arranca (contesta esa versión); lanza UpdateError si no. */
export async function verifyRunnerVersion(version: string, execPath = process.execPath): Promise<void> {
  const [cmd, ...args] = [...npxRunner(execPath, version), '--version'];
  let stdout: string;
  try {
    ({ stdout } = await execFileP(cmd!, args, { cwd: os.tmpdir(), timeout: VERIFY_TIMEOUT_MS, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    console.error(`[runner] npx duckhunt-runner@${version} --version falló: ${e.message}`);
    if (e.killed) throw new UpdateError(`npx tardó más de ${VERIFY_TIMEOUT_MS / 1000} s en bajar duckhunt-runner@${version}`);
    if (e.code === 'ENOENT') throw new UpdateError('npx no está en esta máquina');
    throw new UpdateError(`npx no pudo bajar o arrancar duckhunt-runner@${version}${typeof e.code === 'number' ? ` (salida ${e.code})` : ''}`);
  }
  const said = stdout.trim().split('\n').at(-1)?.trim() ?? '';
  if (said !== version) {
    console.error(`[runner] npx duckhunt-runner@${version} --version contestó «${said}»`);
    throw new UpdateError(`duckhunt-runner@${version} contestó otra versión`);
  }
}

// los argumentos con los que arranca el relevo: `start`, con --verbose si este lo llevaba.
const successorArgs = (argv: readonly string[]): string[] => ['start', ...(argv.includes('--verbose') ? ['--verbose'] : [])];

/**
 * deja lista la versión `version` para que arranque en cuanto este daemon salga: en systemd, la unidad reescrita y
 * recargada; sin servicio, el relevo ya lanzado (espera a este pid). lanza UpdateError si no pudo: el daemon sigue.
 */
export async function restartInto(mode: UpdateMode, version: string): Promise<void> {
  if (mode === UPDATE_MODE.systemd) {
    try {
      pinSystemdUnit(version);
      return;
    } catch (err) {
      console.error(`[runner] no se pudo reescribir la unidad de systemd: ${(err as Error).message}`);
      throw new UpdateError('no se pudo reescribir la unidad de systemd de la máquina');
    }
  }
  const logFile = path.join(runnerHome(), DAEMON_LOG_FILE);
  let log: number;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    log = fs.openSync(logFile, 'a');
  } catch (err) {
    console.error(`[runner] no se pudo abrir ${logFile}: ${(err as Error).message}`);
    throw new UpdateError('no se pudo abrir el log del relevo en la máquina');
  }
  const [cmd, ...args] = [...npxRunner(process.execPath, version), ...successorArgs(process.argv.slice(2))];
  try {
    const child = spawn(cmd!, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, [HANDOFF_PID_ENV]: String(process.pid) },
    });
    await Promise.race([once(child, 'spawn'), once(child, 'error').then(([err]) => Promise.reject(err as Error))]);
    child.unref();
    console.log(`[runner] relevo en duckhunt-runner@${version} lanzado (pid ${child.pid}, log ${logFile})`);
  } catch (err) {
    console.error(`[runner] no se pudo lanzar el relevo: ${(err as Error).message}`);
    throw new UpdateError('no se pudo lanzar el daemon nuevo en la máquina');
  } finally {
    fs.closeSync(log);
  }
}

/** lo que el daemon usa para actualizarse: cómo se reinicia esta máquina (null = no sabe), comprobar una versión y dejar
 *  listo el arranque en ella. las pruebas pasan uno falso. */
export interface SelfUpdater {
  mode: UpdateMode | null;
  verify(version: string): Promise<void>;
  restart(mode: UpdateMode, version: string): Promise<void>;
}

/** el de este proceso: su modo según sus hechos, npx para comprobar y la unidad o el relevo para reiniciarse. */
export const processUpdater = (): SelfUpdater => ({
  mode: selfUpdateMode(processFacts()),
  verify: (version) => verifyRunnerVersion(version),
  restart: restartInto,
});

/** en un arranque que releva a otro daemon (HANDOFF_PID_ENV), espera a que ese salga antes de tomar el lock. */
export async function awaitHandoff(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pid = Number(env[HANDOFF_PID_ENV]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !pidAlive(pid)) return;
  console.log(`[runner] esperando a que salga el daemon anterior (pid ${pid})`);
  const deadline = Date.now() + HANDOFF_WAIT_MS;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
}
