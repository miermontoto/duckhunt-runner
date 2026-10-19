// aws del proceso claude de un run: la cuenta del claim → el perfil que la mapea en esta máquina
// (`aws add`). desde 0.11.0 (capability aws_strict, t#465 P12) una cuenta que esta máquina NO mapea falla
// cerrado: AWS_CONFIG_FILE y AWS_SHARED_CREDENTIALS_FILE apuntan a ficheros vacíos del propio run, sin
// perfil, sin claves en el env y sin metadata de instancia o contenedor. antes caía en el perfil por
// defecto, que puede ser OTRA cuenta (el server ya no manda los patrones aws a una plantilla cuya cuenta
// no anuncia la máquina, t#465 P6; esto es la segunda línea, también para los prompt runs).
// decisiones:
// - los ficheros vacíos van en el run-config de la plataforma (paths.ts), aws-<run>-<rand>/ (0700, como los mcp-config: ya
//   negado a Read en todo kit) y se borran al cerrar el segmento; un run en edición podría escribir en
//   ellos (`aws configure set`) y uno compartido contaminaría a otros runs. los que dejó un daemon muerto
//   se borran al arrancar.
// - sin cuenta en el claim (o sin aws) nada cambia: el env del usuario tal cual, como siempre.
// proveedor de recursos (t#495, M2): la aws es el recurso de la fase env (resources/types.ts). la clave es el id
// de cuenta del claim y la ref su perfil mapeado; una clave sin mapear degrada a la aws vacía con un aviso. lo
// que pone se calcula como diff sobre el env de partida, y el directorio de aws vacía se borra al soltar.
// - `default` (la identidad aws por defecto de la máquina) es una clave más que el usuario expone a mano: nada
//   la crea sola, y un claim legacy sin cuenta sigue con el env del usuario tal cual.
// - aislar (isolate): un claim toolset_v1 sin grant de aws corre con la aws vacía, sin región. un claim legacy
//   nunca se aísla: lo decide quien hace el plan (registry.ts, solo con toolset_v1).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AwsAccountConfig } from '../config.js';
import { runConfigDir } from '../paths.js';
import { PHASE, type ResourceProvider, type RunContext } from './types.js';

export const AWS_TYPE = 'aws';
// identidad aws por defecto de la máquina: una clave que solo existe si el usuario la expone.
export const AWS_DEFAULT_KEY = 'default';
export const AWS_ACCOUNT_ID_RE = /^\d{12}$/;
export const AWS_PARAM = {
  region: 'region',
} as const;

const AWS_EMPTY_PREFIX = 'aws-';
const AWS_EMPTY_RANDOM_BYTES = 4;
const AWS_EMPTY_DIR_MODE = 0o700;
const AWS_EMPTY_FILE_MODE = 0o600;
const AWS_CONFIG = 'config';
const AWS_CREDENTIALS = 'credentials';
// todo lo que daría credenciales a la aws cli sin los ficheros de config: perfiles, claves en el env,
// web identity y los endpoints de credenciales de contenedor.
const AWS_CREDENTIAL_VARS = [
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
];

/** la cuenta y región aws que trae el claim de un run (null = sin aws). */
export type RunAws = { accountId: string | null; region: string | null } | null;

/** env aws de un run y, si falló cerrado, la cuenta sin mapear (para el feed). */
export interface RunAwsEnv {
  env: NodeJS.ProcessEnv;
  unmapped: string | null;
}

/**
 * env del proceso claude con la aws del run: el perfil mapeado (y su región), o, con una cuenta sin
 * mapear, la aws cli sin credenciales (emptyDir: el directorio con config y credentials vacíos). no muta `base`.
 */
export function runAwsEnv(base: NodeJS.ProcessEnv, aws: RunAws, map: Record<string, AwsAccountConfig>, emptyDir: () => string): RunAwsEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const accountId = aws?.accountId ?? null;
  const account = accountId && Object.hasOwn(map, accountId) ? map[accountId] : undefined;
  if (account) {
    env.AWS_PROFILE = account.profile;
    const region = account.region ?? aws?.region ?? undefined;
    if (region) env.AWS_DEFAULT_REGION = region;
    return { env, unmapped: null };
  }
  if (aws?.region) env.AWS_DEFAULT_REGION = aws.region;
  if (!accountId) return { env, unmapped: null };
  return { env: withEmptyAws(env, emptyDir()), unmapped: accountId };
}

