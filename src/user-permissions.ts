// reglas del allow de los settings de claude que carga un run, espejadas a su deny (deny gana a
// allow, así que espejarlas las anula sin tocar los ficheros).
// - prompt run de lectura (t#385): carga solo los settings de USUARIO (`--setting-sources user`) y ya
//   no niega Bash entero, así que un `Bash(npm run test:*)` de ese allow ejecutaría código de un
//   checkout que puede haber empujado cualquiera. tampoco niega ya Edit/Write enteras (t#434: sin
//   regla, solo alcanzan la memoria nativa del cli), así que un `Edit` o un `Write(src/**)` de ese
//   allow abriría el repo. se espejan Bash y las de escritura.
// - run de reglas (t#434): carga todas las fuentes (usuario, proyecto y local del checkout) y ya no
//   niega Edit/Write enteras, así que se espejan las de escritura de los tres. su Bash no: va entero en
//   el allow del run y espejar sus reglas negaría comandos que el run sí puede usar.
// fail-closed: settings ilegibles, que no son json o con una regla que no cabe en argv → esa tool
// entera al deny (la lectura se queda sin shell, y sin memoria si la que falla es de escritura).
// fuera de alcance: los managed settings del sistema (los fija un administrador, no el checkout).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_TOOL, isToolId } from './claim.js';

// built-in de escritura cuyo allow se espeja (las mismas que un run de lectura nunca puede permitir).
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];
// lo que se espeja en un prompt run de lectura: la shell y las de escritura.
export const READ_MIRRORED_TOOLS: readonly string[] = [BASH_TOOL, ...WRITE_TOOLS];

// settings de usuario de claude y los del proyecto, relativos al cwd del run.
const SETTINGS_FILE = 'settings.json';
const LOCAL_SETTINGS_FILE = 'settings.local.json';
const PROJECT_DIR = '.claude';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// tool a la que pertenece una regla (`Edit` o `Edit(src/**)` → Edit), o undefined.
const toolOf = (rule: string, tools: readonly string[]): string | undefined => tools.find((t) => rule === t || rule.startsWith(`${t}(`));

/** deny que anula las reglas de `tools` en `permissions.allow`; una regla que no cabe en argv → su tool entera. */
export function mirrorAllow(settings: unknown, tools: readonly string[]): string[] {
  const allow = isObj(settings) && isObj(settings.permissions) && Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  const rules = allow.filter((r): r is string => typeof r === 'string' && toolOf(r, tools) !== undefined);
  return Array.from(new Set(rules.map((r) => (isToolId(r) ? r : toolOf(r, tools)!))));
}

// reglas espejadas de un fichero de settings; sin fichero, nada; ilegible o no json, `tools` enteras.
function mirrorFile(file: string, tools: readonly string[]): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error(`[runner] no se pueden leer los settings de claude (${file}): ${(err as Error).message}; ${tools.join(', ')} negadas enteras`);
    return [...tools];
  }
  try {
    return mirrorAllow(JSON.parse(raw), tools);
  } catch (err) {
    console.error(`[runner] los settings de claude no son json (${file}): ${(err as Error).message}; ${tools.join(', ')} negadas enteras`);
    return [...tools];
  }
}

/**
 * settings que carga un run: el de usuario (CLAUDE_CONFIG_DIR o ~/.claude) siempre y, si no va con
 * `--setting-sources user`, los del proyecto y el local de su cwd.
 */
export function settingsFilesFor(cwd: string, userOnly: boolean): string[] {
  const user = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), SETTINGS_FILE);
  return userOnly ? [user] : [user, path.join(cwd, PROJECT_DIR, SETTINGS_FILE), path.join(cwd, PROJECT_DIR, LOCAL_SETTINGS_FILE)];
}

/** deny extra de un run: las reglas de `tools` del allow de cada settings que carga, espejadas. */
export function mirroredDeny(files: readonly string[], tools: readonly string[]): string[] {
  return Array.from(new Set(files.flatMap((file) => mirrorFile(file, tools))));
}
