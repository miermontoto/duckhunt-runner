// plataforma falsa para las pruebas (t#495, M6): el mismo seam (src/platforms/platform.ts) que usará la plataforma
// local. cada claim saca la siguiente respuesta de `claims` (sin más, idle) y apunta lo que le llega; `reject` hace
// que toda llamada lance PlatformRejectedError (la credencial murió; con `rejectNamesClient`, nombrando su clientId
// como el refresh real, y el daemon la borra del fichero); `hold` deja el claim colgado hasta soltarlo.

import type { ClaimResponse } from '../src/claim.js';
import type { RunnerCredential } from '../src/config.js';
import type { SeqEvent } from '../src/event-uploader.js';
import {
  CLAIM_RESULT,
  PlatformRejectedError,
  PROTOCOL,
  type ClaimAnnounce,
  type ClaimResult,
  type HeartbeatVerdict,
  type Platform,
  type PlatformFactories,
  type RunSegment,
  type UnpairOutcome,
} from '../src/platforms/platform.js';
import type { RepoCommand, RepoCommandResult } from '../src/repo-commands.js';
import type { StatusReport } from '../src/status-report.js';

export const IDLE: ClaimResult = { kind: CLAIM_RESULT.idle, said: { state: null, runner: null }, commandsPending: false };
export const UNAVAILABLE: ClaimResult = { kind: CLAIM_RESULT.unavailable, commandsPending: false };
export const runResult = (claim: ClaimResponse): ClaimResult => ({ kind: CLAIM_RESULT.run, claim, said: { state: 'claimed', runner: null }, commandsPending: false });

export class FakePlatform implements Platform {
  readonly protocol = PROTOCOL.duckhunt42;
  readonly announces: ClaimAnnounce[] = [];
  readonly results: { runId: string; report: StatusReport }[] = [];
  readonly observed: RunnerCredential[] = [];
  claims: ClaimResult[] = [];
  reject = false;
  rejectNamesClient = false;
  hold: Promise<void> | null = null;

  constructor(
    readonly id: string,
    public credential: RunnerCredential,
  ) {}

  private alive(): void {
    if (this.reject) throw new PlatformRejectedError(`la credencial de ${this.id} ya no vale`, this.rejectNamesClient ? this.credential.clientId : undefined);
  }

  identity(): { baseUrl: string; clientId: string } {
    return { baseUrl: this.credential.baseUrl, clientId: this.credential.clientId };
  }

  observe(credential: RunnerCredential): void {
    this.observed.push(credential);
  }

  async claim(a: ClaimAnnounce): Promise<ClaimResult> {
    this.alive();
    this.announces.push(a);
    if (this.hold) await this.hold;
    return this.claims.shift() ?? IDLE;
  }

  async heartbeat(_runId: string, _seg: RunSegment): Promise<HeartbeatVerdict> {
    this.alive();
    return { stop: false };
  }

  async progress(): Promise<void> {
    this.alive();
  }

  async events(_runId: string, _events: SeqEvent[], _seg: RunSegment): Promise<number> {
    this.alive();
    return 200;
  }

  async result(runId: string, report: StatusReport): Promise<void> {
    this.results.push({ runId, report });
  }

  async openConversations(runIds: string[]): Promise<Set<string>> {
    return new Set(runIds);
  }

  async commands(_label: string): Promise<RepoCommand[] | null> {
    return [];
  }

  async ackCommands(_results: RepoCommandResult[]): Promise<void> {}

  async unpair(): Promise<UnpairOutcome> {
    return { kind: 'unpaired', canceled: 0 };
  }
}

/** fábricas que crean (y guardan por id) plataformas falsas para el protocolo duckhunt-42. */
export function fakeFactories(): { factories: PlatformFactories; created: Map<string, FakePlatform> } {
  const created = new Map<string, FakePlatform>();
  const factories: PlatformFactories = {
    [PROTOCOL.duckhunt42]: (id, credential) => {
      const p = new FakePlatform(id, credential);
      created.set(id, p);
      return p;
    },
  };
  return { factories, created };
}
