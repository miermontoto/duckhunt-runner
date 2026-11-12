// la plataforma de mentira de una sonda (t#440 P6): lo que el run de la sonda contacta además del modelo. su mcp
// (`mcp.url` del claim) contesta el saludo de streamable http sin ninguna tool, y la ruta de permisos (`permissions.url`,
// t#527) aprueba todo lo que el cli pregunta: la sonda mide lo que un run PUEDE hacer si la persona dice que sí, nunca
// lo que la persona decidiría.
// decisiones:
// - vive en el mismo servidor que el proveedor (permissions.url tiene que ser del origen del mcp del claim).
// - lo que el cli manda aquí (el token per-run en la cabecera del mcp, las peticiones de permiso) queda grabado, pero el
//   veredicto nunca lo mira: el token llega a su propio mcp, que es lo esperado.

import { PERMISSION_DECISION, RUNNER_PERMISSIONS_PATH } from '../vendor/runner-protocol/index.js';
import type { ProviderReply } from './provider-dialect.js';

/** la ruta del mcp de la plataforma de la sonda. */
export const PLATFORM_MCP_PATH = '/mcp';
export { RUNNER_PERMISSIONS_PATH };

const JSONRPC = '2.0';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_PARSE_ERROR = -32700;
const HTTP = { ok: 200, accepted: 202, methodNotAllowed: 405 } as const;
// el id de toda petición de permiso aprobada (la tool de permisos solo lo compara entre su POST y sus GET).
const PERMISSION_ID = 1;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// una respuesta json-rpc del mcp.
const rpc = (id: unknown, payload: Obj): ProviderReply => ({ kind: 'json', status: HTTP.ok, body: { jsonrpc: JSONRPC, id, ...payload } });

// el mcp: initialize y tools/list (vacío); una notificación, 202; otro método, «no existe».
function mcpReply(method: string, body: string): ProviderReply {
  if (method !== 'POST') return { kind: 'empty', status: HTTP.methodNotAllowed };
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    // no es json-rpc: el cli recibe el error de parseo del protocolo.
    return rpc(null, { error: { code: JSONRPC_PARSE_ERROR, message: 'parse error' } });
  }
  if (!isObj(msg) || msg.id === undefined) return { kind: 'empty', status: HTTP.accepted };
  const params = isObj(msg.params) ? msg.params : {};
  if (msg.method === 'initialize') {
    const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
    return rpc(msg.id, { result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'conformance-platform', version: '0.0.0' } } });
  }
  if (msg.method === 'tools/list') return rpc(msg.id, { result: { tools: [] } });
  if (msg.method === 'ping') return rpc(msg.id, { result: {} });
  return rpc(msg.id, { error: { code: JSONRPC_METHOD_NOT_FOUND, message: `método ${String(msg.method)} desconocido` } });
}

/** contesta lo que es de la plataforma de la sonda (ver cabecera); null = la ruta no es suya. */
export function platformReply(method: string, path: string, body: string): ProviderReply | null {
  if (path === PLATFORM_MCP_PATH) return mcpReply(method, body);
  if (path === RUNNER_PERMISSIONS_PATH || path.startsWith(`${RUNNER_PERMISSIONS_PATH}/`)) {
    return { kind: 'json', status: HTTP.ok, body: { id: PERMISSION_ID, decision: PERMISSION_DECISION.allow, message: null } };
  }
  return null;
}

/** cuántas peticiones de permiso hizo el run (el POST de cada una). */
export const permissionRequests = (requests: readonly { method: string; path: string }[]): number =>
  requests.filter((r) => r.method === 'POST' && r.path === RUNNER_PERMISSIONS_PATH).length;
