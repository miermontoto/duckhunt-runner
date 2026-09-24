// versión del daemon (la de su package.json). viaja en el claim para que /settings/agents la
// muestre junto a la de claude, y la imprimen `--version` y `status`.

import fs from 'node:fs';

// dist/version.js → ../package.json: el package.json va siempre en el paquete publicado.
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

let cached: string | null | undefined;

/** versión semver del daemon, o null si el package.json no se puede leer (build suelto). */
export function runnerVersion(): string | null {
  if (cached !== undefined) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_URL, 'utf-8')) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : null;
  } catch (err) {
    console.error(`[runner] no se pudo leer la versión del daemon: ${(err as Error).message}`);
    cached = null;
  }
  return cached;
}
