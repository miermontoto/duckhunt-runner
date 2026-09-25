// forma del claim de POST /api/runner/claim (contrato 42 + prompts libres t#378) y su validación
// local. el daemon ejecuta lo que el server compone, pero lo que acaba en paths o en argv (id del
// run, sesión, rama, permission mode, ids de tools) se valida aquí: ni un server comprometido ni un
// bug suyo deben poder colar un flag en `claude`/`git` ni un `..` en un path.
// decisiones:
// - una rama inutilizable NO tumba el claim: se ignora con un aviso y el worktree cae en la base por
//   defecto (las ramas de prs de bitbucket/github llevan ñ, '+', '#'…; quien decide es
//   `git check-ref-format`, y todo argumento de git va tras `--end-of-options`).
// - el perfil read de un prompt run se hace cumplir AQUÍ también: permission mode dontAsk, nada de
//   Bash/Edit/Write/NotebookEdit en las permitidas y las cuatro forzadas en las denegadas. un bug o
//   una deriva del server nunca le da Bash a una lectura.
// - `run.segment` es la identidad del proceso: viaja de vuelta en heartbeat/progress/events/status.

// capacidades que el daemon anuncia en el claim. el server entrega kind=prompt solo a quien
// anuncia `prompt`, pide el feed de progreso solo a quien anuncia `events` y deja abrir una
// conversación en el checkout solo a quien anuncia `checkout` (>= 0.6.0).
export const RUNNER_CAPABILITY = {
  aws: 'aws',
  prompt: 'prompt',
  events: 'events',
  checkout: 'checkout',
} as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITY)[keyof typeof RUNNER_CAPABILITY];

// dónde trabaja un prompt run con repo (lo elige el usuario al abrir la conversación): el worktree
// conv-<id> aislado o el checkout tal cual (su rama y sus cambios). ausente o desconocido = worktree,
// lo más aislado. los runs de reglas no lo usan: su cwd lo decide `worktree` del repo en la config.
export const RUN_ISOLATION = {
  worktree: 'worktree',
  checkout: 'checkout',
} as const;
export type RunIsolation = (typeof RUN_ISOLATION)[keyof typeof RUN_ISOLATION];

export const RUN_KIND = {
  investigate: 'investigate',
  resume: 'resume',
  prompt: 'prompt',
} as const;

export const PROMPT_PROFILE = {
  read: 'read',
  edit: 'edit',
} as const;
export type PromptProfile = (typeof PROMPT_PROFILE)[keyof typeof PROMPT_PROFILE];

// techo local de permission modes: el server manda dontAsk; bypassPermissions nunca se acepta
// desde fuera (el opt-in a saltarse permisos es solo local, `repos add --dangerously-skip-permissions`).
export const ALLOWED_PERMISSION_MODES: readonly string[] = ['dontAsk', 'default', 'acceptEdits', 'plan'];

// si el server omite timeoutMs/heartbeatMs (espejo de AGENT_HARNESS_RUN_TIMEOUT_MS y
// RUN_HEARTBEAT_INTERVAL_MS del server).
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
// defaults del feed si el server no los manda (espejo de AGENT_RUN_EVENT_* del server).
export const EVENTS_DEFAULTS = {
  nextSeq: 1,
  flushMs: 1000,
  flushCount: 20,
  batchMax: 50,
  bodyMaxChars: 4000,
  toolArgMaxChars: 200,
} as const;

