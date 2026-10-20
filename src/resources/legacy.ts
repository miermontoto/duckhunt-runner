// peticiones de recursos de un claim legacy (contrato 42, t#495 M2): ese claim no trae grants, así que se derivan
// de sus campos para que el mismo ciclo de vida sirva a los claims de hoy y a los toolset_v1 de mañana. el repo del
// run, con su rama y su aislamiento (conversación, checkout o el worktree de un kind de reglas), y su aws: la cuenta
// (null si el claim solo trae región) con su región. el acceso es informativo hasta M5 (toolset_v1): quien acota
// de verdad sigue siendo el kit del server. un claim legacy nunca aísla la aws: sin bloque aws, el env del usuario.

import { PROMPT_PROFILE, RUN_ISOLATION, RUN_KIND, type ClaimedRun } from '../claim.js';
import { AWS_PARAM, AWS_TYPE } from './aws.js';
import { REPO_PARAM, REPO_TYPE, REPO_WORKTREE } from './repo/provider.js';
import { ACCESS, ResourceUnavailableError, type ResourceRequest } from './types.js';

// prefijo del error de /status de un run cuyo cwd no se pudo preparar (el texto de siempre en el cable legacy).
const WORKDIR_FAILED_PREFIX = 'no se pudo preparar el directorio del run';
const RUN_FAILED_PREFIX = 'no se pudo preparar el run';

// dónde trabaja el repo de un run legacy: lo decidían kind e isolation.
function repoWorktree(run: ClaimedRun): string {
  if (run.kind !== RUN_KIND.prompt) return REPO_WORKTREE.run;
  return run.isolation === RUN_ISOLATION.checkout ? REPO_WORKTREE.checkout : REPO_WORKTREE.conversation;
}

/** parámetros del repo de un run legacy: su rama y dónde trabaja (también los del grant del flip de toolset_v1). */
export const legacyRepoParams = (run: ClaimedRun): Readonly<Record<string, string | null>> => ({
  [REPO_PARAM.branch]: run.branch,
  [REPO_PARAM.worktree]: repoWorktree(run),
});

/** recursos que pide un run legacy. */
export function legacyRequests(run: ClaimedRun): ResourceRequest[] {
  const access = run.profile === PROMPT_PROFILE.edit ? ACCESS.full : ACCESS.read;
  return [
    ...(run.repo ? [{ type: REPO_TYPE, key: run.repo, access, params: legacyRepoParams(run) }] : []),
    ...(run.aws ? [{ type: AWS_TYPE, key: run.aws.accountId, access: ACCESS.read, params: { [AWS_PARAM.region]: run.aws.region } }] : []),
  ];
}

/** un run legacy en el scratch se turna con los demás si escribe en él (perfil edit): la auto-memory compartida
 *  es la gracia del cwd fijo, pero dos ediciones a la vez se pisarían. */
export const legacyScratchExclusive = (run: ClaimedRun): boolean => run.profile === PROMPT_PROFILE.edit;

/** error de /status de un run cuyos recursos no se pudieron preparar: el del repo (su cwd) con el texto de siempre;
 *  el de otro recurso sin paths, solo tipo, clave y motivo (el detalle va al log local). */
export function legacyResourceError(err: unknown): string {
  if (!(err instanceof ResourceUnavailableError)) return `${WORKDIR_FAILED_PREFIX}: ${(err as Error).message}`;
  if (err.type === REPO_TYPE && err.cause instanceof Error) return `${WORKDIR_FAILED_PREFIX}: ${err.cause.message}`;
  if (err.cause instanceof Error) console.error(`[runner] ${err.message}: ${err.cause.message}`);
  return `${RUN_FAILED_PREFIX}: ${err.message}`;
}
