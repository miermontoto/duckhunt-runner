// la tool de permisos (t#527, 0.15.0): el flujo contra una plataforma falsa en local (permitir al momento, pendiente y
// luego permitir por la consulta, denegar con motivo, red caída y 5xx con reintento, caducidad, 4xx), el recorte de la
// entrada (textos largos primero; si no, el principio del json) con la original intacta al permitir, la config de su
// env y el subcomando oculto por stdio, que atiende un ping mientras una petición espera.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  askPermission,
  fitPermissionInput,
  PERMISSION_ENV,
  PERMISSION_SUBCOMMAND,
  permissionConfigOf,
  type PermissionTiming,
  type PermissionToolConfig,
} from '../src/permission-server.js';
import { AGENT_PERMISSION_TOOL, PERMISSION_INPUT_MAX_CHARS, PERMISSION_MESSAGE_MAX_CHARS, RUNNER_PERMISSIONS_PATH } from '../src/vendor/runner-protocol/index.js';

const INDEX = new URL('../src/index.js', import.meta.url);
const TOKEN = 'dho_run_token';
const TIMING: PermissionTiming = { graceMs: 0, retryMinMs: 10, retryMaxMs: 40, requestMarginMs: 2_000 };
const INPUT = { command: 'touch nuevo.txt', description: 'crea un fichero' };
const CALL = { tool_name: 'Bash', input: INPUT, tool_use_id: 'toolu_01' };

type Obj = Record<string, unknown>;
interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: Obj | null;
}
// lo que contesta la plataforma falsa a la petición n (0 = el POST): un estado, un cuerpo crudo o cortar la conexión.
type Reply = { status: number; body?: unknown; raw?: string } | 'drop';

