// proveedor de repos (t#495, M2): el cwd de un run con repo, lo que antes era daemon.ts::prepareWorkdir, movido tal
// cual. la clave es la del mapa de repos (workspace/slug u owner/repo) y la ref su entrada de la config (el checkout).
// - parámetro `worktree`: conversation = el worktree conv-<id> de un prompt run, que se conserva entre segmentos y
//   se marca al soltar; checkout = la conversación que el usuario abrió en el checkout tal cual (turno exclusivo);
//   run = los kinds de reglas heredados: su worktree efímero run-<id> (se borra en done, se conserva para autopsia
//   si no), o el checkout si el repo lleva `worktree: false` (turno exclusivo).
// - parámetro `mount` (t#597): add_dir = un repo adicional de la conversación. su worktree conv-<id> en SU checkout
//   (nunca el checkout tal cual: no tiene turno exclusivo) va como directorio adicional del run (--add-dir), no como
//   cwd; su acceso read lo deja en solo lectura. sin mapear o sin checkout degrada igual: el run sigue sin él.
// - sin mapear o con el checkout borrado degrada: sin cwd (el ciclo de vida pone el scratch) y con un aviso.
// - el git de preparar y de borrar va bajo el lock git de su checkout.

import fs from 'node:fs';
import path from 'node:path';
import type { RepoConfig } from '../../config.js';
import { CWD_WAIT_NOTE } from '../lifecycle.js';
import { ACCESS, PHASE, RELEASE, RESOURCE_TYPE, type Materialized, type ResourceProvider } from '../types.js';
import { prepareCheckout, prepareConversationWorktree, prepareRunWorktree, removeRunWorktree, touchWorktree, type PreparedWorktree } from './worktree.js';

export const REPO_TYPE = RESOURCE_TYPE.repo;
export const REPO_PARAM = {
  branch: 'branch',
  worktree: 'worktree',
  mount: 'mount',
} as const;
// cómo entra el repo en el run: sin el parámetro, como cwd; add_dir, como directorio adicional (t#597).
export const REPO_MOUNT = {
  addDir: 'add_dir',
} as const;
export const REPO_WORKTREE = {
  conversation: 'conversation',
  checkout: 'checkout',
  run: 'run',
} as const;

const noRelease = async (): Promise<void> => {};

// sin cwd: el ciclo de vida cae al scratch con esta nota y este aviso.
const degraded = (note: string, warning: string): Materialized => ({ note, warnings: [warning], release: noRelease });
// un repo adicional que no está: el run sigue sin él, con el aviso (ni cwd ni nota: la del run es la del principal).
const skipped = (warning: string): Materialized => ({ warnings: [warning], release: noRelease });

export const repoProvider: ResourceProvider<RepoConfig> = {
  type: REPO_TYPE,
  phase: PHASE.cwd,

  async materialize(req, ref, ctx) {
    const key = req.key ?? '';
    const extra = req.params[REPO_PARAM.mount] === REPO_MOUNT.addDir;
    if (!ref) {
      return extra ? skipped(`repo adicional ${key} no mapeado en este runner: el run sigue sin él`) : degraded('scratch · sin repo mapeado', `repo ${key} no mapeado en este runner: corriendo en scratch`);
    }
    if (!fs.existsSync(ref.path)) {
      console.log(`[runner] run ${ctx.runId}: el checkout ${ref.path} no existe`);
      return extra
        ? skipped(`el checkout del repo adicional ${key} no existe en este runner: el run sigue sin él`)
        : degraded('scratch · checkout no encontrado', `el checkout de ${key} no existe en este runner: corriendo en scratch`);
    }
    const root = path.resolve(ref.path);
    const underGit = <T>(fn: () => Promise<T>): Promise<T> => ctx.gitLocks.run(root, fn);
    if (extra) {
      const wt = await underGit(() => prepareConversationWorktree(ref.path, ctx.runId, req.params[REPO_PARAM.branch] ?? null, ctx.env, ctx.platform));
      return {
        addDir: { key, dir: wt.workdir, readOnly: req.access !== ACCESS.full, checkout: true },
        note: `${key}: ${wt.note}`,
        warnings: wt.warnings,
        release: async () => touchWorktree(wt.workdir),
      };
    }
    const branch = req.params[REPO_PARAM.branch] ?? null;
    const skipPermissions = ref.dangerouslySkipPermissions === true;
    const at = (dir: string): Materialized['cwd'] => ({ dir, checkout: true, skipPermissions });
    const shared = (prepared: PreparedWorktree): Materialized => ({
      cwd: at(prepared.workdir),
      note: prepared.note,
      warnings: prepared.warnings,
      locks: [{ key: path.resolve(prepared.workdir), waitNote: CWD_WAIT_NOTE }],
      release: noRelease,
    });
    const mode = req.params[REPO_PARAM.worktree];
    if (mode === REPO_WORKTREE.checkout) return shared(await underGit(() => prepareCheckout(ref.path, ctx.env, ctx.platform)));
    if (mode === REPO_WORKTREE.conversation) {
      // worktree salvo que el usuario eligiera el checkout: `worktree: false` y skip-permissions del repo son solo
      // para los kinds de reglas heredados (un server anterior a t#465 P6).
      const wt = await underGit(() => prepareConversationWorktree(ref.path, ctx.runId, branch, ctx.env, ctx.platform));
      return { cwd: at(wt.workdir), note: wt.note, warnings: wt.warnings, release: async () => touchWorktree(wt.workdir) };
    }
    if (ref.worktree === false) return shared({ workdir: ref.path, note: 'checkout · sin worktree', warnings: [] });
    const wt = await underGit(() => prepareRunWorktree(ref.path, ctx.runId, branch, ctx.env, ctx.platform));
    return {
      cwd: at(wt.workdir),
      note: wt.note,
      warnings: wt.warnings,
      release: async (outcome) => {
        if (outcome === RELEASE.done) await underGit(() => removeRunWorktree(ref.path, wt.workdir, ctx.env));
        else console.log(`[runner] worktree conservado para autopsia: ${wt.workdir}`);
      },
    };
  },
};
