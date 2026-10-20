// el claim del cable v0 (t#495, M4; vendor/runner-protocol, v0.ts) a lo que ejecuta el daemon, APLICANDO la
// política: en v0 no hay legacy que guardar y la plataforma puede ser de un tercero, así que nunca se lanza con
// listas de tools que traiga el claim. lo que corre sale de aquí:
// - tools = render(toolset ∩ el techo que el usuario le puso a la plataforma) (toolset/render.ts), con las tools de
//   la plataforma sobre cada uno de sus servidores mcp. un run de perfil read nunca escribe ni tiene shell entera:
//   su toolset se corta a eso aunque el techo dejara más. lo que se corta va a `narrowed` (para el log).
// - recursos = los grants del toolset, con los parámetros de su entrada en resources[] (rama, región…). antes de
//   nada se rechaza el claim entero (nunca se corre a medias) si un grant es de un tipo que este daemon no sirve, si
//   su clave no está expuesta a esta plataforma o si el techo no da acceso a su tipo, y si una entrada de
//   resources[] no tiene grant. el acceso efectivo es el mínimo del grant y del techo.
// - un campo del núcleo de `policy` que no conozco rechaza el claim (fail closed); lo desconocido de `ext` se ignora.
// - (M6.4) cada servidor mcp del claim, en el MISMO origen que la plataforma (y esta en https, o en loopback para
//   desarrollo): una plataforma no puede hacer que el agente hable con otro host ni con un servicio de localhost
//   del usuario (platforms/origin.ts).
// - las listas pre-renderizadas de `backend.claude_code`, si vienen, SOLO alimentan la comparación en sombra.
// - el resultado pasa por la misma validación que un claim legacy (claim.ts::parseClaimBody): ids de tool para argv,
//   perfil de lectura sin escritura, permission mode, sesión, modelo, rama, bloque mcp.
// un claim rechazado se cierra como failed con su código (CLAIM_REJECT) y el motivo, sin paths.

import { parseClaimBody, PROMPT_PROFILE, RUN_ISOLATION, RUN_KIND, RUN_SEED, type ClaimResponse, type McpServer, type PromptProfile } from '../claim.js';
import { AWS_PARAM, AWS_TYPE } from '../resources/aws.js';
import { REPO_PARAM, REPO_TYPE, REPO_WORKTREE } from '../resources/repo/provider.js';
import type { ResourceRequest } from '../resources/types.js';
import { intersectToolset } from '../toolset/intersect.js';
import { parseToolsetV1 } from '../toolset/parse.js';
import { renderClaudeTools } from '../toolset/render.js';
import { DUCKHUNT_EXT_NS, GRANT_ACCESS, RUN_ID_V0_RE, TOOLSET_SHELL, TOOLSET_V1, V0_BACKEND, type ToolsetGrant, type ToolsetV1 } from '../vendor/runner-protocol/index.js';
import { sameSecureOrigin } from './origin.js';
import { isExposed, type Exposure, type ToolsetCeiling } from './types.js';

/** por qué se rechaza un claim de v0 (el código viaja en el error del result). */
export const CLAIM_REJECT = {
  invalid: 'claim_invalid',
  unknownPolicy: 'policy_unknown_field',
  unknownType: 'resource_type_unknown',
  notExposed: 'resource_not_exposed',
  notAllowed: 'resource_not_allowed',
  withoutGrant: 'resource_without_grant',
  mcpOrigin: 'mcp_server_not_allowed',
} as const;
export type ClaimRejectCode = (typeof CLAIM_REJECT)[keyof typeof CLAIM_REJECT];

export class ClaimRejectedError extends Error {
  constructor(
    readonly code: ClaimRejectCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ClaimRejectedError';
  }
}

/** lo que el daemon aplica a un claim de esta plataforma (de la config de AHORA y de la máquina). */
export interface V0Enforcement {
  ceiling: ToolsetCeiling;
  expose: Readonly<Record<string, Exposure>>;
  // tipos de recurso que sirve este daemon (resources/registry.ts).
  resourceTypes: readonly string[];
  awsCli: boolean;
  // base de la plataforma (su credencial): el único origen en el que pueden vivir sus servidores mcp.
  platformBaseUrl: string;
}

