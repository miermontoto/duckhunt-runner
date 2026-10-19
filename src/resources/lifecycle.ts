// ciclo de vida de los recursos de un run (t#495, M2): materializar todo o nada → juntar (cwd, env, nota, avisos,
// locks) → turnos exclusivos → (el daemon lanza claude) → soltar al revés. el orden lo fijan las fases
// (types.ts::PHASE_ORDER): cada una hereda el env de las anteriores.
// - todo o nada: si el recurso i falla, los 0…i-1 ya materializados se sueltan al revés con `aborted` y el run
//   se cierra como failed con resource_unavailable {type, key, kind}, nunca se lanza con parte de sus recursos.
// - env: el base saneado y encima el de cada recurso en orden de fase. la misma variable con valores distintos
//   de dos recursos es un env_conflict (aborta como arriba): ninguno gana en silencio.
// - cwd: el del proveedor de la fase cwd; sin él (sin repo, o un repo sin mapear que degrada) el scratch de la
//   plataforma, con turno exclusivo si el run escribe en él.
// - locks: los de todos los recursos, sin repetir y ORDENADOS (dos runs que piden A y B nunca se esperan en
//   cruz), esperando con el run vivo: un run cancelado mientras espera deja de esperar y suelta lo que le llegue.
// - soltar: al revés del orden de materialización, cada recurso en su try/catch (uno que falla no deja a los
//   demás sin soltar).

import path from 'node:path';
import type { KeyedMutex } from '../keyed-mutex.js';
import type { PlannedResource } from './registry.js';
import {
  PHASE,
  PHASE_NOTE_ORDER,
  PHASE_ORDER,
  RELEASE,
  ResourceUnavailableError,
  UNAVAILABLE_KIND,
  type Materialized,
  type Phase,
  type ReleaseOutcome,
  type ResourceLock,
  type RunContext,
  type RunCwd,
} from './types.js';

/** nota del feed de un run que espera turno en un cwd compartido. */
export const CWD_WAIT_NOTE = 'esperando turno: otro run trabaja en este mismo directorio';
/** nota de workdir de un run sin cwd de ningún proveedor. */
export const SCRATCH_NOTE = 'scratch · sin repo';

/** el cwd por defecto: el scratch de la plataforma (se crea al pedirlo) y si el run escribe en él. */
export interface ScratchDefault {
  dir: () => string;
  exclusive: boolean;
}

/** los recursos de un run, juntos. */
export interface MaterializedRun {
  cwd: RunCwd;
  env: NodeJS.ProcessEnv;
  note: string;
  warnings: string[];
  locks: ResourceLock[];
  release(outcome: ReleaseOutcome): Promise<void>;
}

interface Step {
  type: string;
  key: string | null;
  phase: Phase;
  m: Materialized;
}

const phaseRank = (order: readonly Phase[], phase: Phase): number => order.indexOf(phase);

// i/o secuencial al revés: cada recurso se suelta aunque falle el anterior.
async function releaseInReverse(steps: readonly Step[], outcome: ReleaseOutcome): Promise<void> {
  for (const s of [...steps].reverse()) {
    try {
      await s.m.release(outcome);
    } catch (err) {
      console.error(`[runner] soltar el recurso ${s.type}${s.key ? ` ${s.key}` : ''} falló: ${(err as Error).message}`);
    }
  }
}

// env con lo que pone un recurso (null = quitar).
const applyEnv = (env: NodeJS.ProcessEnv, vars: Readonly<Record<string, string | null>>): NodeJS.ProcessEnv =>
  Object.entries(vars).reduce<NodeJS.ProcessEnv>((acc, [k, v]) => {
    const { [k]: _, ...rest } = acc;
    return v === null ? rest : { ...rest, [k]: v };
  }, env);

