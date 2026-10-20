// origen de una plataforma (t#495, M6.4): lo que se compara para que el code, el verifier, los tokens y los
// servidores mcp de un run no salgan del server de la plataforma. loopback (localhost, 127.0.0.0/8, ::1) es el
// entorno de desarrollo: solo ahí vale http.

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]']);
const LOOPBACK_V4_RE = /^127(\.\d{1,3}){3}$/;
const HTTPS = 'https:';
const HTTP = 'http:';

/** la url ya parseada, o null si no lo es. */
export function urlOf(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** localhost, 127.0.0.0/8 o ::1. */
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname) || LOOPBACK_V4_RE.test(hostname);

/** https, o http solo en loopback. */
export const isSecureOrLoopback = (u: URL): boolean => u.protocol === HTTPS || (u.protocol === HTTP && isLoopbackHost(u.hostname));

/** `raw` está en el mismo origen (esquema + host + puerto) que la plataforma de `baseUrl`, y esa plataforma sirve
 *  https (o es loopback). una plataforma remota nunca apunta así a otro host ni a un servicio de localhost. */
export function sameSecureOrigin(raw: string, baseUrl: string): boolean {
  const [u, base] = [urlOf(raw), urlOf(baseUrl)];
  return u !== null && base !== null && u.origin === base.origin && isSecureOrLoopback(base);
}
