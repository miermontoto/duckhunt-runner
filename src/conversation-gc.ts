// recogida de worktrees del daemon (t#378). los conv-<id> sobreviven a propósito entre segmentos,
// así que alguien tiene que borrarlos: el daemon, en su loop de claim y como mucho cada
// CONVERSATION_GC_INTERVAL_MS, pregunta al server qué conversaciones siguen abiertas
// (POST /api/runner/conversations) y borra las cerradas o sin uso desde hace más de
// CONVERSATION_IDLE_TTL_MS. los run-<id> que quedaron de runs fallidos (autopsia) caen por el mismo
// ttl. regla dura: un worktree con cambios sin commitear o con commits que ninguna rama ni remoto
// contiene NO se borra nunca; se conserva y se avisa en el log. con runs en paralelo el gc corre
// mientras otros slots trabajan: nunca toca el worktree de un run en vuelo (lo reclamó este daemon
// y el server aún podría darlo por cerrado) y cada borrado va bajo el lock git de su checkout.

import fs from 'node:fs';
import path from 'node:path';
import { CONVERSATION_WORKTREE_PREFIX, RUN_WORKTREE_PREFIX, removeCleanWorktree, unsavedWork, worktreesDir } from './worktree.js';

// inactividad tras la que un worktree se puede borrar aunque el server lo dé por abierto
// (AGENT_CONVERSATION_IDLE_TTL_MS del server).
export const CONVERSATION_IDLE_TTL_MS = 7 * 24 * 60 * 60_000;
// cadencia de la recogida (y la primera, al arrancar).
export const CONVERSATION_GC_INTERVAL_MS = 30 * 60_000;
// ids por consulta a /conversations (RUNNER_CONVERSATIONS_MAX del server).
export const CONVERSATIONS_QUERY_MAX = 500;

export interface WorktreeCandidate {
  repoPath: string;
  dir: string;
  kind: 'conversation' | 'run';
  runId: number;
  lastUsedAt: number;
}

const ID_SUFFIX_RE = /^\d+$/;

function candidateOf(repoPath: string, name: string): WorktreeCandidate | null {
  const kind = name.startsWith(CONVERSATION_WORKTREE_PREFIX) ? 'conversation' : name.startsWith(RUN_WORKTREE_PREFIX) ? 'run' : null;
  if (!kind) return null;
  const suffix = name.slice(kind === 'conversation' ? CONVERSATION_WORKTREE_PREFIX.length : RUN_WORKTREE_PREFIX.length);
  const runId = ID_SUFFIX_RE.test(suffix) ? Number(suffix) : NaN;
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  const dir = path.join(worktreesDir(repoPath), name);
  return { repoPath, dir, kind, runId, lastUsedAt: fs.statSync(dir).mtimeMs };
}

/** worktrees del daemon presentes en disco en los checkouts dados (paths deduplicados). */
export function listWorktreeCandidates(repoPaths: string[]): WorktreeCandidate[] {
  return [...new Set(repoPaths)]
    .filter((repoPath) => fs.existsSync(worktreesDir(repoPath)))
    .flatMap((repoPath) =>
      fs
        .readdirSync(worktreesDir(repoPath), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => candidateOf(repoPath, e.name))
        .filter((c): c is WorktreeCandidate => c !== null),
    );
}

/** candidatos a borrar: conversación cerrada según el server, o cualquiera inactivo más del ttl.
 *  los runs en vuelo en este daemon (`inFlight`) nunca. */
export function selectForRemoval(
  candidates: WorktreeCandidate[],
  open: ReadonlySet<number>,
  now: number,
  inFlight: ReadonlySet<number> = new Set(),
  ttlMs = CONVERSATION_IDLE_TTL_MS,
): WorktreeCandidate[] {
  return candidates.filter((c) => !inFlight.has(c.runId) && (now - c.lastUsedAt > ttlMs || (c.kind === 'conversation' && !open.has(c.runId))));
}

/** trocea ids en consultas de como mucho `size` (el server limita cada llamada). */
export function chunk<T>(items: T[], size = CONVERSATIONS_QUERY_MAX): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/**
 * borra los worktrees seleccionados que no guarden trabajo. secuencial (git bloquea el repo por
 * operación). devuelve cuántos borró; conservar o fallar se loguea, nunca lanza.
 */
export async function removeWorktrees(targets: WorktreeCandidate[], env: NodeJS.ProcessEnv): Promise<number> {
  let removed = 0;
  // i/o secuencial: cada `git worktree remove` toca el mismo repositorio.
  for (const c of targets) {
    const name = path.basename(c.dir);
    try {
      const keep = await unsavedWork(c.dir, env);
      if (keep) {
        console.warn(`[runner] worktree ${c.dir} conservado: ${keep} (bórralo a mano con \`git worktree remove\` cuando ya no lo necesites)`);
        continue;
      }
      await removeCleanWorktree(c.repoPath, c.dir, env);
      removed++;
    } catch (err) {
      console.error(`[runner] no se pudo recoger el worktree ${name}: ${(err as Error).message}`);
    }
  }
  return removed;
}
