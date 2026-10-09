// cambios del mapa de repos pedidos desde duckhunt (t#463 fase 2): quitar un repo o cambiar la
// carpeta de uno entre los candidatos que este daemon anunció. regla dura: el server NUNCA mete un
// path. elige un id opaco de la última lista de candidatos (repo-health.ts::repoChoices) y aquí se
// rechaza cualquier id que no esté en ella, que sea de otro repo o cuya carpeta ya no sea un
// checkout de ese repo. quitar un mapeo no borra nada del disco. los errores viajan al server: sin
// paths. el daemon aplica y guarda la config (es su dueño mientras corre: reescribe el fichero en
// cada refresh del token). se apagan en la máquina con `defaults.remoteRepoEdits: false`.

import type { RepoConfig } from './config.js';
import { inspectCheckouts } from './repo-health.js';
import { sameRepoKey } from './repo-key.js';

export const REPO_COMMAND_ACTION = { unmap: 'unmap', remap: 'remap' } as const;
export type RepoCommandAction = (typeof REPO_COMMAND_ACTION)[keyof typeof REPO_COMMAND_ACTION];

/** comando pendiente tal como lo entrega POST /api/runner/repo-commands. */
export interface RepoCommand {
  id: number;
  action: RepoCommandAction;
  repo: string;
  candidateId: string | null;
}

/** resultado que vuelve al server (error sin paths). */
export interface RepoCommandResult {
  id: number;
  ok: boolean;
  error?: string;
}

/** resultado de aplicar: el mapa nuevo, lo que se reporta y la línea de log local (con paths). */
export interface AppliedRepoCommand {
  repos: Record<string, RepoConfig>;
  result: RepoCommandResult;
  log: string | null;
}

const ACTIONS = new Set<string>(Object.values(REPO_COMMAND_ACTION));

/** comandos bien formados de la respuesta del server; el resto se descarta. */
export function parseRepoCommands(raw: unknown): RepoCommand[] {
  const list = (raw as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c): RepoCommand[] => {
    const { id, action, repo, candidateId } = (c ?? {}) as Record<string, unknown>;
    const valid =
      Number.isSafeInteger(id) &&
      typeof action === 'string' &&
      ACTIONS.has(action) &&
      typeof repo === 'string' &&
      (candidateId === null || candidateId === undefined || typeof candidateId === 'string');
    return valid ? [{ id: id as number, action: action as RepoCommandAction, repo, candidateId: (candidateId as string | undefined) ?? null }] : [];
  });
}

const failed = (repos: Record<string, RepoConfig>, id: number, error: string): AppliedRepoCommand => ({ repos, result: { id, ok: false, error }, log: null });

/** aplica un comando sobre el mapa (sin mutarlo); `candidates` = ids → carpeta de la última foto. */
export async function applyRepoCommand(
  repos: Record<string, RepoConfig>,
  cmd: RepoCommand,
  candidates: ReadonlyMap<string, { repo: string; path: string }>,
  env: NodeJS.ProcessEnv,
): Promise<AppliedRepoCommand> {
  const current = Object.hasOwn(repos, cmd.repo) ? repos[cmd.repo]! : null;
  if (cmd.action === REPO_COMMAND_ACTION.unmap) {
    // idempotente: si ya no estaba (lo quitaron por la cli), el pedido está cumplido.
    if (!current) return { repos, result: { id: cmd.id, ok: true }, log: null };
    const rest = Object.fromEntries(Object.entries(repos).filter(([key]) => key !== cmd.repo));
    return { repos: rest, result: { id: cmd.id, ok: true }, log: `quitado ${cmd.repo} (era ${current.path}) desde duckhunt` };
  }
  if (!current) return failed(repos, cmd.id, 'el repo ya no está mapeado en este runner');
  const target = cmd.candidateId ? candidates.get(cmd.candidateId) : undefined;
  if (!target || target.repo !== cmd.repo) return failed(repos, cmd.id, 'carpeta desconocida para este repo: vuelve a elegirla');
  // la foto puede tener minutos: la carpeta se vuelve a comprobar justo antes de mapearla.
  const [state] = await inspectCheckouts([target.path], env);
  if (!state?.root || state.key === null || !sameRepoKey(state.key, cmd.repo)) {
    return failed(repos, cmd.id, 'la carpeta elegida ya no es un checkout de este repo');
  }
  if (current.path === target.path) return { repos, result: { id: cmd.id, ok: true }, log: null };
  // los flags del repo (skip-permissions, sin worktree) son intención del usuario sobre el repo: se conservan.
  return {
    repos: { ...repos, [cmd.repo]: { ...current, path: target.path } },
    result: { id: cmd.id, ok: true },
    log: `${cmd.repo} → ${target.path} (era ${current.path}) desde duckhunt`,
  };
}