async function fakePlatform(script: (seen: Seen, n: number) => Reply): Promise<{ cfg: PermissionToolConfig; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: data ? (JSON.parse(data) as Obj) : null };
      seen.push(s);
      const reply = script(s, seen.length - 1);
      if (reply === 'drop') {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    cfg: { url: `http://127.0.0.1:${port}${RUNNER_PERMISSIONS_PATH}`, token: TOKEN, segment: 3, ttlMs: 2_000, waitMs: 50 },
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const status = (decision: string | null, message: string | null = null, id = 7): Reply => ({ status: 200, body: { id, decision, message } });

test('permitido al momento: el POST lleva la petición con el token y vuelve la entrada original', async () => {
  const p = await fakePlatform(() => status('allow'));
  try {
    assert.deepEqual(await askPermission(CALL, p.cfg, TIMING), { behavior: 'allow', updatedInput: INPUT });
    assert.equal(p.seen.length, 1);
    assert.deepEqual(p.seen[0], {
      method: 'POST',
      url: RUNNER_PERMISSIONS_PATH,
      auth: `Bearer ${TOKEN}`,
      body: { segment: 3, toolName: 'Bash', input: INPUT, truncated: false, toolUseId: 'toolu_01' },
    });
  } finally {
    await p.close();
  }
});

test('pendiente y luego permitido: consulta GET <url>/<id>?wait=<waitMs> hasta la decisión', async () => {
  const p = await fakePlatform((_s, n) => (n < 3 ? status(null) : status('allow')));
  try {
    assert.deepEqual(await askPermission(CALL, p.cfg, TIMING), { behavior: 'allow', updatedInput: INPUT });
    assert.deepEqual(
      p.seen.slice(1).map((s) => [s.method, s.url, s.auth, s.body]),
      Array.from({ length: 3 }, () => ['GET', `${RUNNER_PERMISSIONS_PATH}/7?wait=50`, `Bearer ${TOKEN}`, null]),
    );
  } finally {
    await p.close();
  }
});

test('denegado: con el motivo de la persona, o el de siempre si no trae; acotado al tope del protocolo', async () => {
  const p = await fakePlatform((_s, n) => (n === 0 ? status(null) : n === 1 ? status('deny', 'no toques prod') : status('deny')));
  try {
    assert.deepEqual(await askPermission(CALL, p.cfg, TIMING), { behavior: 'deny', message: 'no toques prod' });
    const plain = await askPermission(CALL, p.cfg, TIMING);
    assert.equal(plain.behavior, 'deny');
    assert.match((plain as { message: string }).message, /la persona denegó/);
  } finally {
    await p.close();
  }
  const long = await fakePlatform(() => status('deny', 'x'.repeat(PERMISSION_MESSAGE_MAX_CHARS * 2)));
  try {
    assert.equal(((await askPermission(CALL, long.cfg, TIMING)) as { message: string }).message.length, PERMISSION_MESSAGE_MAX_CHARS);
  } finally {
    await long.close();
  }
});

test('red caída, 5xx y 429: reintenta hasta la respuesta', async () => {
  const p = await fakePlatform((_s, n) => (n === 0 ? 'drop' : n === 1 ? { status: 503, raw: 'mantenimiento' } : n === 2 ? { status: 429 } : n === 3 ? status(null) : n === 4 ? 'drop' : status('allow')));
  try {
    assert.deepEqual(await askPermission(CALL, p.cfg, TIMING), { behavior: 'allow', updatedInput: INPUT });
    assert.deepEqual(
      p.seen.map((s) => s.method),
      ['POST', 'POST', 'POST', 'POST', 'GET', 'GET'],
    );
  } finally {
    await p.close();
  }
});

test('nadie responde en el ttl (más su margen): denegado, sin colgarse', async () => {
  const p = await fakePlatform(() => status(null));
  const startedAt = Date.now();
  try {
    const answer = await askPermission(CALL, { ...p.cfg, ttlMs: 200 }, TIMING);
    assert.deepEqual(answer, { behavior: 'deny', message: 'nadie respondió a tiempo a la petición de permiso: denegada' });
    assert.ok(Date.now() - startedAt < 2_000, 'se corta en el plazo');
  } finally {
    await p.close();
  }
  // una plataforma caída entera: lo mismo.
  const down = await fakePlatform(() => 'drop');
  try {
    assert.match(((await askPermission(CALL, { ...down.cfg, ttlMs: 150 }, TIMING)) as { message: string }).message, /nadie respondió/);
  } finally {
    await down.close();
  }
});

test('4xx o un cuerpo que no es un estado: denegado con el motivo, sin reintentar', async () => {
  // i/o secuencial: un servidor por código.
  for (const code of [401, 403, 404, 409, 400]) {
    const p = await fakePlatform((_s, n) => (n === 0 ? status(null) : { status: code, body: { error: 'x' } }));
    try {
      const answer = await askPermission(CALL, p.cfg, TIMING);
      assert.equal(answer.behavior, 'deny');
      assert.match((answer as { message: string }).message, new RegExp(`rechazó la petición de permiso \\(HTTP ${code}\\)`));
      assert.equal(p.seen.length, 2, `${code}: sin reintentos`);
    } finally {
      await p.close();
    }
  }
  // una redirección no se sigue con el token.
  const moved = await fakePlatform(() => ({ status: 302, raw: '' }));
  try {
    assert.match(((await askPermission(CALL, moved.cfg, TIMING)) as { message: string }).message, /HTTP 302/);
    assert.equal(moved.seen.length, 1);
  } finally {
    await moved.close();
  }
  const html = await fakePlatform(() => ({ status: 200, raw: '<html>proxy</html>' }));
  try {
    assert.match(((await askPermission(CALL, html.cfg, TIMING)) as { message: string }).message, /no es su estado/);
  } finally {
    await html.close();
  }
  // un GET que devuelve otra petición tampoco vale.
  const other = await fakePlatform((_s, n) => (n === 0 ? status(null) : status('allow', null, 8)));
  try {
    assert.equal((await askPermission(CALL, other.cfg, TIMING)).behavior, 'deny');
  } finally {
    await other.close();
  }
});

test('una llamada del cli sin tool_name o sin entrada: denegada sin preguntar a nadie', async () => {
  const p = await fakePlatform(() => status('allow'));
  try {
    assert.equal((await askPermission({ input: INPUT }, p.cfg, TIMING)).behavior, 'deny');
    assert.equal((await askPermission({ tool_name: 'Bash', input: 'rm -rf /' }, p.cfg, TIMING)).behavior, 'deny');
    assert.equal(p.seen.length, 0);
    // sin tool_use_id (o uno que no cabe), la petición va con null.
    await askPermission({ tool_name: 'Bash', input: INPUT, tool_use_id: 'x'.repeat(201) }, p.cfg, TIMING);
    assert.equal(p.seen[0]!.body!.toolUseId, null);
  } finally {
    await p.close();
  }
});

test('recorte: los textos largos primero, con el mayor tope que cabe; si no, el principio del json', () => {
  const small = { file_path: '/repo/a.ts', content: 'hola' };
  assert.deepEqual(fitPermissionInput(small), { input: small, truncated: false });
  const big = { file_path: '/repo/src/muy/largo.ts', content: 'x'.repeat(40_000), old: 'y'.repeat(30_000) };
  const fitted = fitPermissionInput(big);
  assert.equal(fitted.truncated, true);
  assert.ok(JSON.stringify(fitted.input).length <= PERMISSION_INPUT_MAX_CHARS);
  assert.ok(JSON.stringify(fitted.input).length > PERMISSION_INPUT_MAX_CHARS - 100, 'aprovecha el tope');
  assert.equal(fitted.input.file_path, big.file_path, 'lo corto, intacto');
  assert.match(String(fitted.input.content), /^x+…$/);
  assert.equal(String(fitted.input.content).length, String(fitted.input.old).length, 'el mismo tope para todos');
  // anidado también.
  const nested = fitPermissionInput({ edits: [{ old_string: 'a'.repeat(20_000), new_string: 'b' }] });
  assert.match(String((nested.input.edits as Obj[])[0]!.old_string), /…$/);
  assert.equal((nested.input.edits as Obj[])[0]!.new_string, 'b');
  // muchos campos cortos: ningún tope de texto basta.
  const wide = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, 'v'.repeat(20)]));
  const preview = fitPermissionInput(wide);
  assert.deepEqual(Object.keys(preview.input), ['preview']);
  assert.equal(preview.truncated, true);
  assert.ok(JSON.stringify(preview.input).length <= PERMISSION_INPUT_MAX_CHARS);
  assert.ok(String(preview.input.preview).startsWith('{"k0":"vvvv'));
  // comillas que se escapan dos veces en el json de la vista previa.
  const quoted = fitPermissionInput(Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, '"'.repeat(20)])));
  assert.ok(JSON.stringify(quoted.input).length <= PERMISSION_INPUT_MAX_CHARS);
});

