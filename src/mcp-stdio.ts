// servidor mcp por stdio de las tools que pone el propio runner en un run (t#495, 0.13.0; hoy la lectura de objetos
// s3, resources/s3-read.ts): el mismo subconjunto de json-rpc que el de la plataforma local (local/mcp.ts:
// initialize, ping, tools/list, tools/call) sobre el transporte stdio del mcp, un mensaje json por línea. sin
// dependencias. el cli lo lanza como cualquier servidor stdio del mcp-config del run y lo cierra con el run.
// - una tool que falla (argumentos que no valen, un objeto que no se puede leer) vuelve como resultado con isError (la
//   convención del mcp): el agente lo lee y puede corregirse. un fallo de json-rpc, solo para lo que no es una
//   llamada válida.
// - los mensajes se atienden en orden, uno tras otro: el cli no manda en paralelo y así una lectura grande no se
//   cruza con otra.

import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { JSONRPC_VERSION, MCP_PROTOCOL_FALLBACK, RPC_ERROR, rpcError, rpcResult } from './local/mcp.js';
import { runnerVersion } from './version.js';

/** una tool que lista el servidor (su esquema es lo que valida quien la atiende). */
export interface StdioTool {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

/** atiende una tool: el texto para el agente, o lanza con el motivo. */
export type StdioCall = (tool: string, args: Record<string, unknown>) => Promise<string>;

export interface StdioMcpOptions {
  name: string;
  tools: readonly StdioTool[];
  call: StdioCall;
  input?: Readable;
  output?: Writable;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// la respuesta a un mensaje (null = una notificación, que no lleva).
async function answer(o: StdioMcpOptions, line: string): Promise<Obj | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return rpcError(null, RPC_ERROR.parse, 'json ilegible');
  }
  if (!isObj(msg) || msg.jsonrpc !== JSONRPC_VERSION || typeof msg.method !== 'string') return rpcError(isObj(msg) ? msg.id : null, RPC_ERROR.invalidRequest, 'petición json-rpc inválida');
  if (msg.id === undefined) return null;
  const params = isObj(msg.params) ? msg.params : {};
  if (msg.method === 'initialize') {
    return rpcResult(msg.id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: o.name, version: runnerVersion() ?? '0' },
    });
  }
  if (msg.method === 'ping') return rpcResult(msg.id, {});
  if (msg.method === 'tools/list') return rpcResult(msg.id, { tools: o.tools });
  if (msg.method !== 'tools/call') return rpcError(msg.id, RPC_ERROR.methodNotFound, `método desconocido: ${msg.method}`);
  const name = params.name;
  if (typeof name !== 'string' || !o.tools.some((t) => t.name === name)) return rpcError(msg.id, RPC_ERROR.invalidParams, `tool desconocida: ${String(name)}`);
  try {
    const text = await o.call(name, isObj(params.arguments) ? params.arguments : {});
    return rpcResult(msg.id, { content: [{ type: 'text', text }] });
  } catch (err) {
    return rpcResult(msg.id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
  }
}

/** atiende el mcp por stdio hasta que se cierra la entrada (el run terminó). */
export async function serveStdioMcp(o: StdioMcpOptions): Promise<void> {
  const output = o.output ?? process.stdout;
  const lines = readline.createInterface({ input: o.input ?? process.stdin, crlfDelay: Infinity });
  // i/o secuencial: un mensaje tras otro (ver cabecera).
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const reply = await answer(o, line);
    if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
  }
}
