// recursos de un run (t#495, M2): lo que la máquina del usuario pone a disposición de un run (un repo, una cuenta
// aws y, más adelante, una sesión de navegador o un cluster) detrás de un mismo contrato. cada tipo lo sirve un
// proveedor que sabe materializarlo para un run (su cwd, su env…) y soltarlo al cerrar; el ciclo de vida
// (lifecycle.ts) los encadena todo o nada y el registro (registry.ts) resuelve el proveedor de cada tipo.
// decisiones:
// - fases en orden env → cwd → mcp: lo que pone una fase lo hereda la siguiente. el git del repo (fetch con un
//   credential helper de codecommit, p. ej.) corre con la aws del run, como antes de los recursos, y lo que el
//   run cuenta en el feed empieza por dónde corre (los avisos van en orden cwd → env → mcp).
// - el lock de un recurso compartido (un checkout sin worktree, el scratch en edición) solo se sabe tras
//   materializarlo (el checkout puede no existir y caer al scratch): lo devuelve el proveedor y el ciclo de vida
//   los toma ordenados antes de lanzar claude.
// - una petición legacy puede no llevar clave (key null): la aws de un claim que solo trae región.
// - el error de un recurso que no se pudo materializar viaja sin paths: tipo, clave y motivo (el detalle, al
//   log local por `cause`).

import type { KeyedMutex } from '../keyed-mutex.js';

export const ACCESS = {
  read: 'read',
  interact: 'interact',
  full: 'full',
} as const;
export type Access = (typeof ACCESS)[keyof typeof ACCESS];

export const PHASE = {
  env: 'env',
  cwd: 'cwd',
  mcp: 'mcp',
} as const;
export type Phase = (typeof PHASE)[keyof typeof PHASE];

/** orden de materialización (y, al revés, el de soltarlos). */
export const PHASE_ORDER: readonly Phase[] = [PHASE.env, PHASE.cwd, PHASE.mcp];
/** orden en el que los avisos de cada fase salen al feed. */
export const PHASE_NOTE_ORDER: readonly Phase[] = [PHASE.cwd, PHASE.env, PHASE.mcp];

/** lo que un run pide de un tipo de recurso: la clave expuesta (null = petición legacy sin clave), el acceso y
 *  los parámetros del run (rama, aislamiento, región…). */
export interface ResourceRequest {
  type: string;
  key: string | null;
  access: Access;
  params: Readonly<Record<string, string | null>>;
}

/** lo que un proveedor sabe del run al materializar. */
export interface RunContext {
  platform: string;
  runId: string;
  // env del run hasta esta fase: el base saneado más lo que pusieron las fases anteriores.
  env: NodeJS.ProcessEnv;
  // git sobre un mismo checkout, serializado entre los runs en paralelo de este daemon.
  gitLocks: KeyedMutex;
}

/** cómo acabó el run: lo que el proveedor hace al soltar (borrar el worktree de un run de reglas solo si done).
 *  aborted = no llegó a lanzarse porque otro recurso falló. */
export const RELEASE = {
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
  aborted: 'aborted',
} as const;
export type ReleaseOutcome = (typeof RELEASE)[keyof typeof RELEASE];

/** cwd del run según el proveedor de la fase cwd. */
export interface RunCwd {
  dir: string;
  // es un checkout git: sus symlinks commiteados se revisan antes de dar shell de lectura (read-shell-guard.ts).
  checkout: boolean;
  // opt-in local deprecado del repo (solo los kinds de reglas heredados, claude-args.ts).
  skipPermissions: boolean;
}

/** turno exclusivo que pide un recurso compartido y la nota del feed si toca esperarlo. */
export interface ResourceLock {
  key: string;
  waitNote: string;
}

/** un recurso ya preparado para el run. */
export interface Materialized {
  cwd?: RunCwd;
  // variables que pone (null = la quita del env base).
  env?: Readonly<Record<string, string | null>>;
  // nota corta del cwd para agent_run.workdir y el feed (sin paths absolutos).
  note?: string;
  // avisos para el log y el feed (rama ignorada, cuenta sin mapear…).
  warnings: readonly string[];
  locks?: readonly ResourceLock[];
  // al cerrar el run (o al deshacer si otro recurso falló). no debe lanzar, pero si lanza no frena a los demás.
  release(outcome: ReleaseOutcome): Promise<void>;
}

/** proveedor de un tipo de recurso. `Ref` es su entrada en la config local (checkout, perfil aws…). */
export interface ResourceProvider<Ref = unknown> {
  readonly type: string;
  readonly phase: Phase;
  // ref null = la clave no está mapeada en esta máquina: el proveedor decide si degrada (con aviso) o falla.
  materialize(req: ResourceRequest, ref: Ref | null, ctx: RunContext): Promise<Materialized>;
  // sin petición de este tipo, en un claim que lo pide (toolset_v1): aislar al run de lo de la máquina.
  isolate?(ctx: RunContext): Promise<Materialized>;
  // al arrancar, con el lock del daemon: borra lo que dejó un daemon muerto. devuelve cuántos.
  sweep?(platform: string): number;
}

export const RESOURCE_UNAVAILABLE = 'resource_unavailable';
export const UNAVAILABLE_KIND = {
  // tipo de recurso que ningún proveedor sirve en este daemon.
  unknownType: 'unknown_type',
  // el proveedor lanzó al materializar.
  failed: 'materialize_failed',
  // dos recursos ponen la misma variable con valores distintos.
  envConflict: 'env_conflict',
  // dos recursos dan cwd al mismo run.
  cwdConflict: 'cwd_conflict',
} as const;

/** un recurso del run no se pudo preparar: el run no se lanza (nunca con solo parte de sus recursos). */
export class ResourceUnavailableError extends Error {
  readonly code = RESOURCE_UNAVAILABLE;

  constructor(
    readonly type: string,
    readonly key: string | null,
    readonly kind: string,
    cause?: unknown,
  ) {
    super(`recurso ${type}${key ? ` ${key}` : ''} no disponible (${kind})`, { cause });
  }
}