/** el claim listo para ejecutar y lo que el techo (o el perfil) le recortó al toolset. */
export interface AdaptedClaim {
  claim: ClaimResponse;
  narrowed: string[];
}

// núcleo de `policy` y de sus límites: ni un campo más.
const POLICY_KEYS: ReadonlySet<string> = new Set(['toolset', 'limits']);
const LIMITS_KEYS: ReadonlySet<string> = new Set(['timeoutMs', 'budgetUsd']);
// nombre de un servidor mcp de la plataforma: clave del mcp-config y prefijo de sus tools. `res_` es de los
// servidores que pondrán los recursos (el navegador, M7): ninguna plataforma lo usa.
const PLATFORM_MCP_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const RESERVED_MCP_PREFIX = 'res_';
const MCP_PREFIX = 'mcp__';
const MCP_SEPARATOR = '__';
// tipos con un solo recurso por run (el cwd y el env de la aws no se mezclan).
const SINGLE_TYPES: ReadonlySet<string> = new Set([REPO_TYPE, AWS_TYPE]);
// lo que el corte por perfil read anota en narrowed.
const READ_PROFILE_NARROWED = 'profile:read';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const reject = (code: ClaimRejectCode, message: string): never => {
  throw new ClaimRejectedError(code, message);
};
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const grantId = (g: { type: string; key: string }): string => `${g.type}:${g.key}`;

/** el id de un run de v0 si es usable (para cerrar como failed un claim que no se acepta), o null. */
export function v0RunIdOf(raw: unknown): string | null {
  return isObj(raw) && typeof raw.id === 'string' && RUN_ID_V0_RE.test(raw.id) ? raw.id : null;
}

function onlyKeys(v: Obj, allowed: ReadonlySet<string>, where: string): void {
  const extra = Object.keys(v).filter((k) => !allowed.has(k));
  if (extra.length > 0) reject(CLAIM_REJECT.unknownPolicy, `${where} con campos que este runner no conoce (${extra.join(', ')})`);
}

// los servidores mcp de la plataforma: al menos uno, nombres válidos, sin el prefijo reservado ni repetidos, y en el
// origen de la plataforma.
function mcpServersOf(raw: unknown, platformBaseUrl: string): McpServer[] {
  if (!Array.isArray(raw) || raw.length === 0) return reject(CLAIM_REJECT.invalid, 'mcpServers vacío');
  const servers = raw.map((s, i): McpServer => {
    if (!isObj(s)) return reject(CLAIM_REJECT.invalid, `mcpServers[${i}] no es un objeto`);
    const { name, url, token, expiresAt } = s;
    if (typeof name !== 'string' || !PLATFORM_MCP_NAME_RE.test(name) || name.startsWith(RESERVED_MCP_PREFIX)) {
      return reject(CLAIM_REJECT.invalid, `mcpServers[${i}].name no válido`);
    }
    if (typeof url !== 'string' || typeof token !== 'string' || !token) {
      return reject(CLAIM_REJECT.invalid, `mcpServers[${i}] sin url o token`);
    }
    if (!sameSecureOrigin(url, platformBaseUrl)) return reject(CLAIM_REJECT.mcpOrigin, `mcpServers[${i}] fuera del origen de la plataforma`);
    return { serverName: name, url, token, expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : 0 };
  });
  if (new Set(servers.map((s) => s.serverName)).size !== servers.length) reject(CLAIM_REJECT.invalid, 'mcpServers con nombres repetidos');
  return servers;
}

// cada grant contra la máquina: un tipo que se sirve, con acceso en el techo y una clave expuesta a esta plataforma.
function checkGrants(t: ToolsetV1, e: V0Enforcement): void {
  t.grants.forEach((g) => {
    if (!e.resourceTypes.includes(g.type)) reject(CLAIM_REJECT.unknownType, `grant de ${g.type}: este runner no sirve ese tipo`);
    if (!Object.hasOwn(e.ceiling.access, g.type)) reject(CLAIM_REJECT.notAllowed, `grant de ${g.type}: el techo de la plataforma no le da acceso`);
    if (!isExposed(e.expose, g.type, g.key)) reject(CLAIM_REJECT.notExposed, `grant de ${g.type} ${g.key}: no está expuesto a esta plataforma`);
  });
  const repeated = [...SINGLE_TYPES].filter((type) => t.grants.filter((g) => g.type === type).length > 1);
  if (repeated.length > 0) reject(CLAIM_REJECT.invalid, `más de un grant de ${repeated.join(', ')}`);
}

