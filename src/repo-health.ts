// salud de los repos mapeados (t#463): lo que hace fallar o confunde un run ANTES de que falle. el
// origen: un checkout movido dejó un .git a medias en el path mapeado y los runs de reglas fallaron
// un día entero sin que nadie se enterase. el daemon la mide al arrancar y cada
// REPO_HEALTH_INTERVAL_MS (nunca por claim: son cientos de procesos git), la imprime al cambiar y la
// anuncia en el claim como `repoIssues`: key + código + recuento, NUNCA paths (contrato 42: el mapa
// repo→checkout es local). `status` y `repos list|add|discover` la enseñan con los paths.
// - bloqueantes (el run falla o trabaja sobre OTRO repo): missing, not_git (incluye un path dentro de
//   otro repo: git subiría al padre y el worktree saldría de él) y remote_mismatch.
// - avisos: no_origin, duplicate (otro checkout con el mismo origin entre los hermanos de los
//   mapeados, profundidad 1 como `repos discover`; un worktree enlazado del mismo repo no cuenta,
//   se distingue por el git-common-dir), shared_path (un checkout bajo varias keys) y
//   orphan_worktrees (worktrees del daemon que nadie recogerá: los que git ya no registra y los de un
//   checkout que ya no está mapeado, que el gc no recorre; sin repo legible van con repo null).
// un checkout roto con el repo en otro sitio no se cuenta como duplicado: el detalle lo sugiere.

import fs from 'node:fs';
import path from 'node:path';
import type { RepoConfig } from './config.js';
import { repoKeyFromRemote, sameRepoKey } from './repo-key.js';
import { gitMaybe, worktreesDir } from './worktree.js';

// cadencia del chequeo (y el primero, al arrancar).
export const REPO_HEALTH_INTERVAL_MS = 10 * 60_000;
// issues por claim (RUNNER_REPO_ISSUES_MAX del server).
export const REPO_ISSUES_MAX = 200;
// procesos git a la vez: un escaneo son cientos y no deben competir con los runs.
const GIT_BATCH = 8;
const WORKTREE_LINE_PREFIX = 'worktree ';

export const REPO_ISSUE = {
  missing: 'missing',
  notGit: 'not_git',
  remoteMismatch: 'remote_mismatch',
  noOrigin: 'no_origin',
  duplicate: 'duplicate',
  sharedPath: 'shared_path',
  orphanWorktrees: 'orphan_worktrees',
} as const;
export type RepoIssueKind = (typeof REPO_ISSUE)[keyof typeof REPO_ISSUE];

const ISSUE_LABEL: Record<RepoIssueKind, string> = {
  missing: 'el checkout no existe',
  not_git: 'no es un checkout git usable',
  remote_mismatch: 'su origin es otro repo',
  no_origin: 'sin remote origin',
  duplicate: 'otros checkouts del mismo repo',
  shared_path: 'checkout mapeado bajo varias keys',
  orphan_worktrees: 'worktrees del daemon huérfanos',
};

/** lo que viaja al server: key (null = huérfanos de un checkout sin repo legible), código y recuento. */
export interface RepoIssue {
  repo: string | null;
  kind: RepoIssueKind;
  count?: number;
}

/** hallazgo local: el issue más el detalle con paths, solo para el log y la cli. */
export interface RepoFinding {
  issue: RepoIssue;
  detail: string;
}

/** lo que se sabe de un directorio (mapeado, hermano de uno mapeado o candidato de discover). */
export interface CheckoutState {
  dir: string;
  real: string;
  exists: boolean;
  // toplevel según git; null = git no lo reconoce.
  top: string | null;
  // es la raíz de un checkout (no un subdirectorio de otro repo).
  root: boolean;
  key: string | null;
  // .git común: agrupa los worktrees enlazados de un mismo repo.
  commonDir: string | null;
  // directorios bajo .duckhunt/worktrees y los que git registra como worktree (realpaths).
  worktrees: string[];
  registered: ReadonlySet<string>;
}

const realOrSelf = (p: string): string => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));

const finding = (repo: string | null, kind: RepoIssueKind, detail: string, count?: number): RepoFinding => ({
  issue: { repo, kind, ...(count !== undefined ? { count } : {}) },
  detail,
});

