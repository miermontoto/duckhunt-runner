// forma del claim de POST /api/runner/claim (contrato 42 + prompts libres t#378) y su validación
// local. el daemon ejecuta lo que el server compone, pero lo que acaba en paths o en argv (id del
// run, sesión, rama, permission mode, ids de tools) se valida aquí: ni un server comprometido ni un
// bug suyo deben poder colar un flag en `claude`/`git` ni un `..` en un path.
// decisiones:
// - una rama inutilizable NO tumba el claim: se ignora con un aviso y el worktree cae en la base por
//   defecto (las ramas de prs de bitbucket/github llevan ñ, '+', '#'…; quien decide es
//   `git check-ref-format`, y todo argumento de git va tras `--end-of-options`).
// - el perfil read de un prompt run se hace cumplir AQUÍ también: permission mode dontAsk, nada de
//   Edit/Write/NotebookEdit en las permitidas (NotebookEdit forzada en las denegadas) y Bash solo como
//   shell de solo lectura (t#385): nunca Bash entero ni un patrón que no sea `Bash(aws <servicio> <lectura>*)`.
//   Edit/Write ya no se fuerzan al deny entero (t#434, `native_memory`): sin regla de allow, dontAsk
//   solo las deja escribir la memoria nativa del cli (su excepción para el dir de auto-memory; el
//   resto de rutas, denegadas), y las reglas Edit/Write de los settings que carga el run se espejan
//   al deny (user-permissions.ts). el deny entero ganaría también a esa excepción.
//   el cli auto-aprueba su propia shell de lectura (cat, grep, git log…) y bloquea la que ejecuta o
//   escribe; la aws cli va fijada en servicio + operación (un `*` antes de la operación dejó pasar
//   `aws s3 rm … --exclude list-x`) y sus lecturas que escriben un fichero local, negadas siempre.
//   un bug o una deriva del server nunca le da a una lectura una shell que ejecute o escriba.
// - `run.segment` es la identidad del proceso: viaja de vuelta en heartbeat/progress/events/status.
// - `run.id` (t#495, M1) es texto opaco por dentro (run-id.ts): del cable legacy solo vale un entero positivo,
//   que se guarda como String(id); la vuelta a número para el cable vive en run-id.ts::legacyWireRunId.
// - `run.seed` (t#465 P6) dice si la conversación nació de una plantilla de investigación: con
//   seed_budget (0.11.0) su presupuesto se aplica aunque viaje como prompt run (claude-args.ts). el bloque
//   `runner` de un server >= t#465 P12 no es del run: lo lee server-state.ts, y parseClaim lo ignora.
// - `run.model` (0.12.0, capability `model`): el modelo que la persona eligió para esa conversación
//   (su default de ajustes, el composer, el hilo o la acción de una regla); null = ninguno, manda
//   `defaults.model` de la config y si no el default del cli. acaba en argv tras `--model`, así que
//   solo pasa un alias o un id de modelo (MODEL_RE, el AGENT_MODEL_ID_RE del server); cualquier otra
//   cosa se ignora con un aviso y el run sigue con el modelo de la máquina: un modelo raro no merece
//   tumbar el claim, y un `-x` nunca llega al cli como flag.

import { runIdFromLegacy } from './run-id.js';
import {
  AGENT_AWS_READ_COMMANDS,
  AGENT_AWS_READ_VERBS,
  AGENT_PROMPT_PROFILE,
  AGENT_RUN_EVENT_BATCH_MAX,
  AGENT_RUN_EVENT_BODY_MAX_CHARS,
  AGENT_RUN_EVENT_FLUSH_COUNT,
  AGENT_RUN_EVENT_FLUSH_MS,
  AGENT_RUN_EVENT_TOOL_ARG_MAX_CHARS,
  AGENT_RUN_ISOLATION,
  AGENT_RUN_KIND,
  AGENT_RUN_SEED,
  RUNNER_CAPABILITY,
  TOOLSET_V1,
  type AgentPromptProfile,
  type AgentRunIsolation,
  type AgentRunSeed,
  type RunnerCapability,
} from './vendor/runner-protocol/index.js';
import { parseToolsetV1 } from './toolset/parse.js';
import type { ShadowSource } from './toolset/shadow.js';
import type { ResourceRequest } from './resources/types.js';

