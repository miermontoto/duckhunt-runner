#!/usr/bin/env node
// cli del daemon de duckhunt (contrato 42): `login` conecta la credencial oauth (audiencia
// /api/runner), `repos`/`aws` mantienen los mapas locales, `status` diagnostica el kit de la
// máquina y el modo por defecto (`start`) arranca el loop de claim.

import { DEFAULT_BASE_URL, loadConfig } from './config.js';
import { login, parseLoginArgs } from './oauth.js';
import { RunnerDaemon } from './daemon.js';
import { reposCommand } from './repos.js';
import { awsCommand } from './aws.js';
import { statusCommand } from './status.js';

const USAGE = `duckhunt-runner — daemon local de agent runs

uso:
  duckhunt-runner login [base-url] [label]   conecta el runner (pega el código del browser)
                                            sin base-url apunta a ${DEFAULT_BASE_URL}
  duckhunt-runner status                     kit de esta máquina: claude, credencial, aws, repos
  duckhunt-runner start [--verbose]          arranca el daemon (config en ~/.duckhunt-runner.json)
  duckhunt-runner repos list|add|remove|discover
  duckhunt-runner aws list|add|remove
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
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
    console.error('sin config: ejecuta `duckhunt-runner login <base-url>` primero');
    process.exitCode = 1;
    return;
  }
  await new RunnerDaemon(cfg, { verboseLog: rest.includes('--verbose') }).run();
}

main().catch((err) => {
  console.error(`[runner] ${(err as Error).message}`);
  process.exitCode = 1;
});
