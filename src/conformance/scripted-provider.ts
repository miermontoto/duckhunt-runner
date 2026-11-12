// el proveedor de modelo guionizado de una sonda (t#440 P6): un servidor http local que habla el dialecto de la api del
// cli (anthropic-dialect.ts para claude code) y, en el mismo origen, la plataforma de mentira (platform-stub.ts). el cli
// de la sonda trabaja contra él sin modelo de verdad y sin gastar tokens; todo lo que manda queda grabado para el
// veredicto.
// decisiones:
// - solo escucha en 127.0.0.1, en un puerto libre.
// - también hace de proxy de salida de la sonda (HTTP(S)_PROXY): un CONNECT, o una petición a otro host, se rechaza
//   (403) y se apunta. así nada de la sonda sale a la red y el informe dice qué intentó contactar el cli.
// - de lo grabado se quitan las cabeceras con credenciales (la api key de mentira, el token per-run en el mcp).
// - una ruta que no es de nadie es un 404 grabado como «sin guion»: el informe lo lista para adaptar el dialecto.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { platformReply } from './platform-stub.js';
import type { ModelScript } from './probe.js';
import type { ProviderDialect, ProviderReply, RecordedRequest } from './provider-dialect.js';

const LISTEN_HOST = '127.0.0.1';
const HTTP = { forbidden: 403, notFound: 404 } as const;
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie']);
const REDACTED = '[redacted]';
const FORBIDDEN_RESPONSE = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

/** un evento sse tal como viaja: `event:` + `data:` (json en una línea) y una línea en blanco. */
export const sseFrame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** el proveedor en marcha. */
export interface ScriptedProvider {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  // salidas a la red que se rechazaron (`CONNECT host:puerto` o `MÉTODO url`).
  readonly egress: readonly string[];
  close(): Promise<void>;
}

// las cabeceras de una petición sin las credenciales.
const recordedHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, CREDENTIAL_HEADERS.has(k) ? REDACTED : Array.isArray(v) ? v.join(', ') : (v ?? '')]));

function send(res: http.ServerResponse, reply: ProviderReply): void {
  if (reply.kind === 'sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(reply.events.map((e) => sseFrame(e.event, e.data)).join(''));
    return;
  }
  if (reply.kind === 'empty') {
    res.writeHead(reply.status).end();
    return;
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
}

/** arranca el proveedor de `dialect` con el guion de la sonda (ver cabecera). */
export async function startScriptedProvider(dialect: ProviderDialect, script: ModelScript): Promise<ScriptedProvider> {
  const requests: RecordedRequest[] = [];
  const egress: string[] = [];
  const server = http.createServer();
  server.on('connect', (req, socket) => {
    egress.push(`CONNECT ${req.url ?? ''}`);
    socket.end(FORBIDDEN_RESPONSE);
  });
  server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const own = `${LISTEN_HOST}:${(server.address() as AddressInfo).port}`;
      const target = new URL(req.url ?? '/', `http://${own}`);
      const method = req.method ?? 'GET';
      // una petición en forma absoluta a otro host: el cli la mandó por el proxy de salida.
      if (target.host !== own) {
        egress.push(`${method} ${target.origin}${target.pathname}`);
        res.writeHead(HTTP.forbidden).end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const reply = platformReply(method, target.pathname, body) ?? dialect.answer(method, target.pathname, body, script);
      requests.push({ method, path: target.pathname, headers: recordedHeaders(req.headers), body, handled: reply !== null });
      send(res, reply ?? { kind: 'json', status: HTTP.notFound, body: { type: 'error', error: { type: 'not_found_error', message: `${method} ${target.pathname} sin guion` } } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LISTEN_HOST, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${LISTEN_HOST}:${port}`,
    requests,
    egress,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
