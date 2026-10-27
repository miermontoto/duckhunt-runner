// el cable de duckhunt (contrato 42) como plataforma (t#495, M6): lo que antes vivía en daemon.ts (claim, latido,
// progreso, feed, status, /conversations y los comandos de repos) y en logout.ts (/unpair), movido tal cual sobre
// el transporte http (http-transport.ts). los cuerpos y las cabeceras son los de siempre, byte a byte
// (test/wire-legacy.test.ts, test/wire-responses.test.ts).
// - ids de run: por dentro texto (run-id.ts); /runs/<id> sale con el mismo texto y los dos cuerpos que llevan ids
//   (/conversations y keptWorktrees del claim) los pasan a número: uno opaco no llega nunca a este cable.
// - el diff de cada turno (t#514): POST /runs/<id>/changes, solo si el claim trajo el bloque `changes`.
// - el claim: 204 = nada que hacer (server anterior a t#465 P12, o en pausa, sin slot, actualizar: la cabecera);
//   200 { run: null } = sin trabajo con la fila de esta máquina; un json ilegible cuenta como reclamado (y no se
//   puede cerrar: lo cierra el sweeper del server); un claim que no parsea se devuelve como invalid con su id.

import { claimRunId, parseClaim } from '../claim.js';
import type { SeqEvent } from '../event-uploader.js';
import { parseRepoCommands, type RepoCommand, type RepoCommandResult } from '../repo-commands.js';
import { chunk } from '../resources/repo/gc.js';
import { RESOURCE_TYPE } from '../resources/types.js';
import { isLegacyRunId, legacyWireRunId } from '../run-id.js';
import { CLAIM_OUTCOME, parseRunnerBlock } from '../server-state.js';
import { SLASH_UPLOAD, type SlashUploadOutcome } from '../slash-commands.js';
import { clampReport, type StatusReport } from '../status-report.js';
import type { RunnerCredential } from '../config.js';
import { RUNNER_CLAUDE_VERSION_MAX_CHARS, RUNNER_SLASH_COMMANDS_PATH, RUNNER_STATE_HEADER, type RunChangesReport, type RunnerSlashCommands } from '../vendor/runner-protocol/index.js';
import { HttpTransport } from './http-transport.js';
import { credentialStore } from './credentials.js';
import {
  CLAIM_RESULT,
  PlatformRejectedError,
  PROTOCOL,
  type ClaimAnnounce,
  type ClaimResult,
  type HeartbeatVerdict,
  type Platform,
  type RunSegment,
  type UnpairOutcome,
} from './platform.js';

// cabecera de la respuesta del claim con los comandos de repos pendientes para esta máquina.
const REPO_COMMANDS_HEADER = 'x-duckhunt-repo-commands';
// cabecera del 204 (o del 200 sin trabajo de un server >= t#465 P12) con el motivo de no recibir trabajo: la
// RUNNER_STATE_HEADER del protocolo. y el tope de la versión del cli que el claim anuncia
// (RUNNER_CLAUDE_VERSION_MAX_CHARS del protocolo).
const CLAUDE_VERSION_MAX_CHARS = RUNNER_CLAUDE_VERSION_MAX_CHARS;
// estado del run que el latido espera mientras el proceso es su dueño.
const RUN_STATUS_RUNNING = 'running';
// POST /status: intentos con backoff exponencial (2 s, 4 s, 8 s, 16 s).
export const STATUS_POST_ATTEMPTS = 5;
export const STATUS_POST_BACKOFF_MS = 2_000;
const HTTP_NO_CONTENT = 204;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TIMEOUT = 408;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const KEEP: HeartbeatVerdict = { stop: false };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const isTransient = (status: number): boolean => status === HTTP_TIMEOUT || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR;

export class Duckhunt42Platform implements Platform {
  readonly protocol = PROTOCOL.duckhunt42;

  constructor(
    readonly id: string,
    private readonly transport: HttpTransport,
  ) {}

  identity(): { baseUrl: string; clientId: string } {
    const { baseUrl, clientId } = this.transport.credential;
    return { baseUrl, clientId };
  }

  observe(credential: RunnerCredential): void {
    this.transport.observe(credential);
  }