function daemonWorktrees(dir: string): string[] {
  const root = worktreesDir(dir);
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch (err) {
    console.error(`[runner] repos: no se pudo leer ${root}: ${(err as Error).message}`);
    return [];
  }
}

async function inspect(dir: string, env: NodeJS.ProcessEnv): Promise<CheckoutState> {
  const exists = fs.existsSync(dir);
  const real = realOrSelf(dir);
  const worktrees = exists ? daemonWorktrees(dir) : [];
  const base = { dir, real, exists, top: null, root: false, key: null, commonDir: null, worktrees, registered: new Set<string>() };
  if (!exists) return base;
  const top = await gitMaybe(dir, ['rev-parse', '--show-toplevel'], env);
  if (top === null || realOrSelf(top) !== real) return { ...base, top };
  const [url, commonDir, list] = await Promise.all([
    gitMaybe(dir, ['remote', 'get-url', 'origin'], env),
    gitMaybe(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env),
    worktrees.length > 0 ? gitMaybe(dir, ['worktree', 'list', '--porcelain'], env) : Promise.resolve(null),
  ]);
  const registered = new Set(
    (list ?? '')
      .split('\n')
      .filter((line) => line.startsWith(WORKTREE_LINE_PREFIX))
      .map((line) => realOrSelf(line.slice(WORKTREE_LINE_PREFIX.length))),
  );
  return { ...base, top, root: true, key: url ? repoKeyFromRemote(url) : null, commonDir: commonDir ? realOrSelf(commonDir) : null, registered };
}

// i/o por tandas: un escaneo son cientos de procesos git y no deben salir todos a la vez.
async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += GIT_BATCH) out.push(...(await Promise.all(items.slice(i, i + GIT_BATCH).map(fn))));
  return out;
}

/** inspecciona directorios candidatos a checkout (lo comparten el chequeo y `repos discover`). */
export function inspectCheckouts(dirs: string[], env: NodeJS.ProcessEnv): Promise<CheckoutState[]> {
  return inBatches([...new Set(dirs)], (dir) => inspect(dir, env));
}

// hermanos de los checkouts mapeados que son checkouts git o guardan worktrees del daemon.
function siblingDirs(parents: string[], mappedReals: ReadonlySet<string>): string[] {
  return parents.flatMap((parent) =>
    fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(parent, e.name))
      .filter((dir) => (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(worktreesDir(dir))) && !mappedReals.has(realOrSelf(dir))),
  );
}

// worktrees del daemon que git no registra en ese checkout (en uno roto, todos).
const unregistered = (s: CheckoutState): string[] => s.worktrees.filter((w) => !s.registered.has(realOrSelf(w)));

function findingsFor(repo: string, s: CheckoutState, known: CheckoutState[]): RepoFinding[] {
  const healthy = s.root && s.key !== null && sameRepoKey(s.key, repo);
  // el mismo repo en otro directorio (un worktree enlazado del checkout mapeado no cuenta).
  const elsewhere = known.filter(
    (o) => o.key !== null && sameRepoKey(o.key, repo) && o.real !== s.real && (!healthy || o.commonDir !== s.commonDir),
  );
  const hint = elsewhere[0] ? `; está en ${elsewhere[0].dir} (\`duckhunt-runner repos add ${repo} ${elsewhere[0].dir}\`)` : '';
  if (!s.exists) return [finding(repo, REPO_ISSUE.missing, `${s.dir} no existe${hint}`)];
  if (!s.root) {
    const why = s.top ? `${s.dir} está dentro de otro repo (${s.top})` : `git no reconoce ${s.dir} como checkout`;
    return [finding(repo, REPO_ISSUE.notGit, `${why}${hint}`)];
  }
  if (s.key === null) return [finding(repo, REPO_ISSUE.noOrigin, `${s.dir} no tiene un remote origin del que derivar la key${hint}`)];
  if (!healthy) return [finding(repo, REPO_ISSUE.remoteMismatch, `el origin de ${s.dir} es ${s.key}${hint}`)];
  return elsewhere.length > 0 ? [finding(repo, REPO_ISSUE.duplicate, `también en ${elsewhere.map((o) => o.dir).join(', ')}`, elsewhere.length)] : [];
}