// la aws cli sin credenciales: sin perfil ni claves en el env, sin metadata y con los ficheros vacíos de `dir`.
// muta y devuelve `env` (una copia del llamador).
function withEmptyAws(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  AWS_CREDENTIAL_VARS.forEach((key) => delete env[key]);
  env.AWS_CONFIG_FILE = path.join(dir, AWS_CONFIG);
  env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, AWS_CREDENTIALS);
  env.AWS_EC2_METADATA_DISABLED = 'true';
  return env;
}

/** crea el directorio de un run con la config y las credenciales de aws vacías (0700 / 0600). devuelve su ruta. */
export function writeEmptyAwsConfig(runId: string, platform: string): string {
  const dir = path.join(runConfigDir(platform), `${AWS_EMPTY_PREFIX}${runId}-${crypto.randomBytes(AWS_EMPTY_RANDOM_BYTES).toString('hex')}`);
  fs.mkdirSync(dir, { mode: AWS_EMPTY_DIR_MODE });
  [AWS_CONFIG, AWS_CREDENTIALS].forEach((name) => fs.writeFileSync(path.join(dir, name), '', { mode: AWS_EMPTY_FILE_MODE, flag: 'wx' }));
  return dir;
}

/** borra los directorios de aws vacía que dejó un daemon anterior. solo al arrancar, con el lock tomado. devuelve cuántos. */
export function clearRunAwsConfigs(platform: string): number {
  const dir = runConfigDir(platform);
  const stale = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith(AWS_EMPTY_PREFIX));
  stale.forEach((d) => fs.rmSync(path.join(dir, d.name), { recursive: true, force: true }));
  return stale.length;
}

/** clave aws válida: un id de cuenta o la identidad por defecto. */
export const isAwsKey = (key: string): boolean => AWS_ACCOUNT_ID_RE.test(key) || key === AWS_DEFAULT_KEY;

/** aviso del feed de una cuenta que esta máquina no mapea. */
export const unmappedAwsWarning = (account: string): string =>
  `cuenta aws ${account} sin mapear en esta máquina: la aws cli corre sin credenciales (\`duckhunt-runner aws add ${account} <perfil>\`)`;

// lo que una aws pone o quita respecto al env de partida (null = la quita).
const envDiff = (base: NodeJS.ProcessEnv, next: NodeJS.ProcessEnv): Record<string, string | null> => ({
  ...Object.fromEntries(Object.entries(next).filter((e): e is [string, string] => e[1] !== undefined && base[e[0]] !== e[1])),
  ...Object.fromEntries(Object.keys(base).filter((k) => base[k] !== undefined && !Object.hasOwn(next, k)).map((k) => [k, null])),
});

// el directorio de aws vacía de un run (solo si hace falta) y cómo soltarlo.
function emptyDirOf(ctx: RunContext): { create: () => string; drop: () => Promise<void> } {
  let dir: string | null = null;
  return {
    create: () => (dir = writeEmptyAwsConfig(ctx.runId, ctx.platform)),
    drop: async () => {
      if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const awsProvider: ResourceProvider<AwsAccountConfig> = {
  type: AWS_TYPE,
  phase: PHASE.env,

  async materialize(req, ref, ctx) {
    const empty = emptyDirOf(ctx);
    const map = req.key !== null && ref ? { [req.key]: ref } : {};
    const { env, unmapped } = runAwsEnv(ctx.env, { accountId: req.key, region: req.params[AWS_PARAM.region] ?? null }, map, empty.create);
    return { env: envDiff(ctx.env, env), warnings: unmapped ? [unmappedAwsWarning(unmapped)] : [], release: empty.drop };
  },

  async isolate(ctx) {
    const empty = emptyDirOf(ctx);
    return { env: envDiff(ctx.env, withEmptyAws({ ...ctx.env }, empty.create())), warnings: [], release: empty.drop };
  },

  sweep: clearRunAwsConfigs,
};
