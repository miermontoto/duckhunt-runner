// cuentas aws de la máquina para el paso aws de `setup` (t#660): los perfiles de la aws cli, la cuenta de cada uno
// (sts get-caller-identity) y su región, y qué se propone mapear sobre lo ya mapeado. el mapa es el de `aws add`
// (aws.ts): id de cuenta → perfil; el server nunca ve perfiles ni credenciales.
// decisiones:
// - la cuenta la dice sts con el propio perfil (lo que el run usará), no el nombre del perfil: dos perfiles pueden ser
//   la misma cuenta (lectura y admin) y elegir uno es de la persona; sin terminal, una cuenta así no se mapea.
// - un perfil que sts rechaza (sso caducado, claves revocadas) no bloquea nada: se dice con su arreglo y se sigue.
// - sts va en paralelo y con tope de tiempo: un perfil colgado (proceso de credenciales, red) no cuelga setup.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AwsAccountConfig } from './config.js';
import { AWS_ACCOUNT_ID_RE } from './resources/aws.js';

const execFileP = promisify(execFile);

const AWS_TIMEOUT_MS = 15_000;
// sin paginador: la cli abriría less sobre la salida.
const AWS_ENV = { ...process.env, AWS_PAGER: '' };
// el rechazo de un perfil sso sin sesión (o caducada): su arreglo es `aws sso login`.
const SSO_EXPIRED_RE = /sso|token has expired|refresh failed/i;
const ERROR_MAX_CHARS = 120;

/** un perfil de la aws cli con su cuenta y su región; `error` si sts lo rechazó (account null). */
export interface AwsProfileAccount {
  profile: string;
  account: string | null;
  region: string | null;
  error?: string;
}

/** una cuenta sin mapear y los perfiles que llegan a ella. */
export interface AwsAccountCandidate {
  account: string;
  profiles: AwsProfileAccount[];
}

async function aws(args: string[]): Promise<string> {
  return (await execFileP('aws', args, { encoding: 'utf-8', timeout: AWS_TIMEOUT_MS, env: AWS_ENV })).stdout.trim();
}

/** los perfiles de la aws cli; null si no hay aws cli. */
export async function listAwsProfiles(): Promise<string[] | null> {
  try {
    return (await aws(['configure', 'list-profiles'])).split('\n').map((p) => p.trim()).filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`aws configure list-profiles falló: ${(err as Error).message}`);
  }
}

// lo que dice un rechazo de sts, en una línea y con su arreglo si es una sesión sso.
function stsError(profile: string, err: unknown): string {
  const stderr = String((err as { stderr?: unknown }).stderr ?? (err as Error).message).trim();
  if (SSO_EXPIRED_RE.test(stderr)) return `sin sesión: \`aws sso login --profile ${profile}\``;
  const line = stderr.split('\n').find((l) => l.trim()) ?? 'sin respuesta';
  return line.length > ERROR_MAX_CHARS ? `${line.slice(0, ERROR_MAX_CHARS)}…` : line;
}

// cuenta y región de un perfil.
async function resolveProfile(profile: string): Promise<AwsProfileAccount> {
  // sin región configurada la cli sale con 1: el perfil va sin región (la del claim o la de la cli al correr).
  const region = await aws(['configure', 'get', 'region', '--profile', profile]).catch(() => '');
  try {
    const account = await aws(['sts', 'get-caller-identity', '--profile', profile, '--query', 'Account', '--output', 'text']);
    return AWS_ACCOUNT_ID_RE.test(account) ? { profile, account, region: region || null } : { profile, account: null, region: region || null, error: `sts devolvió «${account}»` };
  } catch (err) {
    return { profile, account: null, region: region || null, error: stsError(profile, err) };
  }
}

/** la cuenta de cada perfil, en paralelo (ver cabecera). */
export function resolveAwsProfiles(profiles: readonly string[]): Promise<AwsProfileAccount[]> {
  return Promise.all(profiles.map(resolveProfile));
}

/** lo que se propone sobre lo ya mapeado: las cuentas nuevas con sus perfiles y una línea por perfil o cuenta vista
 *  (`+` una cuenta con un perfil, `?` varios perfiles de una cuenta, `=` ya mapeada, `!` perfil rechazado). */
export function planAwsAccounts(found: readonly AwsProfileAccount[], mapped: Readonly<Record<string, AwsAccountConfig>>): { fresh: AwsAccountCandidate[]; lines: string[] } {
  const byAccount = found
    .filter((p) => p.account !== null)
    .reduce((acc, p) => acc.set(p.account!, [...(acc.get(p.account!) ?? []), p]), new Map<string, AwsProfileAccount[]>());
  const accounts = [...byAccount.entries()].map(([account, profiles]) => ({ account, profiles }));
  const fresh = accounts.filter((a) => !(a.account in mapped));
  const describe = (p: AwsProfileAccount): string => `${p.profile}${p.region ? ` (${p.region})` : ''}`;
  const lines = [
    ...accounts.map((a) =>
      a.account in mapped
        ? `  = ${a.account} ya mapeada (perfil ${mapped[a.account]!.profile})`
        : a.profiles.length === 1
          ? `  + ${a.account} ← perfil ${describe(a.profiles[0]!)}`
          : `  ? ${a.account}: perfiles ${a.profiles.map(describe).join(', ')}`,
    ),
    ...found.filter((p) => p.error).map((p) => `  ! perfil ${p.profile}: ${p.error}`),
  ];
  return { fresh, lines };
}

/** la entrada del mapa para un perfil (la de `aws add <cuenta> <perfil> [región]`). */
export const awsEntryOf = (p: AwsProfileAccount): AwsAccountConfig => ({ profile: p.profile, ...(p.region ? { region: p.region } : {}) });
