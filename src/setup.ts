// `duckhunt-runner setup` (t#660): el alta guiada en un comando. comprueba el kit de la máquina, le pone nombre, la
// conecta (navegador con vuelta automática o el code pegado, oauth.ts::connect), mapea los repos de una carpeta
// (repos.ts::planDiscover), propone las cuentas de los perfiles de la aws cli (aws-discover.ts) y la deja en marcha:
// como servicio de la sesión (service.ts) o en primer plano (lo arranca index.ts con la misma ruta que `start`).
// decisiones:
// - cada pregunta tiene su flag y su valor por defecto; `--yes` (o sin terminal) toma los valores por defecto sin
//   preguntar: provisionado y scripts. sin terminal y sin navegador, el code se lee del pipe como en `login`.
// - repetir `setup` es seguro: una máquina ya conectada a esa instancia se conserva salvo que se pida reconectar, lo
//   mapeado se queda (discover solo añade) y el servicio se reescribe con esta versión (actualizar = setup de nuevo).
// - un daemon ya en marcha fuera del servicio no se toca: adopta la credencial nueva solo (oauth.ts) y un servicio
//   encima no podría tomar su lock. se dice cómo pasarlo a servicio.
// - los requisitos no bloquean: sin claude code la máquina se vincula igual y el primer run lo dice; aquí se avisa.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { awsEntryOf, listAwsProfiles, planAwsAccounts, resolveAwsProfiles, type AwsProfileAccount } from './aws-discover.js';
import { interactiveAuth, NO_BROWSER_FLAG } from './browser-open.js';
import { detectClaude } from './claude.js';
import { loadStoredConfig, saveConfig } from './config.js';
import { daemonLockHolder } from './daemon-lock.js';
import { ownedHere } from './machine.js';
import { connect, parseLoginArgs } from './oauth.js';
import { applyDiscover, planDiscover } from './repos.js';
import { installService, serviceLogsHint, serviceManager, serviceRunning, SERVICE_NAME } from './service.js';
import { askLine } from './terminal-prompt.js';
import { runnerVersion } from './version.js';

const execFileP = promisify(execFile);

export const SETUP_FLAG = {
  name: '--name',
  repos: '--repos',
  noRepos: '--no-repos',
  noAws: '--no-aws',
  service: '--service',
  noService: '--no-service',
  yes: '--yes',
  yesShort: '-y',
} as const;

export const SETUP_USAGE = `uso: duckhunt-runner setup [base-url] [${SETUP_FLAG.name} <nombre>] [${SETUP_FLAG.repos} <dir> | ${SETUP_FLAG.noRepos}] [${SETUP_FLAG.noAws}]
                            [${SETUP_FLAG.service} | ${SETUP_FLAG.noService}] [${SETUP_FLAG.yes}] [${NO_BROWSER_FLAG}]`;

const STEPS = 5;
// carpetas de checkouts habituales bajo el home, en orden: la primera que exista es la que se propone.
const CODE_DIRS = ['dev', 'code', 'src', 'projects', 'repos', 'git', 'workspace', 'Developer'];
// respuesta que salta el paso de repos.
const SKIP_ANSWER = '-';
const YES_RE = /^(s|si|sí|y|yes)$/i;
const NO_RE = /^(n|no)$/i;
// página de duckhunt con las máquinas de la persona.
const MACHINES_PATH = '/settings/agents/connections#machines';

/** lo que se puede responder por flag (ver SETUP_USAGE). */
export interface SetupArgs {
  baseUrl: string;
  name?: string;
  // null = --no-repos.
  reposDir?: string | null;
  // false = --no-aws.
  aws?: boolean;
  service?: boolean;
  yes: boolean;
}

function usageError(): never {
  throw new Error(SETUP_USAGE);
}

/** los argumentos de `setup`. lanza con el uso si algo no casa. `--no-browser` lo lee interactiveAuth. */
export function parseSetupArgs(rest: readonly string[]): SetupArgs {
  const parsed: Omit<SetupArgs, 'baseUrl'> & { positional: string[] } = { yes: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      return next === undefined || next.startsWith('-') ? usageError() : next;
    };
    if (token === SETUP_FLAG.name) parsed.name = value();
    else if (token === SETUP_FLAG.repos) parsed.reposDir = value();
    else if (token === SETUP_FLAG.noRepos) parsed.reposDir = null;
    else if (token === SETUP_FLAG.noAws) parsed.aws = false;
    else if (token === SETUP_FLAG.service) parsed.service = true;
    else if (token === SETUP_FLAG.noService) parsed.service = false;
    else if (token === SETUP_FLAG.yes || token === SETUP_FLAG.yesShort) parsed.yes = true;
    else if (token === NO_BROWSER_FLAG) continue;
    else if (token.startsWith('-')) usageError();
    else parsed.positional.push(token);
  }
  if (parsed.positional.length > 2) usageError();
  // los posicionales, como los de `login`: la instancia si parece una url y, si no, el nombre.
  const { baseUrl, label } = parseLoginArgs(parsed.positional);
  const name = parsed.name ?? label;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    yes: parsed.yes,
    ...(name ? { name } : {}),
    ...(parsed.reposDir !== undefined ? { reposDir: parsed.reposDir } : {}),
    ...(parsed.aws === false ? { aws: false } : {}),
    ...(parsed.service !== undefined ? { service: parsed.service } : {}),
  };
}

