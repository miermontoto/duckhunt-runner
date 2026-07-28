#!/usr/bin/env node
// cli del runner de duckhunt (contrato 32 fase 2): `login <url>` conecta la credencial
// oauth (audiencia /api/runner) y el modo por defecto arranca el daemon de claim.

import { loadConfig } from './config.js';
import { login } from './oauth.js';
import { RunnerDaemon } from './daemon.js';
import { reposCommand } from './repos.js';

const USAGE = `duckhunt-runner — runner local de agent runs

uso:
  duckhunt-runner login <base-url> [label]   conecta el runner (pega el código del browser)
  duckhunt-runner repos list|add|remove      gestiona el mapa repo→checkout local
  duckhunt-runner                            arranca el daemon (config en ~/.duckhunt-runner.json)
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'login') {
    const [baseUrl, label] = rest;
    if (!baseUrl) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    await login(baseUrl, label);
    return;
  }
  if (cmd === 'repos') {
    reposCommand(rest);
    return;
  }
  if (cmd !== undefined && cmd !== 'run') {
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
  await new RunnerDaemon(cfg).run();
}

main().catch((err) => {
  console.error(`[runner] ${(err as Error).message}`);
  process.exitCode = 1;
});
