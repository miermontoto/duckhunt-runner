// enmascarado de secretos en todo lo que el daemon sube al feed de progreso. espejo de
// SECRET_MASK_PATTERNS del server (que vuelve a enmascarar al guardar): defensa en profundidad,
// el texto no debería salir de la máquina con un secreto dentro ni un instante.

export const SECRET_MASK = '***';

// todas con /g: úsalas SOLO con String.replace (.test() arrastraría lastIndex entre llamadas).
const SECRET_MASK_PATTERNS: readonly RegExp[] = [
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
  // asignaciones genéricas (DB_PASSWORD=…, api_key: …, "token": "…"): se enmascara la clave y su valor.
  /(?<![A-Za-z0-9])(?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?[^\s"',;]+/gi,
];

/** sustituye cada secreto reconocible por `***`. aplícalo ANTES de recortar el texto. */
export function maskSecrets(text: string): string {
  return SECRET_MASK_PATTERNS.reduce((acc, re) => acc.replace(re, SECRET_MASK), text);
}