// capacidades que el daemon anuncia en el claim: sus ids y lo que el server hace con cada una vienen del
// protocolo vendorizado (vendor/runner-protocol, t#495 M3). el server entrega kind=prompt solo a quien
// anuncia `prompt`, pide el feed de progreso solo a quien anuncia `events` y deja abrir una
// conversación en el checkout solo a quien anuncia `checkout` (>= 0.6.0), la shell de solo lectura
// en read solo a quien anuncia `read_shell` (>= 0.7.0) y deja de negar Edit/Write enteras en read y
// en los runs de reglas (su memoria nativa) solo a quien anuncia `native_memory` (>= 0.8.0).
// lo propio de este daemon: `repo_edit` (cambios del mapa de repos pedidos desde duckhunt, repo-commands.ts)
// es apagable en local; 0.11.0 (t#465 P12) niega a Read las rutas reales de las credenciales de esta máquina
// en todo kit de lectura (secret-paths.ts), aplica el presupuesto a las plantillas (seed_budget), corre con la
// aws vacía una cuenta sin mapear (resources/aws.ts), anuncia el trabajo que su gc conservó (keptWorktrees) y
// sabe desvincularse (`logout`, y lee el bloque runner del claim); 0.12.0 (t#465) pasa a claude el modelo que
// pide el claim (run.model) con --model, y `model` se anuncia solo si `claude --help` lista --model.
export { RUNNER_CAPABILITY, type RunnerCapability };

// dónde trabaja un prompt run con repo (lo elige el usuario al abrir la conversación): el worktree
// conv-<id> aislado o el checkout tal cual (su rama y sus cambios). ausente o desconocido = worktree,
// lo más aislado. los runs de reglas no lo usan: su cwd lo decide `worktree` del repo en la config.
export const RUN_ISOLATION = AGENT_RUN_ISOLATION;
export type RunIsolation = AgentRunIsolation;

export const RUN_KIND = AGENT_RUN_KIND;

export const PROMPT_PROFILE = AGENT_PROMPT_PROFILE;
export type PromptProfile = AgentPromptProfile;

// de qué nació la conversación (run.seed, t#465 P6): una plantilla de investigación o el texto de la persona.
export const RUN_SEED = AGENT_RUN_SEED;
export type RunSeed = AgentRunSeed;

// techo local de permission modes: el server manda dontAsk; bypassPermissions nunca se acepta
// desde fuera (el opt-in a saltarse permisos es solo local, `repos add --dangerously-skip-permissions`).
export const ALLOWED_PERMISSION_MODES: readonly string[] = ['dontAsk', 'default', 'acceptEdits', 'plan'];

// si el server omite timeoutMs/heartbeatMs (espejo de AGENT_HARNESS_RUN_TIMEOUT_MS y
// RUN_HEARTBEAT_INTERVAL_MS del server).
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
// defaults del feed si el server no los manda: los AGENT_RUN_EVENT_* del protocolo, los que manda él.
export const EVENTS_DEFAULTS = {
  nextSeq: 1,
  flushMs: AGENT_RUN_EVENT_FLUSH_MS,
  flushCount: AGENT_RUN_EVENT_FLUSH_COUNT,
  batchMax: AGENT_RUN_EVENT_BATCH_MAX,
  bodyMaxChars: AGENT_RUN_EVENT_BODY_MAX_CHARS,
  toolArgMaxChars: AGENT_RUN_EVENT_TOOL_ARG_MAX_CHARS,
} as const;

