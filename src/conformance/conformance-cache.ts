// la caché del arnés de conformidad (t#440 P6): un registro por backend, versión del cli, sha256 de su binario, sistema y
// arnés, en <runnerHome>/conformance/<backend>/. la medida es cara (un cli por sonda) y solo cambia si cambia algo de
// eso: un registro guardado vale mientras su clave sea idéntica.
// decisiones:
// - el arnés entra en la clave: la versión del runner y un hash de sus sondas (incluido el código de sus guiones y
//   comprobaciones). cambiar una sonda deja la medida vieja sin efecto.
// - un registro ilegible, de otro formato o de otra clave es como no tener: se vuelve a medir.
// - el directorio es 0700 y el fichero 0600 (cuenta qué protege y qué no esta máquina), escrito atómico.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runnerHome } from '../config.js';
import { runnerVersion } from '../version.js';
import type { ConformanceBackend } from './conformance-backend.js';
import { RECORD_VERSION, type ConformanceRecord } from './run-conformance.js';

const CACHE_SUBDIR = 'conformance';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const KEY_HASH_CHARS = 16;
const PROBES_HASH_CHARS = 12;
const UNKNOWN_VERSION = 'unknown';

/** lo que identifica una medida (ver cabecera). */
export interface ConformanceKey {
  backend: string;
  version: string;
  sha256: string;
  os: string;
  harness: string;
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/** el sistema de la medida: plataforma y arquitectura. */
export const hostOs = (): string => `${process.platform}-${process.arch}`;

/** el arnés que mide (ver cabecera): versión del runner + hash de las sondas del backend. */
export function harnessId(backend: Pick<ConformanceBackend, 'probes'>): string {
  const probes = backend.probes.map((p) => ({
    id: p.id,
    gap: p.gap,
    attestations: p.attestations,
    platforms: p.platforms ?? null,
    run: p.run,
    script: p.script.toString(),
    controls: p.controls.toString(),
    checks: p.checks.toString(),
  }));
  return `${runnerVersion() ?? UNKNOWN_VERSION}+${sha256(JSON.stringify(probes)).slice(0, PROBES_HASH_CHARS)}`;
}

/** el fichero de la medida de `key`. */
export const cachePath = (key: ConformanceKey): string => path.join(runnerHome(), CACHE_SUBDIR, key.backend, `${sha256(JSON.stringify(key)).slice(0, KEY_HASH_CHARS)}.json`);

const sameKey = (r: ConformanceRecord, key: ConformanceKey): boolean =>
  r.backend === key.backend && r.cli.version === key.version && r.cli.sha256 === key.sha256 && r.os === key.os && r.harness === key.harness;

/** la medida guardada de `key`, o null (ver cabecera). */
export function readCached(key: ConformanceKey): ConformanceRecord | null {
  const file = cachePath(key);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[conformance] la medida guardada en ${file} no se puede leer: ${(err as Error).message}; se vuelve a medir`);
    return null;
  }
  const r = raw as ConformanceRecord | null;
  const valid = r !== null && typeof r === 'object' && r.v === RECORD_VERSION && typeof r.cli === 'object' && Array.isArray(r.results) && Array.isArray(r.attestations) && sameKey(r, key);
  return valid ? r : null;
}

/** guarda la medida de `key` (ver cabecera) y devuelve su fichero. */
export function writeCached(key: ConformanceKey, record: ConformanceRecord): string {
  const file = cachePath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  return file;
}