const home = os.homedir();
const tildify = (p: string): string => (p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p);
const untildify = (p: string): string => (p === '~' || p.startsWith(`~${path.sep}`) || p.startsWith('~/') ? path.join(home, p.slice(1)) : p);
// el nombre corto de la máquina (sin el dominio).
const shortHost = (): string => os.hostname().split('.')[0] || os.hostname();

/** carpeta de checkouts que se propone: la primera de CODE_DIRS que existe bajo el home, o el home. */
export function defaultCodeDir(exists: (p: string) => boolean = (p) => fs.existsSync(p)): string {
  return CODE_DIRS.map((d) => path.join(home, d)).find(exists) ?? home;
}

// preguntas con su valor por defecto; sin terminal o con --yes, el valor por defecto sin preguntar.
class Prompter {
  constructor(private readonly interactive: boolean) {}

  async text(question: string, fallback: string): Promise<string> {
    if (!this.interactive) return fallback;
    return (await askLine(`${question} [${fallback}]: `)).trim() || fallback;
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    if (!this.interactive) return fallback;
    for (;;) {
      const answer = (await askLine(`${question} [${fallback ? 'S/n' : 's/N'}]: `)).trim();
      if (!answer) return fallback;
      if (YES_RE.test(answer)) return true;
      if (NO_RE.test(answer)) return false;
    }
  }
}

const step = (n: number, title: string): void => console.log(`\n[${n}/${STEPS}] ${title}`);
const ok = (text: string): void => console.log(`  ✓ ${text}`);
const warn = (text: string): void => console.log(`  ! ${text}`);

// versión de una herramienta de la máquina (su primera línea), o null si no está.
async function toolVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileP(cmd, args, { encoding: 'utf-8' })).stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

// paso 1: lo que los runs necesitan en esta máquina. avisa, no bloquea.
async function checkKit(): Promise<void> {
  step(1, 'requisitos');
  ok(`node ${process.versions.node}`);
  const claude = await detectClaude();
  if (claude.version) ok(`claude code ${claude.version}`);
  else warn('claude code no está en el PATH: los runs lo lanzan. instálalo (npm install -g @anthropic-ai/claude-code) y haz login con `claude`');
  const git = await toolVersion('git', ['--version']);
  if (git) ok(git);
  else warn('git no está en el PATH: sin él los runs no pueden leer ni editar tus repos');
}

// paso 2: nombre y credencial. una máquina ya conectada a esa instancia se conserva salvo que se pida reconectar.
async function connectStep(args: SetupArgs, prompt: Prompter, rawArgs: readonly string[]): Promise<string> {
  step(2, `conectar con ${args.baseUrl}`);
  const cfg = loadStoredConfig();
  const current = cfg?.label ?? shortHost();
  const connected = Boolean(cfg?.clientId && cfg.refreshToken && cfg.baseUrl === args.baseUrl && ownedHere(cfg));
  if (connected) {
    ok(`ya está conectada como «${current}»`);
    if (!(await prompt.confirm('  ¿volver a conectarla?', false))) {
      if (args.name && args.name !== cfg?.label) {
        saveConfig(() => ({ label: args.name }));
        ok(`ahora se llama «${args.name}»`);
      }
      return args.name ?? current;
    }
  }
  const name = args.name ?? (await prompt.text('  nombre de esta máquina', current));
  await connect(args.baseUrl, name, interactiveAuth(rawArgs));
  ok(`conectada como «${name}»`);
  return name;
}

// paso 3: mapear los checkouts de una carpeta (solo añade: lo mapeado se queda).
async function reposStep(args: SetupArgs, prompt: Prompter): Promise<void> {
  step(3, 'repos');
  const mapped = Object.keys(loadStoredConfig()?.repos ?? {}).length;
  if (mapped > 0) ok(`${mapped} repo(s) ya mapeados`);
  if (args.reposDir === null) {
    console.log('  saltado: mapea luego con `duckhunt-runner repos discover <dir>`');
    return;
  }
  const answer = args.reposDir ?? (await prompt.text(`  carpeta con tus checkouts git («${SKIP_ANSWER}» para saltar)`, tildify(defaultCodeDir())));
  if (answer === SKIP_ANSWER) {
    console.log('  saltado: mapea luego con `duckhunt-runner repos discover <dir>`');
    return;
  }
  const dir = path.resolve(untildify(answer));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    warn(`${tildify(dir)} no es un directorio: mapea luego con \`duckhunt-runner repos discover <dir>\``);
    return;
  }
  const plan = await planDiscover(dir, loadStoredConfig() ?? { repos: {} });
  plan.lines.forEach((line) => console.log(line));
  if (plan.fresh.length === 0) {
    if (plan.checkouts > 0) ok('nada nuevo que mapear');
    return;
  }
  if (await prompt.confirm(`  ¿mapear ${plan.fresh.length} repo(s)?`, true)) {
    applyDiscover(plan.fresh);
    ok(`${plan.fresh.length} repo(s) mapeados: solo su clave (workspace/slug) llega a duckhunt, nunca la ruta`);
  }
}

