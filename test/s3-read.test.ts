// lectura de objetos s3 desde un run (t#495, 0.13.0): el lector (gzip, topes, páginas, alcance, binarios, tamaño),
// el servidor mcp por stdio del subcomando oculto, lo que pone el proveedor aws (solo con toolset_v1 y s3Read), la cli
// `aws add --s3-read` y el resumen del feed. una aws falsa sirve los objetos de un directorio y apunta cada llamada:
// el único destino de `cp` es `-` y el lector no deja ningún fichero.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { awsCommand } from '../src/aws.js';
import { configPath, loadStoredConfig } from '../src/config.js';
import { summarizeToolUse, type FeedContext } from '../src/feed.js';
import { KeyedMutex } from '../src/keyed-mutex.js';
import { awsProvider } from '../src/resources/aws.js';
import { S3_READ_SCOPE_ENV, S3_READ_SUBCOMMAND, s3ReadScopeOf } from '../src/resources/s3-read.js';
import type { Materialized, RunContext } from '../src/resources/types.js';
import { readS3Object, type S3ReadLimits } from '../src/s3-read-server.js';

const ACCOUNT = '123456789012';
const BUCKET = 'acme-alb-logs';
const PREFIX = 'AWSLogs/111122223333/';
const GZ_KEY = `${PREFIX}elasticloadbalancing/eu-south-2/2026/10/20/alb.log.gz`;
const TEXT_KEY = `${PREFIX}notes.txt`;
const BIN_KEY = `${PREFIX}blob.bin`;
const INDEX = new URL('../src/index.js', import.meta.url);
const LIMITS: S3ReadLimits = { maxBytes: 4096, objectMaxBytes: 10 * 1024 * 1024, scanMaxBytes: 1024 * 1024, timeoutMs: 15_000 };
const SCOPE = [{ bucket: BUCKET, prefix: PREFIX }];
// las líneas de un access log de alb: cada una con su número, para saber qué página llegó.
const LOG = Array.from({ length: 400 }, (_, i) => `https 2026-10-20T11:${String(i % 60).padStart(2, '0')}:00Z app/acme-ALB line-${i} 10.0.0.1:443 GET /api/x\n`).join('');

let root = '';
let env: NodeJS.ProcessEnv = {};
let log = '';

// la aws falsa: head-object y `s3 cp s3://b/k -` sobre S3_FAKE_OBJECTS; cada llamada, una línea en S3_FAKE_LOG.
const FAKE_AWS = `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.S3_FAKE_LOG, JSON.stringify(a) + '\\n');
const arg = (f) => a[a.indexOf(f) + 1];
const file = (b, k) => path.join(process.env.S3_FAKE_OBJECTS, b, k);
if (a[0] === 's3api' && a[1] === 'head-object') {
  const f = file(arg('--bucket'), arg('--key'));
  if (!fs.existsSync(f)) { process.stderr.write('An error occurred (404) when calling the HeadObject operation: Not Found'); process.exit(254); }
  process.stdout.write(JSON.stringify({ ContentLength: fs.statSync(f).size }));
} else if (a[0] === 's3' && a[1] === 'cp' && a[3] === '-') {
  const m = /^s3:\\/\\/([^/]+)\\/(.+)$/.exec(a[2]);
  fs.createReadStream(file(m[1], m[2])).on('error', () => process.exit(1)).pipe(process.stdout);
} else { process.stderr.write('llamada inesperada'); process.exit(3); }
`;

const put = (key: string, data: Buffer | string): void => {
  const f = path.join(root, 'objects', BUCKET, key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const calls = (): string[][] => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-s3-read-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), FAKE_AWS, { mode: 0o755 });
  log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(log, '');
  put(GZ_KEY, zlib.gzipSync(LOG));
  put(TEXT_KEY, 'hola\nmundo\n');
  put(BIN_KEY, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]));
  env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: root, S3_FAKE_OBJECTS: path.join(root, 'objects'), S3_FAKE_LOG: log };
  process.env.DUCKHUNT_RUNNER_HOME = path.join(root, 'home');
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(root, 'runner.json');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('un .log.gz se lee descomprimido, por páginas con su offset, hasta el final', async () => {
  const first = await readS3Object({ bucket: BUCKET, key: GZ_KEY }, SCOPE, env, LIMITS);
  const [header, ...body] = first.split('\n');
  assert.match(header!, /^s3:\/\/acme-alb-logs\/.+alb\.log\.gz · bytes 0-4096 · hay más: sigue con offset=4096$/);
  assert.equal(body.join('\n'), LOG.slice(0, 4096));
  // la última página dice que no queda nada.
  const offset = LOG.length - 100;
  const last = await readS3Object({ bucket: BUCKET, key: GZ_KEY, offset }, SCOPE, env, LIMITS);
  assert.match(last.split('\n')[0]!, new RegExp(`· bytes ${offset}-${LOG.length} · fin del objeto$`));
  assert.ok(last.endsWith(LOG.slice(offset)));
  // con maxBytes propio.
  const small = await readS3Object({ bucket: BUCKET, key: GZ_KEY, offset: 10, maxBytes: 20 }, SCOPE, env, LIMITS);
  assert.equal(small.slice(small.indexOf('\n') + 1), LOG.slice(10, 30));
  // nunca otro destino que stdout, y nada más que head-object y cp.
  assert.ok(calls().every((c) => (c[0] === 's3api' && c[1] === 'head-object') || (c[0] === 's3' && c[1] === 'cp' && c[3] === '-')), JSON.stringify(calls()));
});