// cordura mínima de una rama ANTES de tocar git: sin '-' inicial (no puede parecer una opción), sin
// espacios ni caracteres de control, acotada. quien decide de verdad es `git check-ref-format --branch`.
export const BRANCH_RE = /^(?!-)[^\s\x00-\x1f\x7f]{1,250}$/;
// permission mode que exige un prompt run (el server lo manda siempre; sin él heredaría el del usuario).
export const PROMPT_PERMISSION_MODE = 'dontAsk';
// built-in que un prompt run de lectura nunca puede tener en el allow (ni con patrón). de ellas solo
// NotebookEdit va siempre a su deny: Edit/Write sin regla alcanzan solo la memoria nativa del cli.
export const READ_FORBIDDEN_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];
// built-in con las que el cli escribe su memoria nativa: fuera del deny forzado de lectura.
export const MEMORY_WRITE_TOOLS: readonly string[] = ['Edit', 'Write'];
export const BASH_TOOL = 'Bash';
// aws cli en lectura (AGENT_AWS_READ_VERBS / AGENT_AWS_READ_COMMANDS del protocolo): verbos por
// convención de la api de aws y lecturas sueltas (servicio + operación exacta). el servicio no se acota
// aquí (el server sí los enumera): lo que fija la lectura es la operación.
export const READ_AWS_VERBS: readonly string[] = AGENT_AWS_READ_VERBS;
export const READ_AWS_COMMANDS: readonly string[] = AGENT_AWS_READ_COMMANDS;
// lecturas de la aws cli que escriben un fichero local (payload blob → la cli exige un outfile):
// al deny de TODO claim read, del servicio que sea. derivadas de los modelos de botocore de la aws
// cli 2.30.4 (operaciones describe|list|get|batch-get|head con payload blob), por prefijo de
// operación (s3api get-object cubre get-object-torrent).
export const AWS_OUTFILE_COMMANDS: readonly string[] = [
  'apigateway get-export',
  'apigateway get-sdk',
  'appconfig get-configuration',
  'appconfig get-hosted-configuration-version',
  'appconfigdata get-latest-configuration',
  'appsync get-introspection-schema',
  'cloudfront get-function',
  'codeartifact get-package-version-asset',
  'codeguruprofiler get-profile',
  'datazone get-lineage-event',
  'ebs get-snapshot-block',
  'geo-maps get-glyphs',
  'geo-maps get-sprites',
  'geo-maps get-static-map',
  'geo-maps get-style-descriptor',
  'geo-maps get-tile',
  'glacier get-job-output',
  'iot-data get-thing-shadow',
  'iotwireless get-position-estimate',
  'iotwireless get-resource-position',
  'kinesis-video-archived-media get-clip',
  'kinesis-video-archived-media get-media-for-fragment-list',
  'kinesis-video-media get-media',
  'lakeformation get-work-unit-results',
  'location get-map-glyphs',
  'location get-map-sprites',
  'location get-map-style-descriptor',
  'location get-map-tile',
  'medialive describe-input-device-thumbnail',
  'mediastore-data get-object',
  'medical-imaging get-image-frame',
  'medical-imaging get-image-set-metadata',
  'omics get-read-set',
  'omics get-reference',
  's3api get-object',
  'sagemaker-geospatial get-tile',
  'schemas get-code-binding-source',
  'tnb get-sol-function-package-content',
  'tnb get-sol-function-package-descriptor',
  'tnb get-sol-network-package-content',
  'tnb get-sol-network-package-descriptor',
  'workmailmessageflow get-raw-message-content',
];
// patrón de la aws cli fijado en servicio + operación, tal como lo compone el server.
const AWS_READ_PATTERN_RE = /^Bash\(aws ([a-z0-9-]+) ([a-z0-9-]+)\*\)$/;
// deny forzado de un claim read: built-in prohibidas salvo las de la memoria + escritores de fichero
// de la aws cli.
const READ_FORCED_DENY: readonly string[] = [
  ...READ_FORBIDDEN_TOOLS.filter((t) => !MEMORY_WRITE_TOOLS.includes(t)),
  ...AWS_OUTFILE_COMMANDS.map((c) => `${BASH_TOOL}(aws ${c}*)`),
];
// longitud con la que un valor descartado (rama, modelo) aparece en el aviso.
const WARNING_VALUE_CHARS = 80;
// alias (`opus`, `sonnet`…) o id completo de modelo (`claude-opus-5-5`): minúsculas, dígitos, '.' y '-',
// empieza por letra (nunca parece un flag). el mismo patrón que AGENT_MODEL_ID_RE del server.
export const MODEL_RE = /^[a-z][a-z0-9.-]{1,63}$/;
// workspace/slug u owner/repo (REPO_KEY_RE del server).
export const REPO_KEY_RE = /^[^/\s]+\/[^/\s]+$/;
// session id de claude (uuid): va tras --resume, nunca debe parecer un flag.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// id de tool para --allowedTools/--disallowedTools (`Read`, `Bash(git log:*)`, `mcp__duckhunt__x`):
// empieza por letra (nunca '-') y sin comas ni saltos (se unen con ',' en un solo argumento).
const TOOL_ID_RE = /^[A-Za-z_][^,\n\r]{0,199}$/;
// nombre del servidor mcp: clave del mcp-config y prefijo mcp__<name>__ de las tools.
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClaimedRun {
  // opaco (run-id.ts): hoy el String() del entero positivo del cable legacy.
  id: string;
  // investigate | resume | prompt (un kind desconocido se trata como run de reglas).
  kind: string;
  entryId: number;
  workspaceId: number;
  repo: string | null;
  branch: string | null;
  repoSource: string;
  repoAvailable: boolean;
  aws: { accountId: string | null; region: string | null } | null;
  sessionId: string | null;
  parentRunId: number | null;
  profile: PromptProfile | null;
  // null = server anterior a t#465 P6 (o un valor desconocido).
  seed: RunSeed | null;
  // solo prompt runs; en runs de reglas siempre worktree (no se consulta).
  isolation: RunIsolation;
  // segmento del claim (null = server anterior a los segmentos).
  segment: number | null;
  // modelo que pide duckhunt (0.12.0; null = ninguno: el de la config o el default del cli).
  model: string | null;
}

