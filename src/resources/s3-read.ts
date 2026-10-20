// lectura de objetos s3 desde un run (t#495, 0.13.0): un run de lectura puede `aws s3 ls` pero no leer un objeto
// (`s3api get-object` está negado: exige un outfile y las reglas por prefijo no lo limitan a stdout), y una
// investigación necesita, por ejemplo, los access logs de un alb (.log.gz). el runner pone una tool propia, s3_read,
// en un servidor mcp stdio del recurso aws (res_aws_<clave>): el propio runner en un subcomando oculto
// (s3-read-server.ts), que lee con `aws s3 cp s3://… -` sin shell, descomprime gzip y devuelve texto acotado.
// decisiones:
// - opt-in por clave aws en la config de la máquina (`aws.<clave>.s3Read`): true = cualquier bucket que lea su perfil;
//   una lista = solo esos buckets o prefijos (`bucket` o `bucket/prefijo/`). sin él, nada cambia.
// - solo con un claim que manda con toolset_v1 (el render del daemon, v0 o la plataforma local): con el interruptor
//   del flip las listas son las del server y no la nombran, así que no se ofrece (con una nota).
// - el servidor recibe en su env SOLO lo que necesita: la aws del run (perfil, región, ficheros de config), PATH y
//   HOME para la aws cli, y su alcance. los topes van compilados en el runner (s3-read-server.ts).
// - nunca escribe un fichero local ni tiene un camino de subida: `cp` solo hacia stdout.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerEntry } from './types.js';

/** la tool del servidor (mcp__res_aws_<clave>__s3_read en el run). */
export const S3_READ_TOOL = 's3_read';
/** subcomando oculto del runner que sirve el mcp por stdio. */
export const S3_READ_SUBCOMMAND = 'mcp-s3';
/** variable con el alcance (json) que recibe el servidor. */
export const S3_READ_SCOPE_ENV = 'DUCKHUNT_S3_READ_SCOPE';
/** alcance sin lista: cualquier bucket que lea el perfil. */
export const S3_READ_ALL = '*';

// nombre de bucket de s3 (reglas de la api: 3–63, minúsculas, dígitos, puntos y guiones).
export const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_SEPARATOR = '/';
// variables del env del run que la aws cli del servidor necesita además de las AWS_*.
const PASSED_ENV = ['PATH', 'HOME'];
const AWS_ENV_PREFIX = 'AWS_';
// el entrypoint del runner (dist/index.js) junto a este módulo (dist/resources/s3-read.js).
const RUNNER_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

/** un bucket con su prefijo ('' = el bucket entero). */
export interface S3Target {
  bucket: string;
  prefix: string;
}
export type S3ReadScope = typeof S3_READ_ALL | readonly S3Target[];

/** `bucket` o `bucket/prefijo` → su destino, o null si no es un bucket válido. */
export function parseS3Target(raw: string): S3Target | null {
  const at = raw.indexOf(PREFIX_SEPARATOR);
  const bucket = at === -1 ? raw : raw.slice(0, at);
  return S3_BUCKET_RE.test(bucket) ? { bucket, prefix: at === -1 ? '' : raw.slice(at + 1) } : null;
}

/** el alcance de `s3Read` de una entrada aws de la config: null = sin lectura s3; 'invalid' = no se entiende (se avisa). */
export function s3ReadScopeOf(raw: unknown): S3ReadScope | null | 'invalid' {
  if (raw === undefined || raw === false) return null;
  if (raw === true) return S3_READ_ALL;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((t) => typeof t === 'string')) return 'invalid';
  const targets = (raw as string[]).map(parseS3Target);
  return targets.every((t): t is S3Target => t !== null) ? targets : 'invalid';
}

/** ¿el alcance cubre este objeto? */
export const s3ScopeAllows = (scope: S3ReadScope, bucket: string, key: string): boolean =>
  scope === S3_READ_ALL || scope.some((t) => t.bucket === bucket && key.startsWith(t.prefix));

/** el alcance en la forma de la config (`s3Read`): true, o la lista de `bucket[/prefijo]`. */
export const s3ScopeConfig = (scope: S3ReadScope): true | string[] =>
  scope === S3_READ_ALL ? true : scope.map((t) => `${t.bucket}${t.prefix ? `${PREFIX_SEPARATOR}${t.prefix}` : ''}`);

/** el alcance para la cli y los avisos. */
export const describeS3Scope = (scope: S3ReadScope): string => {
  const config = s3ScopeConfig(scope);
  return config === true ? 'cualquier bucket' : config.join(', ');
};

/** el servidor mcp stdio del run: el runner en su subcomando, con la aws del run y el alcance (ver cabecera). */
export function s3ReadServer(scope: S3ReadScope, runEnv: NodeJS.ProcessEnv): McpServerEntry {
  const passed = Object.entries(runEnv).filter((e): e is [string, string] => e[1] !== undefined && (e[0].startsWith(AWS_ENV_PREFIX) || PASSED_ENV.includes(e[0])));
  return {
    type: 'stdio',
    command: process.execPath,
    args: [path.resolve(RUNNER_ENTRY), S3_READ_SUBCOMMAND],
    env: { ...Object.fromEntries(passed), [S3_READ_SCOPE_ENV]: JSON.stringify(s3ScopeConfig(scope)) },
  };
}