test('texto sin comprimir; un objeto binario no se devuelve, solo cuánto se leyó', async () => {
  const text = await readS3Object({ bucket: BUCKET, key: TEXT_KEY }, SCOPE, env, LIMITS);
  assert.equal(text, `s3://${BUCKET}/${TEXT_KEY} · bytes 0-11 · fin del objeto\nhola\nmundo\n`);
  await assert.rejects(readS3Object({ bucket: BUCKET, key: BIN_KEY }, SCOPE, env, LIMITS), /es binario \(7 bytes leídos\): s3_read solo devuelve texto/);
});

test('fuera del alcance, con argumentos que no valen o por encima del tope de tamaño: no se lee', async () => {
  await assert.rejects(readS3Object({ bucket: BUCKET, key: 'otra/ruta.log' }, SCOPE, env, LIMITS), /queda fuera de lo que esta máquina deja leer/);
  await assert.rejects(readS3Object({ bucket: 'otro-bucket', key: GZ_KEY }, SCOPE, env, LIMITS), /queda fuera/);
  await assert.rejects(readS3Object({ bucket: 'Mal_Bucket', key: 'x' }, '*', env, LIMITS), /bucket no válido/);
  await assert.rejects(readS3Object({ bucket: BUCKET, key: 'a\nb' }, '*', env, LIMITS), /key no válida/);
  await assert.rejects(readS3Object({ bucket: BUCKET, key: GZ_KEY, offset: -1 }, SCOPE, env, LIMITS), /offset/);
  await assert.rejects(readS3Object({ bucket: BUCKET, key: GZ_KEY, maxBytes: LIMITS.maxBytes + 1 }, SCOPE, env, LIMITS), /maxBytes/);
  await assert.rejects(readS3Object({ bucket: BUCKET, key: GZ_KEY, region: 'eu; rm -rf' }, SCOPE, env, LIMITS), /region no válida/);
  const before = calls().length;
  await assert.rejects(readS3Object({ bucket: BUCKET, key: GZ_KEY }, SCOPE, env, { ...LIMITS, objectMaxBytes: 10 }), /ocupa \d+ bytes: más de 10, no se lee/);
  assert.deepEqual(calls().slice(before).map((c) => c[1]), ['head-object'], 'por encima del tope ni se descarga');
  await assert.rejects(readS3Object({ bucket: BUCKET, key: `${PREFIX}no-existe.log` }, SCOPE, env, LIMITS), /head-object falló: .*Not Found/);
});