export interface EventsConfig {
  enabled: boolean;
  nextSeq: number;
  flushMs: number;
  flushCount: number;
  batchMax: number;
  bodyMaxChars: number;
  toolArgMaxChars: number;
}

// marca de un claim que MANDA con la política neutra toolset_v1 (t#495, M5): separa un claim toolset_v1 de uno
// legacy donde el runner se comporta distinto (aislar la aws de la máquina, resources/aws.ts). la pone el cable v0
// (platforms/claim-v0.ts, M4); el toolset del cable legacy va en sombra (toolsetShadow) y allí las listas de tools
// siguen mandando.
export { TOOLSET_V1 };
export interface ToolsetV1 {
  v: typeof TOOLSET_V1;
}

export interface ClaimResponse {
  run: ClaimedRun;
  prompt: string;
  fallbackPrompt: string | null;
  // tier del perfil que compuso el server (investigate|act|world). informativo: quien acota de
  // verdad es tools.allowed, pero saberlo en el log explica por qué un run no pudo escribir.
  tier: string | null;
  tools: { allowed: string[]; disallowed: string[] };
  permissionMode: string;
  // null en prompt runs: sin --max-turns ni --max-budget-usd (el tope es el wall clock).
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  timeoutMs: number;
  heartbeatMs: number;
  // null = server sin feed (anterior a t#378): no se suben eventos.
  events: EventsConfig | null;
  mcp: McpServer;
  // avisos de la validación local (rama ignorada…): el daemon los loguea y los sube al feed.
  warnings: string[];
  // null = claim legacy (duckhunt-42); un claim v0 la lleva siempre.
  toolset: ToolsetV1 | null;
  // toolset_v1 en sombra (daemon con `toolset_v1`): el toolset y las listas del server tal cual llegaron, para
  // comparar con el render del daemon (toolset/shadow.ts). null = el claim no lo trajo (o no era válido).
  toolsetShadow: ShadowSource | null;
  // recursos del run que conceden los grants del toolset que manda (cable v0, platforms/claim-v0.ts). ausente = un
  // claim legacy: sus recursos salen de sus campos (resources/legacy.ts).
  resources?: ResourceRequest[];
  // servidores mcp de la plataforma además de `mcp` (cable v0: mcpServers[] a partir del segundo). ausente = ninguno.
  extraMcp?: McpServer[];
}

/** un servidor mcp de la plataforma con el token per-run (expiresAt en ms desde epoch). */
export interface McpServer {
  serverName: string;
  url: string;
  token: string;
  expiresAt: number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** id de run válido para paths y logs (del entero positivo legacy), o null. sirve para fallar un claim roto. */
export function claimRunId(raw: unknown): string | null {
  return isObj(raw) && isObj(raw.run) ? runIdFromLegacy(raw.run.id) : null;
}

/** cordura mínima de una rama para pasarla a git (git check-ref-format decide aparte). */
export function isValidBranchName(branch: string): boolean {
  return BRANCH_RE.test(branch);
}

// ¿una tool permitida es (o acota) una de las prohibidas en lectura? `Edit` y `Write(x)` lo son, y
// también Bash entero o un patrón que no sea de la aws cli (`Bash(git log:*)`).
const isForbiddenInRead = (tool: string): boolean =>
  READ_FORBIDDEN_TOOLS.some((f) => tool === f || tool.startsWith(`${f}(`)) ||
  tool === BASH_TOOL ||
  (tool.startsWith(`${BASH_TOOL}(`) && !tool.startsWith(`${BASH_TOOL}(aws `));

/** true si el patrón es una lectura de la aws cli fijada en servicio + operación (verbo o lectura suelta). */
export function isAwsReadPattern(tool: string): boolean {
  const m = AWS_READ_PATTERN_RE.exec(tool);
  return m !== null && (READ_AWS_VERBS.some((verb) => m[2].startsWith(verb)) || READ_AWS_COMMANDS.includes(`${m[1]} ${m[2]}`));
}

/** id de tool pasable por argv (--allowedTools/--disallowedTools lo unen con ','). */
export const isToolId = (tool: string): boolean => TOOL_ID_RE.test(tool);

function toolList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((t): t is string => typeof t === 'string' && TOOL_ID_RE.test(t))) {
    throw new Error(`claim inválido: ${field} con ids de tool no válidos`);
  }
  return v;
}

