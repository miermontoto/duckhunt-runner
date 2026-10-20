// el servidor mcp de lectura de objetos s3 de un run (t#495, 0.13.0; el porqué y el alcance, resources/s3-read.ts):
// `duckhunt-runner mcp-s3`, lanzado por el cli del run como servidor stdio. una sola tool, s3_read.
// - primero `aws s3api head-object`: un objeto por encima de S3_OBJECT_MAX_BYTES no se lee.
// - luego `aws s3 cp s3://bucket/clave -` (stdout, sin shell: argumentos en array), descomprimiendo gzip (clave .gz o
//   la cabecera mágica) con zlib, y se corta en cuanto hay offset + maxBytes: ni un objeto grande ni una bomba gzip
//   se leen enteros (y nunca más allá de S3_SCAN_MAX_BYTES).
// - devuelve texto, como mucho S3_READ_MAX_BYTES por llamada, con una cabecera (qué bytes son y desde dónde
//   seguir). un objeto binario (bytes nul) no se devuelve: solo cuánto se leyó.
// - nunca escribe un fichero ni sube nada: el único destino de `cp` es `-`.

import { execFile, spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { serveStdioMcp, type StdioTool } from './mcp-stdio.js';
import { S3_BUCKET_RE, S3_READ_SCOPE_ENV, S3_READ_TOOL, s3ReadScopeOf, s3ScopeAllows, type S3ReadScope } from './resources/s3-read.js';

/** texto por llamada, ya descomprimido. */
export const S3_READ_MAX_BYTES = 512 * 1024;
/** tamaño máximo del objeto (comprimido, el de head-object). */
export const S3_OBJECT_MAX_BYTES = 256 * 1024 * 1024;
/** hasta dónde se pagina dentro del objeto descomprimido. */
export const S3_SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** plazo de cada llamada a la aws cli. */
export const S3_READ_TIMEOUT_MS = 60_000;

export interface S3ReadLimits {
  maxBytes: number;
  objectMaxBytes: number;
  scanMaxBytes: number;
  timeoutMs: number;
}
const DEFAULT_LIMITS: S3ReadLimits = { maxBytes: S3_READ_MAX_BYTES, objectMaxBytes: S3_OBJECT_MAX_BYTES, scanMaxBytes: S3_SCAN_MAX_BYTES, timeoutMs: S3_READ_TIMEOUT_MS };

const AWS_BIN = 'aws';
const SERVER_NAME = 'duckhunt-runner-s3';
const KEY_MAX_CHARS = 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const GZ_SUFFIX = '.gz';
const GZIP_MAGIC = [0x1f, 0x8b] as const;
const NUL = 0;
const STDERR_TAIL_CHARS = 400;
// lo que head-object puede devolver (un json corto).
const HEAD_MAX_BUFFER = 64 * 1024;

export const S3_READ_TOOL_DEF: StdioTool = {
  name: S3_READ_TOOL,
  description:
    'lee un objeto de s3 como texto (descomprime gzip, p. ej. access logs .log.gz): como mucho 512 KB por llamada; para seguir, vuelve a llamar con el offset que indica la cabecera. solo buckets y prefijos permitidos en esta máquina; nada binario.',
  inputSchema: {
    type: 'object',
    properties: {
      bucket: { type: 'string' },
      key: { type: 'string' },
      offset: { type: 'integer', minimum: 0, description: 'byte del objeto descomprimido desde el que leer (0 por defecto)' },
      maxBytes: { type: 'integer', minimum: 1, maximum: S3_READ_MAX_BYTES },
      region: { type: 'string', description: 'región del bucket si no es la del perfil' },
    },
    required: ['bucket', 'key'],
  },
};

interface ReadArgs {
  bucket: string;
  key: string;
  offset: number;
  maxBytes: number;
  region: string | null;
}

const bad = (msg: string): never => {
  throw new Error(msg);
};

// los argumentos de la tool, validados contra el alcance y los topes.
function readArgs(raw: Record<string, unknown>, scope: S3ReadScope, limits: S3ReadLimits): ReadArgs {
  const { bucket, key } = raw;
  if (typeof bucket !== 'string' || !S3_BUCKET_RE.test(bucket)) return bad('bucket no válido');
  if (typeof key !== 'string' || key === '' || key.length > KEY_MAX_CHARS || CONTROL_RE.test(key)) return bad('key no válida');
  const offset = raw.offset ?? 0;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > limits.scanMaxBytes) return bad(`offset: entero entre 0 y ${limits.scanMaxBytes}`);
  const maxBytes = raw.maxBytes ?? limits.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > limits.maxBytes) return bad(`maxBytes: entero entre 1 y ${limits.maxBytes}`);
  const region = raw.region ?? null;
  if (region !== null && (typeof region !== 'string' || !REGION_RE.test(region))) return bad('region no válida');
  if (!s3ScopeAllows(scope, bucket, key)) return bad(`s3://${bucket}/${key} queda fuera de lo que esta máquina deja leer (aws.<clave>.s3Read)`);
  return { bucket, key, offset: offset as number, maxBytes: maxBytes as number, region: region as string | null };
}

