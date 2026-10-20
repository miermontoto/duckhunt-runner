// la spec v0 del cable del runner como plataforma (t#495, M4; vendor/runner-protocol, v0.ts): cualquier plataforma
// que publique `/.well-known/agent-runner` (discovery.ts) y hable `/api/runner/v0/*` con la misma credencial oauth.
// - la cabecera de versión en toda petición (http-transport.ts con las rutas desde la raíz que da el discovery).
// - el claim anuncia features, attestations y recursos por clave (también `default` de la aws si el usuario la
//   expone); el run que llega se APLICA (claim-v0.ts): un claim que no se acepta vuelve como invalid con su código y
//   el supervisor lo cierra como failed.
// - lease = latido y progreso: el run muere solo con `cancel` o un 404. el progreso sale en su propio lease (su
//   respuesta la ignora: el latido siguiente, como mucho a heartbeatMs, recoge cualquier cancel).
// - result idempotente: un 200 (también `duplicate`) cierra; un 409 (segmento superado, run cerrado) o un 404 son
//   definitivos; 429 y 5xx se reintentan con el backoff del legacy.
// - lo de duckhunt (conversaciones abiertas, comandos del mapa de repos, candidatos y trabajo conservado en el
//   claim) solo si el discovery anuncia su extensión `x-duckhunt`.

import type { RunnerCredential } from '../config.js';
import type { SeqEvent } from '../event-uploader.js';
import { parseRepoCommands, type RepoCommand, type RepoCommandResult } from '../repo-commands.js';
import { chunk } from '../resources/repo/gc.js';
import { RESOURCE_TYPE } from '../resources/types.js';
import { CLAIM_OUTCOME, type RunnerBlock } from '../server-state.js';
import { clampReport, type StatusReport } from '../status-report.js';
import {
  DUCKHUNT_EXT_NS,
  RUNNER_CLAUDE_VERSION_MAX_CHARS,
  RUNNER_PROTOCOL_HEADER,
  RUNNER_PROTOCOL_V0,
  V0_ATTESTATION,
  V0_BACKEND,
  V0_FEATURE,
  V0_NAME_OF_CAPABILITY,
  V0_RUNNER_STATE,
  v0RunPath,
  type ClaimRequestV0,
  type RunnerCapability,
} from '../vendor/runner-protocol/index.js';
import { claimOfV0, v0RunIdOf } from './claim-v0.js';
import { credentialStore } from './credentials.js';
import { fetchDiscovery, type V0Discovery } from './discovery.js';
import { isTransient, sleep, STATUS_POST_ATTEMPTS, STATUS_POST_BACKOFF_MS } from './duckhunt42.js';
import { HttpTransport } from './http-transport.js';
import {
  CLAIM_RESULT,
  PlatformRejectedError,
  PROTOCOL,
  type ClaimAnnounce,
  type ClaimResult,
  type HeartbeatVerdict,
  type Platform,
  type PlatformContext,
  type RunSegment,
  type UnpairOutcome,
} from './platform.js';

// la versión del daemon si no se pudo leer la suya (el claim la exige).
const UNKNOWN_VERSION = 'unknown';
// features que este daemon pide siempre: el toolset neutro y los recursos de repo.
const BASE_FEATURES: readonly string[] = [V0_FEATURE.toolsetV1, V0_FEATURE.resourcesRepo];
const ATTESTATIONS: ReadonlySet<string> = new Set(Object.values(V0_ATTESTATION));
// endpoints de la extensión de duckhunt (por su nombre en el discovery).
const EXT = { conversations: 'conversations', repoCommands: 'repoCommands', repoCommandResults: 'repoCommandResults' } as const;
const REPO_COMMANDS_HEADER = 'x-duckhunt-repo-commands';
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const KEEP: HeartbeatVerdict = { stop: false };
const DIGITS_RE = /^\d+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** las capabilities de este daemon como features y attestations de v0 (las implícitas no viajan). */
export function v0Announce(capabilities: readonly string[]): { features: string[]; attestations: string[] } {
  const names = capabilities.flatMap((c) => V0_NAME_OF_CAPABILITY[c as RunnerCapability] ?? []);
  return {
    features: [...new Set([...BASE_FEATURES, ...names.filter((n) => !ATTESTATIONS.has(n))])],
    attestations: names.filter((n) => ATTESTATIONS.has(n)),
  };
}

