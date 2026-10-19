// subcomandos `duckhunt-runner aws ...`: mapa id de cuenta aws → perfil local de la aws cli. el
// claim trae solo el id de cuenta (y región) de la conexión del entry; el daemon lo traduce a
// AWS_PROFILE/AWS_DEFAULT_REGION del proceso claude. el server nunca ve perfiles ni credenciales.
// desde t#495 (M2) es también `resource … aws` (resource.ts), que acepta además la clave `default`: la identidad
// aws por defecto de la máquina, que solo existe si el usuario la expone. `aws add` sigue pidiendo un id de cuenta.

import { configPath, loadStoredConfig, saveConfig } from './config.js';
import { AWS_ACCOUNT_ID_RE, AWS_DEFAULT_KEY, isAwsKey } from './resources/aws.js';

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
  duckhunt-runner aws add <account-id> <profile> [region]
  duckhunt-runner aws remove <account-id>
`;

export function awsCommand(args: string[], keys: AwsKeys = ACCOUNT_KEYS): void {
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
      console.log('sin cuentas aws mapeadas. añade con `duckhunt-runner aws add <account-id> <profile> [region]`');
      return;
    }
    entries.forEach(([account, a]) => console.log(`  ${account} → perfil ${a.profile}${a.region ? ` (${a.region})` : ''}`));
    return;
  }

  if (sub === 'add') {
    const [account, profile, region] = rest;
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
    saveConfig((current) => ({ aws: { ...current.aws, [account]: { profile, ...(region ? { region } : {}) } } }));
    console.log(`mapeada la cuenta ${account} → perfil ${profile}${region ? ` (${region})` : ''} en ${configPath()}`);
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
