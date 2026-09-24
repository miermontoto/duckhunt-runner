// worktrees git donde corre `claude`, bajo <checkout>/.duckhunt/worktrees/:
// - run-<id>: runs de reglas (investigar). detached sobre la rama del run (local u origin) o HEAD,
//   sin fetch; el daemon lo borra en done y lo conserva en failed para autopsia.
// - conv-<id>: prompt runs (t#378), uno POR CONVERSACIÓN. detached sobre origin/<rama> tras un
//   `git fetch`; si la rama no existe aún, sobre la rama por defecto del remoto (origin/HEAD) y el
//   agente la crea si el prompt lo pide. se CONSERVA entre segmentos (waiting/done/failed): lo que
//   edite el perfil edit sobrevive a una pregunta o a un seguimiento. lo recoge conversation-gc.ts.
// toda rama que viene del server se valida (cordura del claim + `git check-ref-format --branch`, que
// es quien decide) y ningún argumento de git va sin `--end-of-options`: un nombre que empiece por
// '-' no es un flag. una rama que git no acepta NO falla el run: worktree sobre la base por defecto
// con un aviso (como hacía 0.3.1 con HEAD). un conv-<id> borrado a mano sin `git worktree remove`
// sigue registrado y el `worktree add` fallaría para siempre: antes de crearlo, `git worktree prune`.
// al server solo viaja una nota corta con la base git (`origin/main@a1b2c3d`): ni paths absolutos ni el
// nombre del directorio (conv-88 se leía en la ui como id del run, que es r#88).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidBranchName } from './claim.js';

const execFileP = promisify(execFile);

const WORKTREES_SUBDIR = path.join('.duckhunt', 'worktrees');
export const CONVERSATION_WORKTREE_PREFIX = 'conv-';
export const RUN_WORKTREE_PREFIX = 'run-';
// git local (rev-parse, worktree add, status) y de red (fetch, que puede colgarse en un prompt de ssh).
const GIT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;
const SHORT_SHA_CHARS = 7;
const REMOTE = 'origin';
const REMOTE_PREFIX = `${REMOTE}/`;

export interface PreparedWorktree {
  workdir: string;
  // nota para agent_run.workdir (sin paths absolutos).
  note: string;
  // avisos para el log y el feed (fetch fallido, rama que no existe…).
  warnings: string[];
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env, timeout, encoding: 'utf-8' });
  return stdout.trim();
}

// variante que devuelve null en vez de lanzar: para sondas cuyo fallo es una respuesta (la ref no existe).
const gitMaybe = (cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> =>
  git(cwd, args, env).then(
    (out) => out || null,
    () => null,
  );

/** directorio de los worktrees del daemon dentro de un checkout. */
export function worktreesDir(repoPath: string): string {
  return path.join(repoPath, WORKTREES_SUBDIR);
}

/** sha del commit al que apunta una ref, o null si no existe. */
export function resolveCommit(repoPath: string, ref: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return gitMaybe(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], env);
}

/** cordura del claim + `git check-ref-format --branch` (que ya rechaza un nombre que empiece por '-'). */
export async function isUsableBranch(repoPath: string, branch: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!isValidBranchName(branch)) return false;
  return git(repoPath, ['check-ref-format', '--branch', branch], env).then(
    () => true,
    () => false,
  );
}

async function fetchRef(repoPath: string, ref: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return git(repoPath, ['fetch', '--quiet', REMOTE, '--end-of-options', ref], env, GIT_FETCH_TIMEOUT_MS).then(
    () => true,
    () => false,
  );
}

// true si `dir` es la raíz de un worktree git registrado y usable.
async function isWorktreeRoot(dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const top = await gitMaybe(dir, ['rev-parse', '--show-toplevel'], env);
  return top !== null && fs.realpathSync(top) === fs.realpathSync(dir);
}

