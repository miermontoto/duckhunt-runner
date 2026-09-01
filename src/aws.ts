// subcomandos `duckhunt-runner aws ...`: mapa id de cuenta aws → perfil local de la aws cli. el
// claim trae solo el id de cuenta (y región) de la conexión del entry; el daemon lo traduce a
// AWS_PROFILE/AWS_DEFAULT_REGION del proceso claude. el server nunca ve perfiles ni credenciales.

import { configPath, loadConfig, saveConfig } from './config.js';

const ACCOUNT_ID_RE = /^\d{12}$/;

const USAGE = `uso:
  duckhunt-runner aws list
  duckhunt-runner aws add <account-id> <profile> [region]
  duckhunt-runner aws remove <account-id>
`;

export function awsCommand(args: string[]): void {
  const cfg = loadConfig();
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
    if (!ACCOUNT_ID_RE.test(account)) {
      console.error(`id de cuenta inválido: "${account}" (12 dígitos)`);
      process.exitCode = 1;
      return;
    }
    cfg.aws[account] = { profile, ...(region ? { region } : {}) };
    saveConfig(cfg);
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
    delete cfg.aws[account];
    saveConfig(cfg);
    console.log(`eliminada la cuenta ${account}`);
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}
