// toolset_v1 del claim (t#495, M5): validación estricta de lo que manda la plataforma. un campo desconocido, un tipo
// que no toca o un valor fuera de catálogo rechazan el toolset entero: lo que acabará en argv (ids de tools) o en
// recursos de la máquina (claves) no se interpreta a medias. en la fase en sombra un toolset rechazado no tumba el
// claim (claim.ts lo ignora con un aviso en el log): las listas del claim siguen mandando.

import { GRANT_ACCESS, TOOLSET_SHELL, TOOLSET_V1, type GrantAccess, type ToolsetGrant, type ToolsetShell, type ToolsetV1 } from '../vendor/runner-protocol/index.js';

// claves del toolset y de cada grant: ni una más.
const TOOLSET_KEYS: ReadonlySet<string> = new Set(['v', 'shell', 'fsWrite', 'memory', 'web', 'vcsPush', 'grants', 'platformTools']);
const GRANT_KEYS: ReadonlySet<string> = new Set(['type', 'key', 'access']);
const FLAG_KEYS = ['fsWrite', 'memory', 'web', 'vcsPush'] as const;
// tipo de recurso (repo, aws, browser…) y su clave tal como el daemon la anunció (ws/slug, id de cuenta, default…):
// sin espacios ni caracteres de control, acotada.
const GRANT_TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const GRANT_KEY_RE = /^[^\s\x00-\x1f\x7f]{1,200}$/;
// tool del mcp de la plataforma: acaba en argv como mcp__<server>__<tool>, sin comas ni saltos.
const PLATFORM_TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
// topes holgados: solo acotan lo que se acepta.
const GRANTS_MAX = 32;
const PLATFORM_TOOLS_MAX = 512;

const SHELLS: readonly unknown[] = Object.values(TOOLSET_SHELL);
const ACCESSES: readonly unknown[] = Object.values(GRANT_ACCESS);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (what: string): Error => new Error(`toolset_v1 inválido: ${what}`);

function onlyKeys(v: Obj, allowed: ReadonlySet<string>, where: string): void {
  const extra = Object.keys(v).filter((k) => !allowed.has(k));
  if (extra.length > 0) throw invalid(`${where} con campos desconocidos (${extra.join(', ')})`);
}

function grantOf(v: unknown, i: number): ToolsetGrant {
  const where = `grants[${i}]`;
  if (!isObj(v)) throw invalid(`${where} no es un objeto`);
  onlyKeys(v, GRANT_KEYS, where);
  if (typeof v.type !== 'string' || !GRANT_TYPE_RE.test(v.type)) throw invalid(`${where}.type no válido`);
  if (typeof v.key !== 'string' || !GRANT_KEY_RE.test(v.key)) throw invalid(`${where}.key no válida`);
  if (v.access !== undefined && !ACCESSES.includes(v.access)) throw invalid(`${where}.access: ${ACCESSES.join(' | ')}`);
  return { type: v.type, key: v.key, ...(v.access !== undefined ? { access: v.access as GrantAccess } : {}) };
}

/** valida el toolset_v1 de un claim (ver cabecera). lanza con el motivo. */
export function parseToolsetV1(raw: unknown): ToolsetV1 {
  if (!isObj(raw)) throw invalid('no es un objeto');
  onlyKeys(raw, TOOLSET_KEYS, 'el toolset');
  if (raw.v !== TOOLSET_V1) throw invalid(`versión ${JSON.stringify(raw.v)} (este runner habla la ${TOOLSET_V1})`);
  if (!SHELLS.includes(raw.shell)) throw invalid(`shell: ${SHELLS.join(' | ')}`);
  const missing = FLAG_KEYS.filter((k) => typeof raw[k] !== 'boolean');
  if (missing.length > 0) throw invalid(`${missing.join(', ')} no booleano`);
  if (!Array.isArray(raw.grants) || raw.grants.length > GRANTS_MAX) throw invalid(`grants: una lista de hasta ${GRANTS_MAX}`);
  const grants = raw.grants.map(grantOf);
  const ids = grants.map((g) => `${g.type}:${g.key}`);
  if (new Set(ids).size !== ids.length) throw invalid('grants repetidos');
  const tools = raw.platformTools;
  if (!Array.isArray(tools) || tools.length > PLATFORM_TOOLS_MAX || !tools.every((t) => typeof t === 'string' && PLATFORM_TOOL_RE.test(t))) {
    throw invalid(`platformTools: hasta ${PLATFORM_TOOLS_MAX} nombres de tool`);
  }
  return {
    v: TOOLSET_V1,
    shell: raw.shell as ToolsetShell,
    fsWrite: raw.fsWrite as boolean,
    memory: raw.memory as boolean,
    web: raw.web as boolean,
    vcsPush: raw.vcsPush as boolean,
    grants,
    platformTools: [...(tools as string[])],
  };
}
