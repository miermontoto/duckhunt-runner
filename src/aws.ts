// subcomandos `duckhunt-runner aws ...`: mapa id de cuenta aws → perfil local de la aws cli. el
// claim trae solo el id de cuenta (y región) de la conexión del entry; el daemon lo traduce a
// AWS_PROFILE/AWS_DEFAULT_REGION del proceso claude. el server nunca ve perfiles ni credenciales.
// desde t#495 (M2) es también `resource … aws` (resource.ts), que acepta además la clave `default`: la identidad
// aws por defecto de la máquina, que solo existe si el usuario la expone. `aws add` sigue pidiendo un id de cuenta.
// 0.13.0 (t#495): `--s3-read [bucket[/prefijo]]…` al final de `add` deja leer objetos s3 a los runs con esa clave
// (resources/s3-read.ts): sin destinos, cualquier bucket que lea el perfil; sin el flag, como siempre.
// `discover [perfil…]` mapea sin escribir ids ni perfiles: los perfiles que la aws cli tiene guardados, la cuenta de cada
// uno según sts (aws-discover.ts) y su región. solo añade; una cuenta con varios perfiles no se mapea hasta que se
// nombra uno (`discover <perfil>`), como un repo con varios checkouts en `repos discover`.

import { applyAwsAccounts, listAwsProfiles, planAwsAccounts, resolveAwsProfiles, unambiguousPicks } from './aws-discover.js';
import { configPath, loadStoredConfig, saveConfig, type AwsAccountConfig, type StoredConfig } from './config.js';
import { AWS_ACCOUNT_ID_RE, AWS_DEFAULT_KEY, isAwsKey } from './resources/aws.js';
import { describeS3Scope, parseS3Target, s3ReadScopeOf, type S3ReadScope } from './resources/s3-read.js';

/** claves que acepta `add` y cómo se describen en el error. */
export interface AwsKeys {
  accepts: (key: string) => boolean;
  hint: string;
}

const ACCOUNT_KEYS: AwsKeys = { accepts: (key) => AWS_ACCOUNT_ID_RE.test(key), hint: '12 dígitos' };
/** las de `resource add aws`: un id de cuenta o `default`. */
export const RESOURCE_AWS_KEYS: AwsKeys = { accepts: isAwsKey, hint: `12 dígitos o \`${AWS_DEFAULT_KEY}\`` };

const USAGE = `uso:
  duckhunt-runner aws list
  duckhunt-runner aws add <account-id> <profile> [region] [--s3-read [bucket[/prefijo]]…]
  duckhunt-runner aws remove <account-id>
  duckhunt-runner aws discover [profile…] [--dry-run]
`;

/** el flag de `add` que deja leer objetos s3 a los runs con la clave. */
export const S3_READ_FLAG = '--s3-read';
/** el flag de `discover` que enseña lo que mapearía sin escribirlo. */
export const DRY_RUN_FLAG = '--dry-run';
// cómo se elige el perfil de una cuenta a la que llegan varios.
const PICK_HINT = '`duckhunt-runner aws discover <perfil>`';
// lo que se escribe del alcance en `list` y al añadir (nada si la clave no lo tiene).
const s3Note = (a: AwsAccountConfig): string => {
  const scope = s3ReadScopeOf(a.s3Read);
  return scope === null ? '' : scope === 'invalid' ? ' · lectura s3: no válida' : ` · lectura s3: ${describeS3Scope(scope as S3ReadScope)}`;
};

const fail = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};

