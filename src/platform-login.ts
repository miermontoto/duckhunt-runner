// `login <url> --as [id]` (t#495, M6.4): da de alta, o renueva, una plataforma que NO es duckhunt.
// decisiones:
// - `login <url>` sin --as sigue siendo el de siempre (oauth.ts::login): la credencial de duckhunt en las claves de
//   siempre y duckhunt en su cable duckhunt-42 aunque ya publique discovery. pasarla a v0 es otra decisión.
// - con discovery (`/.well-known/agent-runner`, validado como el del daemon) la plataforma habla v0 y el oauth sale
//   de su metadata rfc 8414: dcr de cliente público, pkce S256, el resource del discovery y el code que se pega.
//   todo endpoint del oauth y el redirect, en el MISMO origen que la plataforma (el code, el verifier y los tokens no
//   salen de él), y la plataforma en https salvo en loopback (desarrollo).
// - sin discovery (404): el contrato de duckhunt (duckhunt-42), solo con --trusted: en ese cable su techo no se
//   aplica (M6.3) y sus runs reciben el kit que mande su server.
// - id: el de --as; `--as` sin valor lo deriva del host del issuer (`.` → `-`, hasta 32). `duckhunt` y `local` están
//   reservados. mismo id y mismo issuer = renovar la credencial (exposición, techo y cuota se quedan, y la nueva
//   reemplaza a la vieja en el server con replacesClientId); otro issuer con el mismo id se rechaza antes del oauth.
// - una nueva arranca sin nada expuesto, con el techo más bajo (DEFAULT_CEILING) y un slot.

import path from 'node:path';
import { configPath, loadConfigV2, loadStoredConfig, saveConfigV2, type RunnerCredential } from './config.js';
import { daemonLockHolder } from './daemon-lock.js';
import { authorizeClient, legacyOAuth, tokenUrlOf, type AskCode, type OAuthEndpoints } from './oauth.js';
import { LEGACY_PLATFORM_ID, PLATFORM_ID_RE, RESERVED_PLATFORM_IDS } from './paths.js';
import { getDiscovery, parseDiscovery, parseDiscoveryAuth } from './platforms/discovery.js';
import { isSecureOrLoopback, sameSecureOrigin, sameUrl, urlOf } from './platforms/origin.js';
import { PROTOCOL, type Protocol } from './platforms/platform.js';
import { DEFAULT_CEILING, PLATFORM_DEFAULT_SLOTS, type PlatformConfig } from './platforms/types.js';

export const PLATFORM_LOGIN_FLAG = { as: '--as', name: '--name', trusted: '--trusted' } as const;
const FLAG_PREFIX = '--';
// lo que parece una url (no un id) tras --as: queda para la url.
const URL_LIKE_RE = /[.:/]/;
const SCHEME_RE = /^https?:\/\//i;
const HTTPS_PREFIX = 'https://';
const HTTP_NOT_FOUND = 404;
const METADATA_TIMEOUT_MS = 10_000;
const PKCE_S256 = 'S256';
// largo máximo de un id (PLATFORM_ID_RE).
const ID_MAX_CHARS = 32;
const CLIENT_NAME_FALLBACK = 'local';

const USAGE = `uso: duckhunt-runner login <url> ${PLATFORM_LOGIN_FLAG.as} [id] [${PLATFORM_LOGIN_FLAG.name} <nombre>] [${PLATFORM_LOGIN_FLAG.trusted}]`;