// cordura mínima de una rama ANTES de tocar git: sin '-' inicial (no puede parecer una opción), sin
// espacios ni caracteres de control, acotada. quien decide de verdad es `git check-ref-format --branch`.
export const BRANCH_RE = /^(?!-)[^\s\x00-\x1f\x7f]{1,250}$/;
// permission mode que exige un prompt run (el server lo manda siempre; sin él heredaría el del usuario).
export const PROMPT_PERMISSION_MODE = 'dontAsk';
// built-in que un prompt run de lectura nunca puede tener (ni con patrón: `Bash(git log:*)`).
export const READ_FORBIDDEN_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'NotebookEdit'];
// longitud con la que una rama descartada aparece en el aviso.
const WARNING_BRANCH_CHARS = 80;
// workspace/slug u owner/repo (REPO_KEY_RE del server).
export const REPO_KEY_RE = /^[^/\s]+\/[^/\s]+$/;
// session id de claude (uuid): va tras --resume, nunca debe parecer un flag.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// id de tool para --allowedTools/--disallowedTools (`Read`, `Bash(git log:*)`, `mcp__duckhunt__x`):
// empieza por letra (nunca '-') y sin comas ni saltos (se unen con ',' en un solo argumento).
const TOOL_ID_RE = /^[A-Za-z_][^,\n\r]{0,199}$/;
// nombre del servidor mcp: clave del mcp-config y prefijo mcp__<name>__ de las tools.
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClaimedRun {
  id: number;
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
  // solo prompt runs; en runs de reglas siempre worktree (no se consulta).
  isolation: RunIsolation;
  // segmento del claim (null = server anterior a los segmentos).
  segment: number | null;
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
  mcp: { serverName: string; url: string; token: string; expiresAt: number };
  // avisos de la validación local (rama ignorada…): el daemon los loguea y los sube al feed.
  warnings: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** id de run válido para paths y logs (entero positivo), o null. sirve para fallar un claim roto. */
export function claimRunId(raw: unknown): number | null {
  return isObj(raw) && isObj(raw.run) ? posInt(raw.run.id) : null;
}

/** cordura mínima de una rama para pasarla a git (git check-ref-format decide aparte). */
export function isValidBranchName(branch: string): boolean {
  return BRANCH_RE.test(branch);
}

// ¿una tool permitida es (o acota) una de las prohibidas en lectura? `Bash` y `Bash(git:*)` lo son.
const isForbiddenInRead = (tool: string): boolean => READ_FORBIDDEN_TOOLS.some((f) => tool === f || tool.startsWith(`${f}(`));

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
  const r = raw.run;
  const id = posInt(r.id);
  if (id === null) throw new Error('claim inválido: run.id no es un entero positivo');
  const kind = str(r.kind);
  if (!kind) throw new Error('claim inválido: run.kind ausente');
  const repo = str(r.repo);
  if (repo !== null && !REPO_KEY_RE.test(repo)) throw new Error(`claim inválido: repo "${repo}"`);
  const warnings: string[] = [];
  const rawBranch = str(r.branch);
  const branch = rawBranch !== null && isValidBranchName(rawBranch) ? rawBranch : null;
  if (rawBranch !== null && branch === null) {
    warnings.push(`rama ${JSON.stringify(rawBranch.slice(0, WARNING_BRANCH_CHARS))} ignorada (nombre no utilizable): worktree sobre la rama por defecto`);
  }
  const sessionId = str(r.sessionId);
  if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) throw new Error('claim inválido: sessionId con formato inesperado');
  const profile = r.profile === PROMPT_PROFILE.read || r.profile === PROMPT_PROFILE.edit ? r.profile : null;
  if (kind === RUN_KIND.prompt && profile === null) throw new Error('claim inválido: prompt run sin perfil read|edit');

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
  const allowed = toolList(tools.allowed, 'tools.allowed');
  const readPrompt = kind === RUN_KIND.prompt && profile === PROMPT_PROFILE.read;
  const leaked = readPrompt ? allowed.filter(isForbiddenInRead) : [];
  if (leaked.length > 0) throw new Error(`claim inválido: un prompt run de lectura no puede permitir ${leaked.join(', ')}`);
  const disallowed = Array.from(new Set([...toolList(tools.disallowed, 'tools.disallowed'), ...(readPrompt ? READ_FORBIDDEN_TOOLS : [])]));
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
      isolation: kind === RUN_KIND.prompt && r.isolation === RUN_ISOLATION.checkout ? RUN_ISOLATION.checkout : RUN_ISOLATION.worktree,
      segment: posInt(r.segment),
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
  };
}
