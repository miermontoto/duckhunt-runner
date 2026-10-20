#!/usr/bin/env node
// cli del daemon de duckhunt (contrato 42): `login` conecta la credencial oauth (audiencia
// /api/runner), `logout` la desvincula desde la máquina (0.11.0, t#465 P12: logout.ts), `repos`/`aws`
// mantienen los mapas locales, `status` diagnostica el kit de la máquina y lo último que duckhunt dijo
// de ella, y el modo por defecto (`start`) arranca el loop de claim. `start` toma antes de nada el lock
// de un solo daemon (daemon-lock.ts) y lo suelta al salir; `login`, `repos` y `aws` con el daemon en
// marcha valen sin reiniciarlo (lo recarga en cada vuelta de su loop). `resource` (t#495, M2) es la cli genérica
// de los recursos de la máquina por tipo: `repos` y `aws` son sus tipos repo y aws (resource.ts).
// (t#495, M6.4) `login <url> --as [id]` da de alta otra plataforma (platform-login.ts), `platforms` las gestiona
// (platforms-cli.ts) y `logout <id>` desvincula una; `login` y `logout` a secas son los de siempre (duckhunt).
// (t#495, M7) `browser` gestiona las sesiones de navegador guardadas por odysea (browser-cli.ts).

import { configPath, DEFAULT_BASE_URL, loadConfig } from './config.js';
import { acquireDaemonLock } from './daemon-lock.js';
import { login, parseLoginArgs } from './oauth.js';
import { logoutCommand } from './logout.js';
import { parsePlatformLoginArgs, platformLogin } from './platform-login.js';
import { platformsCommand } from './platforms-cli.js';
import { RunnerDaemon } from './daemon.js';
import { reposCommand } from './repos.js';
import { awsCommand } from './aws.js';
import { resourceCommand } from './resource.js';
import { statusCommand } from './status.js';
import { auditCommand } from './audit-cli.js';
import { browserCommand } from './browser-cli.js';
import { runnerVersion } from './version.js';

const USAGE = `duckhunt-runner — daemon local de agent runs

uso:
  duckhunt-runner login [base-url] [label]   conecta el runner (pega el código del browser)
                                            sin base-url apunta a ${DEFAULT_BASE_URL}
  duckhunt-runner login <url> --as [id] [--name <n>] [--trusted]
                                            da de alta otra plataforma (su discovery y su oauth)
  duckhunt-runner logout                     desvincula esta máquina de duckhunt y borra su credencial
  duckhunt-runner logout <id>                lo mismo con otra plataforma
  duckhunt-runner platforms list|pause|resume|remove|expose|unexpose|trust|untrust
                                            las plataformas de esta máquina
  duckhunt-runner status                     kit de esta máquina y lo que duckhunt dice de ella
  duckhunt-runner status --platforms         cada plataforma: estado, cuota, techo, lo expuesto y su auditoría
  duckhunt-runner start [--verbose]          arranca el daemon
  duckhunt-runner repos list|add|remove|discover
  duckhunt-runner aws list|add|remove
  duckhunt-runner resource list|add|remove|check [repo|aws|browser]   los recursos de la máquina por tipo
  duckhunt-runner browser login|list|check|remove   sesiones de navegador guardadas (odysea)
  duckhunt-runner audit [--platform <id>] [--since 7d|<fecha>] [--json]   lo que corrió cada plataforma
  duckhunt-runner --version

config en ~/.duckhunt-runner.json (otra con DUCKHUNT_RUNNER_CONFIG=<fichero>); scratch, logs y
configs de run en ~/.duckhunt-runner/ (otro con DUCKHUNT_RUNNER_HOME=<dir>).
instala fijando la versión: npx duckhunt-runner@${runnerVersion() ?? '<versión>'} <comando>.
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version' || cmd === 'version') {
    console.log(runnerVersion() ?? 'desconocida');
    return;
  }
  if (cmd === 'login') {
    const platform = parsePlatformLoginArgs(rest);
    if (platform) {
      await platformLogin(platform);
      return;
    }
    const { baseUrl, label } = parseLoginArgs(rest);
    await login(baseUrl, label);
    return;
  }
  if (cmd === 'logout') {
    await logoutCommand(rest[0]);
    return;
  }
  if (cmd === 'platforms') {
    await platformsCommand(rest);
    return;
  }
  if (cmd === 'status') {
    await statusCommand(rest);
    return;
  }
  if (cmd === 'repos') {
    await reposCommand(rest);
    return;
  }
  if (cmd === 'aws') {
    awsCommand(rest);
    return;
  }
  if (cmd === 'audit') {
    auditCommand(rest);
    return;
  }
  if (cmd === 'resource') {
    await resourceCommand(rest);
    return;
  }
  if (cmd === 'browser') {
    await browserCommand(rest);
    return;
  }
  if (cmd !== undefined && cmd !== 'start' && cmd !== 'run') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error(`sin config (${configPath()}): ejecuta \`duckhunt-runner login <base-url>\` primero`);
    process.exitCode = 1;
    return;
  }
  process.once('exit', acquireDaemonLock());
  // salida explícita: los sockets keep-alive de fetch no deben alargar la parada.
  process.exit(await new RunnerDaemon(cfg, { verboseLog: rest.includes('--verbose') }).run());
}

main().catch((err) => {
  console.error(`[runner] ${(err as Error).message}`);
  process.exitCode = 1;
});
