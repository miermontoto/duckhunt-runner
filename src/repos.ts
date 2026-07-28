// subcomandos `duckhunt-runner repos ...`: gestionan el mapa repo→checkout local de la
// config sin editar json a mano. el mapa es local A PROPÓSITO (el server nunca ve paths,
// contrato 32); al server solo viajan las KEYS via el claim (presencia, sin paths).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configPath, loadConfig, saveConfig } from './config.js';

// mismo formato que valida el server para target_repo.repo: workspace/slug u owner/repo.
const REPO_KEY_RE = /^[^/\s]+\/[^/\s]+$/;

const USAGE = `uso:
  duckhunt-runner repos list
  duckhunt-runner repos add <workspace/slug> <path> [--dangerously-skip-permissions] [--no-worktree]
  duckhunt-runner repos remove <workspace/slug>
  duckhunt-runner repos discover [dir] [--dry-run]   escanea checkouts git y los mapea por su remote
`;

// deriva la key workspace/slug del url del remote origin. cubre las formas habituales:
// git@host:ws/slug.git · https://host/ws/slug.git · ssh://git@host/ws/slug.git
// (los dos últimos segmentos del path, sin .git — coincide con target_repo.repo tanto
// para bitbucket como para github).
function repoKeyFromRemote(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, '');
  const scpLike = cleaned.match(/^[^@\s]+@[^:/\s]+:(.+)$/);
  const pathPart = scpLike
    ? scpLike[1]!
    : (() => {
        try {
          return new URL(cleaned).pathname.replace(/^\/+/, '');
        } catch {
          return null;
        }
      })();
  if (!pathPart) return null;
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const key = segments.slice(-2).join('/');
  return REPO_KEY_RE.test(key) ? key : null;
}

// url del remote origin de un checkout, o null si no es repo git / no tiene origin.
function originUrl(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    // sin repo git o sin remote origin: candidato descartado, no es un error.
    return null;
  }
}

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

  if (sub === 'discover') {
    const dryRun = rest.includes('--dry-run');
    const base = path.resolve(rest.find((a) => !a.startsWith('--')) ?? '.');
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      console.error(`directorio no existe: ${base}`);
      process.exitCode = 1;
      return;
    }
    // candidatos: el propio dir + sus hijos directos (los checkouts suelen vivir planos
    // bajo ~/dev; profundidad 1 evita recorrer node_modules y árboles enormes).
    const candidates = [
      base,
      ...fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => path.join(base, e.name)),
    ].filter((dir) => fs.existsSync(path.join(dir, '.git')));

    const found = candidates.flatMap((dir) => {
      const url = originUrl(dir);
      const key = url ? repoKeyFromRemote(url) : null;
      return key ? [{ key, dir }] : [];
    });
    if (found.length === 0) {
      console.log(`sin checkouts git con remote origin bajo ${base}`);
      return;
    }

    const skipped = found.filter(({ key }) => key in cfg.repos);
    const fresh = found.filter(({ key }) => !(key in cfg.repos));
    skipped.forEach(({ key }) => console.log(`  = ${key} ya mapeado (${cfg.repos[key]!.path})`));
    fresh.forEach(({ key, dir }) => console.log(`  + ${key} → ${dir}`));
    if (fresh.length === 0) {
      console.log('nada nuevo que mapear');
      return;
    }
    if (dryRun) {
      console.log(`dry-run: ${fresh.length} repo(s) sin aplicar`);
      return;
    }
    // los flags sensibles (skip-permissions, no-worktree) NUNCA se autodescubren:
    // son opt-in explícito por repo via `repos add` o editando la config.
    fresh.forEach(({ key, dir }) => (cfg.repos[key] = { path: dir }));
    saveConfig(cfg);
    console.log(`mapeados ${fresh.length} repo(s) en ${configPath()}`);
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