// resources[]: cada entrada con su grant; sus parámetros (texto o null) por grant.
function resourceParams(raw: unknown, t: ToolsetV1): Map<string, Readonly<Record<string, string | null>>> {
  if (raw === undefined) return new Map();
  if (!Array.isArray(raw)) return reject(CLAIM_REJECT.invalid, 'resources no es una lista');
  const granted = new Set(t.grants.map(grantId));
  return new Map(
    raw.map((r, i): [string, Record<string, string | null>] => {
      if (!isObj(r) || typeof r.type !== 'string' || typeof r.key !== 'string') return reject(CLAIM_REJECT.invalid, `resources[${i}] sin tipo o clave`);
      const id = grantId({ type: r.type, key: r.key });
      if (!granted.has(id)) return reject(CLAIM_REJECT.withoutGrant, `resources[${i}] (${r.type}) sin grant en el toolset`);
      const params = r.params === undefined ? {} : r.params;
      if (!isObj(params) || !Object.values(params).every((v) => v === null || typeof v === 'string')) {
        return reject(CLAIM_REJECT.invalid, `resources[${i}].params no válidos`);
      }
      return [id, params as Record<string, string | null>];
    }),
  );
}

// un run de lectura no escribe ni tiene shell entera, deje lo que deje el techo.
function forProfile(t: ToolsetV1, profile: PromptProfile): { toolset: ToolsetV1; narrowed: string[] } {
  if (profile !== PROMPT_PROFILE.read || (t.shell !== TOOLSET_SHELL.full && !t.fsWrite)) return { toolset: t, narrowed: [] };
  return { toolset: { ...t, shell: t.shell === TOOLSET_SHELL.full ? TOOLSET_SHELL.read : t.shell, fsWrite: false }, narrowed: [READ_PROFILE_NARROWED] };
}

// la petición de recurso de un grant efectivo, con los parámetros que el lifecycle de su tipo espera.
function requestOf(g: ToolsetGrant, params: Readonly<Record<string, string | null>>, claim: ClaimResponse): ResourceRequest {
  const access = g.access ?? GRANT_ACCESS.read;
  if (g.type === REPO_TYPE) {
    const worktree = claim.run.isolation === RUN_ISOLATION.checkout ? REPO_WORKTREE.checkout : REPO_WORKTREE.conversation;
    return { type: g.type, key: g.key, access, params: { [REPO_PARAM.branch]: claim.run.branch, [REPO_PARAM.worktree]: worktree } };
  }
  if (g.type === AWS_TYPE) return { type: g.type, key: g.key, access, params: { [AWS_PARAM.region]: params[AWS_PARAM.region] ?? null } };
  return { type: g.type, key: g.key, access, params };
}

// las listas que la plataforma pre-renderizó para claude code (solo para la sombra), o null.
function backendLists(raw: unknown): { allowed: string[]; disallowed: string[]; permissionMode: string } | null {
  const lists = isObj(raw) ? raw[V0_BACKEND.claudeCode] : undefined;
  if (!isObj(lists)) return null;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const { allowed, disallowed, permissionMode } = lists;
  return strings(allowed) && strings(disallowed) && typeof permissionMode === 'string' ? { allowed, disallowed, permissionMode } : null;
}