function eventsConfig(v: unknown): EventsConfig | null {
  if (!isObj(v)) return null;
  return {
    enabled: v.enabled === true,
    nextSeq: posInt(v.nextSeq) ?? EVENTS_DEFAULTS.nextSeq,
    flushMs: posNum(v.flushMs) ?? EVENTS_DEFAULTS.flushMs,
    flushCount: posInt(v.flushCount) ?? EVENTS_DEFAULTS.flushCount,
    batchMax: posInt(v.batchMax) ?? EVENTS_DEFAULTS.batchMax,
    bodyMaxChars: posInt(v.bodyMaxChars) ?? EVENTS_DEFAULTS.bodyMaxChars,
    toolArgMaxChars: posInt(v.toolArgMaxChars) ?? EVENTS_DEFAULTS.toolArgMaxChars,
  };
}

/** valida y normaliza la respuesta 200 del claim. lanza con el motivo si algo no es seguro. */
export function parseClaim(raw: unknown): ClaimResponse {
  if (!isObj(raw) || !isObj(raw.run)) throw new Error('claim inválido: falta run');
  const id = runIdFromLegacy(raw.run.id);
  if (id === null) throw new Error('claim inválido: run.id no es un entero positivo');
  return parseClaimBody(raw, id);
}

/**
 * el claim con la forma del legacy y el id de run ya validado por quien llama (el cable legacy, del entero; el v0,
 * su id opaco: platforms/claim-v0.ts lo arma desde el suyo y pasa por aquí para las mismas comprobaciones).
 */
