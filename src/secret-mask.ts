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
// un fichero de configuración (CONFIG_FILE_RE) lleva además el enmascarado entero del feed: ahí `password: hunter2`
// sin comillas es un secreto. todo lineal: identificadores acotados, sin lookbehinds de largo variable y la línea de
// .env anclada a su principio (un diff trae líneas enormes). espejo de los SECRET_MASK_* del server.
// asignación de un literal: identificador, con guiones (`x-api-key`) pero empezando por una letra o un dígito (el `-` de
// una línea quitada del diff se conserva), (que se mira con KEY_RE) + `=`/`:` + el literal.
const LITERAL_RE = /(?<![A-Za-z0-9_])([A-Za-z0-9_][A-Za-z0-9_-]{0,127})["']?[ \t]*[=:][ \t]*(?:"[^"\n]+(?:"|(?=\n)|$)|'[^'\n]+(?:'|(?=\n)|$)|`[^`\n]+(?:`|(?=\n)|$))/g;
// línea de un .env: prefijo (que se conserva) + clave (que se mira con KEY_RE) + `=` + valor.
const ENV_LINE_RE = /^([+\- ]?[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?)([A-Za-z0-9_]{1,128})[ \t]*=[ \t]*\S+/gm;
// sin /g: se usa con .test().
const KEY_RE = /password|passwd|secret|token|api[_-]?key/i;
// un nombre de fichero de configuración en la cabecera `diff --git a/<vieja> b/<nueva>` de un trozo: vale cualquiera
// de las dos rutas (un renombrado desde un .yml trae sus líneas quitadas) y también entre las comillas de git. ante la
// duda gana el enmascarado entero: un falso positivo solo enmascara de más.
const CONFIG_FILE_RE = /(?:^|[/\s"])(?:\.env[^/\s"]*|Dockerfile[^/\s"]*|[^/\s"]+\.(?:ya?ml|env|properties|ini|toml|cfg|conf))(?=[\s"]|$)/i;
const DIFF_FILE_HEADER = 'diff --git ';

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

/** el trozo de UN fichero de un diff (desde su `diff --git`): la configuración, o lo que no se sabe qué es, con los dos. */
export function maskDiffChunk(chunk: string): string {
  const header = chunk.split('\n', 1)[0]!;
  return header.startsWith(DIFF_FILE_HEADER) && !CONFIG_FILE_RE.test(header) ? maskDiffSecrets(chunk) : maskDiffSecrets(maskSecrets(chunk));
}