/** el claim de v0 listo para ejecutar con la política aplicada (ver cabecera). lanza ClaimRejectedError. */
export function claimOfV0(raw: unknown, e: V0Enforcement): AdaptedClaim {
  if (!isObj(raw)) return reject(CLAIM_REJECT.invalid, 'run no es un objeto');
  const id = v0RunIdOf(raw) ?? reject(CLAIM_REJECT.invalid, 'id de run no válido');
  const segment = posInt(raw.segment) ?? reject(CLAIM_REJECT.invalid, 'segment no es un entero positivo');
  const profile = raw.profile === PROMPT_PROFILE.read || raw.profile === PROMPT_PROFILE.edit ? raw.profile : reject(CLAIM_REJECT.invalid, 'profile: read | edit');
  if (!isObj(raw.policy)) return reject(CLAIM_REJECT.invalid, 'sin policy');
  onlyKeys(raw.policy, POLICY_KEYS, 'policy');
  const limits = isObj(raw.policy.limits) ? raw.policy.limits : reject(CLAIM_REJECT.invalid, 'sin policy.limits');
  onlyKeys(limits, LIMITS_KEYS, 'policy.limits');
  let requested: ToolsetV1;
  try {
    requested = parseToolsetV1(raw.policy.toolset);
  } catch (err) {
    return reject(CLAIM_REJECT.invalid, (err as Error).message);
  }
  checkGrants(requested, e);
  const params = resourceParams(raw.resources, requested);
  const ceiled = intersectToolset(requested, e.ceiling);
  const { toolset, narrowed: byProfile } = forProfile(ceiled.toolset, profile);
  const servers = mcpServersOf(raw.mcpServers, e.platformBaseUrl);
  const [platform, ...extra] = servers;
  const rendered = renderClaudeTools(toolset, { mcpServerName: platform!.serverName, awsCli: e.awsCli });
  // las tools de la plataforma también sobre sus demás servidores mcp.
  const extraTools = extra.flatMap((s) => toolset.platformTools.map((tool) => `${MCP_PREFIX}${s.serverName}${MCP_SEPARATOR}${tool}`));
  const own = isObj(raw.ext) && isObj(raw.ext[DUCKHUNT_EXT_NS]) ? raw.ext[DUCKHUNT_EXT_NS] : {};
  const repo = toolset.grants.find((g) => g.type === REPO_TYPE) ?? null;
  const aws = toolset.grants.find((g) => g.type === AWS_TYPE) ?? null;
  const session = isObj(raw.session) && raw.session.backend === V0_BACKEND.claudeCode ? raw.session.handle : null;
  const lease = isObj(raw.lease) ? raw.lease : {};
  // la forma del legacy, para pasar por su misma validación (claim.ts::parseClaimBody).
  const legacyShaped = {
    run: {
      kind: RUN_KIND.prompt,
      seed: own.seed === RUN_SEED.template ? RUN_SEED.template : RUN_SEED.prompt,
      entryId: own.entryId,
      workspaceId: own.workspaceId,
      repo: repo?.key ?? null,
      branch: repo ? (params.get(grantId(repo))?.[REPO_PARAM.branch] ?? null) : null,
      repoSource: typeof own.repoSource === 'string' ? own.repoSource : undefined,
      repoAvailable: repo !== null,
      aws: aws ? { accountId: aws.key, region: params.get(grantId(aws))?.[AWS_PARAM.region] ?? null } : null,
      sessionId: session,
      parentRunId: null,
      profile,
      isolation: raw.isolation === RUN_ISOLATION.checkout ? RUN_ISOLATION.checkout : RUN_ISOLATION.worktree,
      segment,
      model: raw.model,
    },
    prompt: raw.prompt,
    fallbackPrompt: typeof raw.fallbackPrompt === 'string' ? raw.fallbackPrompt : null,
    tier: typeof own.tier === 'string' ? own.tier : null,
    tools: { allowed: [...rendered.allowed, ...extraTools], disallowed: rendered.disallowed },
    permissionMode: rendered.permissionMode,
    maxTurns: null,
    maxBudgetUsd: typeof limits.budgetUsd === 'number' ? limits.budgetUsd : null,
    timeoutMs: limits.timeoutMs,
    heartbeatMs: lease.heartbeatMs,
    events: raw.events,
    mcp: { serverName: platform!.serverName, url: platform!.url, token: platform!.token, expiresAt: platform!.expiresAt },
  };
  let claim: ClaimResponse;
  try {
    claim = parseClaimBody(legacyShaped, id);
  } catch (err) {
    return reject(CLAIM_REJECT.invalid, (err as Error).message);
  }
  const server = backendLists(raw.backend);
  return {
    claim: {
      ...claim,
      // manda con toolset_v1: la aws de la máquina se aísla si no hay grant (resources/aws.ts::isolate).
      toolset: { v: TOOLSET_V1 },
      toolsetShadow: server ? { toolset: requested, server } : null,
      resources: toolset.grants.map((g) => requestOf(g, params.get(grantId(g)) ?? {}, claim)),
      extraMcp: extra,
      policyAudit: { requested, effective: toolset, narrowed: [...ceiled.narrowed, ...byProfile] },
    },
    narrowed: [...ceiled.narrowed, ...byProfile],
  };
}
