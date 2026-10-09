// subcomandos `duckhunt-runner repos ...`: gestionan el mapa repo→checkout local de la config sin
// editar json a mano. el mapa es local A PROPÓSITO (el server nunca ve paths, contrato 42); al
// server solo viajan las KEYS via el claim (presencia, sin paths). `list` y `add` enseñan la salud
// de cada repo (repo-health.ts) y `discover` no mapea una key con varios checkouts distintos: antes
// el último pisaba al primero en silencio (okt-api-parked le ganó a okt-api por orden alfabético).

import fs from 'node:fs';
import path from 'node:path';
import { configPath, loadConfig, saveConfig } from './config.js';
import { REPO_KEY_RE, sameRepoKey } from './repo-key.js';
import { describeFinding, inspectCheckouts, repoFindings, scanRepos, type CheckoutState } from './repo-health.js';
import { scrubEnv } from './scrub-env.js';

const USAGE = `uso:
  duckhunt-runner repos list
  duckhunt-runner repos add <workspace/slug> <path> [--dangerously-skip-permissions] [--no-worktree]
  duckhunt-runner repos remove <workspace/slug>
  duckhunt-runner repos discover [dir] [--dry-run]   escanea checkouts git y los mapea por su remote
`;

// ficheros de settings de claude code que un run headless en ese repo cargará (hooks incluidos).
const CLAUDE_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

// aviso informativo: un hook Stop del repo se ejecuta al terminar cada run (p.ej. un rebuild de
// docker). el usuario asume sus hooks (decisión del contrato 42), pero conviene que lo sepa.
function warnStopHooks(repoPath: string): void {
  CLAUDE_SETTINGS_FILES.forEach((rel) => {
    const file = path.join(repoPath, rel);
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { hooks?: { Stop?: unknown[] } };
      if (Array.isArray(parsed.hooks?.Stop) && parsed.hooks.Stop.length > 0) {
        console.warn(`aviso: ${rel} define hooks Stop — se ejecutarán al terminar cada run en este repo`);
      }
    } catch {
      // settings ilegibles: no es asunto del daemon.
    }
  });
}

// checkout principal de un grupo del mismo repo: el que guarda el .git común (no un worktree enlazado).
const mainCheckout = (group: CheckoutState[]): CheckoutState =>
  group.find((s) => s.commonDir !== null && path.dirname(s.commonDir) === s.real) ?? group[0]!;

export async function reposCommand(args: string[]): Promise<void> {
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
      console.log('sin repos mapeados. añade con `duckhunt-runner repos add <workspace/slug> <path>` o `repos discover <dir>`');
      return;
    }
    const findings = repoFindings(await scanRepos(cfg.repos, scrubEnv(process.env)));
    entries.forEach(([repo, rc]) => {
      const flags = [
        ...(rc.dangerouslySkipPermissions ? ['skip-permissions'] : []),
        ...(rc.worktree === false ? ['sin worktree'] : []),
      ];
      console.log(`  ${repo} → ${rc.path}${flags.length ? `  (${flags.join(', ')})` : ''}`);
      findings.filter((f) => f.issue.repo === repo).forEach((f) => console.log(`      ⚠ ${describeFinding(f, false)}`));
    });
    findings.filter((f) => f.issue.repo === null).forEach((f) => console.log(`  ⚠ ${describeFinding(f)}`));
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
    warnStopHooks(abs);
    cfg.repos[repo] = {
      path: abs,
      ...(rest.includes('--dangerously-skip-permissions') ? { dangerouslySkipPermissions: true } : {}),
      ...(rest.includes('--no-worktree') ? { worktree: false } : {}),
    };
    saveConfig(cfg);
    console.log(`mapeado ${repo} → ${abs} en ${configPath()}`);
    // avisos no bloqueantes (no es git, el origin es otro repo, hay otro checkout…). con la config
    // ENTERA: sola, los demás repos mapeados del mismo directorio saldrían como checkouts sin mapear.
    const findings = repoFindings(await scanRepos(cfg.repos, scrubEnv(process.env)));
    findings.filter((f) => f.issue.repo === repo).forEach((f) => console.warn(`aviso: ${describeFinding(f, false)}`));
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

    // agrupados por key: los worktrees enlazados de un repo comparten git-common-dir y son UN checkout.
    const groups = (await inspectCheckouts(candidates, scrubEnv(process.env)))
      .filter((s) => s.root && s.key !== null)
      .reduce((acc, s) => acc.set(s.key!.toLowerCase(), [...(acc.get(s.key!.toLowerCase()) ?? []), s]), new Map<string, CheckoutState[]>());
    if (groups.size === 0) {
      console.log(`sin checkouts git con remote origin bajo ${base}`);
      return;
    }

    const fresh = [...groups.values()].flatMap((group) => {
      const key = group[0]!.key!;
      const repos = [...new Map(group.map((s) => [s.commonDir ?? s.real, s])).values()];
      const mapped = Object.keys(cfg.repos).find((k) => sameRepoKey(k, key));
      if (mapped) {
        const mappedPath = cfg.repos[mapped]!.path;
        const mappedReal = fs.existsSync(mappedPath) ? fs.realpathSync(mappedPath) : path.resolve(mappedPath);
        const mappedCommon = group.find((s) => s.real === mappedReal)?.commonDir ?? null;
        const others = repos.filter((s) => s.real !== mappedReal && (mappedCommon === null || s.commonDir !== mappedCommon)).map((s) => s.dir);
        console.log(`  = ${mapped} ya mapeado (${cfg.repos[mapped]!.path})${others.length ? `; también en ${others.join(', ')}` : ''}`);
        return [];
      }
      // varios checkouts distintos del mismo repo: elegir es del usuario, nunca del orden alfabético.
      if (repos.length > 1) {
        console.log(`  ? ${key}: ${repos.map((s) => s.dir).join(', ')} — varios checkouts: elige uno con \`repos add ${key} <path>\``);
        return [];
      }
      const pick = mainCheckout(group);
      console.log(`  + ${key} → ${pick.dir}`);
      return [{ key, dir: pick.dir }];
    });
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
