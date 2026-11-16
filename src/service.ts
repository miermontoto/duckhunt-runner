// el daemon como servicio de la sesión del usuario (t#660): `setup` lo ofrece y `service install|remove` lo gestiona.
// linux = una unidad de systemd --user, macos = un LaunchAgent de launchd. en el resto (windows, un contenedor sin
// systemd) no hay servicio y `setup` arranca el daemon en primer plano.
// decisiones:
// - el comando del servicio fija la versión que lo instala. lanzado con npx (su caché, `_npx`, se puede vaciar en
//   cualquier momento) es `npx --yes duckhunt-runner@<versión> start`; instalado (global o un checkout), su propio
//   index.js con este node. reinstalar con otra versión reescribe la unidad: actualizar = `setup` o `service install`
//   con la versión nueva.
// - el entorno del servicio es el de quien lo instala, solo lo que necesita: PATH (claude, git, aws y node para npx;
//   un servicio de usuario arranca con un PATH mínimo), la config y el home del daemon si no son los de siempre, la
//   config de claude y los proxies. ni credenciales ni el resto del entorno. del PATH se quita lo que `npm exec` (npx)
//   mete delante al lanzar el paquete —el .bin de su caché, el de cada carpeta hasta la raíz y su node-gyp-bin— y los
//   repetidos: no es de quien instala, apunta a cachés efímeras y cada actualización desde duckhunt (t#670, que
//   reescribe la unidad desde el propio servicio) lo volvería a apilar.
// - exit 78 (EXIT_CODE_UNPAIRED: la máquina se desvinculó o caducó su credencial) no se reinicia en systemd
//   (RestartPreventExitStatus). launchd no sabe excluir un código: lo reintenta con un ThrottleInterval largo y el
//   daemon sale enseguida sin credencial; `service remove` lo quita.
// - systemd --user para el servicio al cerrar la última sesión salvo con linger: se sugiere, no se activa (es del
//   sistema y puede pedir permisos).
// - non-goal: windows (sin gestor de servicios de usuario equivalente sin privilegios).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerHome } from './config.js';
import { EXIT_CODE_UNPAIRED } from './daemon.js';
import { runnerVersion } from './version.js';

