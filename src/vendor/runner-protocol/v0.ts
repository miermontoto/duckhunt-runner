// spec v0 del cable del runner (t#495, M4): el protocolo abierto con el que cualquier plataforma encarga runs a un
// daemon, junto al legacy (contrato 42) que sigue congelado byte a byte. lo descubre el daemon en
// `/.well-known/agent-runner` (sin ese documento sigue en legacy) y habla por `/api/runner/v0/*` con la misma
// audiencia oauth (la credencial de siempre vale).
// decisiones:
// - ids de run opacos (string, RUN_ID_V0_RE): el daemon los usa en nombres de fichero; nunca el entero interno.
// - toda petición lleva PROTOCOL_HEADER con la versión mayor y toda respuesta la devuelve; un error viaja siempre
//   en el sobre `{ error: { code, message, retryable? } }` con un código estable (V0_ERROR_CODE).
// - claim: siempre 200 (`{ run: null }` sin trabajo, nunca 204). lease = latido + progreso, y `cancel` es la única
//   señal de matar. result idempotente por (run, segmento): un segundo informe responde `duplicate: true`.
// - features (el daemon le pide a la plataforma que cambie lo que manda) frente a attestations (el daemon promete
//   que aplica algo en local). los nombres del núcleo van sin prefijo; los del backend, `backend.<id>.*`; los de
//   una plataforma, `x-<ns>.*` (y sus campos en `ext["x-<ns>"]`). ambos lados ignoran lo desconocido de `ext` y las
//   features que no conocen; el daemon rechaza un claim con un campo de `policy` del núcleo que no conoce.
// - policy.toolset (toolset.ts) es lo que manda en v0: el daemon renderiza sus tools cortando el toolset con el
//   techo que el usuario le puso a la plataforma. `backend.claude_code` (las listas de siempre) viaja mientras
//   dura la transición y solo sirve para la comparación en sombra.

import type { AgentPromptProfile, AgentRunIsolation, LegacyClaimEvents } from './claim.js';
import { RUNNER_CAPABILITY, type RunnerCapability } from './capabilities.js';
import { AGENT_RUN_ERROR_CODE } from './errors.js';
import type { AgentRunEventKind } from './events.js';
import type { ToolsetShadow, ToolsetV1 } from './toolset.js';

/** nombre del protocolo en el documento de discovery. */
export const AGENT_RUNNER_PROTOCOL = 'agent-runner';
/** versión mayor de este cable: fija status, campos obligatorios y la máquina de estados. */
export const RUNNER_PROTOCOL_V0 = '0';
/** cabecera con la versión mayor en toda petición y toda respuesta. */
export const RUNNER_PROTOCOL_HEADER = 'Agent-Runner-Protocol';
/** documento de discovery, bajo `/.well-known/`. */
export const AGENT_RUNNER_WELL_KNOWN = 'agent-runner';
/** id de run del cable v0: opaco y apto para un nombre de fichero. */
export const RUN_ID_V0_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** rutas de v0 relativas a la raíz del server (las de un run llevan `{id}`). */
export const V0_ENDPOINT = {
  claim: '/api/runner/v0/claim',
  lease: '/api/runner/v0/runs/{id}/lease',
  events: '/api/runner/v0/runs/{id}/events',
  result: '/api/runner/v0/runs/{id}/result',
  unpair: '/api/runner/v0/unpair',
} as const;
export type V0EndpointName = keyof typeof V0_ENDPOINT;
/** marcador del id en las rutas de un run. */
export const V0_RUN_ID_PLACEHOLDER = '{id}';

/** backends para los que la plataforma puede pre-renderizar su kit (`backend.<id>`). */
export const V0_BACKEND = { claudeCode: 'claude_code' } as const;

/** lo que el daemon pide (features) y lo que promete aplicar (attestations). */
export const V0_FEATURE = {
  model: 'model',
  checkout: 'checkout',
  toolsetV1: 'toolset_v1',
  resourcesRepo: 'resources.repo',
  resourcesAws: 'resources.cloud.aws',
  resourcesBrowser: 'resources.browser',
  readShell: 'backend.claude_code.read_shell',
  nativeMemory: 'backend.claude_code.native_memory',
  repoEdit: 'x-duckhunt.repo_edit',
  worktreeReport: 'x-duckhunt.worktree_report',
  seedBudget: 'x-duckhunt.seed_budget',
} as const;
export const V0_ATTESTATION = {
  secretPaths: 'secret_paths',
  awsStrict: 'aws_strict',
} as const;

