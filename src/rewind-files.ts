// volver atrás con los ficheros (0.17.0, t#564; el contrato, en el protocolo: rewind.ts): antes de un turno que rehace
// otro, el worktree de la conversación vuelve a la foto con la que empezó aquel (el tree de git de turn-changes.ts) y
// su índice a HEAD. `--rewind-files` del cli no sirve en headless (graba snapshots vacíos), así que lo hace el daemon.
// decisiones:
// - solo si HEAD sigue donde estaba al hacer la foto: con un commit por medio (del agente o de la persona) restaurar
//   el árbol dejaría ese commit «deshecho» en el working tree sin que nadie lo pidiera. y solo si el tree sigue en el
//   repo (son objetos sueltos: un gc puede habérselo llevado). si no, lanza con el motivo y el turno no se lanza.
// - el árbol se escribe con un índice TEMPORAL (read-tree + checkout-index -a -f): pisa lo que cambió y recrea lo que
//   faltaba sin tocar el índice de la conversación; lo que existe ahora y no estaba en la foto (lo que vería `add -A`:
//   .gitignore respetado, un node_modules ignorado nunca se toca) se borra. después el índice vuelve a HEAD (`reset`
//   mixto): nada de lo que se descartó queda preparado para un commit; los cambios siguen en el working tree.
// - nunca en el checkout de la persona: el claim solo trae `restore` en worktree (claim.ts) y el daemon lo repite.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { snapshotTree } from './turn-changes.js';
import type { LegacyClaimRestore } from './vendor/runner-protocol/index.js';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const TMP_PREFIX = 'duckhunt-rewind-';
const GIT_TREE_TYPE = 'tree';

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf-8' });
  return stdout;
}

/** HEAD de `dir` (el commit), o null si git falla (sin commits, no es un repo). */
export async function headOf(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--verify', 'HEAD'], env)).trim() || null;
  } catch (err) {
    console.error(`[runner] HEAD del árbol de trabajo ilegible: ${(err as Error).message}`);
    return null;
  }
}

// ¿el objeto `id` sigue en el repo y es un tree?
async function isTree(dir: string, env: NodeJS.ProcessEnv, id: string): Promise<boolean> {
  try {
    return (await git(dir, ['cat-file', '-t', id], env)).trim() === GIT_TREE_TYPE;
  } catch {
    // cat-file sale con error si el objeto no existe: es la respuesta, no un fallo.
    return false;
  }
}

// rutas (relativas) que hay en `now` y no en `then`: lo creado desde la foto.
async function addedSince(dir: string, env: NodeJS.ProcessEnv, then: string, now: string): Promise<string[]> {
  const out = await git(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', then, now], env);
  return out.split('\0').filter((p) => p !== '');
}

/** devuelve el working tree de `dir` a la foto `restore` y su índice a HEAD (ver cabecera); lanza con el motivo si no puede. */
export async function restoreTree(dir: string, env: NodeJS.ProcessEnv, restore: LegacyClaimRestore): Promise<void> {
  const head = await headOf(dir, env);
  if (head !== restore.head) throw new Error('HEAD cambió desde ese turno (hay commits por medio): los ficheros no se tocan');
  if (!(await isTree(dir, env, restore.tree))) throw new Error('la foto de ese turno ya no está en el repo');
  const now = await snapshotTree(dir, env);
  if (now === null) throw new Error('no se pudo fotografiar el árbol de ahora');
  const root = path.resolve(dir);
  // fuera de lo que git considera del árbol nunca se borra nada (una ruta rara de git no sale del cwd).
  const inside = (p: string): string | null => {
    const abs = path.resolve(root, p);
    return abs.startsWith(`${root}${path.sep}`) ? abs : null;
  };
  (await addedSince(dir, env, restore.tree, now))
    .map(inside)
    .filter((abs): abs is string => abs !== null)
    .forEach((abs) => fs.rmSync(abs, { force: true }));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    const withIndex = { ...env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    await git(dir, ['read-tree', restore.tree], withIndex);
    await git(dir, ['checkout-index', '-a', '-f'], withIndex);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await git(dir, ['reset', '-q'], env);
}