// paso 4: proponer las cuentas de los perfiles de la aws cli que aún no están mapeadas. una cuenta con varios perfiles
// pregunta cuál (sin terminal, se salta).
async function awsStep(args: SetupArgs, prompt: Prompter, interactive: boolean): Promise<void> {
  step(4, 'cuentas aws');
  const later = 'mapea luego con `duckhunt-runner aws add <account-id> <profile> [region]`';
  if (args.aws === false) {
    console.log(`  saltado: ${later}`);
    return;
  }
  const profiles = await listAwsProfiles();
  if (profiles === null) {
    console.log('  sin aws cli: los runs no leerán métricas, logs ni recursos de aws. instálala y repite `setup` si los quieres');
    return;
  }
  if (profiles.length === 0) {
    console.log(`  la aws cli no tiene perfiles: ${later}`);
    return;
  }
  console.log(`  ${profiles.length} perfil(es): compruebo a qué cuenta llega cada uno (sts get-caller-identity)…`);
  const plan = planAwsAccounts(await resolveAwsProfiles(profiles), loadStoredConfig()?.aws ?? {});
  plan.lines.forEach((line) => console.log(line));
  if (plan.fresh.length === 0) {
    ok('nada nuevo que mapear');
    return;
  }
  // una cuenta con varios perfiles: elige la persona (el número, o «-» para no mapearla).
  const picks: { account: string; profile: AwsProfileAccount }[] = [];
  for (const candidate of plan.fresh) {
    if (candidate.profiles.length === 1) {
      picks.push({ account: candidate.account, profile: candidate.profiles[0]! });
      continue;
    }
    if (!interactive) continue;
    const options = candidate.profiles.map((p, i) => `${i + 1} ${p.profile}`).join(', ');
    const answer = await prompt.text(`  ¿qué perfil para ${candidate.account}? (${options}, «${SKIP_ANSWER}» ninguno)`, '1');
    const chosen = candidate.profiles[Number.parseInt(answer, 10) - 1];
    if (chosen) picks.push({ account: candidate.account, profile: chosen });
  }
  if (picks.length === 0) return;
  if (await prompt.confirm(`  ¿mapear ${picks.length} cuenta(s) aws?`, true)) {
    saveConfig((current) => ({ aws: { ...current.aws, ...Object.fromEntries(picks.map((p) => [p.account, awsEntryOf(p.profile)])) } }));
    ok(`${picks.length} cuenta(s) mapeadas: solo el id de cuenta llega a duckhunt, nunca el perfil ni sus credenciales`);
  }
}

// paso 5: dejarlo en marcha. true = arrancarlo ahora en primer plano.
async function runStep(args: SetupArgs, prompt: Prompter): Promise<boolean> {
  step(5, 'mantenerlo en marcha');
  const manager = serviceManager();
  const holder = daemonLockHolder();
  if (holder && !serviceRunning(manager)) {
    ok(`ya hay un daemon en marcha (pid ${holder.pid}): recoge los cambios en su próxima vuelta`);
    if (manager) console.log('  para pasarlo a servicio: páralo y ejecuta `duckhunt-runner service install`');
    return false;
  }
  if (manager) {
    const how = manager === 'systemd' ? 'systemd --user' : 'launchd';
    if (args.service ?? (await prompt.confirm(`  ¿dejarlo en segundo plano y que arranque con tu sesión (${how})?`, true))) {
      const { file } = installService(manager);
      ok(`servicio ${SERVICE_NAME} en marcha (${tildify(file)})`);
      console.log(`  logs: ${serviceLogsHint(manager)}`);
      if (manager === 'systemd') console.log(`  para que siga sin una sesión abierta: loginctl enable-linger ${os.userInfo().username}`);
      console.log('  quitarlo: `duckhunt-runner service remove`');
      return false;
    }
  } else if (args.service) {
    warn('esta máquina no tiene systemd --user ni launchd: arranca en primer plano');
  }
  return true;
}

/** `setup` (ver cabecera). devuelve si index.ts debe arrancar el daemon en primer plano. */
export async function setupCommand(rest: readonly string[]): Promise<{ foreground: boolean }> {
  const args = parseSetupArgs(rest);
  const interactive = !args.yes && Boolean(process.stdin.isTTY);
  const prompt = new Prompter(interactive);
  console.log(`duckhunt-runner ${runnerVersion() ?? ''} · vincula esta máquina con duckhunt para que tus agentes trabajen en ella`);
  await checkKit();
  const name = await connectStep(args, prompt, rest);
  await reposStep(args, prompt);
  await awsStep(args, prompt, interactive);
  const foreground = await runStep(args, prompt);
  console.log(`\nlisto: «${name}» sale en ${args.baseUrl}${MACHINES_PATH} en cuanto reclame trabajo.`);
  if (foreground) console.log('arrancando el daemon en primer plano: déjalo abierto (ctrl-c lo para).\n');
  return { foreground };
}
