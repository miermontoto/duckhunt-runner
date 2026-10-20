// local.sock (t#495, M7): con el daemon en marcha, `runner run` es un cliente fino de la plataforma local que vive en
// él, así comparte sus slots, sus cuotas y su lock de git. ndjson en un socket unix: el cliente manda `submit`,
// `answer`, `cancel` o `subscribe` y el daemon contesta `accepted` (o `refused`) y le pasa lo que oye de esa
// conversación (local/platform.ts::LocalMessage) hasta su result.
// decisiones:
// - <runnerHome>/sockets/local.sock, 0600 dentro de un directorio 0700: solo el usuario dueño habla con él. quien
//   llega aquí es ese usuario: el techo y la exposición se aplican igual (al aceptar y en el claim), el
//   consentimiento de una escalada es cosa del cli.
// - el daemon tiene su lock al escuchar: un socket que ya estaba es de un daemon muerto y se borra.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runnerHome } from '../config.js';
import type { LocalMessage, LocalPlatform } from '../platforms/local.js';
import type { ToolsetV1 } from '../vendor/runner-protocol/index.js';
import { RequestRefusedError, type LocalRequest } from './policy.js';

const SOCKETS_SUBDIR = 'sockets';
const SOCKET_FILE = 'local.sock';
const DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;
const NEWLINE = '\n';
// tope de una línea del cliente (un prompt largo cabe de sobra).
const LINE_MAX_BYTES = 1 << 20;

export const SOCKET_OP = { evaluate: 'evaluate', submit: 'submit', answer: 'answer', cancel: 'cancel', subscribe: 'subscribe' } as const;

/** lo que manda el cliente. */
export type ClientMessage =
  | { op: typeof SOCKET_OP.evaluate; request: LocalRequest }
  | { op: typeof SOCKET_OP.submit; request: LocalRequest }
  | { op: typeof SOCKET_OP.answer; conversation: string; text: string }
  | { op: typeof SOCKET_OP.cancel; conversation: string }
  | { op: typeof SOCKET_OP.subscribe; conversation: string };

/** lo que contesta el daemon, además de lo que oye de la conversación. */
export type ServerMessage =
  | LocalMessage
  | { type: 'evaluated'; evaluation: LocalEvaluation }
  | { type: 'accepted'; conversation: string; segment: number; toolset?: ToolsetV1 }
  | { type: 'refused'; message: string }
  | { type: 'error'; message: string };

/** lo que diría el daemon de una petición sin lanzarla: su toolset y si la local acepta escaladas sin tty. */
export interface LocalEvaluation {
  toolset: ToolsetV1;
  unattendedEscalation: boolean;
}

/** lo que el daemon pone para servir el socket: la plataforma y cómo aceptar una petición con la config de AHORA. */
export interface LocalHost {
  platform: LocalPlatform;
  // la petición contra el techo y la exposición de la local; lanza RequestRefusedError.
  evaluate(request: LocalRequest): LocalEvaluation;
}

/** ruta del socket (sin crearlo). */
export function localSocketPath(): string {
  return path.join(runnerHome(), SOCKETS_SUBDIR, SOCKET_FILE);
}

// las líneas ndjson de un stream, acotadas.
function onLines(stream: net.Socket, handle: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > LINE_MAX_BYTES) {
      stream.destroy();
      return;
    }
    const lines = buffer.split(NEWLINE);
    buffer = lines.pop() ?? '';
    lines.filter((l) => l.trim()).forEach(handle);
  });
}

const write = (socket: net.Socket, m: ServerMessage): void => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(m)}${NEWLINE}`);
};

// sigue la conversación hasta su result (o hasta que el cliente se vaya).
function follow(socket: net.Socket, platform: LocalPlatform, conversation: string): void {
  const stop = platform.subscribe(conversation, (m) => {
    write(socket, m);
    if (m.type === 'result') stop();
  });
  socket.once('close', stop);
}

function handle(socket: net.Socket, host: LocalHost, raw: string): void {
  let m: ClientMessage;
  try {
    m = JSON.parse(raw) as ClientMessage;
  } catch {
    return write(socket, { type: 'error', message: 'línea ilegible' });
  }
  try {
    if (m.op === SOCKET_OP.evaluate) return write(socket, { type: 'evaluated', evaluation: host.evaluate(m.request) });
    if (m.op === SOCKET_OP.submit) {
      const { toolset } = host.evaluate(m.request);
      const conversation = host.platform.submit(m.request, toolset);
      follow(socket, host.platform, conversation);
      return write(socket, { type: 'accepted', conversation, segment: 1, toolset });
    }
    if (m.op === SOCKET_OP.answer) {
      follow(socket, host.platform, m.conversation);
      const segment = host.platform.answer(m.conversation, m.text);
      return write(socket, { type: 'accepted', conversation: m.conversation, segment });
    }
    if (m.op === SOCKET_OP.cancel) return host.platform.cancel(m.conversation);
    if (m.op === SOCKET_OP.subscribe) return follow(socket, host.platform, m.conversation);
    write(socket, { type: 'error', message: `op desconocida: ${String((m as { op?: unknown }).op)}` });
  } catch (err) {
    write(socket, err instanceof RequestRefusedError ? { type: 'refused', message: err.message } : { type: 'error', message: (err as Error).message });
  }
}

/** escucha en local.sock (ver cabecera). devuelve con qué cerrarlo. */
export async function serveLocal(host: LocalHost, file: string = localSocketPath()): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  fs.chmodSync(path.dirname(file), DIR_MODE);
  fs.rmSync(file, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    onLines(socket, (line) => handle(socket, host, line));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => resolve());
  });
  fs.chmodSync(file, SOCKET_MODE);
  server.unref();
  return async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(file, { force: true });
  };
}

/** una conexión a local.sock desde el cli. */
export interface LocalConnection {
  send(m: ClientMessage): void;
  // cada mensaje del daemon, en orden; `closed` cuando se cae la conexión.
  onMessage(handler: (m: ServerMessage) => void): void;
  readonly closed: Promise<void>;
  close(): void;
}

/** conecta con el daemon; null si no hay ninguno escuchando. */
export async function connectLocal(file: string = localSocketPath()): Promise<LocalConnection | null> {
  const socket = await new Promise<net.Socket | null>((resolve) => {
    const s = net.createConnection(file);
    s.once('connect', () => resolve(s));
    s.once('error', () => resolve(null));
  });
  if (!socket) return null;
  const handlers: ((m: ServerMessage) => void)[] = [];
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('error', () => socket.destroy());
  onLines(socket, (line) => {
    let m: ServerMessage;
    try {
      m = JSON.parse(line) as ServerMessage;
    } catch {
      return;
    }
    handlers.forEach((h) => h(m));
  });
  return {
    send: (m) => void socket.write(`${JSON.stringify(m)}${NEWLINE}`),
    onMessage: (h) => void handlers.push(h),
    closed,
    close: () => socket.end(),
  };
}