// el bloque de la máquina de v0 en la forma que guarda server-state (status lo enseña): id numérico si lo es.
function runnerBlockOf(raw: unknown): RunnerBlock | null {
  if (!isObj(raw) || !isObj(raw.runner)) return null;
  const { id, name, paused, accepts, maxSlots } = raw.runner;
  if (typeof id !== 'string' || !DIGITS_RE.test(id) || typeof paused !== 'boolean' || !Array.isArray(accepts)) return null;
  return {
    id: Number(id),
    name: typeof name === 'string' ? name : null,
    paused,
    accepts: accepts.filter((a): a is string => typeof a === 'string').join(','),
    maxSlots: typeof maxSlots === 'number' ? maxSlots : null,
  };
}

// el error del sobre de v0 de una respuesta, para el log.
const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  return body?.error ? `${String(body.error.code)}: ${String(body.error.message)}` : `http ${res.status}`;
};

export class V0Platform implements Platform {
  readonly protocol = PROTOCOL.v0;
  // el discovery validado; se vuelve a pedir mientras no se tenga uno.
  private discovery: V0Discovery | null = null;

  constructor(
    readonly id: string,
    private readonly transport: HttpTransport,
    private readonly ctx: PlatformContext | undefined,
    private readonly discover: (baseUrl: string) => Promise<V0Discovery> = fetchDiscovery,
  ) {}

  identity(): { baseUrl: string; clientId: string } {
    const { baseUrl, clientId } = this.transport.credential;
    return { baseUrl, clientId };
  }

  observe(credential: RunnerCredential): void {
    this.transport.observe(credential);
  }

  private async doc(): Promise<V0Discovery> {
    this.discovery ??= await this.discover(this.transport.credential.baseUrl);
    return this.discovery;
  }

  // una ruta de la extensión de duckhunt, si el discovery la anuncia.
  private extPath(doc: V0Discovery, name: string): string | null {
    return doc.extensions.get(DUCKHUNT_EXT_NS)?.[name] ?? null;
  }

  private claimBody(a: ClaimAnnounce, doc: V0Discovery): ClaimRequestV0 {
    const { replacesClientId } = this.transport.credential;
    const duckhuntExt = doc.extensions.has(DUCKHUNT_EXT_NS);
    const ext = {
      ...(a.repoCandidates ? { repoCandidates: a.repoCandidates } : {}),
      ...(a.kept ? { keptWorktrees: a.kept } : {}),
    };
    return {
      runner: {
        label: a.label,
        version: a.version ?? UNKNOWN_VERSION,
        slots: a.slots,
        ...(a.machineId ? { machineId: a.machineId } : {}),
        ...(replacesClientId ? { replacesClientId } : {}),
      },
      backend: { id: V0_BACKEND.claudeCode, ...(a.claudeVersion ? { version: a.claudeVersion.slice(0, RUNNER_CLAUDE_VERSION_MAX_CHARS) } : {}) },
      ...v0Announce(a.capabilities),
      resources: [
        { type: RESOURCE_TYPE.repo, keys: [...a.repos] },
        { type: RESOURCE_TYPE.aws, keys: [...a.awsKeys] },
      ],
      ...(a.repoIssues
        ? { health: a.repoIssues.flatMap((i) => (i.repo === null ? [] : [{ type: RESOURCE_TYPE.repo, key: i.repo, kind: i.kind, ...(i.count !== undefined ? { count: i.count } : {}) }])) }
        : {}),
      ...(duckhuntExt && Object.keys(ext).length > 0 ? { ext: { [DUCKHUNT_EXT_NS]: ext } } : {}),
    };
  }