test('el subcomando oculto sirve s3_read por mcp stdio con el alcance de su env', async () => {
  const child = spawn(process.execPath, [INDEX.pathname, S3_READ_SUBCOMMAND], { env: { ...env, [S3_READ_SCOPE_ENV]: JSON.stringify([`${BUCKET}/${PREFIX}`]) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map<number, Record<string, unknown>>();
  let buffered = '';
  const done = new Promise<void>((resolve) =>
    child.stdout.on('data', (buf: Buffer) => {
      buffered += buf.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      lines.filter(Boolean).forEach((l) => {
        const msg = JSON.parse(l) as { id: number };
        replies.set(msg.id, msg as unknown as Record<string, unknown>);
      });
      if (replies.size === 3) resolve();
    }),
  );
  const send = (msg: object): boolean => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 's3_read', arguments: { bucket: BUCKET, key: TEXT_KEY } } });
  await done;
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal((replies.get(1)!.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
  assert.deepEqual((replies.get(2)!.result as { tools: { name: string }[] }).tools.map((t) => t.name), ['s3_read']);
  assert.match((replies.get(3)!.result as { content: { text: string }[] }).content[0]!.text, /fin del objeto\nhola\nmundo\n$/);
});

// el contexto de un run para el proveedor aws.
const ctxOf = (toolset: boolean): RunContext => ({ platform: 'duckhunt', runId: '7', env: { PATH: '/usr/bin', HOME: '/home/u', OTRO_SECRETO: 's' }, gitLocks: new KeyedMutex(), toolset });
const awsReq = { type: 'aws', key: ACCOUNT, access: 'read' as const, params: { region: null } };

test('proveedor aws: el servidor de lectura s3 solo con s3Read y un claim toolset_v1; su env, solo la aws del run', async () => {
  const on = (await awsProvider.materialize(awsReq, { profile: 'prod', region: 'eu-west-1', s3Read: [`${BUCKET}/${PREFIX}`] }, ctxOf(true))) as Materialized;
  assert.ok(on.mcp, 'con toolset_v1 y s3Read, su servidor');
  const { server, tools, denied } = await on.mcp!();
  assert.deepEqual([tools, denied], [['s3_read'], []]);
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.at(-1), S3_READ_SUBCOMMAND);
  assert.deepEqual(server.env, { PATH: '/usr/bin', HOME: '/home/u', AWS_PROFILE: 'prod', AWS_DEFAULT_REGION: 'eu-west-1', [S3_READ_SCOPE_ENV]: JSON.stringify([`${BUCKET}/${PREFIX}`]) });
  assert.deepEqual(on.warnings, [`lectura de objetos s3 de ${ACCOUNT}: ${BUCKET}/${PREFIX}`]);
  // con las listas del server (el interruptor del flip), una nota y nada más.
  const off = await awsProvider.materialize(awsReq, { profile: 'prod', s3Read: true }, ctxOf(false));
  assert.equal(off.mcp, undefined);
  assert.match(off.warnings[0]!, /no se ofrece: solo con el render del daemon/);
  // sin s3Read, nada (ni una nota).
  const none = await awsProvider.materialize(awsReq, { profile: 'prod' }, ctxOf(true));
  assert.deepEqual([none.mcp, none.warnings], [undefined, []]);
  // un s3Read que no se entiende, un aviso.
  const bad = await awsProvider.materialize(awsReq, { profile: 'prod', s3Read: ['Mal_Bucket'] }, ctxOf(true));
  assert.equal(bad.mcp, undefined);
  assert.match(bad.warnings[0]!, /s3Read de la config no se entiende/);
  assert.deepEqual([s3ReadScopeOf(true), s3ReadScopeOf(undefined), s3ReadScopeOf([]), s3ReadScopeOf(['a'])], ['*', null, 'invalid', 'invalid']);
});

// salida de un comando de la cli (log + error) y su exit code.
function cli(t: { mock: { method: typeof import('node:test').mock.method } }, run: () => void): { out: string[]; code: number } {
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => out.push(a.join(' ')));
  process.exitCode = undefined;
  run();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out, code };
}

test('cli: `aws add … --s3-read` guarda el alcance; sin el flag, la salida de siempre', (t) => {
  fs.writeFileSync(configPath(), JSON.stringify({ baseUrl: 'https://duckhunt.test', clientId: 'c', refreshToken: 'r', repos: {}, aws: {}, defaults: {} }), { mode: 0o600 });
  const plain = cli(t, () => awsCommand(['add', ACCOUNT, 'prod', 'eu-west-1']));
  assert.deepEqual(plain, { out: [`mapeada la cuenta ${ACCOUNT} → perfil prod (eu-west-1) en ${configPath()}`], code: 0 });
  assert.deepEqual(loadStoredConfig()!.aws[ACCOUNT], { profile: 'prod', region: 'eu-west-1' });
  const scoped = cli(t, () => awsCommand(['add', ACCOUNT, 'prod', 'eu-west-1', '--s3-read', `${BUCKET}/${PREFIX}`, 'otro-bucket']));
  assert.deepEqual(scoped.out, [`mapeada la cuenta ${ACCOUNT} → perfil prod (eu-west-1) · lectura s3: ${BUCKET}/${PREFIX}, otro-bucket en ${configPath()}`]);
  assert.deepEqual(loadStoredConfig()!.aws[ACCOUNT]?.s3Read, [`${BUCKET}/${PREFIX}`, 'otro-bucket']);
  const all = cli(t, () => awsCommand(['add', ACCOUNT, 'prod', '--s3-read']));
  assert.equal(all.code, 0);
  assert.equal(loadStoredConfig()!.aws[ACCOUNT]?.s3Read, true);
  assert.deepEqual(cli(t, () => awsCommand(['list'])).out, [`  ${ACCOUNT} → perfil prod · lectura s3: cualquier bucket`]);
  assert.deepEqual(cli(t, () => awsCommand(['add', ACCOUNT, 'prod', '--s3-read', 'Mal_Bucket'])), { out: ['destino de --s3-read inválido: "Mal_Bucket" (bucket o bucket/prefijo)'], code: 1 });
});

test('feed: s3_read sale como el objeto y la ventana pedida, nunca su contenido', () => {
  const ctx: FeedContext = { cwd: '/w', home: '/home/u', bodyMaxChars: 4000, toolArgMaxChars: 200 };
  assert.equal(summarizeToolUse(`mcp__res_aws_${ACCOUNT}__s3_read`, { bucket: BUCKET, key: TEXT_KEY }, ctx), `s3://${BUCKET}/${TEXT_KEY}`);
  assert.equal(summarizeToolUse(`mcp__res_aws_${ACCOUNT}__s3_read`, { bucket: BUCKET, key: TEXT_KEY, offset: 10, maxBytes: 20 }, ctx), `s3://${BUCKET}/${TEXT_KEY} offset=10 maxBytes=20`);
});