  async claim(a: ClaimAnnounce): Promise<ClaimResult> {
    let res: Response;
    // la credencial de la que sale este claim y a quién reemplaza (hasta que el server lo acepte).
    const { clientId, replacesClientId } = this.transport.credential;
    try {
      res = await this.transport.post('/claim', {
        runnerLabel: a.label,
        repos: a.repos,
        ...(a.repoIssues ? { repoIssues: a.repoIssues } : {}),
        ...(a.repoCandidates ? { repoCandidates: a.repoCandidates } : {}),
        awsAccounts: a.awsAccounts,
        capabilities: a.capabilities,
        slots: a.slots,
        ...(a.version ? { version: a.version } : {}),
        ...(a.claudeVersion ? { claudeVersion: a.claudeVersion.slice(0, CLAUDE_VERSION_MAX_CHARS) } : {}),
        ...(a.machineId ? { machine: { id: a.machineId } } : {}),
        ...(replacesClientId ? { replacesClientId } : {}),
        // el cable legacy lleva ids numéricos: uno opaco no se anuncia (ese server no lo conocería).
        ...(a.kept ? { keptWorktrees: a.kept.filter((k) => isLegacyRunId(k.runId)).map((k) => ({ ...k, runId: legacyWireRunId(k.runId) })) } : {}),
        // al final: lo de antes no cambia de orden.
        ...(a.awsDefault !== null ? { awsDefault: a.awsDefault } : {}),
        // las sesiones de navegador expuestas (LegacyClaimResources del protocolo, t#495 M7): sin ninguna, nada.
        ...(a.browsers
          ? {
              resources: [{ type: RESOURCE_TYPE.browser, keys: [...a.browsers.keys] }],
              ...(a.browsers.health.length > 0 ? { health: a.browsers.health.map((h) => ({ type: RESOURCE_TYPE.browser, key: h.key, kind: h.kind })) } : {}),
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof PlatformRejectedError) throw err;
      console.error(`[runner] claim inaccesible: ${(err as Error).message}`);
      return { kind: CLAIM_RESULT.unavailable, commandsPending: false };
    }
    if (res.ok && replacesClientId) this.transport.accepted(clientId, replacesClientId);
    const commandsPending = Number(res.headers.get(REPO_COMMANDS_HEADER)) > 0;
    const header = res.headers.get(RUNNER_STATE_HEADER);
    if (res.status === HTTP_NO_CONTENT) return { kind: CLAIM_RESULT.idle, said: { state: header, runner: null }, commandsPending };
    if (res.status !== HTTP_OK) {
      console.error(`[runner] claim falló: http ${res.status} ${await res.text().catch(() => '')}`);
      return { kind: CLAIM_RESULT.unavailable, commandsPending };
    }
    const raw: unknown = await res.json().catch((err: Error) => {
      console.error(`[runner] claim con json ilegible: ${err.message}`);
      return null;
    });
    if (raw !== null && typeof raw === 'object' && 'run' in raw && raw.run === null) {
      return { kind: CLAIM_RESULT.idle, said: { state: header, runner: parseRunnerBlock(raw) }, commandsPending };
    }
    const said = { state: CLAIM_OUTCOME.claimed, runner: parseRunnerBlock(raw) };
    try {
      return { kind: CLAIM_RESULT.run, claim: parseClaim(raw), said, commandsPending };
    } catch (err) {
      // el run ya está reclamado (running): si su id es usable se cierra con el motivo; si no, lo cerrará el
      // sweeper del server.
      const message = (err as Error).message;
      console.error(`[runner] ${message}`);
      return { kind: CLAIM_RESULT.invalid, runId: claimRunId(raw), error: message, said, commandsPending };
    }
  }

  // el run muere si ya no es suyo: cancel, un estado que no es running, o el run no existe.
  async heartbeat(runId: string, seg: RunSegment): Promise<HeartbeatVerdict> {
    const res = await this.transport.post(`/runs/${runId}/heartbeat`, seg);
    if (res.status === HTTP_NOT_FOUND) return { stop: true, reason: 'ya no existe en el server' };
    if (!res.ok) return KEEP;
    const body = (await res.json().catch(() => null)) as { cancel?: boolean; status?: string } | null;
    if (body?.cancel || (typeof body?.status === 'string' && body.status !== RUN_STATUS_RUNNING)) {
      return { stop: true, reason: `ya no es de este proceso (${body?.status ?? 'cancelado'})` };
    }
    return KEEP;
  }

  async progress(runId: string, toolCalls: number, seg: RunSegment, workdir?: string): Promise<void> {
    await this.transport.post(`/runs/${runId}/progress`, { toolCalls, ...(workdir ? { workdir } : {}), ...seg });
  }

  async events(runId: string, events: SeqEvent[], seg: RunSegment): Promise<number> {
    const res = await this.transport.post(`/runs/${runId}/events`, { events, ...seg });
    return res.status;
  }

  // el diff del turno (t#514): un intento, sin reintento ni excepción (un 409 = el run ya se cerró).
  async changes(runId: string, report: RunChangesReport, seg: RunSegment): Promise<void> {
    const res = await this.transport.post(`/runs/${runId}/changes`, { ...report, ...seg }).catch((err: Error) => {
      console.error(`[runner] diff del turno del run ${runId} no subido: ${err.message}`);
      return null;
    });
    if (res && !res.ok) console.error(`[runner] diff del turno del run ${runId} rechazado: http ${res.status}`);
  }

  // cierre con reintento acotado: es lo único del run que el server no puede reconstruir.
  async result(runId: string, report: StatusReport): Promise<void> {
    const body = clampReport(report);
    // i/o secuencial con backoff exponencial.
    for (let attempt = 1; attempt <= STATUS_POST_ATTEMPTS; attempt++) {
      let rejected = false;
      const res = await this.transport.post(`/runs/${runId}/status`, body).catch((err: Error) => {
        rejected = err instanceof PlatformRejectedError;
        console.error(`[runner] status post falló (intento ${attempt}/${STATUS_POST_ATTEMPTS}): ${err.message}`);
        return null;
      });
      // sin credencial no hay reintento que valga (duckhunt ya lo cerró al desvincular la máquina).
      if (rejected) return;
      // 409 = el server ya cerró el run (cancel del usuario, sweeper): benigno.
      if (res && (res.ok || res.status === HTTP_CONFLICT)) return;
      if (res && !isTransient(res.status)) {
        console.error(`[runner] status post rechazado: http ${res.status} ${await res.text().catch(() => '')}`);
        return;
      }
      if (res) console.error(`[runner] status post: http ${res.status} (intento ${attempt}/${STATUS_POST_ATTEMPTS})`);
      if (attempt < STATUS_POST_ATTEMPTS) await sleep(STATUS_POST_BACKOFF_MS * 2 ** (attempt - 1));
    }
    console.error(`[runner] status del run ${runId} sin entregar: el server lo cerrará por inactividad`);
  }

  // si el server no contesta (o es anterior a t#378), todas se dan por abiertas: entonces solo actúa el ttl de
  // inactividad, que nunca pierde trabajo. un id opaco no se pregunta y cuenta como abierto (solo el ttl).
  async openConversations(runIds: string[]): Promise<Set<string>> {
    const open = new Set(runIds.filter((id) => !isLegacyRunId(id)));
    if (open.size > 0) console.warn(`[runner] gc: ${open.size} worktree(s) con id no numérico; solo se les aplica el ttl`);
    // i/o secuencial: pocas llamadas, en orden.
    for (const ids of chunk(runIds.filter(isLegacyRunId))) {
      const res = await this.transport.post('/conversations', { runIds: ids.map(legacyWireRunId) }).catch((err: Error) => {
        console.error(`[runner] gc: /conversations inaccesible: ${err.message}`);
        return null;
      });
      const body = res?.ok ? ((await res.json().catch(() => null)) as { open?: unknown } | null) : null;
      if (!body || !Array.isArray(body.open)) {
        if (res && !res.ok) console.error(`[runner] gc: /conversations respondió http ${res.status}: solo se aplica el ttl`);
        ids.forEach((id) => open.add(id));
        continue;
      }
      body.open.filter((id): id is number => Number.isSafeInteger(id)).forEach((id) => open.add(String(id)));
    }
    return open;
  }

  async commands(label: string): Promise<RepoCommand[] | null> {
    const res = await this.transport.post('/repo-commands', { runnerLabel: label });
    if (!res.ok) {
      console.error(`[runner] repos: /repo-commands respondió http ${res.status}`);
      return null;
    }
    return parseRepoCommands(await res.json().catch(() => null));
  }

  async ackCommands(results: RepoCommandResult[]): Promise<void> {
    const ack = await this.transport.post('/repo-commands/results', { results });
    if (!ack.ok) console.error(`[runner] repos: /repo-commands/results respondió http ${ack.status}`);
  }

  // catálogo de slash commands (t#555). un 404 = server anterior a la ruta: no se reintenta hasta que el catálogo cambie.
  async slashCommands(catalog: RunnerSlashCommands): Promise<SlashUploadOutcome> {
    const res = await this.transport.post(RUNNER_SLASH_COMMANDS_PATH, catalog).catch((err: Error) => {
      console.error(`[runner] slash commands: ${RUNNER_SLASH_COMMANDS_PATH} inaccesible: ${err.message}`);
      return null;
    });
    if (res?.ok) return SLASH_UPLOAD.ok;
    if (res?.status === HTTP_NOT_FOUND) return SLASH_UPLOAD.unsupported;
    if (res) console.error(`[runner] slash commands: ${RUNNER_SLASH_COMMANDS_PATH} respondió http ${res.status}`);
    return SLASH_UPLOAD.failed;
  }

  // revoca la credencial, borra la fila de la máquina y cancela sus runs en marcha (lo mismo que el × de
  // Ajustes → Agentes → Máquinas). un 404 = server anterior a 0.11, sin el endpoint.
  async unpair(): Promise<UnpairOutcome> {
    let res: Response;
    try {
      res = await this.transport.postOnce('/unpair');
    } catch (err) {
      if (err instanceof PlatformRejectedError) return { kind: 'gone' };
      throw err;
    }
    if (res.status === HTTP_NOT_FOUND) return { kind: 'unsupported' };
    if (res.status === HTTP_UNAUTHORIZED) return { kind: 'gone' };
    if (!res.ok) throw new Error(`el server respondió http ${res.status} ${await res.text().catch(() => '')}`);
    const body = (await res.json().catch(() => ({}))) as { canceled?: unknown };
    return { kind: 'unpaired', canceled: Array.isArray(body.canceled) ? body.canceled.length : 0 };
  }
}

/** la plataforma duckhunt-42 de un id, sobre el transporte de siempre. */
export const createDuckhunt42Platform = (id: string, credential: RunnerCredential): Duckhunt42Platform =>
  new Duckhunt42Platform(id, new HttpTransport(credential, credentialStore(id)));