// `discover` (ver cabecera): los perfiles pedidos (o todos), su cuenta y lo que se mapea sobre lo ya mapeado.
async function discover(rest: readonly string[], cfg: StoredConfig): Promise<void> {
  const flags = rest.filter((a) => a.startsWith('-'));
  if (flags.some((f) => f !== DRY_RUN_FLAG)) return fail(USAGE);
  const wanted = rest.filter((a) => !a.startsWith('-'));
  const all = await listAwsProfiles();
  if (all === null) return fail('sin aws cli en el PATH: instálala y configura sus perfiles (`aws configure` o `aws configure sso`)');
  const unknown = wanted.filter((p) => !all.includes(p));
  if (unknown.length > 0) return fail(`perfil(es) que la aws cli no tiene: ${unknown.join(', ')}`);
  const profiles = wanted.length > 0 ? wanted : all;
  if (profiles.length === 0) {
    console.log('la aws cli no tiene perfiles guardados (~/.aws/config, ~/.aws/credentials): créalos con `aws configure` o `aws configure sso`');
    return;
  }
  console.log(`${profiles.length} perfil(es): compruebo a qué cuenta llega cada uno (sts get-caller-identity)…`);
  const plan = planAwsAccounts(await resolveAwsProfiles(profiles), cfg.aws);
  plan.lines.forEach((line) => console.log(line));
  if (plan.fresh.length === 0) {
    console.log('nada nuevo que mapear');
    return;
  }
  plan.fresh.filter((c) => c.profiles.length > 1).forEach((c) => console.log(`  sin mapear ${c.account}: elige su perfil con ${PICK_HINT}`));
  const picks = unambiguousPicks(plan.fresh);
  if (picks.length === 0) return;
  if (rest.includes(DRY_RUN_FLAG)) {
    console.log(`dry-run: ${picks.length} cuenta(s) sin aplicar`);
    return;
  }
  applyAwsAccounts(picks);
  console.log(`mapeadas ${picks.length} cuenta(s) en ${configPath()}: solo el id de cuenta llega a duckhunt, nunca el perfil ni sus credenciales`);
}

export async function awsCommand(args: string[], keys: AwsKeys = ACCOUNT_KEYS): Promise<void> {
  // sin credencial también (tras `logout` los mapas se quedan): solo se leen y escriben los mapas.
  const cfg = loadStoredConfig();
  if (!cfg) {
    console.error('sin config: ejecuta `duckhunt-runner login <base-url>` primero');
    process.exitCode = 1;
    return;
  }
  const [sub, ...rest] = args;

  if (sub === 'list') {
    const entries = Object.entries(cfg.aws);
    if (entries.length === 0) {
      console.log('sin cuentas aws mapeadas. añade con `duckhunt-runner aws discover` (los perfiles de la aws cli) o `aws add <account-id> <profile> [region]`');
      return;
    }
    entries.forEach(([account, a]) => console.log(`  ${account} → perfil ${a.profile}${a.region ? ` (${a.region})` : ''}${s3Note(a)}`));
    return;
  }

  if (sub === 'add') {
    // lo que sigue a --s3-read son sus destinos; antes, los posicionales de siempre.
    const flagAt = rest.indexOf(S3_READ_FLAG);
    const positional = flagAt === -1 ? rest : rest.slice(0, flagAt);
    const targets = flagAt === -1 ? null : rest.slice(flagAt + 1);
    const [account, profile, region] = positional;
    if (!account || !profile) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    if (!keys.accepts(account)) {
      console.error(`id de cuenta inválido: "${account}" (${keys.hint})`);
      process.exitCode = 1;
      return;
    }
    const invalid = (targets ?? []).find((t) => parseS3Target(t) === null);
    if (invalid !== undefined) {
      console.error(`destino de --s3-read inválido: "${invalid}" (bucket o bucket/prefijo)`);
      process.exitCode = 1;
      return;
    }
    const entry: AwsAccountConfig = { profile, ...(region ? { region } : {}), ...(targets === null ? {} : { s3Read: targets.length === 0 ? true : targets }) };
    saveConfig((current) => ({ aws: { ...current.aws, [account]: entry } }));
    console.log(`mapeada la cuenta ${account} → perfil ${profile}${region ? ` (${region})` : ''}${s3Note(entry)} en ${configPath()}`);
    return;
  }

  if (sub === 'discover') {
    await discover(rest, cfg);
    return;
  }

  if (sub === 'remove') {
    const [account] = rest;
    if (!account || !(account in cfg.aws)) {
      console.error(account ? `cuenta no mapeada: ${account}` : USAGE);
      process.exitCode = 1;
      return;
    }
    saveConfig((current) => ({ aws: Object.fromEntries(Object.entries(current.aws).filter(([key]) => key !== account)) }));
    console.log(`eliminada la cuenta ${account}`);
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}
