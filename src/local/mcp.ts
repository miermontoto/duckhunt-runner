// servidor mcp de la plataforma local (t#495, M7): sus dos tools (ask_user, reply) para el claude de un `runner run`,
// en 127.0.0.1 con un puerto al azar. un subconjunto de json-rpc escrito a mano (initialize, ping, tools/list,
// tools/call; respuestas json, sin sse) para seguir sin dependencias: el cli lo carga como cualquier servidor http
// del mcp-config del run (run-mcp-config.ts).
// decisiones:
// - un token bearer por segmento: se da al reclamar y se revoca con su result; sin token vivo, 401.
// - la tool solo anota (quien aloja la plataforma, `handle`) y contesta un texto: el turno lo cierra el agente.
// - un argumento que no vale vuelve como resultado de tool con isError (la convención del mcp), no como error de
//   json-rpc: el agente lo lee y puede corregirse.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runnerVersion } from '../version.js';
import { LOCAL_TOOL } from './policy.js';
import { QUESTION_KIND, REPLY_KIND } from './store.js';

const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
export const JSONRPC_VERSION = '2.0';
// versión del protocolo mcp si el cliente no pide ninguna (la que dice el cliente se devuelve tal cual).
export const MCP_PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_NAME = 'duckhunt-runner-local';
const TOKEN_BYTES = 24;
const BODY_MAX_BYTES = 1 << 20;
const HTTP = { ok: 200, accepted: 202, unauthorized: 401, notFound: 404, notAllowed: 405, tooLarge: 413 } as const;
export const RPC_ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 } as const;
const BEARER_RE = /^Bearer\s+(\S+)$/i;
const JSON_TYPE = { 'Content-Type': 'application/json' } as const;
// marca del error de un cuerpo que pasa de BODY_MAX_BYTES.
const TOO_LARGE = 'too_large';

/** de quién es un token: la conversación y el segmento que lo recibieron al reclamar. */
export interface TokenSubject {
  conversation: string;
  segment: number;
}

/** atiende una tool: devuelve el texto para el agente o lanza con el motivo (argumentos que no valen). */
export type ToolHandler = (subject: TokenSubject, tool: string, args: Record<string, unknown>) => string;

const QUESTION_KINDS: readonly string[] = Object.values(QUESTION_KIND);
const REPLY_KINDS: readonly string[] = Object.values(REPLY_KIND);

/** las tools que lista el servidor (su esquema es lo que valida quien las atiende). */
export const LOCAL_TOOLS = [
  {
    name: LOCAL_TOOL.askUser,
    description:
      'pregunta al usuario y termina tu turno: la respuesta llega como el siguiente mensaje. kind yes_no (sí o no), text (texto libre) o form (varias preguntas en `questions`, cada una con sus `options` si son de elegir).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: QUESTION_KINDS },
        question: { type: 'string' },
        questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
      },
      required: ['kind', 'question'],
    },
  },
  {
    name: LOCAL_TOOL.reply,
    description: 'tu respuesta final al usuario: kind result (el trabajo hecho) o blocker (no puedes seguir y por qué). body es lo que el usuario lee.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: REPLY_KINDS }, body: { type: 'string' }, summary: { type: 'string' } },
      required: ['kind', 'body'],
    },
  },
] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const rpcResult = (id: unknown, result: unknown): Obj => ({ jsonrpc: JSONRPC_VERSION, id, result });
export const rpcError = (id: unknown, code: number, message: string): Obj => ({ jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message } });

export class LocalMcpServer {
  private server: http.Server | null = null;
  private readonly tokens = new Map<string, TokenSubject>();

  constructor(private readonly handle: ToolHandler) {}

  /** arranca en un puerto libre de loopback. */
  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, () => resolve());
    });
    // un cli que deja la conexión abierta no debe alargar la parada.
    server.unref();
    this.server = server;
  }

  /** origen del servidor (la base de la plataforma local: el mcp vive en su mismo origen, claim-v0.ts). */
  get origin(): string {
    const { port } = this.server!.address() as AddressInfo;
    return `http://${LOOPBACK_HOST}:${port}`;
  }

  get url(): string {
    return `${this.origin}${MCP_PATH}`;
  }

  /** un token para el segmento. */
  issue(subject: TokenSubject): string {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    this.tokens.set(token, subject);
    return token;
  }

  /** revoca los tokens del segmento. */
  revoke(subject: TokenSubject): void {
    [...this.tokens].filter(([, s]) => s.conversation === subject.conversation && s.segment === subject.segment).forEach(([token]) => this.tokens.delete(token));
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, body === undefined ? {} : JSON_TYPE);
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (new URL(req.url ?? '/', this.origin).pathname !== MCP_PATH) return send(HTTP.notFound, { error: 'no encontrado' });
    if (req.method !== 'POST') return send(HTTP.notAllowed, { error: 'solo POST (sin sse)' });
    const token = BEARER_RE.exec(req.headers.authorization ?? '')?.[1];
    const subject = token === undefined ? undefined : this.tokens.get(token);
    if (!subject) return send(HTTP.unauthorized, { error: 'token inválido o revocado' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if ((err as Error).message === TOO_LARGE) return send(HTTP.tooLarge, { error: 'cuerpo demasiado grande' });
      return send(HTTP.ok, rpcError(null, RPC_ERROR.parse, 'json ilegible'));
    }
    if (!isObj(body) || body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== 'string') return send(HTTP.ok, rpcError(isObj(body) ? body.id : null, RPC_ERROR.invalidRequest, 'petición json-rpc inválida'));
    // una notificación (sin id) no lleva respuesta.
    if (body.id === undefined) return send(HTTP.accepted);
    send(HTTP.ok, this.answer(subject, body.id, body.method, isObj(body.params) ? body.params : {}));
  }

  private answer(subject: TokenSubject, id: unknown, method: string, params: Obj): Obj {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: runnerVersion() ?? '0' },
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: LOCAL_TOOLS });
    if (method !== 'tools/call') return rpcError(id, RPC_ERROR.methodNotFound, `método desconocido: ${method}`);
    const name = params.name;
    if (typeof name !== 'string' || !LOCAL_TOOLS.some((t) => t.name === name)) return rpcError(id, RPC_ERROR.invalidParams, `tool desconocida: ${String(name)}`);
    try {
      const text = this.handle(subject, name, isObj(params.arguments) ? params.arguments : {});
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      return rpcResult(id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
    }
  }
}

// el cuerpo entero, acotado.
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX_BYTES) throw new Error(TOO_LARGE);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
