// key workspace/slug de un repo a partir del url de su remote: la que el server usa en target_repo.repo
// y el daemon en su mapa de repos. la usan `repos discover` y el chequeo de salud (resources/repo/health.ts).
// github y bitbucket identifican el repo con los DOS PRIMEROS segmentos del path: un clone hecho con
// la url del navegador (…/okticket/new-boilerplate/src/main/) derivaba "src/main" con los dos
// últimos y dos repos distintos acababan bajo la misma key. el resto de hosts (subgrupos de gitlab,
// remotes propios) siguen con los dos últimos.

// mismo formato que valida el server para target_repo.repo: workspace/slug u owner/repo.
export const REPO_KEY_RE = /^[^/\s]+\/[^/\s]+$/;

// hosts donde el repo son los dos primeros segmentos del path, diga lo que diga el resto.
const LEADING_KEY_HOSTS: ReadonlySet<string> = new Set(['github.com', 'bitbucket.org']);

// host y path de un remote: git@host:ws/slug.git · https://host/ws/slug.git · ssh://git@host/ws/slug.git
function splitRemote(url: string): { host: string; path: string } | null {
  const cleaned = url.trim();
  const scpLike = cleaned.match(/^[^@\s]+@([^:/\s]+):(.+)$/);
  if (scpLike) return { host: scpLike[1]!.toLowerCase(), path: scpLike[2]! };
  try {
    const parsed = new URL(cleaned);
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
  } catch {
    // ni url ni scp-like (un remote a un path local): no hay key que derivar.
    return null;
  }
}

/** key ws/slug del url de un remote, o null si no se puede derivar. */
export function repoKeyFromRemote(url: string): string | null {
  const remote = splitRemote(url);
  if (!remote) return null;
  const segments = remote.path.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const pair = LEADING_KEY_HOSTS.has(remote.host) ? segments.slice(0, 2) : segments.slice(-2);
  const key = pair.join('/').replace(/\.git$/, '');
  return REPO_KEY_RE.test(key) ? key : null;
}

/** misma key de repo: github y bitbucket no distinguen mayúsculas en workspace ni slug. */
export function sameRepoKey(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