  async claim(a: ClaimAnnounce): Promise<ClaimResult> {
    let doc: V0Discovery;
    try {
      doc = await this.doc();
    } catch (err) {
      console.error(`[runner] plataforma ${this.id}: ${(err as Error).message}`);
      return { kind: CLAIM_RESULT.unavailable, commandsPending: false };
    }
    const { clientId, replacesClientId } = this.transport.credential;
    let res: Response;
    try {
      res = await this.transport.post(doc.endpoints.claim, this.claimBody(a, doc));
    } catch (err) {
      if (err instanceof PlatformRejectedError) throw err;
      console.error(`[runner] plataforma ${this.id}: claim inaccesible: ${(err as Error).message}`);
      return { kind: CLAIM_RESULT.unavailable, commandsPending: false };
    }
    if (res.ok && replacesClientId) this.transport.accepted(clientId, replacesClientId);
    const commandsPending = this.extPath(doc, EXT.repoCommands) !== null && Number(res.headers.get(REPO_COMMANDS_HEADER)) > 0;
    if (res.status !== HTTP_OK) {
      console.error(`[runner] plataforma ${this.id}: claim falló: ${await errorOf(res)}`);
      return { kind: CLAIM_RESULT.unavailable, commandsPending };
    }
    const raw: unknown = await res.json().catch(() => null);
    if (!isObj(raw)) {
      console.error(`[runner] plataforma ${this.id}: claim con json ilegible`);
      return { kind: CLAIM_RESULT.unavailable, commandsPending };
    }
    const runner = runnerBlockOf(raw);
    if (raw.run === null || raw.run === undefined) {
      const state = typeof raw.state === 'string' && raw.state !== V0_RUNNER_STATE.idle ? raw.state : null;
      return { kind: CLAIM_RESULT.idle, said: { state, runner }, commandsPending };
    }
    const said = { state: CLAIM_OUTCOME.claimed, runner };
    const runId = v0RunIdOf(raw.run);
    if (!this.ctx) return { kind: CLAIM_RESULT.invalid, runId, error: 'este daemon no puede aplicar la política de esta plataforma', said, commandsPending };
    try {
      const { claim, narrowed } = claimOfV0(raw.run, this.ctx.enforcement());
      if (narrowed.length > 0) console.log(`[runner] run ${claim.run.id}: toolset acotado por el techo de ${this.id}: ${narrowed.join(', ')}`);
      return { kind: CLAIM_RESULT.run, claim, said, commandsPending };
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[runner] plataforma ${this.id}: claim rechazado: ${message}`);
      return { kind: CLAIM_RESULT.invalid, runId, error: `claim rechazado por el runner (${message})`, said, commandsPending };
    }
  }

  // el run muere solo con cancel o si ya no existe.
  async heartbeat(runId: string, seg: RunSegment): Promise<HeartbeatVerdict> {
    const doc = await this.doc();
    const res = await this.transport.post(v0RunPath(doc.endpoints.lease, runId), seg);
    if (res.status === HTTP_NOT_FOUND) return { stop: true, reason: 'ya no existe en la plataforma' };
    if (!res.ok) return KEEP;
    const body = (await res.json().catch(() => null)) as { cancel?: unknown; reason?: unknown } | null;
    return body?.cancel === true ? { stop: true, reason: `cancelado por la plataforma (${typeof body.reason === 'string' ? body.reason : 'sin motivo'})` } : KEEP;
  }

  async progress(runId: string, toolCalls: number, seg: RunSegment, workdir?: string): Promise<void> {
    const doc = await this.doc();
    await this.transport.post(v0RunPath(doc.endpoints.lease, runId), { ...seg, toolCalls, ...(workdir ? { workdir } : {}) });
  }

  async events(runId: string, events: SeqEvent[], seg: RunSegment): Promise<number> {
    const doc = await this.doc();
    const res = await this.transport.post(v0RunPath(doc.endpoints.events, runId), { ...seg, events });
    return res.status;
  }

  // cierre con reintento acotado (ver cabecera): lo único del run que la plataforma no puede reconstruir.
  async result(runId: string, report: StatusReport): Promise<void> {
    let doc: V0Discovery;
    try {
      doc = await this.doc();
    } catch (err) {
      console.error(`[runner] result del run ${runId} sin entregar: ${(err as Error).message}`);
      return;
    }
    const r = clampReport(report);
    const usage = { ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}), ...(r.numTurns !== undefined ? { numTurns: r.numTurns } : {}), ...(r.toolCalls !== undefined ? { toolCalls: r.toolCalls } : {}) };
    const body = {
      segment: r.segment,
      status: r.status,
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.sessionId !== undefined ? { session: { handle: r.sessionId, resumed: r.resumed ?? false } } : {}),
      ...(r.stderrTail !== undefined ? { stderrTail: r.stderrTail } : {}),
      ...(r.toolsetShadow !== undefined ? { toolsetShadow: r.toolsetShadow } : {}),
    };
    // i/o secuencial con backoff exponencial.
    for (let attempt = 1; attempt <= STATUS_POST_ATTEMPTS; attempt++) {
      let rejected = false;
      const res = await this.transport.post(v0RunPath(doc.endpoints.result, runId), body).catch((err: Error) => {
        rejected = err instanceof PlatformRejectedError;
        console.error(`[runner] result falló (intento ${attempt}/${STATUS_POST_ATTEMPTS}): ${err.message}`);
        return null;
      });
      if (rejected) return;
      if (res?.ok) return;
      if (res && !isTransient(res.status)) {
        console.error(`[runner] result del run ${runId} rechazado: ${await errorOf(res)}`);
        return;
      }
      if (res) console.error(`[runner] result: http ${res.status} (intento ${attempt}/${STATUS_POST_ATTEMPTS})`);
      if (attempt < STATUS_POST_ATTEMPTS) await sleep(STATUS_POST_BACKOFF_MS * 2 ** (attempt - 1));
    }
    console.error(`[runner] result del run ${runId} sin entregar: la plataforma lo cerrará por inactividad`);
  }

  // sin la extensión de duckhunt (o sin respuesta) todas se dan por abiertas: solo actúa el ttl, que nunca pierde trabajo.
  async openConversations(runIds: string[]): Promise<Set<string>> {
    const doc = await this.doc().catch(() => null);
    const path = doc ? this.extPath(doc, EXT.conversations) : null;
    if (!path) return new Set(runIds);
    const open = new Set<string>();
    // i/o secuencial: pocas llamadas, en orden.
    for (const ids of chunk(runIds)) {
      const res = await this.transport.post(path, { runIds: ids }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { open?: unknown } | null) : null;
      if (!body || !Array.isArray(body.open)) {
        ids.forEach((id) => open.add(id));
        continue;
      }
      body.open.filter((id): id is string => typeof id === 'string').forEach((id) => open.add(id));
    }
    return open;
  }

  async commands(): Promise<RepoCommand[] | null> {
    const doc = await this.doc().catch(() => null);
    const path = doc ? this.extPath(doc, EXT.repoCommands) : null;
    if (!path) return null;
    const res = await this.transport.post(path, {});
    return res.ok ? parseRepoCommands(await res.json().catch(() => null)) : null;
  }

  async ackCommands(results: RepoCommandResult[]): Promise<void> {
    const doc = await this.doc().catch(() => null);
    const path = doc ? this.extPath(doc, EXT.repoCommandResults) : null;
    if (path) await this.transport.post(path, { results });
  }

  // revoca la credencial, borra la fila de la máquina y cancela sus runs en marcha.
  async unpair(): Promise<UnpairOutcome> {
    const doc = await this.doc();
    let res: Response;
    try {
      res = await this.transport.postOnce(doc.endpoints.unpair);
    } catch (err) {
      if (err instanceof PlatformRejectedError) return { kind: 'gone' };
      throw err;
    }
    if (res.status === HTTP_NOT_FOUND) return { kind: 'unsupported' };
    if (res.status === HTTP_UNAUTHORIZED) return { kind: 'gone' };
    if (!res.ok) throw new Error(`la plataforma respondió ${await errorOf(res)}`);
    const body = (await res.json().catch(() => ({}))) as { canceled?: unknown };
    return { kind: 'unpaired', canceled: Array.isArray(body.canceled) ? body.canceled.length : 0 };
  }
}

/** la plataforma v0 de un id, con la cabecera de versión en toda petición y las rutas desde la raíz del server. */
export const createV0Platform = (id: string, credential: RunnerCredential, ctx?: PlatformContext): V0Platform =>
  new V0Platform(id, new HttpTransport(credential, credentialStore(id), { apiPath: '', headers: { [RUNNER_PROTOCOL_HEADER]: RUNNER_PROTOCOL_V0 } }), ctx);
