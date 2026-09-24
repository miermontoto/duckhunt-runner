#!/usr/bin/env node
// cli del daemon de duckhunt (contrato 42): `login` conecta la credencial oauth (audiencia
// /api/runner), `repos`/`aws` mantienen los mapas locales, `status` diagnostica el kit de la
// máquina y el modo por defecto (`start`) arranca el loop de claim.

import { configPath, DEFAULT_BASE_URL, loadConfig } from './config.js';
import { login, parseLoginArgs } from './oauth.js';
import { RunnerDaemon } from './daemon.js';
import { reposCommand } from './repos.js';
import { awsCommand } from './aws.js';
import { statusCommand } from './status.js';
import { runnerVersion } from './version.js';

const USAGE = `duckhunt-runner — daemon local de agent runs

uso:
  duckhunt-runner login [base-url] [label]   conecta el runner (pega el código del browser)
                                            sin base-url apunta a ${DEFAULT_BASE_URL}
  duckhunt-runner status                     kit de esta máquina: claude, credencial, aws, repos
  duckhunt-runner start [--verbose]          arranca el daemon
  duckhunt-runner repos list|add|remove|discover
  duckhunt-runner aws list|add|remove
  duckhunt-runner --version

config en ~/.duckhunt-runner.json (otra con DUCKHUNT_RUNNER_CONFIG=<fichero>); scratch y logs en
~/.duckhunt-runner/ (otro con DUCKHUNT_RUNNER_HOME=<dir>).
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version' || cmd === 'version') {
    console.log(runnerVersion() ?? 'desconocida');
    return;
  }
  if (cmd === 'login') {
    const { baseUrl, label } = parseLoginArgs(rest);
    await login(baseUrl, label);
    return;
  }
  if (cmd === 'status') {
    await statusCommand();
    return;
  }
  if (cmd === 'repos') {
    reposCommand(rest);
    return;
  }
  if (cmd === 'aws') {
    awsCommand(rest);
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
  // salida explícita: los sockets keep-alive de fetch no deben alargar la parada.
  process.exit(await new RunnerDaemon(cfg, { verboseLog: rest.includes('--verbose') }).run());
}

main().catch((err) => {
  console.error(`[runner] ${(err as Error).message}`);
  process.exitCode = 1;
});
