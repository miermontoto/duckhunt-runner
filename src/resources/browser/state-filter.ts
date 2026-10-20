// la copia por run de una sesión de navegador (t#495, M7): el storage state de playwright que guarda odysea
// (`cookies` + `origins` con su localStorage e IndexedDB) filtrado a la allowlist de la sesión (origins.ts). lo
// hace el runner, no odysea: lo que llega a un run no depende de que odysea filtre bien. puro, salvo writeStateAtomic.
// - cookies: las que casan con la allowlist (cookieAllowed) y no han caducado (expires en segundos; -1 o 0 = de
//   sesión, que no caduca).
// - origins: los que casan exactos con un patrón (esquema, host y puerto).
// - write-back (sesión exclusiva): el vault sin lo que casa con la allowlist, más lo filtrado de la copia del run. lo
//   de otros dominios que el run haya podido recoger nunca entra en el vault, y lo del vault fuera de la allowlist
//   (otro sitio de la misma sesión) se queda como estaba.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { cookieAllowed, originAllowed, type OriginPattern } from './origins.js';

export interface StateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  // segundos epoch; -1 = cookie de sesión.
  expires: number;
  [field: string]: unknown;
}

export interface StateOrigin {
  origin: string;
  [field: string]: unknown;
}

export interface StorageState {
  cookies: StateCookie[];
  origins: StateOrigin[];
}

const STATE_FILE_MODE = 0o600;
const TMP_RANDOM_BYTES = 4;
const MS_PER_S = 1000;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCookie = (c: unknown): c is StateCookie =>
  isObj(c) && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && typeof c.path === 'string' && typeof c.expires === 'number';
const isOrigin = (o: unknown): o is StateOrigin => isObj(o) && typeof o.origin === 'string';

/** el storage state de un fichero de odysea; lanza si no tiene su forma. */
export function parseStorageState(text: string): StorageState {
  const raw: unknown = JSON.parse(text);
  if (!isObj(raw) || !Array.isArray(raw.cookies) || !Array.isArray(raw.origins)) throw new Error('no es un storage state (cookies, origins)');
  if (!raw.cookies.every(isCookie)) throw new Error('una cookie sin name, value, domain, path o expires');
  if (!raw.origins.every(isOrigin)) throw new Error('un origen sin origin');
  return { cookies: raw.cookies, origins: raw.origins };
}

/** la cookie caducó antes de `nowMs` (una de sesión, nunca). */
export const isExpired = (c: StateCookie, nowMs: number): boolean => c.expires > 0 && c.expires * MS_PER_S <= nowMs;

const cookieIn = (patterns: readonly OriginPattern[]) => (c: StateCookie): boolean => cookieAllowed(c.domain, patterns);
const originIn = (patterns: readonly OriginPattern[]) => (o: StateOrigin): boolean => originAllowed(o.origin, patterns);

/** la copia de `state` que puede ver un run: solo la allowlist y sin cookies caducadas. */
export function filterState(state: StorageState, patterns: readonly OriginPattern[], nowMs: number): StorageState {
  return {
    cookies: state.cookies.filter((c) => cookieIn(patterns)(c) && !isExpired(c, nowMs)),
    origins: state.origins.filter(originIn(patterns)),
  };
}

/** el vault tras el run de una sesión exclusiva: lo suyo fuera de la allowlist, más lo filtrado de la copia del run. */
export function mergeBack(vault: StorageState, run: StorageState, patterns: readonly OriginPattern[], nowMs: number): StorageState {
  const fromRun = filterState(run, patterns, nowMs);
  return {
    cookies: [...vault.cookies.filter((c) => !cookieIn(patterns)(c)), ...fromRun.cookies],
    origins: [...vault.origins.filter((o) => !originIn(patterns)(o)), ...fromRun.origins],
  };
}

/** escribe un storage state atómico (tmp `wx` 0600 en el mismo dir + rename): un lector nunca ve uno a medias. */
export function writeStateAtomic(file: string, state: StorageState): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(TMP_RANDOM_BYTES).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: STATE_FILE_MODE, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