const regionArgs = (a: ReadArgs): string[] => (a.region ? ['--region', a.region] : []);
const tail = (s: string): string => s.trim().slice(-STDERR_TAIL_CHARS);

// tamaño del objeto (comprimido) por head-object.
function objectSize(a: ReadArgs, env: NodeJS.ProcessEnv, limits: S3ReadLimits): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      AWS_BIN,
      ['s3api', 'head-object', '--bucket', a.bucket, '--key', a.key, '--output', 'json', ...regionArgs(a)],
      { env, timeout: limits.timeoutMs, maxBuffer: HEAD_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`head-object falló: ${tail(stderr) || err.message}`));
        const size = (JSON.parse(stdout) as { ContentLength?: unknown }).ContentLength;
        return typeof size === 'number' ? resolve(size) : reject(new Error('head-object sin ContentLength'));
      },
    );
  });
}

// los primeros `want` bytes del objeto (descomprimido si es gzip) y si se llegó al final.
function streamObject(a: ReadArgs, env: NodeJS.ProcessEnv, want: number, limits: S3ReadLimits): Promise<{ bytes: Buffer; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(AWS_BIN, ['s3', 'cp', `s3://${a.bucket}/${a.key}`, '-', '--only-show-errors', ...regionArgs(a)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let gunzip: zlib.Gunzip | null = null;
    let decided = false;
    let done = false;
    const stop = (): void => {
      done = true;
      clearTimeout(timer);
      gunzip?.destroy();
      if (child.exitCode === null) child.kill();
    };
    const finish = (ended: boolean): void => {
      if (done) return;
      stop();
      resolve({ bytes: Buffer.concat(chunks), ended });
    };
    const fail = (err: Error): void => {
      if (done) return;
      stop();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`la lectura pasó de ${limits.timeoutMs / 1000} s`)), limits.timeoutMs);
    const take = (buf: Buffer): void => {
      chunks.push(buf);
      size += buf.length;
      if (size >= want) finish(false);
    };
    child.stderr.on('data', (buf: Buffer) => (stderr += buf.toString('utf8')));
    child.stdout.on('data', (buf: Buffer) => {
      if (done) return;
      if (!decided) {
        decided = true;
        if (a.key.endsWith(GZ_SUFFIX) || (buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1])) {
          gunzip = zlib.createGunzip();
          gunzip.on('data', take);
          gunzip.on('end', () => finish(true));
          gunzip.on('error', (err) => fail(new Error(`no se pudo descomprimir: ${err.message}`)));
        }
      }
      if (gunzip) gunzip.write(buf);
      else take(buf);
    });
    child.stdout.on('end', () => (gunzip ? gunzip.end() : finish(true)));
    child.on('error', (err) => fail(new Error(`no se pudo lanzar la aws cli: ${err.message}`)));
    child.on('close', (code) => {
      if (!done && code !== 0) fail(new Error(`s3 cp falló: ${tail(stderr) || `exit ${code}`}`));
    });
  });
}

/** lee un trozo de texto de un objeto (ver cabecera). lanza con el motivo si no se puede. */
export async function readS3Object(raw: Record<string, unknown>, scope: S3ReadScope, env: NodeJS.ProcessEnv, limits: S3ReadLimits = DEFAULT_LIMITS): Promise<string> {
  const a = readArgs(raw, scope, limits);
  const size = await objectSize(a, env, limits);
  if (size > limits.objectMaxBytes) return bad(`s3://${a.bucket}/${a.key} ocupa ${size} bytes: más de ${limits.objectMaxBytes}, no se lee`);
  // un byte de más dice si queda objeto tras la ventana.
  const { bytes, ended } = await streamObject(a, env, a.offset + a.maxBytes + 1, limits);
  const window = bytes.subarray(a.offset, a.offset + a.maxBytes);
  if (window.includes(NUL)) return bad(`s3://${a.bucket}/${a.key} es binario (${bytes.length} bytes leídos): s3_read solo devuelve texto`);
  const more = !ended || bytes.length > a.offset + a.maxBytes;
  const end = a.offset + window.length;
  const header = `s3://${a.bucket}/${a.key} · bytes ${a.offset}-${end}${more ? ` · hay más: sigue con offset=${end}` : ' · fin del objeto'}`;
  return `${header}\n${window.toString('utf8')}`;
}

/** `duckhunt-runner mcp-s3`: el servidor stdio con el alcance de su env. */
export async function s3McpCommand(): Promise<void> {
  const scope = s3ReadScopeOf(JSON.parse(process.env[S3_READ_SCOPE_ENV] ?? 'null'));
  if (scope === null || scope === 'invalid') {
    console.error(`mcp-s3: sin alcance válido en ${S3_READ_SCOPE_ENV}`);
    process.exitCode = 1;
    return;
  }
  await serveStdioMcp({ name: SERVER_NAME, tools: [S3_READ_TOOL_DEF], call: (_tool, args) => readS3Object(args, scope, process.env) });
}
