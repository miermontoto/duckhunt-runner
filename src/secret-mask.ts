// enmascarado de secretos en todo lo que el daemon sube al feed de progreso. espejo de
// SECRET_MASK_PATTERNS del server (que vuelve a enmascarar al guardar): defensa en profundidad,
// el texto no debería salir de la máquina con un secreto dentro ni un instante.

export const SECRET_MASK = '***';

// todas con /g: úsalas SOLO con String.replace (.test() arrastraría lastIndex entre llamadas).
// formatos de token reconocibles: los comparten el feed y el diff de cada turno (t#514).
const SECRET_MASK_TOKEN_PATTERNS: readonly RegExp[] = [
  // aws access key id (largo plazo AKIA / temporal ASIA) y secretos en formato credentials/env.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi,
  // github (classic ghp_/gho_/ghu_/ghs_/ghr_ y fine-grained github_pat_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // slack (xoxb-, xoxp-, xoxa-, xoxo-, xoxs-, xoxr-).
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // tokens propios de duckhunt (dha_ respuesta, dhw_ widget, dho_/dhr_ mcp, dhc_ code, dhi_ investigar).
  /\bdh[acioprw]_[A-Za-z0-9_-]{16,}/g,
  // cabecera Authorization pegada en un comando (curl -H "Authorization: Bearer …").
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // bloque de clave privada pegado en la prosa.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // credenciales en la url de un remoto (git push https://usuario:token@bitbucket.org/…): el userinfo entero.
  /(?<=:\/\/)[^/\s:@]+:[^@\s/]+(?=@)/g,
  // atlassian (api token ATATT…), bitbucket (app password ATBB…) y anthropic (sk-ant-…).
  /\bATATT[A-Za-z0-9_=-]{20,}/g,
  /\bATBB[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
];
const SECRET_MASK_PATTERNS: readonly RegExp[] = [
  ...SECRET_MASK_TOKEN_PATTERNS,
  // asignaciones genéricas (DB_PASSWORD=…, api_key: …, "token": "…"): se enmascara la clave y su valor.
  /(?<![A-Za-z0-9])(?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?[^\s"',;]+/gi,
];
// el diff de un turno (t#514) es código: la asignación genérica destrozaría `password: string` o
// `token = getToken()`. en un fichero de código, además de los formatos de token, solo se enmascara una asignación a
// un literal entre comillas (de cualquier largo; sin cerrar, hasta el final de la línea) o una línea de .env
// (`DB_PASSWORD=x`, con el prefijo +/-/espacio del diff, sangría, un `- ` de lista o un `export` delante, que se
// conservan), cuando el identificador lleva una palabra de secreto (KEY_RE: `secretKey`, `SECRET_KEY`, `api_token`).
// solo los hunks de un fichero de código (CODE_FILE_RE) se libran del enmascarado entero del feed: en cualquier otro
// (.yml, .env, un script de shell, un .md, uno sin extensión) `password: hunter2` o `--password=hunter2` sin comillas
// es un secreto, y la cabecera del trozo (rutas, renombrados, `---`/`+++`) no es código. todo lineal: identificadores
// acotados, sin lookbehinds de largo variable y la línea de .env anclada a su principio (un diff trae líneas enormes).
// espejo de los SECRET_MASK_* del server.
// asignación de un literal: identificador, con guiones (`x-api-key`) pero empezando por una letra o un dígito (el `-` de
// una línea quitada del diff se conserva), (que se mira con KEY_RE) + `=`/`:` + el literal.
const LITERAL_RE = /(?<![A-Za-z0-9_])([A-Za-z0-9_][A-Za-z0-9_-]{0,127})["']?[ \t]*[=:][ \t]*(?:"[^"\n]+(?:"|(?=\n)|$)|'[^'\n]+(?:'|(?=\n)|$)|`[^`\n]+(?:`|(?=\n)|$))/g;
// línea de un .env: prefijo (que se conserva) + clave (que se mira con KEY_RE) + `=` + valor.
const ENV_LINE_RE = /^([+\- ]?[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?)([A-Za-z0-9_]{1,128})[ \t]*=[ \t]*\S+/gm;
// sin /g: se usa con .test().
const KEY_RE = /password|passwd|secret|token|api[_-]?key/i;
// extensiones de código, al final de una ruta (también entre las comillas de git). el enmascarado ligero es la
// excepción: hace falta que las DOS rutas de la cabecera `diff --git a/<vieja> b/<nueva>` acaben en una (un renombrado
// desde un .yml trae sus líneas quitadas). los scripts de shell no están: llevan credenciales en línea
// (`mysql --password=x`). ante la duda gana el enmascarado entero: un falso positivo solo enmascara de más.
const CODE_FILE_RE = /\.(?:c|cc|cjs|cpp|cs|cts|cxx|dart|ex|exs|fs|go|gql|graphql|h|hpp|java|js|jsx|kt|kts|m|mjs|mm|mts|php|proto|py|rb|rs|scala|svelte|swift|ts|tsx|vue)"?$/i;
const DIFF_FILE_HEADER = 'diff --git ';
// dónde empieza la ruta nueva en la cabecera, sin y con las comillas de git
const DIFF_NEW_PATH_SEPARATORS: readonly string[] = [' b/', ' "b/'];
// el primer hunk de un trozo: lo de antes (cabecera, index, rename, `---`/`+++`) son rutas, no código
const DIFF_HUNK_START = '\n@@';

// las dos rutas de la cabecera son de código. si una ruta lleva un separador dentro (`a/x b/y.ts`), la partición es
// ambigua y no lo es
function isCodeDiff(header: string): boolean {
  const paths = header.slice(DIFF_FILE_HEADER.length);
  const cuts = DIFF_NEW_PATH_SEPARATORS.map((sep) => [paths.indexOf(sep), paths.lastIndexOf(sep)] as const).filter(([first]) => first >= 0);
  if (cuts.length !== 1 || cuts[0]![0] !== cuts[0]![1]) return false;
  const cut = cuts[0]![0];
  return CODE_FILE_RE.test(paths.slice(0, cut)) && CODE_FILE_RE.test(paths.slice(cut + 1));
}

/** sustituye cada secreto reconocible por `***`. aplícalo ANTES de recortar el texto. */
export function maskSecrets(text: string): string {
  return SECRET_MASK_PATTERNS.reduce((acc, re) => acc.replace(re, SECRET_MASK), text);
}

/** lo mismo para el diff de un turno (t#514): sin destrozar el código (formatos de token + literales y .env). */
export function maskDiffSecrets(text: string): string {
  const secretKey = (m: string, key: string, prefix = ''): string => (KEY_RE.test(key) ? `${prefix}${SECRET_MASK}` : m);
  return SECRET_MASK_TOKEN_PATTERNS.reduce((acc, re) => acc.replace(re, SECRET_MASK), text)
    .replace(LITERAL_RE, (m, key: string) => secretKey(m, key))
    .replace(ENV_LINE_RE, (m, prefix: string, key: string) => secretKey(m, key, prefix));
}

/** los dos enmascarados: para lo que no es código (configuración, rutas, lo que no se sabe qué es). */
export function maskDiffText(text: string): string {
  return maskDiffSecrets(maskSecrets(text));
}

/** el trozo de UN fichero de un diff (desde su `diff --git`): solo los hunks de un fichero de código van con el
 * enmascarado del diff; su cabecera, cualquier otro fichero y lo que no se sabe qué es, con los dos. */
export function maskDiffChunk(chunk: string): string {
  const header = chunk.split('\n', 1)[0]!;
  const hunks = chunk.indexOf(DIFF_HUNK_START);
  if (!header.startsWith(DIFF_FILE_HEADER) || hunks < 0 || !isCodeDiff(header)) return maskDiffText(chunk);
  return maskDiffText(chunk.slice(0, hunks)) + maskDiffSecrets(chunk.slice(hunks));
}
