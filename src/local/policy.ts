// la política de un `runner run` (t#495, M7): el usuario ES la plataforma local, así que sus flags son la petición
// (toolset_v1) y su techo el de `platforms.local` (por defecto el entero: platforms/types.ts::LOCAL_PLATFORM_DEFAULTS).
// el daemon aplica el claim igual que el de cualquier plataforma v0 (platforms/claim-v0.ts); esto mira lo mismo ANTES
// de lanzar, para negarse con su exit code y decir qué falta en vez de recortar en silencio.
// decisiones:
// - perfil read por defecto: shell de lectura, sin escribir, memoria y web; edit da shell entera y escritura; --push el
//   push; --repo un grant del repo (full en edit, read si no); --grant tipo:clave[:acceso] añade grants.
// - las tools de la plataforma local son ask_user y reply (local/mcp.ts), siempre.
// - pedir más que el techo no se recorta: se rechaza diciendo qué campos (lo que intersect anotaría en narrowed).
// - escalada = lo que pasa de lectura: shell entera, escritura, push y grants de interact o full. en una tty se enseña
//   y se pregunta; sin tty, solo con --yes Y `unattendedEscalation` en la plataforma local.

import { PROMPT_PROFILE, type PromptProfile } from '../claim.js';
import { checkGrants, CLAIM_REJECT, ClaimRejectedError } from '../platforms/claim-v0.js';
import type { PlatformConfig } from '../platforms/types.js';
import { RESOURCE_TYPE } from '../resources/types.js';
import { intersectToolset } from '../toolset/intersect.js';
import { GRANT_ACCESS, TOOLSET_SHELL, TOOLSET_V1, type GrantAccess, type ToolsetGrant, type ToolsetV1 } from '../vendor/runner-protocol/index.js';

/** nombre del servidor mcp de la plataforma local: prefijo de sus tools (`mcp__local__ask_user`). */
export const LOCAL_MCP_SERVER = 'local';
export const LOCAL_TOOL = { askUser: 'ask_user', reply: 'reply' } as const;
export const LOCAL_PLATFORM_TOOLS: readonly string[] = Object.values(LOCAL_TOOL);

// separador de `--grant tipo:clave[:acceso]`.
const GRANT_SEPARATOR = ':';
const GRANT_PARTS_MIN = 2;
const GRANT_PARTS_MAX = 3;
const ACCESS_LEVELS: readonly string[] = Object.values(GRANT_ACCESS);

/** lo que pide un `runner run`: el prompt y sus flags de política. */
export interface LocalRequest {
  prompt: string;
  profile: PromptProfile;
  repo: string | null;
  branch: string | null;
  push: boolean;
  grants: ToolsetGrant[];
  model: string | null;
}

/** una petición que no se lanza: el techo, la exposición o el consentimiento la niegan (exit 77). */
export class RequestRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestRefusedError';
  }
}

/** `tipo:clave[:acceso]` como grant, o null si no tiene esa forma. */
export function parseGrant(raw: string): ToolsetGrant | null {
  const parts = raw.split(GRANT_SEPARATOR);
  if (parts.length < GRANT_PARTS_MIN || parts.length > GRANT_PARTS_MAX || parts.some((p) => !p)) return null;
  const [type, key, access] = parts as [string, string, string | undefined];
  if (access !== undefined && !ACCESS_LEVELS.includes(access)) return null;
  return { type, key, access: (access as GrantAccess | undefined) ?? GRANT_ACCESS.read };
}

/** el toolset_v1 de una petición (ver cabecera). */
export function toolsetOfRequest(req: LocalRequest): ToolsetV1 {
  const edit = req.profile === PROMPT_PROFILE.edit;
  const repo: ToolsetGrant[] = req.repo ? [{ type: RESOURCE_TYPE.repo, key: req.repo, access: edit ? GRANT_ACCESS.full : GRANT_ACCESS.read }] : [];
  return {
    v: TOOLSET_V1,
    shell: edit ? TOOLSET_SHELL.full : TOOLSET_SHELL.read,
    fsWrite: edit,
    memory: true,
    web: true,
    vcsPush: req.push,
    grants: [...repo, ...req.grants],
    platformTools: [...LOCAL_PLATFORM_TOOLS],
  };
}

/** lo que el toolset pide por encima de lectura, como líneas para enseñar (vacío = no hay escalada). */
export function escalationOf(t: ToolsetV1): string[] {
  return [
    ...(t.shell === TOOLSET_SHELL.full ? ['shell entera'] : []),
    ...(t.fsWrite ? ['escribir ficheros'] : []),
    ...(t.vcsPush ? ['push'] : []),
    ...t.grants.filter((g) => (g.access ?? GRANT_ACCESS.read) !== GRANT_ACCESS.read).map((g) => `${g.type} ${g.key}: ${g.access}`),
  ];
}

/**
 * la petición contra la plataforma local de AHORA: lanza RequestRefusedError si el techo la recortaría o un grant no
 * se puede cumplir (un tipo que el daemon no sirve, una clave no expuesta); si no, el toolset y su escalada.
 */
export function evaluateRequest(req: LocalRequest, platform: PlatformConfig, resourceTypes: readonly string[]): { toolset: ToolsetV1; escalation: string[] } {
  const toolset = toolsetOfRequest(req);
  try {
    checkGrants(toolset, { ceiling: platform.ceiling, expose: platform.expose, resourceTypes });
  } catch (err) {
    if (!(err instanceof ClaimRejectedError)) throw err;
    // una clave sin exponer: el comando que la expone.
    const hint = err.code === CLAIM_REJECT.notExposed ? toolset.grants.find((g) => err.message.includes(`${g.type} ${g.key}`)) : undefined;
    throw new RequestRefusedError(`${err.message}${hint ? ` (\`duckhunt-runner platforms expose local ${hint.type} ${hint.key}\`)` : ''}`);
  }
  const { narrowed } = intersectToolset(toolset, platform.ceiling);
  if (narrowed.length > 0) throw new RequestRefusedError(`el techo de la plataforma local no lo permite: ${narrowed.join(', ')}`);
  return { toolset, escalation: escalationOf(toolset) };
}
