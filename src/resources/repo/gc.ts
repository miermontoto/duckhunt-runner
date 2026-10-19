// recogida de worktrees del daemon (t#378). los conv-<id> sobreviven a propósito entre segmentos,
// así que alguien tiene que borrarlos: el daemon, en su loop de claim y como mucho cada
// CONVERSATION_GC_INTERVAL_MS, pregunta al server qué conversaciones siguen abiertas
// (POST /api/runner/conversations) y borra las cerradas o sin uso desde hace más de
// CONVERSATION_IDLE_TTL_MS. los run-<id> que quedaron de runs fallidos (autopsia) caen por el mismo
// ttl. regla dura: un worktree con cambios sin commitear o con commits que ninguna rama ni remoto
// contiene NO se borra nunca; se conserva y se avisa en el log. con runs en paralelo el gc corre
// mientras otros slots trabajan: nunca toca el worktree de un run en vuelo (lo reclamó este daemon
// y el server aún podría darlo por cerrado) y cada borrado va bajo el lock git de su checkout.
// worktree_report (0.11.0, t#465 P12): de cada conversación que se conserva por guardar trabajo sale un
// recuento (KeptWorktree: ficheros sin commitear y commits sin subir, nunca paths) que el daemon anuncia
// en cada claim hasta la siguiente recogida; el hilo de esa conversación lo enseña con «pedir commit».
// ids opacos (t#495, M1): el sufijo de conv-<id>/run-<id> es el id del run tal cual (run-id.ts::RUN_ID_RE);
// los conv-<n> de siempre siguen casando. qué ids se le preguntan al server lo decide el daemon (el cable
// legacy solo lleva numéricos).

import fs from 'node:fs';
import path from 'node:path';
import { CONVERSATION_WORKTREE_PREFIX, RUN_WORKTREE_PREFIX, describeWork, removeCleanWorktree, worktreeWork } from './worktree.js';
import type { KeptWorktree } from '../../server-state.js';
import { RUN_ID_RE } from '../../run-id.js';
import { worktreesDir } from '../../paths.js';

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
  runId: string;
  lastUsedAt: number;
}

function candidateOf(repoPath: string, name: string, platform: string): WorktreeCandidate | null {
  const kind = name.startsWith(CONVERSATION_WORKTREE_PREFIX) ? 'conversation' : name.startsWith(RUN_WORKTREE_PREFIX) ? 'run' : null;
  if (!kind) return null;
  const runId = name.slice(kind === 'conversation' ? CONVERSATION_WORKTREE_PREFIX.length : RUN_WORKTREE_PREFIX.length);
  if (!RUN_ID_RE.test(runId)) return null;
  const dir = path.join(worktreesDir(repoPath, platform), name);
  return { repoPath, dir, kind, runId, lastUsedAt: fs.statSync(dir).mtimeMs };
}

/** worktrees de una plataforma presentes en disco en los checkouts dados (paths deduplicados). */
export function listWorktreeCandidates(repoPaths: string[], platform: string): WorktreeCandidate[] {
  return [...new Set(repoPaths)]
    .filter((repoPath) => fs.existsSync(worktreesDir(repoPath, platform)))
    .flatMap((repoPath) =>
      fs
        .readdirSync(worktreesDir(repoPath, platform), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => candidateOf(repoPath, e.name, platform))
        .filter((c): c is WorktreeCandidate => c !== null),
    );
}

/** candidatos a borrar: conversación cerrada según el server, o cualquiera inactivo más del ttl.
 *  los runs en vuelo en este daemon (`inFlight`) nunca. */
export function selectForRemoval(
  candidates: WorktreeCandidate[],
  open: ReadonlySet<string>,
  now: number,
  inFlight: ReadonlySet<string> = new Set(),
  ttlMs = CONVERSATION_IDLE_TTL_MS,
): WorktreeCandidate[] {
  return candidates.filter((c) => !inFlight.has(c.runId) && (now - c.lastUsedAt > ttlMs || (c.kind === 'conversation' && !open.has(c.runId))));
}

/** trocea ids en consultas de como mucho `size` (el server limita cada llamada). */
export function chunk<T>(items: T[], size = CONVERSATIONS_QUERY_MAX): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/** lo que hizo una recogida: cuántos borró y las conversaciones que conservó por guardar trabajo. */
export interface WorktreeCollection {
  removed: number;
  kept: KeptWorktree[];
}

/**
 * borra los worktrees seleccionados que no guarden trabajo. secuencial (git bloquea el repo por
 * operación). devuelve cuántos borró y el recuento de las conversaciones conservadas; conservar o
 * fallar se loguea, nunca lanza.
 */
export async function removeWorktrees(targets: WorktreeCandidate[], env: NodeJS.ProcessEnv): Promise<WorktreeCollection> {
  const out: WorktreeCollection = { removed: 0, kept: [] };
  // i/o secuencial: cada `git worktree remove` toca el mismo repositorio.
  for (const c of targets) {
    const name = path.basename(c.dir);
    try {
      const work = await worktreeWork(c.dir, env);
      const keep = describeWork(work);
      if (keep) {
        console.warn(`[runner] worktree ${c.dir} conservado: ${keep} (bórralo a mano con \`git worktree remove\` cuando ya no lo necesites)`);
        if (c.kind === 'conversation') out.kept.push({ runId: c.runId, ...work });
        continue;
      }
      await removeCleanWorktree(c.repoPath, c.dir, env);
      out.removed++;
    } catch (err) {
      console.error(`[runner] no se pudo recoger el worktree ${name}: ${(err as Error).message}`);
    }
  }
  return out;
}
