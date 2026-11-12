// el binario de un cli de agente (t#440 P6): dónde lo encuentra el PATH (como execvp) y su sha256, que con la versión y
// el sistema identifica qué se midió. la evidencia de conformidad vale para ESE binario: otro build con la misma versión
// es otra medida.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// fallos de acceso que significan «no está aquí».
const NOT_HERE: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP']);

// ¿es `file` un fichero ejecutable?
function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (err) {
    if (NOT_HERE.has((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

/** la ruta de `command` en el PATH de `env` (o la ruta tal cual si lleva `/`), o null si no está. */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes(path.sep)) return executable(command) ? path.resolve(command) : null;
  const found = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => path.join(dir, command))
    .find(executable);
  return found ?? null;
}

/** sha256 (hex) del binario al que apunta `file`, siguiendo symlinks. */
export function binarySha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    fs.createReadStream(fs.realpathSync.native(file))
      .on('data', (chunk) => hash.update(chunk))
      .on('error', (err) => reject(new Error(`no se pudo leer el binario ${file}: ${err.message}`)))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