export interface PlatformLoginArgs {
  baseUrl: string;
  // null = derivarlo del issuer.
  id: string | null;
  name?: string;
  trusted: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function fail(message: string): never {
  throw new Error(message);
}
const isFlag = (token: string | undefined): boolean => token?.startsWith(FLAG_PREFIX) ?? false;

/** los argumentos de un `login` de plataforma (lleva --as); null = el `login` de siempre. lanza con el uso. */
export function parsePlatformLoginArgs(rest: readonly string[]): PlatformLoginArgs | null {
  if (!rest.includes(PLATFORM_LOGIN_FLAG.as)) return null;
  const parsed: { url?: string; id: string | null; name?: string; trusted: boolean } = { id: null, trusted: false };
  // un token tras otro: los flags con valor consumen el siguiente.
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const next = rest[i + 1];
    if (token === PLATFORM_LOGIN_FLAG.as) {
      if (next !== undefined && !isFlag(next) && !URL_LIKE_RE.test(next)) parsed.id = rest[++i]!;
    } else if (token === PLATFORM_LOGIN_FLAG.name) {
      if (next === undefined || isFlag(next)) fail(USAGE);
      parsed.name = rest[++i]!;
    } else if (token === PLATFORM_LOGIN_FLAG.trusted) {
      parsed.trusted = true;
    } else if (isFlag(token) || parsed.url !== undefined) {
      fail(USAGE);
    } else {
      parsed.url = token;
    }
  }
  if (parsed.url === undefined) return fail(USAGE);
  const raw = (SCHEME_RE.test(parsed.url) ? parsed.url : `${HTTPS_PREFIX}${parsed.url}`).replace(/\/+$/, '');
  const url = urlOf(raw);
  if (!url || !isSecureOrLoopback(url)) fail(`${raw}: una plataforma tiene que servir https (http solo en loopback, para desarrollo)`);
  return { baseUrl: raw, id: parsed.id, ...(parsed.name ? { name: parsed.name } : {}), trusted: parsed.trusted };
}

/** el id que se deriva del host del issuer (null si no sale uno válido y libre). */
export function platformIdOf(issuer: string): string | null {
  const host = urlOf(issuer)?.hostname.toLowerCase() ?? '';
  const id = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, ID_MAX_CHARS).replace(/-+$/, '');
  return PLATFORM_ID_RE.test(id) && !RESERVED_PLATFORM_IDS.has(id) ? id : null;
}

