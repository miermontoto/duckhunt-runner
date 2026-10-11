// mcp-config de cada segmento: lleva el token per-run en la cabecera Authorization y, con slots en
// paralelo, conviven los de varios runs (uno en edición incluido). hasta 0.10.1 iban a os.tmpdir():
// el server niega Read(//tmp/duckhunt-runner-*), pero en macos el tmpdir es otro y la tool Read de un
// run de lectura alcanzaba el token de otro run. desde 0.10.2 viven en <runnerHome>/run-config/ (0700,
// config.ts::runConfigDir; ficheros 0600 creados en exclusiva), se borran al cerrar el segmento y, al
// arrancar el daemon (con su lock tomado, ningún run en vuelo), los que dejó uno que murió. todo kit,
// de lectura y de edición, niega Read de ese directorio por su ruta y por su realpath (el de js y el
// nativo, que solo difieren con un `..` tras un symlink; claude-args.ts::runConfigDeny): el cli carga su --mcp-config igual, la tool Read no lo abre
// (verificado con el cli 2.1.296). ningún cwd de run cae dentro (el scratch es un hermano) y la shell
// de lectura no sale de su cwd. la regla del server sobre /tmp se queda: es inocua.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isToolId, type ClaimResponse } from './claim.js';
import { runConfigDir } from './config.js';

const MCP_CONFIG_PREFIX = 'mcp-';
const MCP_CONFIG_SUFFIX = '.json';
const MCP_CONFIG_MODE = 0o600;
const MCP_CONFIG_RANDOM_BYTES = 4;
// lo que una regla de permisos de claude no expresa tal cual: separadores de --disallowedTools,
// paréntesis de la regla y comodines o escapes del glob. una ruta así dejaría el deny sin efecto.
const RULE_UNSAFE_RE = /[,()*?[\]{}\\\n\r]/;

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

/** escribe el mcp-config de un segmento (0600, en exclusiva) y devuelve su ruta. */
export function writeRunMcpConfig(runId: number, mcp: ClaimResponse['mcp']): string {
  const name = `${MCP_CONFIG_PREFIX}${runId}-${crypto.randomBytes(MCP_CONFIG_RANDOM_BYTES).toString('hex')}${MCP_CONFIG_SUFFIX}`;
  const file = path.join(runConfigDir(), name);
  const config = { mcpServers: { [mcp.serverName]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } };
  // wx: nunca reutiliza ni sigue nada que ya estuviera en esa ruta.
  fs.writeFileSync(file, JSON.stringify(config), { mode: MCP_CONFIG_MODE, flag: 'wx' });
  return file;
}

/** borra los mcp-configs que dejó un daemon anterior. solo al arrancar, con el lock del daemon tomado. devuelve cuántos. */
export function clearRunMcpConfigs(): number {
  const dir = runConfigDir();
  const stale = fs.readdirSync(dir).filter((name) => name.startsWith(MCP_CONFIG_PREFIX) && name.endsWith(MCP_CONFIG_SUFFIX));
  stale.forEach((name) => fs.rmSync(path.join(dir, name), { force: true }));
  return stale.length;
}