export const SERVICE_NAME = 'duckhunt-runner';
/** la unidad de systemd --user del daemon (self-update.ts la busca en el cgroup del proceso). */
export const SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;
/** el LaunchAgent del daemon (self-update.ts lo reconoce para no actualizarse dentro de él). */
export const LAUNCHD_LABEL_ID = 'info.duckhunt.runner';
const SYSTEMD_UNIT = SYSTEMD_UNIT_NAME;
const LAUNCHD_LABEL = LAUNCHD_LABEL_ID;
const PACKAGE_NAME = 'duckhunt-runner';
// variables del entorno de quien instala que el servicio hereda (ver cabecera).
const SERVICE_ENV_KEYS = ['PATH', 'DUCKHUNT_RUNNER_CONFIG', 'DUCKHUNT_RUNNER_HOME', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const;
// las que llevan un fichero o un directorio: absolutas (el servicio no arranca en el cwd de quien lo instala).
const SERVICE_PATH_KEYS: ReadonlySet<string> = new Set(['DUCKHUNT_RUNNER_CONFIG', 'DUCKHUNT_RUNNER_HOME', 'CLAUDE_CONFIG_DIR']);
// segmentos de ruta de un paquete lanzado con npx o pnpm dlx: su caché no es estable.
const EPHEMERAL_SEGMENTS = ['_npx', 'dlx'];
// lo que `npm exec` mete delante del PATH (ver cabecera): cualquier `…/node_modules/.bin` y el node-gyp-bin de npm.
const NPM_EXEC_PATH_RE = /(?:^|[\\/])node_modules[\\/]\.bin[\\/]?$|[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin[\\/]?$/;
const RESTART_SEC = 5;
const LAUNCHD_THROTTLE_S = 60;
/** la salida del daemon fuera de systemd (launchd y el relevo de una actualización, self-update.ts), en su home. */
export const DAEMON_LOG_FILE = 'daemon.log';
const USAGE = 'uso: duckhunt-runner service install|remove';

export type ServiceManager = 'systemd' | 'launchd';

/** el gestor de servicios de usuario de esta máquina, o null si no hay (ver cabecera). */
export function serviceManager(platform: NodeJS.Platform = process.platform): ServiceManager | null {
  if (platform === 'darwin') return 'launchd';
  if (platform !== 'linux') return null;
  try {
    // el gestor de la sesión responde: hay systemd --user (no en un contenedor o un wsl sin systemd).
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return 'systemd';
  } catch {
    return null;
  }
}

/** ¿este daemon corre desde una caché efímera de npx o pnpm dlx? (su script vive en ella). */
export const isEphemeralScript = (script: string): boolean => script.split(/[\\/]/).some((segment) => EPHEMERAL_SEGMENTS.includes(segment));

/** npx (el que va con este node, si está) fijado a duckhunt-runner@`version`: falta el subcomando. */
export function npxRunner(execPath: string, version: string): string[] {
  const npx = path.join(path.dirname(execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  return [fs.existsSync(npx) ? npx : 'npx', '--yes', `${PACKAGE_NAME}@${version}`];
}

/** el comando que arranca el daemon desde el servicio (ver cabecera): npx fijado a `version` si esto corre desde una
 *  caché efímera; si no, este node con su index.js. */
export function daemonCommand(script: string, execPath: string, version: string | null): string[] {
  if (!isEphemeralScript(script)) return [execPath, fs.existsSync(script) ? fs.realpathSync(script) : script, 'start'];
  if (!version) throw new Error('sin versión del daemon (package.json ilegible): no se puede fijar el comando del servicio');
  return [...npxRunner(execPath, version), 'start'];
}

/** el PATH del servicio: el de quien instala sin lo que mete `npm exec` y sin repetidos, en su orden (ver cabecera). */
export function servicePath(value: string, delimiter: string = path.delimiter): string {
  return [...new Set(value.split(delimiter).filter((dir) => dir !== '' && !NPM_EXEC_PATH_RE.test(dir)))].join(delimiter);
}

/** el entorno que hereda el servicio (ver cabecera). */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    SERVICE_ENV_KEYS.flatMap((key) => {
      const value = key === 'PATH' && env.PATH ? servicePath(env.PATH) : env[key];
      if (!value) return [];
      return [[key, SERVICE_PATH_KEYS.has(key) ? path.resolve(value) : value]];
    }),
  );
}

// un valor de systemd entre comillas: escapa `\` y `"`, y `%` (especificadores de la unidad).
const systemdQuote = (arg: string): string => `"${arg.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;
// un argumento de ExecStart: además `$`, que ahí se expande como variable (en Environment= no).
const execQuote = (arg: string): string => systemdQuote(arg).replace(/\$/g, '$$$$');

/** la unidad de systemd --user del daemon. */
export function systemdUnit(command: readonly string[], env: Record<string, string>): string {
  return [
    '[Unit]',
    'Description=duckhunt runner (agent runs on this machine)',
    'Documentation=https://github.com/miermontoto/duckhunt-runner#readme',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${command.map(execQuote).join(' ')}`,
    ...Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    'Restart=always',
    `RestartSec=${RESTART_SEC}`,
    `RestartPreventExitStatus=${EXIT_CODE_UNPAIRED}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** el LaunchAgent del daemon, con su salida en `logFile`. */
export function launchdPlist(command: readonly string[], env: Record<string, string>, logFile: string): string {
  const strings = (items: readonly string[]): string => items.map((item) => `    <string>${xml(item)}</string>`).join('\n');
  const vars = Object.entries(env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${LAUNCHD_THROTTLE_S}</integer>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/** dónde vive la unidad de systemd --user del daemon. */
export function systemdUnitPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT);
}

function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

const launchdDomain = (): string => `gui/${process.getuid?.() ?? 0}`;

const systemctl = (...args: string[]): void => {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
};

/** ¿el servicio está instalado y en marcha? (false sin gestor). */
export function serviceRunning(manager: ServiceManager | null = serviceManager()): boolean {
  try {
    if (manager === 'systemd') {
      execFileSync('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT], { stdio: 'ignore' });
      return true;
    }
    if (manager === 'launchd') {
      execFileSync('launchctl', ['print', `${launchdDomain()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
      return true;
    }
  } catch {
    // no instalado o parado: no está en marcha.
  }
  return false;
}