// descripción corta del HEAD de un worktree existente: `feat/x@a1b2c3d` o `HEAD@a1b2c3d` (+ cambios).
async function describeHead(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const [branch, sha, status] = await Promise.all([
    gitMaybe(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env),
    gitMaybe(dir, ['rev-parse', '--short', 'HEAD'], env),
    gitMaybe(dir, ['status', '--porcelain'], env),
  ]);
  const changes = status ? status.split('\n').length : 0;
  return `${branch ?? 'HEAD'}@${sha ?? '?'}${changes > 0 ? ` (${changes} cambios sin commitear)` : ''}`;
}

/** marca el worktree como usado ahora (el gc mide la inactividad por el mtime del directorio). */
export function touchWorktree(dir: string): void {
  const now = new Date();
  try {
    fs.utimesSync(dir, now, now);
  } catch (err) {
    console.error(`[runner] no se pudo marcar el uso del worktree ${path.basename(dir)}: ${(err as Error).message}`);
  }
}

// registros de worktrees cuyo directorio ya no existe: sin esto `worktree add` sobre el mismo path
// falla con "missing but already registered worktree". barato y nunca toca directorios existentes.
async function pruneWorktrees(repoPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  await git(repoPath, ['worktree', 'prune'], env).catch((err: Error) => console.error(`[runner] git worktree prune falló: ${err.message}`));
}

// reutiliza el worktree si ya existe (segmento siguiente de la misma fila). null = hay que crearlo.
async function reuseWorktree(repoPath: string, dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!fs.existsSync(dir)) {
    await pruneWorktrees(repoPath, env);
    return null;
  }
  if (await isWorktreeRoot(dir, env)) {
    touchWorktree(dir);
    return describeHead(dir, env);
  }
  // registro huérfano (alguien borró el .git del worktree): prune y, si el directorio sigue con
  // contenido, no se toca: podría ser trabajo del usuario.
  await pruneWorktrees(repoPath, env);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`${path.join(WORKTREES_SUBDIR, path.basename(dir))} existe pero no es un worktree git válido: revísalo y bórralo a mano`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

async function addDetached(repoPath: string, dir: string, sha: string, env: NodeJS.ProcessEnv): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repoPath, ['worktree', 'add', '--quiet', '--detach', '--end-of-options', dir, sha], env);
}

interface Base {
  sha: string;
  label: string;
  warnings: string[];
}