function checkId(id: string): void {
  if (RESERVED_PLATFORM_IDS.has(id)) fail(`el id ${id} está reservado${id === LEGACY_PLATFORM_ID ? `: \`login <url>\` sin ${PLATFORM_LOGIN_FLAG.as} es el de ${LEGACY_PLATFORM_ID}` : ''}`);
  if (!PLATFORM_ID_RE.test(id)) fail(`id de plataforma no válido: ${id} (minúsculas, dígitos y '-', hasta ${ID_MAX_CHARS})`);
}

// el mismo id solo renueva la misma plataforma (su issuer; en una escrita a mano, su base).
function checkSameIssuer(id: string, prev: PlatformConfig | undefined, issuer: string): void {
  const prevIssuer = prev?.issuer ?? prev?.credential?.baseUrl;
  if (prevIssuer !== undefined && !sameUrl(prevIssuer, issuer)) fail(`la plataforma ${id} ya es la de ${prevIssuer}: elige otro id con ${PLATFORM_LOGIN_FLAG.as} <id>`);
}

/** a qué plataforma se hace login: su protocolo, quién la emite y su oauth. */
interface LoginTarget {
  protocol: Protocol;
  issuer: string;
  oauth: OAuthEndpoints;
}

// los endpoints de la metadata rfc 8414 de la plataforma: en su origen y con pkce S256.
async function oauthMetadata(url: string, base: string): Promise<Pick<OAuthEndpoints, 'registration' | 'authorization' | 'token'>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!res.ok) fail(`metadata oauth (rfc 8414): http ${res.status}`);
  const raw: unknown = await res.json().catch(() => null);
  const doc = isObj(raw) ? raw : {};
  const endpoint = (key: string): string => {
    const v = doc[key];
    return typeof v === 'string' && sameSecureOrigin(v, base) ? v : fail(`metadata oauth: ${key} fuera del origen de la plataforma`);
  };
  const methods = doc.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes(PKCE_S256)) fail(`metadata oauth: sin pkce ${PKCE_S256}`);
  return { registration: endpoint('registration_endpoint'), authorization: endpoint('authorization_endpoint'), token: endpoint('token_endpoint') };
}

// discovery → v0 con el oauth de su metadata; sin discovery, el contrato de duckhunt (solo trusted).
async function loginTarget(base: string, trusted: boolean): Promise<LoginTarget> {
  const res = await getDiscovery(base);
  if (res.status === HTTP_NOT_FOUND) {
    if (!trusted) {
      fail(`${base} no publica discovery (/.well-known/agent-runner): solo se puede dar de alta con el contrato de duckhunt (duckhunt-42), en el que su techo no se aplica. si es de confianza, repite con ${PLATFORM_LOGIN_FLAG.trusted}`);
    }
    return { protocol: PROTOCOL.duckhunt42, issuer: base, oauth: legacyOAuth(base) };
  }
  if (!res.ok) fail(`discovery: http ${res.status}`);
  // versión, endpoints, audiencia y topes, como los valida el daemon.
  parseDiscovery(res.body, base);
  const auth = parseDiscoveryAuth(res.body, base);
  const endpoints = await oauthMetadata(auth.metadataUrl, base);
  return { protocol: PROTOCOL.v0, issuer: auth.issuer, oauth: { ...endpoints, redirectUri: auth.oobRedirectUri, resource: auth.resource } };
}

/** `login <url> --as [id]`: discovery, oauth y la plataforma en la config (ver cabecera). lanza con el motivo. */
export async function platformLogin(args: PlatformLoginArgs, ask?: AskCode): Promise<void> {
  if (args.id !== null) checkId(args.id);
  const base = args.baseUrl;
  const target = await loginTarget(base, args.trusted);
  const id = args.id ?? platformIdOf(target.issuer) ?? fail(`no sale un id de ${target.issuer}: pásalo con ${PLATFORM_LOGIN_FLAG.as} <id>`);
  checkSameIssuer(id, loadConfigV2()?.platforms[id], target.issuer);
  const { clientId, tokens } = await authorizeClient(target.oauth, `duckhunt-runner (${loadStoredConfig()?.label ?? CLIENT_NAME_FALLBACK})`, ask);
  // el token endpoint solo se guarda si no es el de siempre bajo su base.
  const tokenEndpoint = target.oauth.token === tokenUrlOf({ baseUrl: base }) ? undefined : target.oauth.token;
  const renewed = { value: false };
  saveConfigV2((cfg) => {
    const prev = cfg.platforms[id];
    checkSameIssuer(id, prev, target.issuer);
    renewed.value = prev !== undefined;
    const replaces = prev?.credential ? (prev.credential.replacesClientId ?? prev.credential.clientId) : undefined;
    const credential: RunnerCredential = {
      baseUrl: base,
      clientId,
      refreshToken: tokens.refresh_token,
      ...(replaces ? { replacesClientId: replaces } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
    };
    const kept: PlatformConfig = prev ?? { trusted: args.trusted, expose: {}, ceiling: DEFAULT_CEILING, slots: PLATFORM_DEFAULT_SLOTS };
    const next: PlatformConfig = {
      ...kept,
      credential,
      protocol: target.protocol,
      issuer: target.issuer,
      ...(args.name ? { name: args.name } : {}),
      ...(args.trusted ? { trusted: true } : {}),
    };
    return { ...cfg, platforms: { ...cfg.platforms, [id]: next } };
  });
  console.log(`\nplataforma ${id} ${renewed.value ? 'renovada' : 'dada de alta'} (${target.protocol}) → ${base}. config en ${configPath()}.`);
  if (renewed.value) {
    console.log('su exposición, su techo y su cuota se quedan como estaban.');
  } else {
    console.log(`no ve nada de esta máquina todavía: expón lo que quieras darle, p. ej. \`duckhunt-runner platforms expose ${id} repo <workspace/slug>\`.`);
    console.log(`su techo (lo más que puede pedir) es el mínimo: sin shell, sin escritura y sin web; se cambia en \`platforms.${id}.ceiling\` de la config.`);
  }
  if (target.protocol === PROTOCOL.duckhunt42) console.warn(`aviso: ${id} habla el contrato de duckhunt: su techo no se aplica y sus runs reciben el kit que mande su server.`);
  const daemon = daemonLockHolder();
  if (daemon?.config === path.resolve(configPath())) console.log(`el daemon en marcha (pid ${daemon.pid}) la recoge en su próxima vuelta.`);
}
