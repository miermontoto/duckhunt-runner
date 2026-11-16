// índice de ficheros de los repos de una máquina: lo que el composer de /agents autocompleta tras `@` (el cli expande
// `@ruta` en cualquier punto del prompt, también por stdin en stream-json, y respeta los deny de Read del kit: verificado
// con claude 2.1.325). el daemon lo sube a POST /api/runner/repo-files, UN repo por petición y solo cuando cambia: no
// viaja en el claim, que va cada pocos segundos, y un repo grande pesa cientos de KB.
// decisiones:
// - la fuente es el checkout del mapa de la máquina (`git ls-files --cached --others --exclude-standard`: lo versionado y
//   lo nuevo sin ignorar), no el worktree de cada conversación: la landing y el hilo ven el mismo índice y un fichero que
//   solo existe en un conv-<id> no se sugiere (teclearlo a mano sigue funcionando).
// - se refresca al arrancar, al cerrar un segmento en ese repo y cada REPO_FILES_REFRESH_MS, y se sube con huella: sin
//   cambios no hay petición.
// - rutas relativas a la raíz del checkout con `/`, sin `./` ni `..`; los directorios no viajan (el server los deriva).
// - topes por repo: REPO_FILES_MAX rutas y un cuerpo json de REPO_FILES_BODY_MAX_BYTES (el server responde 413 por encima).
//   al recortar se queda primero lo menos profundo (luego por orden alfabético) y `truncated` lo dice. el server descarta
//   lo que no tiene forma ruta a ruta.
// - cada plataforma recibe solo los índices de los repos que ella misma anuncia en su claim.
// non-goals: el índice de cada worktree de conversación, contenido o tamaños de los ficheros, los repos adicionales de
// un run (--add-dir, t#597).

/** ruta del índice bajo /api/runner (cable legacy). */
export const RUNNER_REPO_FILES_PATH = '/repo-files';
// rutas por repo y bytes del cuerpo json de una subida.
export const REPO_FILES_MAX = 20_000;
export const REPO_FILES_BODY_MAX_BYTES = 2_000_000;
// una ruta más larga se descarta entera.
export const REPO_FILE_PATH_MAX_CHARS = 400;
// cada cuánto el daemon vuelve a listar los checkouts aunque no haya corrido nada en ellos (lo editado a mano).
export const REPO_FILES_REFRESH_MS = 10 * 60_000;

/** cuerpo de POST /api/runner/repo-files: el índice ENTERO de un repo (reemplaza al guardado de esa máquina). */
export interface RunnerRepoFiles {
  // repo en la grafía del mapa de la máquina (ws/slug).
  repo: string;
  files: string[];
  // se recortó por los topes.
  truncated: boolean;
}