export function parseClaimBody(raw: unknown, id: string): ClaimResponse {
  if (!isObj(raw) || !isObj(raw.run)) throw new Error('claim inválido: falta run');
  const r = raw.run;
  const kind = str(r.kind);
  if (!kind) throw new Error('claim inválido: run.kind ausente');
  const repo = str(r.repo);
  if (repo !== null && !REPO_KEY_RE.test(repo)) throw new Error(`claim inválido: repo "${repo}"`);
  const warnings: string[] = [];
  const rawBranch = str(r.branch);
  const branch = rawBranch !== null && isValidBranchName(rawBranch) ? rawBranch : null;
  if (rawBranch !== null && branch === null) {
    warnings.push(`rama ${JSON.stringify(rawBranch.slice(0, WARNING_VALUE_CHARS))} ignorada (nombre no utilizable): worktree sobre la rama por defecto`);
  }
  const sessionId = str(r.sessionId);
  if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) throw new Error('claim inválido: sessionId con formato inesperado');
  const profile = r.profile === PROMPT_PROFILE.read || r.profile === PROMPT_PROFILE.edit ? r.profile : null;
  if (kind === RUN_KIND.prompt && profile === null) throw new Error('claim inválido: prompt run sin perfil read|edit');
  const model = typeof r.model === 'string' && MODEL_RE.test(r.model) ? r.model : null;
  if (r.model !== undefined && r.model !== null && model === null) {
    // de un valor que no es texto solo su tipo: el aviso va al feed.
    const shown = typeof r.model === 'string' ? JSON.stringify(r.model.slice(0, WARNING_VALUE_CHARS)) : `(${typeof r.model})`;
    warnings.push(`modelo ${shown} ignorado (no es un alias ni un id de modelo): el run usa el modelo de esta máquina`);
  }

  const prompt = str(raw.prompt);
  if (!prompt || !prompt.trim()) throw new Error('claim inválido: prompt vacío');
  const permissionMode = str(raw.permissionMode) ?? '';
  if (!ALLOWED_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`claim inválido: permission mode "${permissionMode}" fuera del techo local (${ALLOWED_PERMISSION_MODES.join(', ')})`);
  }
  if (kind === RUN_KIND.prompt && permissionMode !== PROMPT_PERMISSION_MODE) {
    throw new Error(`claim inválido: un prompt run exige permission mode ${PROMPT_PERMISSION_MODE} (llegó "${permissionMode}")`);
  }
  const tools = isObj(raw.tools) ? raw.tools : {};
  const serverAllowed = toolList(tools.allowed, 'tools.allowed');
  const readPrompt = kind === RUN_KIND.prompt && profile === PROMPT_PROFILE.read;
  const leaked = readPrompt ? serverAllowed.filter(isForbiddenInRead) : [];
  if (leaked.length > 0) throw new Error(`claim inválido: un prompt run de lectura no puede permitir ${leaked.join(', ')}`);
  // una `Bash(aws …)` que no reconozco (lectura nueva de un server más moderno, o una escritura) se
  // descarta sin tumbar el run: sin ella el cli la niega (dontAsk).
  const unknownAws = readPrompt ? serverAllowed.filter((t) => t.startsWith(`${BASH_TOOL}(`) && !isAwsReadPattern(t)) : [];
  if (unknownAws.length > 0) warnings.push(`aws descartada en lectura (no es una lectura que este runner reconozca): ${unknownAws.join(', ')}`);
  const allowed = serverAllowed.filter((t) => !unknownAws.includes(t));
  const serverDisallowed = toolList(tools.disallowed, 'tools.disallowed');
  const disallowed = Array.from(new Set([...serverDisallowed, ...(readPrompt ? READ_FORCED_DENY : [])]));
  const mcp = isObj(raw.mcp) ? raw.mcp : {};
  const serverName = str(mcp.serverName) ?? '';
  const url = str(mcp.url) ?? '';
  const token = str(mcp.token) ?? '';
  if (!MCP_SERVER_NAME_RE.test(serverName) || !/^https?:\/\//i.test(url) || !token) {
    throw new Error('claim inválido: bloque mcp incompleto');
  }
  const aws = isObj(r.aws) ? { accountId: str(r.aws.accountId), region: str(r.aws.region) } : null;
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    run: {
      id,
      kind,
      entryId: posInt(r.entryId) ?? 0,
      workspaceId: posInt(r.workspaceId) ?? 0,
      repo,
      branch,
      repoSource: str(r.repoSource) ?? 'none',
      repoAvailable: r.repoAvailable === true,
      aws,
      sessionId,
      parentRunId: posInt(r.parentRunId),
      profile,
      seed: r.seed === RUN_SEED.template || r.seed === RUN_SEED.prompt ? r.seed : null,
      isolation: kind === RUN_KIND.prompt && r.isolation === RUN_ISOLATION.checkout ? RUN_ISOLATION.checkout : RUN_ISOLATION.worktree,
      segment: posInt(r.segment),
      model,
    },
    prompt,
    fallbackPrompt: str(raw.fallbackPrompt),
    tier: str(raw.tier),
    tools: { allowed, disallowed },
    permissionMode,
    maxTurns: numOrNull(raw.maxTurns),
    maxBudgetUsd: numOrNull(raw.maxBudgetUsd),
    timeoutMs: posNum(raw.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    heartbeatMs: posNum(raw.heartbeatMs) ?? DEFAULT_HEARTBEAT_MS,
    events: eventsConfig(raw.events),
    mcp: { serverName, url, token, expiresAt: numOrNull(mcp.expiresAt) ?? 0 },
    warnings,
    toolset: null,
    // las listas antes del filtro de aws y del deny forzado de arriba: las que mandó el server.
    toolsetShadow:
      raw.toolset === undefined || raw.toolset === null
        ? null
        : shadowSourceOf(raw.toolset, { allowed: serverAllowed, disallowed: serverDisallowed, permissionMode }, id),
  };
}

// el toolset_v1 de un claim para la sombra; uno mal formado no tumba el claim (las listas mandan): se ignora con un
// aviso en el log, sin sombra.
function shadowSourceOf(raw: unknown, server: ShadowSource['server'], runId: string): ShadowSource | null {
  try {
    return { toolset: parseToolsetV1(raw), server };
  } catch (err) {
    console.warn(`[runner] run ${runId}: ${(err as Error).message}: sin sombra de toolset_v1`);
    return null;
  }
}