/** capabilities del cable legacy que v0 da por hechas (todo daemon v0 las cumple): no viajan. */
export const V0_IMPLIED_CAPABILITIES: readonly RunnerCapability[] = [
  RUNNER_CAPABILITY.prompt,
  RUNNER_CAPABILITY.events,
  RUNNER_CAPABILITY.logout,
  RUNNER_CAPABILITY.toolsetV1,
];
/** capability legacy → su nombre en v0 (feature o attestation): la tabla con la que ambos lados traducen. */
export const V0_NAME_OF_CAPABILITY: Readonly<Partial<Record<RunnerCapability, string>>> = {
  [RUNNER_CAPABILITY.model]: V0_FEATURE.model,
  [RUNNER_CAPABILITY.checkout]: V0_FEATURE.checkout,
  [RUNNER_CAPABILITY.aws]: V0_FEATURE.resourcesAws,
  [RUNNER_CAPABILITY.browser]: V0_FEATURE.resourcesBrowser,
  [RUNNER_CAPABILITY.readShell]: V0_FEATURE.readShell,
  [RUNNER_CAPABILITY.nativeMemory]: V0_FEATURE.nativeMemory,
  [RUNNER_CAPABILITY.repoEdit]: V0_FEATURE.repoEdit,
  [RUNNER_CAPABILITY.worktreeReport]: V0_FEATURE.worktreeReport,
  [RUNNER_CAPABILITY.seedBudget]: V0_FEATURE.seedBudget,
  [RUNNER_CAPABILITY.secretPaths]: V0_ATTESTATION.secretPaths,
  [RUNNER_CAPABILITY.awsStrict]: V0_ATTESTATION.awsStrict,
};

/** espacio de nombres de las extensiones de duckhunt (campos `ext`, endpoints `/ext/x-duckhunt/*`). */
export const DUCKHUNT_EXT_NS = 'x-duckhunt';
/** endpoints de la extensión de duckhunt: alias de los legacy sobre ids públicos. */
export const DUCKHUNT_EXT_ENDPOINT = {
  repoCommands: '/api/runner/ext/x-duckhunt/repo-commands',
  repoCommandResults: '/api/runner/ext/x-duckhunt/repo-commands/results',
  conversations: '/api/runner/ext/x-duckhunt/conversations',
} as const;

/** códigos del sobre de error de v0 (los de los agent runs, errors.ts, y los del transporte). */
export const V0_ERROR_CODE = {
  ...AGENT_RUN_ERROR_CODE,
  unauthorized: 'unauthorized',
  invalidRequest: 'invalid_request',
  protocolVersionUnsupported: 'protocol_version_unsupported',
  payloadTooLarge: 'payload_too_large',
  rateLimited: 'rate_limited',
  unavailable: 'unavailable',
} as const;
export type V0ErrorCode = (typeof V0_ERROR_CODE)[keyof typeof V0_ERROR_CODE];

export interface V0ErrorEnvelope {
  error: { code: string; message: string; retryable?: boolean };
}

/** topes que publica la plataforma (sustituyen a las constantes que el daemon copiaba a mano). */
export interface V0Limits {
  announceMax: number;
  eventBatchMax: number;
  eventBodyMaxChars: number;
  eventToolMaxChars: number;
  resultMaxChars: number;
  errorMaxChars: number;
  stderrTailMaxChars: number;
  requestBytesMax: number;
}
/** tope del cuerpo de cualquier petición de v0 (más → payload_too_large). */
export const V0_REQUEST_BYTES_MAX = 1_048_576;
/** tope del `result` de un informe. */
export const V0_RESULT_MAX_CHARS = 20_000;

export interface V0Extension {
  ns: string;
  version: string;
  endpoints: Record<string, string>;
}

/** GET /.well-known/agent-runner. */
export interface AgentRunnerDiscovery {
  protocol: typeof AGENT_RUNNER_PROTOCOL;
  protocol_versions: string[];
  issuer: string;
  // metadata rfc 8414 del authorization server (no se duplica aquí).
  authorization_server_metadata: string;
  // la audiencia oauth: todo endpoint vive bajo ella.
  resource: string;
  oob_redirect_uri: string;
  endpoints: Record<V0EndpointName, string>;
  features: string[];
  backends: string[];
  extensions: V0Extension[];
  limits: V0Limits;
}

