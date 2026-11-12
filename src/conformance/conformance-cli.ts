// `duckhunt-runner conformance <backend>` (t#440 P6): mide, sin modelo de verdad ni tokens, qué garantías de seguridad
// cumple el cli de agente instalado, con las mismas listas, flags y ficheros con que el daemon lanza sus runs. busca el
// cli en el PATH, lo identifica (versión, sha256 del binario, sistema), reutiliza la medida guardada para esa clave o
// corre las sondas, la guarda y la imprime.
// decisiones:
// - la detección corre con un HOME temporal: ni `--version` ni `--help` tocan el ~ de verdad.
// - una medida parcial (--probe) ni se lee ni se guarda en la caché: la caché solo tiene medidas enteras.
// - exit 1 si alguna sonda es FAIL (garantía rota sin hueco conocido) o ERROR (no se pudo medir); un XFAIL (hueco
//   conocido abierto) o un XPASS no fallan el comando.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conformanceBackend, conformanceBackendIds } from './backend-registry.js';
import { binarySha256, resolveOnPath } from './cli-binary.js';
import { cachePath, harnessId, hostOs, readCached, writeCached, type ConformanceKey } from './conformance-cache.js';
import { hasProblems, reportLines } from './conformance-report.js';
import { runConformance } from './run-conformance.js';

/** exit codes de `conformance`. */
export const CONFORMANCE_EXIT = { ok: 0, problems: 1, usage: 64 } as const;

export const CONFORMANCE_USAGE = `uso: duckhunt-runner conformance <backend> [--refresh] [--json] [--keep] [--probe <id>]…
  mide sin modelo ni tokens qué garantías de seguridad cumple el cli de agente instalado (un proveedor de modelo
  guionizado en local y un HOME canario por sonda). la medida se guarda por versión, sha256 del binario y sistema.
  backends: ${conformanceBackendIds().join(', ')}
  --refresh   vuelve a medir aunque haya una medida guardada
  --json      el registro entero en json
  --keep      conserva el canario de cada sonda (para mirarlo a mano)
  --probe     solo esa sonda (repetible; no se guarda)
exit: 0 sin problemas · 1 alguna sonda FAIL o ERROR · 64 uso
`;

const FLAG = { refresh: '--refresh', json: '--json', keep: '--keep', probe: '--probe' } as const;
const DETECT_HOME_PREFIX = 'duckhunt-conformance-detect-';

interface Parsed {
  backend: string;
  refresh: boolean;
  json: boolean;
  keep: boolean;
  probes: string[];
}

// los argumentos, o el motivo de uso.
function parse(args: readonly string[]): Parsed | string {
  const probes = args.flatMap((a, i) => (args[i - 1] === FLAG.probe ? [a] : []));
  if (args.at(-1) === FLAG.probe) return `${FLAG.probe} sin sonda`;
  const known = new Set<string>(Object.values(FLAG));
  const positional = args.filter((a, i) => !known.has(a) && args[i - 1] !== FLAG.probe);
  const unknown = positional.filter((a) => a.startsWith('-'));
  if (unknown.length > 0) return `flag desconocido: ${unknown.join(' ')}`;
  if (positional.length !== 1) return 'falta el backend (uno)';
  return { backend: positional[0]!, refresh: args.includes(FLAG.refresh), json: args.includes(FLAG.json), keep: args.includes(FLAG.keep), probes };
}

/** corre el comando (ver cabecera) y devuelve su exit code. */
export async function conformanceCommand(args: readonly string[]): Promise<number> {
  const p = parse(args);
  if (typeof p === 'string') {
    console.error(`${p}\n\n${CONFORMANCE_USAGE}`);
    return CONFORMANCE_EXIT.usage;
  }
  const backend = conformanceBackend(p.backend);
  if (!backend) {
    console.error(`el arnés no sabe medir el backend ${p.backend} (sabe: ${conformanceBackendIds().join(', ')})`);
    return CONFORMANCE_EXIT.usage;
  }
  const binary = resolveOnPath(backend.command, process.env);
  if (binary === null) {
    console.error(`no se encuentra \`${backend.command}\` en el PATH: instálalo antes de medirlo`);
    return CONFORMANCE_EXIT.problems;
  }
  const detectHome = fs.mkdtempSync(path.join(os.tmpdir(), DETECT_HOME_PREFIX));
  const cli = await backend.detect({ PATH: process.env.PATH ?? '', HOME: detectHome, TMPDIR: detectHome }).finally(() => fs.rmSync(detectHome, { recursive: true, force: true }));
  if (cli === null) {
    console.error(`\`${backend.command}\` no arranca (--version): no se puede medir`);
    return CONFORMANCE_EXIT.problems;
  }
  const key: ConformanceKey = { backend: backend.id, version: cli.version, sha256: await binarySha256(binary), os: hostOs(), harness: harnessId(backend) };
  const partial = p.probes.length > 0;
  const cached = p.refresh || partial ? null : readCached(key);
  const record =
    cached ??
    (await runConformance({
      backend,
      cli,
      sha256: key.sha256,
      os: key.os,
      harness: key.harness,
      env: process.env,
      ...(partial ? { only: p.probes } : {}),
      keep: p.keep,
      onProbe: (o, keptAt) => console.error(`· ${o.id}: ${o.verdict}${keptAt ? ` (canario en ${keptAt})` : ''}`),
    }));
  if (cached === null && !partial) console.error(`medida guardada en ${writeCached(key, record)}`);
  else if (cached !== null) console.error(`medida guardada (${cachePath(key)})`);
  console.log(p.json ? JSON.stringify(record, null, 2) : reportLines(record, cached !== null).join('\n'));
  return hasProblems(record.results) ? CONFORMANCE_EXIT.problems : CONFORMANCE_EXIT.ok;
}
