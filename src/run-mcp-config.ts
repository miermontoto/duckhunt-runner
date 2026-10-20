// mcp-config de cada segmento: lleva el token per-run en la cabecera Authorization y, con slots en
// paralelo, conviven los de varios runs (uno en edición incluido). hasta 0.10.1 iban a os.tmpdir():
// el server niega Read(//tmp/duckhunt-runner-*), pero en macos el tmpdir es otro y la tool Read de un
// run de lectura alcanzaba el token de otro run. desde 0.10.2 viven en <runnerHome>/run-config/ (0700,
// paths.ts::runConfigDir, uno por plataforma desde t#495; ficheros 0600 creados en exclusiva), se borran al cerrar el segmento y, al
// arrancar el daemon (con su lock tomado, ningún run en vuelo), los que dejó uno que murió. todo kit,
// de lectura y de edición, niega Read de ese directorio por su ruta y por su realpath (el de js y el
// nativo, que solo difieren con un `..` tras un symlink; claude-args.ts::runConfigDeny): el cli carga su --mcp-config igual, la tool Read no lo abre
// (verificado con el cli 2.1.296). ningún cwd de run cae dentro (el scratch es un hermano) y la shell
// de lectura no sale de su cwd. la regla del server sobre /tmp se queda: es inocua.
// t#495 (M1): cada plataforma tiene su run-config (paths.ts) y el deny de todo kit cubre el de TODAS las que
// tienen estado en disco (paths.ts::allRunConfigDirs): el run de una no lee los tokens per-run de otra.
// 0.11.0: al arrancar también se barren UNA vez los que dejaron en os.tmpdir() los daemons < 0.10.2
// (duckhunt-runner-<run>-<hex>.json, del mismo usuario y ficheros normales): un daemon que murió a mitad
// de run dejaba ahí su token per-run. non-goal: otro daemon viejo del mismo usuario en marcha a la vez
// pierde el fichero del run en curso (su claude ya lo cargó al arrancar el segmento).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isToolId, type McpServer } from './claim.js';
import { runConfigDir } from './paths.js';
import type { McpServerEntry } from './resources/types.js';

const MCP_CONFIG_PREFIX = 'mcp-';
const MCP_CONFIG_SUFFIX = '.json';
const MCP_CONFIG_MODE = 0o600;
const MCP_CONFIG_RANDOM_BYTES = 4;
// nombre de los mcp-config de los daemons < 0.10.2 en os.tmpdir().
const LEGACY_TMP_CONFIG_RE = /^duckhunt-runner-\d+-[0-9a-f]{8}\.json$/;
// lo que una regla de permisos de claude no expresa tal cual: separadores de --disallowedTools,
// paréntesis de la regla y comodines o escapes del glob. una ruta así dejaría el deny sin efecto.
const RULE_UNSAFE_RE = /[,()*?[\]{}\\\n\r]/;

/** regla `Read(//ruta)` (con `/**` si es un directorio) de una ruta absoluta, o null si no cabe en una regla de claude. */
export function readDenyRule(abs: string, dir: boolean): string | null {
  const rule = `Read(/${abs}${dir ? '/**' : ''})`;
  return path.isAbsolute(abs) && !RULE_UNSAFE_RE.test(abs) && isToolId(rule) ? rule : null;
}

/** deny de Read del directorio de mcp-configs (su ruta y su realpath, el de js y el nativo). lanza si no cabe en una regla: sin él no se lanza ningún run. */
export function runConfigDeny(dir: string): string[] {
  const paths = Array.from(new Set([path.resolve(dir), fs.realpathSync(dir), fs.realpathSync.native(dir)]));
  const rules = paths.map((p) => `Read(/${p}/**)`);
  const bad = paths.find((p, i) => RULE_UNSAFE_RE.test(p) || !isToolId(rules[i]!));
  if (bad !== undefined) {
    throw new Error(`el directorio de configs de run (${bad}) no cabe en una regla de permisos de claude (comas, paréntesis, comodines o demasiado largo): usa otro DUCKHUNT_RUNNER_HOME`);
  }
  return rules;
}

// la entrada de un servidor mcp de la plataforma con su token per-run.
const mcpEntry = (mcp: McpServer): [string, object] => [mcp.serverName, { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } }];

/** escribe el mcp-config de un segmento (0600, en exclusiva) y devuelve su ruta. `extra`: los servidores de la
 *  plataforma además del primero (mcpServers[] del cable v0; el legacy solo tiene uno). `resources`: los de los
 *  recursos del run (res_<tipo>_<clave>, t#495 M7), detrás de los de la plataforma; sin ellos, el fichero de siempre. */
export function writeRunMcpConfig(
  runId: string,
  mcp: McpServer,
  platform: string,
  extra: readonly McpServer[] = [],
  resources: Readonly<Record<string, McpServerEntry>> = {},
): string {
  const name = `${MCP_CONFIG_PREFIX}${runId}-${crypto.randomBytes(MCP_CONFIG_RANDOM_BYTES).toString('hex')}${MCP_CONFIG_SUFFIX}`;
  const file = path.join(runConfigDir(platform), name);
  const config = { mcpServers: { ...Object.fromEntries([mcp, ...extra].map(mcpEntry)), ...resources } };
  // wx: nunca reutiliza ni sigue nada que ya estuviera en esa ruta.
  fs.writeFileSync(file, JSON.stringify(config), { mode: MCP_CONFIG_MODE, flag: 'wx' });
  return file;
}

/** borra los mcp-configs que dejó un daemon anterior. solo al arrancar, con el lock del daemon tomado. devuelve cuántos. */
export function clearRunMcpConfigs(platform: string): number {
  const dir = runConfigDir(platform);
  const stale = fs.readdirSync(dir).filter((name) => name.startsWith(MCP_CONFIG_PREFIX) && name.endsWith(MCP_CONFIG_SUFFIX));
  stale.forEach((name) => fs.rmSync(path.join(dir, name), { force: true }));
  return stale.length;
}

/**
 * borra los mcp-config que dejaron en `tmp` los daemons < 0.10.2 (ver cabecera): solo ficheros normales
 * del usuario que arranca. al arrancar, con el lock del daemon tomado. devuelve cuántos.
 */
export function clearLegacyTmpConfigs(tmp: string = os.tmpdir(), uid: number | undefined = process.getuid?.()): number {
  const stale = fs.readdirSync(tmp).filter((name) => {
    if (!LEGACY_TMP_CONFIG_RE.test(name)) return false;
    try {
      const st = fs.lstatSync(path.join(tmp, name));
      return st.isFile() && (uid === undefined || st.uid === uid);
    } catch (err) {
      // desapareció entre el listado y el stat (otro proceso lo borró): nada que barrer.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  });
  stale.forEach((name) => fs.rmSync(path.join(tmp, name), { force: true }));
  return stale.length;
}