/** un recurso que la máquina anuncia (sin paths) y su salud. */
export interface V0ResourceAnnounce {
  type: string;
  keys: string[];
}
export interface V0HealthIssue {
  type: string;
  key: string;
  kind: string;
  count?: number;
}

/** POST claim: lo que anuncia la máquina. */
export interface ClaimRequestV0 {
  runner: { label?: string; version: string; slots: number; machineId?: string; replacesClientId?: string };
  backend: { id: string; version?: string };
  features: string[];
  attestations: string[];
  resources: V0ResourceAnnounce[];
  health?: V0HealthIssue[];
  ext?: Record<string, unknown>;
}

/** estado de la máquina cuando no hay run (idle = nada en cola que acepte). */
export const V0_RUNNER_STATE = {
  idle: 'idle',
  paused: 'paused',
  full: 'full',
  disabled: 'disabled',
  upgradeRequired: 'upgrade_required',
} as const;
export type V0RunnerState = (typeof V0_RUNNER_STATE)[keyof typeof V0_RUNNER_STATE];

/** la máquina tal como la fijó la persona. */
export interface V0RunnerBlock {
  id: string;
  name: string | null;
  paused: boolean;
  accepts: string[];
  maxSlots: number | null;
}

/** un recurso del run: tipo y clave de un grant del toolset, con los parámetros del run (rama, región…). */
export interface V0RunResource {
  type: string;
  key: string;
  params?: Record<string, string | null>;
}

/** un servidor mcp de la plataforma con el token per-run (expiresAt en ms desde epoch). */
export interface V0McpServer {
  name: string;
  url: string;
  token: string;
  expiresAt: number;
}

/** el run reclamado. */
export interface RunV0 {
  id: string;
  segment: number;
  prompt: string;
  fallbackPrompt?: string;
  profile: AgentPromptProfile;
  isolation: AgentRunIsolation;
  model?: string;
  session?: { backend: string; handle: string };
  resources: V0RunResource[];
  policy: { toolset: ToolsetV1; limits: { timeoutMs: number; budgetUsd?: number } };
  mcpServers: V0McpServer[];
  lease: { heartbeatMs: number };
  events: LegacyClaimEvents;
  // listas pre-renderizadas por backend (`claude_code`: allowed, disallowed, permissionMode), en transición.
  backend?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

export interface ClaimResponseV0 {
  run: RunV0 | null;
  runner?: V0RunnerBlock;
  state?: V0RunnerState;
}

/** POST runs/{id}/lease: latido y progreso juntos. */
export interface LeaseRequestV0 {
  segment: number;
  toolCalls?: number;
  workdir?: string;
}
export const V0_LEASE_REASON = {
  canceled: 'canceled',
  superseded: 'superseded',
  closed: 'closed',
  disabled: 'disabled',
} as const;
export interface LeaseResponseV0 {
  cancel: boolean;
  reason?: string;
}

export interface EventsRequestV0 {
  segment: number;
  events: { seq: number; kind: AgentRunEventKind; tool?: string | null; body: string }[];
}
export interface EventsResponseV0 {
  accepted: number;
  lastSeq: number;
}

/** status con el que el daemon cierra un segmento. */
export const V0_RESULT_STATUS = { done: 'done', failed: 'failed', canceled: 'canceled' } as const;
export type V0ResultStatus = (typeof V0_RESULT_STATUS)[keyof typeof V0_RESULT_STATUS];

export interface ResultRequestV0 {
  segment: number;
  status: V0ResultStatus;
  result?: string;
  error?: string;
  usage?: { costUsd?: number; numTurns?: number; toolCalls?: number };
  model?: string;
  session?: { handle: string; resumed: boolean };
  stderrTail?: string;
  // la comparación en sombra del render con las listas de `backend` (toolset.ts), mientras viajen.
  toolsetShadow?: ToolsetShadow;
}
export interface ResultResponseV0 {
  run: { id: string; status: string };
  duplicate?: boolean;
}

export interface UnpairResponseV0 {
  ok: true;
  runnerId: string | null;
  canceled: string[];
}

/** la ruta de un endpoint de un run con su id (encodeURIComponent no hace falta: RUN_ID_V0_RE). */
export const v0RunPath = (template: string, runId: string): string => template.replace(V0_RUN_ID_PLACEHOLDER, runId);
