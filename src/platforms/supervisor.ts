// una plataforma dentro del daemon (t#495, M6.2): su Platform, su poll (con su propia espera: el de una plataforma
// lenta o caída no retrasa el de otra), sus runs en vuelo, lo último que su server dijo de esta máquina
// (server-state.ts, en su directorio) y su estado:
// - active: reclama. paused: no reclama, sus runs siguen latiendo hasta acabar (M6.3, desde la config).
// - unpaired: su credencial murió (desvinculada, revocada o caducada). deja de reclamar y sus runs se cortan;
//   si era la última plataforma usable, el daemon sale con EXIT_CODE_UNPAIRED como siempre. un `login` nuevo
//   (otro clientId en la config) la sustituye por otra activa (M6.3).
// - removing: ya no está en la config. no reclama; cuando acaban sus runs, el daemon la suelta (M6.3).
// lo que es de la máquina (los slots, la config, los recursos, cómo se ejecuta un run) sigue en el daemon.

import type { ClaimResponse } from '../claim.js';
import type { RunLease } from '../run-lease.js';
import { serverStateChanged, writeServerState, type KeptWorktree, type RunnerBlock, type ServerState } from '../server-state.js';
import { CLAIM_RESULT, PlatformRejectedError, type ClaimAnnounce, type ClaimResult, type Platform } from './platform.js';

export const PLATFORM_STATE = {
  active: 'active',
  paused: 'paused',
  unpaired: 'unpaired',
  removing: 'removing',
} as const;
export type PlatformState = (typeof PLATFORM_STATE)[keyof typeof PLATFORM_STATE];

// las que cuentan para seguir vivo: sin ninguna, el daemon sale.
const USABLE_STATES: ReadonlySet<PlatformState> = new Set([PLATFORM_STATE.active, PLATFORM_STATE.paused]);

/** lo que el supervisor necesita del daemon. */
export interface SupervisorHooks {
  // lo que la máquina anuncia a esta plataforma en su claim.
  announce(sup: PlatformSupervisor): ClaimAnnounce;
  // la credencial de esta plataforma murió.
  rejected(sup: PlatformSupervisor, err: PlatformRejectedError): void;
  // la plataforma tiene comandos de repos pendientes para esta máquina.
  commandsPending(sup: PlatformSupervisor): void;
}

export class PlatformSupervisor {
  // runs en vuelo de esta plataforma, uno por slot reservado. por objeto y no por id: la misma fila re-encolada
  // puede reclamarse mientras el segmento anterior aún cierra.
  readonly leases = new Set<RunLease>();
  // conversaciones que su último gc conservó por guardar trabajo (null = aún no recogió: no se anuncia).
  keptWorktrees: KeptWorktree[] | null = null;
  lastGcAt = 0;
  // el poll espera un slot (pool o cuota llenos): lo despierta cualquier slot que se libere, no solo uno suyo.
  blocked = false;
  // lo último escrito en su server-state.json.
  private serverState: ServerState | null = null;
  private wakeUp: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly platform: Platform,
    public state: PlatformState,
    private readonly hooks: SupervisorHooks,
  ) {}

  /** cuenta para seguir vivo (activa o en pausa). */
  get usable(): boolean {
    return USABLE_STATES.has(this.state);
  }

  /** reclama trabajo en esta vuelta. */
  get claiming(): boolean {
    return this.state === PLATFORM_STATE.active;
  }

  /** un claim: lo que dijo el server se guarda, un run que no parsea se cierra como failed y una credencial muerta
   *  se avisa al daemon. devuelve el run, o null si no hay (o no se puede correr). */
  async claim(): Promise<ClaimResponse | null> {
    let result: ClaimResult;
    try {
      result = await this.platform.claim(this.hooks.announce(this));
    } catch (err) {
      if (!(err instanceof PlatformRejectedError)) throw err;
      this.hooks.rejected(this, err);
      return null;
    }
    if (result.commandsPending) this.hooks.commandsPending(this);
    if (result.kind === CLAIM_RESULT.unavailable) return null;
    this.recordServerState(result.said.state, result.said.runner);
    if (result.kind === CLAIM_RESULT.invalid && result.runId !== null) await this.platform.result(result.runId, { status: 'failed', error: result.error });
    return result.kind === CLAIM_RESULT.run ? result.claim : null;
  }

  /** guarda lo que el server acaba de decir de esta máquina para `status` (solo si cambió o envejeció). */
  recordServerState(state: string | null, runner: RunnerBlock | null): void {
    const next: ServerState = { at: Date.now(), ...this.platform.identity(), state, runner, kept: this.keptWorktrees };
    if (!serverStateChanged(this.serverState, next)) return;
    try {
      writeServerState(next, this.id);
      this.serverState = next;
    } catch (err) {
      console.error(`[runner] no se pudo guardar el estado del server: ${(err as Error).message}`);
    }
  }

  /** espera del poll, interrumpible (un slot libre, una parada, comandos aplicados). */
  idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  wake(): void {
    this.wakeUp?.();
  }
}