test('recorte en el cable: la plataforma ve la entrada recortada y el cli recibe la original entera', async () => {
  const input = { file_path: '/repo/a.ts', content: 'z'.repeat(50_000) };
  const p = await fakePlatform(() => status('allow'));
  try {
    assert.deepEqual(await askPermission({ tool_name: 'Write', input }, p.cfg, TIMING), { behavior: 'allow', updatedInput: input });
    const body = p.seen[0]!.body!;
    assert.equal(body.truncated, true);
    assert.equal((body.input as Obj).file_path, '/repo/a.ts');
    assert.ok(JSON.stringify(body.input).length <= PERMISSION_INPUT_MAX_CHARS);
  } finally {
    await p.close();
  }
});

test('config del env: las cinco variables; sin alguna, lanza diciendo cuáles', () => {
  const env = {
    [PERMISSION_ENV.url]: 'https://duckhunt.info/api/runner-permissions',
    [PERMISSION_ENV.token]: TOKEN,
    [PERMISSION_ENV.segment]: '2',
    [PERMISSION_ENV.ttlMs]: '1800000',
    [PERMISSION_ENV.waitMs]: '25000',
  };
  assert.deepEqual(permissionConfigOf(env), { url: 'https://duckhunt.info/api/runner-permissions', token: TOKEN, segment: 2, ttlMs: 1_800_000, waitMs: 25_000 });
  assert.throws(() => permissionConfigOf({ ...env, [PERMISSION_ENV.token]: '' }), /DUCKHUNT_PERMISSION_TOKEN/);
  assert.throws(() => permissionConfigOf({ ...env, [PERMISSION_ENV.segment]: '-1' }), /sin config válida/);
  assert.throws(() => permissionConfigOf({ ...env, [PERMISSION_ENV.url]: 'no es una url' }), /sin config válida/);
});