// i/o secuencial por fases: cada recurso ve el env que dejaron los anteriores. lanza (tras deshacer) al primer fallo.
async function materializeSteps(plan: readonly PlannedResource[], ctx: RunContext): Promise<{ steps: Step[]; env: NodeJS.ProcessEnv }> {
  const ordered = [...plan].sort((a, b) => phaseRank(PHASE_ORDER, a.provider.phase) - phaseRank(PHASE_ORDER, b.provider.phase));
  const steps: Step[] = [];
  // variable → valor que le dio el primer recurso que la tocó (null = la quitó).
  const setBy = new Map<string, string | null>();
  let env: NodeJS.ProcessEnv = { ...ctx.env };
  try {
    for (const { provider, request, ref } of ordered) {
      const key = request?.key ?? null;
      const stepCtx: RunContext = { ...ctx, env };
      const m = await (request ? provider.materialize(request, ref, stepCtx) : provider.isolate!(stepCtx)).catch((err: unknown) => {
        throw err instanceof ResourceUnavailableError ? err : new ResourceUnavailableError(provider.type, key, UNAVAILABLE_KIND.failed, err);
      });
      steps.push({ type: provider.type, key, phase: provider.phase, m });
      const vars = m.env ?? {};
      if (Object.entries(vars).some(([k, v]) => setBy.has(k) && setBy.get(k) !== v)) throw new ResourceUnavailableError(provider.type, key, UNAVAILABLE_KIND.envConflict);
      if (m.cwd && steps.some((s) => s !== steps.at(-1) && s.m.cwd)) throw new ResourceUnavailableError(provider.type, key, UNAVAILABLE_KIND.cwdConflict);
      Object.entries(vars).forEach(([k, v]) => setBy.set(k, v));
      env = applyEnv(env, vars);
    }
  } catch (err) {
    await releaseInReverse(steps, RELEASE.aborted);
    throw err;
  }
  return { steps, env };
}

/** materializa el plan de un run, todo o nada (ver cabecera). lanza ResourceUnavailableError tras deshacer. */
export async function materializeRun(plan: readonly PlannedResource[], ctx: RunContext, scratch: ScratchDefault): Promise<MaterializedRun> {
  const { steps, env } = await materializeSteps(plan, ctx);
  const own = steps.find((s) => s.m.cwd)?.m.cwd;
  const cwd: RunCwd = own ?? { dir: scratch.dir(), checkout: false, skipPermissions: false };
  const scratchLock: ResourceLock[] = !own && scratch.exclusive ? [{ key: path.resolve(cwd.dir), waitNote: CWD_WAIT_NOTE }] : [];
  const byNotePhase = [...steps].sort((a, b) => phaseRank(PHASE_NOTE_ORDER, a.phase) - phaseRank(PHASE_NOTE_ORDER, b.phase));
  return {
    cwd,
    env,
    note: steps.find((s) => s.phase === PHASE.cwd && s.m.note !== undefined)?.m.note ?? SCRATCH_NOTE,
    warnings: byNotePhase.flatMap((s) => s.m.warnings),
    locks: [...steps.flatMap((s) => s.m.locks ?? []), ...scratchLock],
    release: (outcome) => releaseInReverse(steps, outcome),
  };
}

/**
 * toma los turnos exclusivos del run, sin repetir y en orden (ver cabecera), avisando con su nota de los que
 * hay que esperar. devuelve con qué soltarlos. si el run muere esperando, deja de esperar: lo que tenía se suelta
 * con la función devuelta y lo que llegue tarde, en cuanto llega.
 */
export async function holdLocks(locks: readonly ResourceLock[], mutex: KeyedMutex, killed: Promise<unknown>, note: (text: string) => void): Promise<() => void> {
  const notes = new Map(locks.map((l) => [l.key, l.waitNote]));
  const held: (() => void)[] = [];
  const releaseAll = (): void => held.splice(0).reverse().forEach((release) => release());
  // i/o secuencial: un turno tras otro, en orden de clave.
  for (const key of [...notes.keys()].sort()) {
    if (mutex.busy(key)) note(notes.get(key)!);
    const acquiring = mutex.acquire(key);
    const release = await Promise.race([acquiring, killed.then(() => null)]);
    if (!release) {
      void acquiring.then((r) => r());
      break;
    }
    held.push(release);
  }
  return releaseAll;
}