/** dónde ver lo que escribe el servicio. */
export function serviceLogsHint(manager: ServiceManager): string {
  return manager === 'systemd' ? `journalctl --user -u ${SERVICE_NAME} -f` : `tail -f ${path.join(runnerHome(), DAEMON_LOG_FILE)}`;
}

/** reescribe la unidad de systemd con duckhunt-runner@`version` y recarga systemd, SIN reiniciarla: la actualización
 *  desde duckhunt (self-update.ts) sale después y Restart=always la arranca en la versión nueva. lanza si falla. */
export function pinSystemdUnit(version: string): void {
  fs.writeFileSync(systemdUnitPath(), systemdUnit([...npxRunner(process.execPath, version), 'start'], serviceEnv()));
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}

/** instala (o reescribe) el servicio con este daemon y lo (re)arranca. lanza si el gestor falla. */
export function installService(manager: ServiceManager): { file: string } {
  const command = daemonCommand(process.argv[1] ?? '', process.execPath, runnerVersion());
  const env = serviceEnv();
  if (manager === 'systemd') {
    const file = systemdUnitPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemdUnit(command, env));
    systemctl('daemon-reload');
    systemctl('enable', SYSTEMD_UNIT);
    // restart arranca uno parado y releva a uno de otra versión.
    systemctl('restart', SYSTEMD_UNIT);
    return { file };
  }
  const file = launchdPlistPath();
  const logFile = path.join(runnerHome(), DAEMON_LOG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(file, launchdPlist(command, env, logFile));
  // uno ya cargado (otra versión) se descarga antes: bootstrap no relee un plist cargado.
  if (serviceRunning(manager)) execFileSync('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`], { stdio: 'inherit' });
  execFileSync('launchctl', ['bootstrap', launchdDomain(), file], { stdio: 'inherit' });
  return { file };
}

/** para y quita el servicio. false si no estaba instalado. */
export function removeService(manager: ServiceManager): boolean {
  const file = manager === 'systemd' ? systemdUnitPath() : launchdPlistPath();
  if (!fs.existsSync(file)) return false;
  if (manager === 'systemd') {
    systemctl('disable', '--now', SYSTEMD_UNIT);
    fs.rmSync(file);
    systemctl('daemon-reload');
  } else {
    if (serviceRunning(manager)) execFileSync('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`], { stdio: 'inherit' });
    fs.rmSync(file);
  }
  return true;
}

/** `duckhunt-runner service install|remove`. */
export function serviceCommand(args: readonly string[]): void {
  const [sub] = args;
  if (sub !== 'install' && sub !== 'remove') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const manager = serviceManager();
  if (!manager) {
    console.error('esta máquina no tiene systemd --user ni launchd: arranca el daemon con `duckhunt-runner start` (en tmux, screen…)');
    process.exitCode = 1;
    return;
  }
  if (sub === 'remove') {
    console.log(removeService(manager) ? `servicio ${SERVICE_NAME} parado y quitado` : `el servicio ${SERVICE_NAME} no estaba instalado`);
    return;
  }
  const { file } = installService(manager);
  console.log(`servicio ${SERVICE_NAME} en marcha (${file}). logs: ${serviceLogsHint(manager)}`);
  if (manager === 'systemd') console.log(`para que siga sin una sesión abierta: loginctl enable-linger ${os.userInfo().username}`);
}
