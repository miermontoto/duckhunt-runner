// subcomandos `duckhunt-runner repos ...`: gestionan el mapa repo→checkout local de la
// config sin editar json a mano. el mapa es local A PROPÓSITO (el server nunca ve paths,
// contrato 32); al server solo viajan las KEYS via el claim (presencia, sin paths).

import fs from 'node:fs';
import path from 'node:path';
import { configPath, loadConfig, saveConfig } from './config.js';

// mismo formato que valida el server para target_repo.repo: workspace/slug u owner/repo.
const REPO_KEY_RE = /^[^/\s]+\/[^/\s]+$/;

const USAGE = `uso:
  duckhunt-runner repos list
  duckhunt-runner repos add <workspace/slug> <path> [--dangerously-skip-permissions] [--no-worktree]
  duckhunt-runner repos remove <workspace/slug>
`;

export function reposCommand(args: string[]): void {
  const cfg = loadConfig();
  if (!cfg) {
    console.error('sin config: ejecuta `duckhunt-runner login <base-url>` primero');
    process.exitCode = 1;
    return;
  }
  const [sub, ...rest] = args;

  if (sub === 'list') {
    const entries = Object.entries(cfg.repos);
    if (entries.length === 0) {
      console.log('sin repos mapeados. añade con `duckhunt-runner repos add <workspace/slug> <path>`');
      return;
    }
    entries.forEach(([repo, rc]) => {
      const flags = [
        ...(rc.dangerouslySkipPermissions ? ['skip-permissions'] : []),
        ...(rc.worktree === false ? ['sin worktree'] : []),
      ];
      console.log(`  ${repo} → ${rc.path}${flags.length ? `  (${flags.join(', ')})` : ''}`);
    });
    return;
  }

  if (sub === 'add') {
    const positional = rest.filter((a) => !a.startsWith('--'));
    const [repo, repoPath] = positional;
    if (!repo || !repoPath) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    if (!REPO_KEY_RE.test(repo)) {
      console.error(`repo inválido: "${repo}" (formato workspace/slug, como aparece en las branches del target)`);
      process.exitCode = 1;
      return;
    }
    const abs = path.resolve(repoPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      console.error(`path no existe o no es un directorio: ${abs}`);
      process.exitCode = 1;
      return;
    }
    // aviso no bloqueante: el aislamiento por run necesita un checkout git.
    if (!fs.existsSync(path.join(abs, '.git'))) {
      console.warn(`aviso: ${abs} no parece un checkout git (.git ausente)`);
    }
    cfg.repos[repo] = {
      path: abs,
      ...(rest.includes('--dangerously-skip-permissions') ? { dangerouslySkipPermissions: true } : {}),
      ...(rest.includes('--no-worktree') ? { worktree: false } : {}),
    };
    saveConfig(cfg);
    console.log(`mapeado ${repo} → ${abs} en ${configPath()}`);
    return;
  }

  if (sub === 'remove') {
    const [repo] = rest;
    if (!repo || !(repo in cfg.repos)) {
      console.error(repo ? `repo no mapeado: ${repo}` : USAGE);
      process.exitCode = 1;
      return;
    }
    delete cfg.repos[repo];
    saveConfig(cfg);
    console.log(`eliminado ${repo}`);
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}
