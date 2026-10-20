// orígenes de una sesión de navegador (t#495, M7): los patrones `scheme://host[:port]` de su allowlist, con la misma
// sintaxis que ODYSEA_ALLOWED_ORIGINS (odysea/src/origins.ts) para validar la config y filtrar la copia por run sin
// depender de odysea. puro.
// - `*.` delante del host admite una o más etiquetas de subdominio, nunca el apex, y necesita al menos dos etiquetas
//   debajo (`*.net` no vale). sin puerto vale el del esquema, como un origin.
// - una entrada de localStorage / IndexedDB (por origen) solo va si su origen casa con un patrón: esquema, host y
//   puerto.
// - una cookie (por dominio, sin esquema ni puerto) va si su dominio cae dentro del host de un patrón (el mismo o un
//   subdominio; con comodín, solo un subdominio: el apex no es navegable), o si es una cookie de dominio (con punto
//   delante) de un padre de un host permitido: el navegador la manda también a ese host y suele ser la de la
//   sesión. esa misma cookie va también a los hermanos del host, por eso la allowlist de odysea bloquea navegarlos.

export interface OriginPattern {
  scheme: string;
  host: string;
  wildcard: boolean;
  // '' = el puerto por defecto del esquema (como URL.port).
  port: string;
}

const PATTERN_RE = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/i;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };
const NAVIGABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
const MAX_PORT = 65_535;
const MIN_WILDCARD_BASE_LABELS = 2;
const WILDCARD_PREFIX = '*.';
const DOMAIN_COOKIE_PREFIX = '.';

// el puerto por defecto escrito explícito (https://x:443) es el mismo origen que sin puerto.
const normPort = (scheme: string, port: string): string => (port === DEFAULT_PORTS[scheme] ? '' : port);

/** un patrón de la allowlist; lanza con un mensaje para la cli o la config. */
export function parseOriginPattern(raw: string): OriginPattern {
  const m = PATTERN_RE.exec(raw);
  if (!m) throw new Error(`origen "${raw}" no válido: http(s)://host[:puerto] o http(s)://*.dominio`);
  const [, proto, star, host, port = ''] = m;
  if (Number(port) > MAX_PORT) throw new Error(`puerto no válido en el origen "${raw}"`);
  if (star && host!.split('.').length < MIN_WILDCARD_BASE_LABELS) {
    throw new Error(`origen "${raw}" demasiado amplio: un comodín necesita al menos ${MIN_WILDCARD_BASE_LABELS} etiquetas tras *.`);
  }
  const scheme = `${proto!.toLowerCase()}:`;
  return { scheme, host: host!.toLowerCase(), wildcard: Boolean(star), port: normPort(scheme, port) };
}

/** el patrón como se escribe (para ODYSEA_ALLOWED_ORIGINS y la cli). */
export const describePattern = (p: OriginPattern): string => `${p.scheme}//${p.wildcard ? WILDCARD_PREFIX : ''}${p.host}${p.port ? `:${p.port}` : ''}`;

/** el origen `scheme://host[:port]` de una url http(s), o null. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return NAVIGABLE_SCHEMES.has(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

const hostMatches = (p: OriginPattern, host: string): boolean => (p.wildcard ? host.endsWith(`.${p.host}`) : host === p.host);

/** el origen (o una url) casa con algún patrón: mismo esquema, mismo puerto y el host (o un subdominio, con comodín). */
export function originAllowed(origin: string, patterns: readonly OriginPattern[]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return NAVIGABLE_SCHEMES.has(u.protocol) && patterns.some((p) => p.scheme === u.protocol && p.port === u.port && hostMatches(p, u.hostname));
}

/** una cookie del dominio `domain` (con punto delante = cookie de dominio) va en la copia (ver cabecera). */
export function cookieAllowed(domain: string, patterns: readonly OriginPattern[]): boolean {
  const domainCookie = domain.startsWith(DOMAIN_COOKIE_PREFIX);
  const bare = (domainCookie ? domain.slice(DOMAIN_COOKIE_PREFIX.length) : domain).toLowerCase();
  if (!bare) return false;
  return patterns.some((p) => {
    const inside = p.wildcard ? bare.endsWith(`.${p.host}`) : bare === p.host || bare.endsWith(`.${p.host}`);
    // un padre del host permitido (con comodín, el apex también lo es: sus subdominios son los permitidos).
    const parent = domainCookie && ((p.wildcard && p.host === bare) || p.host.endsWith(`.${bare}`));
    return inside || parent;
  });
}