// el subcomando por stdio: respuestas por id, a medida que llegan.
function stdioServer(env: NodeJS.ProcessEnv): { send: (msg: Obj) => void; reply: (id: number) => Promise<Obj>; order: number[]; close: () => Promise<void> } {
  const child = spawn(process.execPath, [INDEX.pathname, PERMISSION_SUBCOMMAND], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map<number, Obj>();
  const waiting = new Map<number, (msg: Obj) => void>();
  const order: number[] = [];
  let buffered = '';
  child.stdout.on('data', (buf: Buffer) => {
    buffered += buf.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    lines.filter(Boolean).forEach((l) => {
      const msg = JSON.parse(l) as Obj & { id: number };
      order.push(msg.id);
      replies.set(msg.id, msg);
      waiting.get(msg.id)?.(msg);
    });
  });
  return {
    send: (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`),
    reply: (id) => (replies.has(id) ? Promise.resolve(replies.get(id)!) : new Promise((resolve) => waiting.set(id, resolve))),
    order,
    close: () => {
      child.stdin.end();
      return new Promise((resolve) => child.on('close', () => resolve()));
    },
  };
}

const textOf = (msg: Obj): { text: string; isError?: boolean } => {
  const result = msg.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0]!.text, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
};

test('subcomando oculto: sirve `prompt` por stdio, atiende un ping mientras una petición espera y sale al cerrarse', async () => {
  let release = false;
  const p = await fakePlatform((_s, n) => (n === 0 || !release ? status(null) : status('allow')));
  const env = {
    PATH: process.env.PATH ?? '',
    [PERMISSION_ENV.url]: p.cfg.url,
    [PERMISSION_ENV.token]: TOKEN,
    [PERMISSION_ENV.segment]: '3',
    [PERMISSION_ENV.ttlMs]: '20000',
    [PERMISSION_ENV.waitMs]: '50',
  };
  const s = stdioServer(env);
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    s.send({ id: 2, method: 'tools/list' });
    assert.deepEqual(((await s.reply(2)).result as { tools: { name: string }[] }).tools.map((t) => t.name), [AGENT_PERMISSION_TOOL.tool]);
    s.send({ id: 3, method: 'tools/call', params: { name: AGENT_PERMISSION_TOOL.tool, arguments: CALL } });
    s.send({ id: 4, method: 'ping' });
    await s.reply(4);
    release = true;
    assert.deepEqual(JSON.parse(textOf(await s.reply(3)).text), { behavior: 'allow', updatedInput: INPUT });
    assert.equal(textOf(await s.reply(3)).isError, undefined, 'nunca isError');
    assert.ok(s.order.indexOf(4) < s.order.indexOf(3), 'el ping no esperó a la petición');
  } finally {
    await s.close();
    await p.close();
  }
});

test('subcomando oculto sin config en su env: deniega cada llamada con el motivo, nunca isError', async () => {
  const s = stdioServer({ PATH: process.env.PATH ?? '' });
  try {
    s.send({ id: 1, method: 'tools/call', params: { name: AGENT_PERMISSION_TOOL.tool, arguments: CALL } });
    const { text, isError } = textOf(await s.reply(1));
    assert.equal(isError, undefined);
    assert.equal(JSON.parse(text).behavior, 'deny');
    assert.match(JSON.parse(text).message, /no está configurada/);
  } finally {
    await s.close();
  }
});
