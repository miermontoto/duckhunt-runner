// las internas del daemon que tocan las pruebas (t#495, M6.2): desde los supervisores por plataforma, el claim, los
// runs en vuelo y lo conservado por el gc son de cada plataforma. `legacyDaemon` da la vista de antes (el claim,
// la parada y el exit code de la plataforma legacy, la única de esos casos) para que sus aserciones no cambien.

import type { ClaimResponse } from '../src/claim.js';
import type { RunnerConfig } from '../src/config.js';
import { RunnerDaemon, type DaemonOptions } from '../src/daemon.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import type { Platform, RunSegment } from '../src/platforms/platform.js';
import type { PlatformState } from '../src/platforms/supervisor.js';
import type { RunLease } from '../src/run-lease.js';
import type { KeptWorktree } from '../src/server-state.js';

export interface SupervisorInternals {
  readonly id: string;
  readonly platform: Platform;
  readonly leases: Set<RunLease>;
  state: PlatformState;
  keptWorktrees: KeptWorktree[] | null;
  blocked: boolean;
  claim(): Promise<ClaimResponse | null>;
}

export interface DaemonInternals {
  reloadConfig(): Promise<void>;
  supervisors: Map<string, SupervisorInternals>;
  scheduler: { used(id?: string): number };
  pollOnce(sup: SupervisorInternals): Promise<boolean>;
  executeRun(sup: SupervisorInternals, claim: ClaimResponse, lease: RunLease): Promise<void>;
  startHeartbeat(sup: SupervisorInternals, lease: RunLease, heartbeatMs: number, seg: RunSegment): NodeJS.Timeout;
  postProgress(sup: SupervisorInternals, runId: string, toolCalls: number, seg: RunSegment, workdir?: string): void;
  addSupervisor(platform: Platform): SupervisorInternals;
  stopping: boolean;
  exitCode: number;
}

export const internals = (cfg: RunnerConfig, opts?: DaemonOptions): DaemonInternals => new RunnerDaemon(cfg, opts) as unknown as DaemonInternals;

export const legacyOf = (d: DaemonInternals): SupervisorInternals => d.supervisors.get(LEGACY_PLATFORM_ID)!;

export interface LegacyDaemon {
  reloadConfig(): Promise<void>;
  claim(): Promise<ClaimResponse | null>;
  readonly stopping: boolean;
  readonly exitCode: number;
}

/** el daemon como lo veían las pruebas con una sola plataforma. */
export function legacyDaemon(d: DaemonInternals): LegacyDaemon {
  return {
    reloadConfig: () => d.reloadConfig(),
    claim: () => legacyOf(d).claim(),
    get stopping() {
      return d.stopping;
    },
    get exitCode() {
      return d.exitCode;
    },
  };
}
