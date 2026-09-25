// reglas Bash del allow de los settings de USUARIO de claude, espejadas al deny de un prompt run de
// lectura. read carga esos settings (`--setting-sources user`) y desde t#385 ya no niega Bash entero:
// un `Bash(npm run test:*)` del allow del usuario ejecutaría código de un checkout que puede haber
// empujado cualquiera. deny gana a allow, así que espejarlas las anula sin tocar el fichero.
// fail-closed: settings ilegibles, que no son json o con una regla que no cabe en argv → Bash entero
// al deny (la lectura se queda sin shell, como antes de t#385). fuera de alcance: los managed
// settings del sistema (los fija un administrador, no el checkout).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_TOOL, isToolId } from './claim.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** deny que anula las reglas Bash de `permissions.allow`; alguna no pasable por argv → Bash entero. */
export function mirrorBashAllow(settings: unknown): string[] {
  const allow = isObj(settings) && isObj(settings.permissions) && Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  const bash = allow.filter((r): r is string => typeof r === 'string' && (r === BASH_TOOL || r.startsWith(`${BASH_TOOL}(`)));
  return bash.every(isToolId) ? bash : [BASH_TOOL];
}

/** deny extra de un prompt run de lectura: las reglas Bash del settings.json de usuario, espejadas. */
export function userBashDeny(): string[] {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error(`[runner] no se pueden leer los settings de usuario (${file}): ${(err as Error).message}; lectura sin shell`);
    return [BASH_TOOL];
  }
  try {
    return mirrorBashAllow(JSON.parse(raw));
  } catch (err) {
    console.error(`[runner] los settings de usuario no son json (${file}): ${(err as Error).message}; lectura sin shell`);
    return [BASH_TOOL];
  }
}
