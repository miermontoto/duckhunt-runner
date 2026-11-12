// el `claude` falso de las pruebas (t#440 P0): un solo preámbulo para todas y el cuerpo de cada prueba detrás.
// el preámbulo contesta --version y --help como el cli de verdad (todos los flags opcionales), y deja a mano `args`,
// `out` (una línea de stream-json), `mcpFile` (el --mcp-config que recibe, o null) y `caseDirOf` (el primer padre de
// un path con runner.json: el directorio del caso). lo que el proceso contesta lo decide el cuerpo: sin red ni modelo.
// decisiones:
// - el shebang es el node que corre la prueba, no `env node`: el PATH del caso puede no tenerlo.
// - el cuerpo es javascript commonjs en texto: el fichero es un ejecutable suelto, sin el loader de las pruebas.

import fs from 'node:fs';
import path from 'node:path';
import { OPTIONAL_FLAGS } from '../../src/claude.js';

/** lo que el falso contesta a --version (un cli que ya tiene todo flag opcional). */
export const FAKE_CLAUDE_VERSION = '9.9.9 (Claude Code)';

const PRELUDE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(FAKE_CLAUDE_VERSION)}); process.exit(0); }
if (args[0] === '--help') { console.log(${JSON.stringify(OPTIONAL_FLAGS.join('\n'))}); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const mcpFile = args.includes('--mcp-config') ? args[args.indexOf('--mcp-config') + 1] : null;
const caseDirOf = (from) => {
  let d = path.dirname(from);
  while (!fs.existsSync(path.join(d, 'runner.json')) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
};
`;

/** escribe `<bin>/claude`: el preámbulo común y `body` (commonjs) detrás. devuelve su path. */
export function writeFakeClaude(bin: string, body: string): string {
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `${PRELUDE}${body}`, { mode: 0o755 });
  return file;
}

/** cuerpo que escribe tal cual unas líneas de stream-json y sale con 0. */
export const replayBody = (lines: readonly unknown[]): string => `${JSON.stringify(lines)}.forEach(out);\n`;