// base por defecto: la rama a la que apunta origin/HEAD (fetch de esa rama antes) o el HEAD del checkout.
async function defaultBase(repoPath: string, env: NodeJS.ProcessEnv): Promise<Base> {
  const remoteHead = await gitMaybe(repoPath, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${REMOTE}/HEAD`], env);
  if (remoteHead?.startsWith(REMOTE_PREFIX)) {
    const fetched = await fetchRef(repoPath, remoteHead.slice(REMOTE_PREFIX.length), env);
    const sha = await resolveCommit(repoPath, `refs/remotes/${remoteHead}`, env);
    if (sha) return { sha, label: remoteHead, warnings: fetched ? [] : [`git fetch de ${remoteHead} falló: base con la copia local`] };
  }
  const sha = await resolveCommit(repoPath, 'HEAD', env);
  if (!sha) throw new Error('el checkout no tiene ningún commit (HEAD vacío)');
  return { sha, label: 'HEAD', warnings: [`sin ${REMOTE}/HEAD: worktree sobre el HEAD del checkout`] };
}

/**
 * worktree de una conversación (prompt run): reutiliza conv-<id> si ya existe; si no, lo crea
 * detached sobre origin/<rama> (fetch antes), la rama local, o la base por defecto si la rama es nueva.
 */
export async function prepareConversationWorktree(repoPath: string, runId: number, branch: string | null, env: NodeJS.ProcessEnv): Promise<PreparedWorktree> {
  const name = `${CONVERSATION_WORKTREE_PREFIX}${runId}`;
  const dir = path.join(worktreesDir(repoPath), name);
  const reused = await reuseWorktree(repoPath, dir, env);
  if (reused !== null) return { workdir: dir, note: reused, warnings: [] };

  const usable = branch !== null && (await isUsableBranch(repoPath, branch, env));
  const rejected = branch !== null && !usable ? [`rama ${JSON.stringify(branch)} no válida para git: worktree sobre la rama por defecto`] : [];
  const base = await (async (): Promise<Base & { newBranch: string | null }> => {
    if (branch === null || !usable) return { ...(await defaultBase(repoPath, env)), newBranch: null };
    const fetched = await fetchRef(repoPath, branch, env);
    const remote = await resolveCommit(repoPath, `refs/remotes/${REMOTE}/${branch}`, env);
    if (remote) {
      return { sha: remote, label: `${REMOTE_PREFIX}${branch}`, warnings: fetched ? [] : [`git fetch de ${branch} falló: base con la copia local de ${REMOTE_PREFIX}${branch}`], newBranch: null };
    }
    const local = await resolveCommit(repoPath, `refs/heads/${branch}`, env);
    if (local) return { sha: local, label: branch, warnings: [`${branch} no existe en ${REMOTE}: worktree sobre la rama local`], newBranch: null };
    return { ...(await defaultBase(repoPath, env)), newBranch: branch };
  })();
  await addDetached(repoPath, dir, base.sha, env);
  const at = `${base.label}@${base.sha.slice(0, SHORT_SHA_CHARS)}`;
  return {
    workdir: dir,
    note: base.newBranch ? `${base.newBranch} (rama nueva) sobre ${at}` : at,
    warnings: [...rejected, ...base.warnings],
  };
}

/** worktree efímero de un run de reglas: detached sobre la rama (local u origin) o HEAD, sin fetch. */
export async function prepareRunWorktree(repoPath: string, runId: number, branch: string | null, env: NodeJS.ProcessEnv): Promise<PreparedWorktree> {
  const name = `${RUN_WORKTREE_PREFIX}${runId}`;
  const dir = path.join(worktreesDir(repoPath), name);
  // el mismo run re-encolado (respuesta a su pregunta) tras un segmento fallido: su worktree sigue ahí.
  const reused = await reuseWorktree(repoPath, dir, env);
  if (reused !== null) return { workdir: dir, note: reused, warnings: [] };
  const usable = branch !== null && (await isUsableBranch(repoPath, branch, env));
  const candidates = usable ? [`refs/heads/${branch}`, `refs/remotes/${REMOTE}/${branch}`] : [];
  // i/o secuencial con early-exit: la primera ref que exista gana.
  const found = await candidates.reduce<Promise<string | null>>(async (acc, ref) => (await acc) ?? resolveCommit(repoPath, ref, env), Promise.resolve(null));
  const sha = found ?? (await resolveCommit(repoPath, 'HEAD', env));
  if (!sha) throw new Error('el checkout no tiene ningún commit (HEAD vacío)');
  await addDetached(repoPath, dir, sha, env);
  const warnings = branch !== null && !found ? [`branch ${branch} no existe localmente: worktree sobre HEAD`] : [];
  return { workdir: dir, note: `${found ? branch : 'HEAD'}@${sha.slice(0, SHORT_SHA_CHARS)}`, warnings };
}

/** borra un worktree de run de reglas (forzado: son de solo lectura). nunca lanza. */
export async function removeRunWorktree(repoPath: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', '--end-of-options', dir], env).catch((err: Error) => {
    console.error(`[runner] limpieza del worktree ${path.basename(dir)} falló: ${err.message}`);
  });
}

/** motivo para NO borrar un worktree (cambios sin commitear o commits que ninguna rama/remoto guarda), o null. */
export async function unsavedWork(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const status = await git(dir, ['status', '--porcelain'], env);
  if (status) return `${status.split('\n').length} cambios sin commitear`;
  // commits alcanzables solo desde el HEAD detached de este worktree: al borrarlo se perderían.
  const orphan = await git(dir, ['rev-list', '-n', '1', 'HEAD', '--not', '--branches', '--remotes', '--tags'], env);
  return orphan ? 'commits que ninguna rama ni remoto contiene' : null;
}

/** borra un worktree de conversación LIMPIO (sin --force: git se niega si aparece algo sucio). */
export async function removeCleanWorktree(repoPath: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--end-of-options', dir], env);
}