/** chequeo completo de los repos mapeados: un hallazgo por problema, en el orden de la config. */
export async function checkRepoHealth(repos: Record<string, RepoConfig>, env: NodeJS.ProcessEnv): Promise<RepoFinding[]> {
  const mapped = Object.entries(repos);
  const states = new Map((await inspectCheckouts(mapped.map(([, rc]) => rc.path), env)).map((s) => [s.dir, s]));
  const stateOf = (rc: RepoConfig): CheckoutState => states.get(rc.path)!;
  const mappedReals = new Set([...states.values()].map((s) => s.real));
  const parents = [...new Set(mapped.map(([, rc]) => path.dirname(path.resolve(rc.path))))].filter((p) => fs.existsSync(p));
  const siblings = await inspectCheckouts(siblingDirs(parents, mappedReals), env);
  const known = [...states.values(), ...siblings];

  const perRepo = mapped.flatMap(([repo, rc]) => findingsFor(repo, stateOf(rc), known));
  const keysByReal = mapped.reduce((acc, [repo, rc]) => acc.set(stateOf(rc).real, [...(acc.get(stateOf(rc).real) ?? []), repo]), new Map<string, string[]>());
  const stateByReal = new Map(mapped.map(([, rc]) => [stateOf(rc).real, stateOf(rc)]));
  // worktrees que git no registra: UNA vez por checkout, bajo la key que casa con su origin (o la primera).
  const orphaned = [...keysByReal].flatMap(([real, keys]) => {
    const s = stateByReal.get(real)!;
    const orphans = unregistered(s);
    if (orphans.length === 0) return [];
    const owner = keys.find((k) => s.key !== null && sameRepoKey(s.key, k)) ?? keys[0]!;
    return [finding(owner, REPO_ISSUE.orphanWorktrees, `${orphans.length} en ${worktreesDir(s.dir)} que git ya no registra`, orphans.length)];
  });
  // el mismo checkout bajo varias keys: como mucho una casa con su origin, las demás ya son mismatch.
  const shared = mapped.flatMap(([repo, rc]) => {
    const keys = keysByReal.get(stateOf(rc).real)!;
    return keys.length > 1 ? [finding(repo, REPO_ISSUE.sharedPath, `${rc.path} también está mapeado como ${keys.filter((k) => k !== repo).join(', ')}`, keys.length)] : [];
  });
  // worktrees en checkouts que ya no están mapeados: el gc solo recorre los mapeados.
  const stranded = siblings
    .filter((s) => s.worktrees.length > 0)
    .map((s) => {
      const owner = s.key === null ? null : (mapped.find(([repo]) => sameRepoKey(repo, s.key!))?.[0] ?? null);
      return finding(owner, REPO_ISSUE.orphanWorktrees, `${s.worktrees.length} en ${worktreesDir(s.dir)}: ese checkout ya no está mapeado y el gc no los recoge`, s.worktrees.length);
    });
  return [...perRepo, ...orphaned, ...shared, ...stranded];
}

/** issues para el claim: sin paths, agrupados por (repo, código) sumando recuentos y capados. */
export function repoIssues(findings: RepoFinding[]): RepoIssue[] {
  const merged = findings.reduce((acc, { issue }) => {
    const id = `${issue.repo ?? ''}\0${issue.kind}`;
    const prev = acc.get(id);
    const count = (prev?.count ?? 0) + (issue.count ?? 0);
    return acc.set(id, { repo: issue.repo, kind: issue.kind, ...(count > 0 ? { count } : {}) });
  }, new Map<string, RepoIssue>());
  return [...merged.values()].slice(0, REPO_ISSUES_MAX);
}

/** línea de log/cli de un hallazgo (con paths: nunca sale de la máquina); sin repo bajo su propia fila. */
export function describeFinding(f: RepoFinding, withRepo = true): string {
  const line = `${ISSUE_LABEL[f.issue.kind]} — ${f.detail}`;
  return withRepo ? `${f.issue.repo ?? '(sin repo)'}: ${line}` : line;
}
