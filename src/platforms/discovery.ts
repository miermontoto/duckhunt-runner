// discovery del cable v0 (t#495, M4; vendor/runner-protocol, v0.ts): GET <base>/.well-known/agent-runner dice qué
// versiones habla la plataforma, dónde están sus endpoints, qué extensiones tiene y sus topes. se valida entero antes
// de usarlo: el daemon le manda su access token a esos endpoints.
// decisiones:
// - los endpoints son rutas relativas a la raíz del MISMO server (empiezan por una sola `/`): un discovery que
//   apunte a otro host no se acepta, el token no sale de su origen.
// - `resource` tiene que ser la audiencia de la credencial (`<base>/api/runner`): otra audiencia = otro recurso, y
//   el token no valdría (o valdría donde no debe).
// - sin `0` en protocol_versions, o con un tope que no es un entero positivo, el documento no vale: la plataforma
//   no se usa (el supervisor reintenta en el siguiente claim).

import {
  AGENT_RUNNER_PROTOCOL,
  AGENT_RUNNER_WELL_KNOWN,
  RUNNER_PROTOCOL_V0,
  V0_ENDPOINT,
  V0_RUN_ID_PLACEHOLDER,
  type V0EndpointName,
  type V0Limits,
} from '../vendor/runner-protocol/index.js';
import { RUNNER_API_PATH } from './http-transport.js';
import { sameSecureOrigin, sameUrl } from './origin.js';

const DISCOVERY_TIMEOUT_MS = 10_000;
// una ruta de la raíz del server: una sola `/` delante (`//host` sería otro origen) y sin query ni fragmento.
const ENDPOINT_PATH_RE = /^\/(?!\/)[A-Za-z0-9/_.{}-]*$/;
// espacio de nombres de una extensión (`x-<ns>`).
const EXT_NS_RE = /^x-[a-z0-9-]{1,32}$/;
const RUN_ENDPOINTS: readonly V0EndpointName[] = ['lease', 'events', 'result'];
const LIMIT_KEYS: readonly (keyof V0Limits)[] = [
  'announceMax',
  'eventBatchMax',
  'eventBodyMaxChars',
  'eventToolMaxChars',
  'resultMaxChars',
  'errorMaxChars',
  'stderrTailMaxChars',
  'requestBytesMax',
];

/** lo que el daemon usa del discovery, ya validado. */
export interface V0Discovery {
  endpoints: Readonly<Record<V0EndpointName, string>>;
  // ns → nombre → ruta de cada extensión que anuncia.
  extensions: ReadonlyMap<string, Readonly<Record<string, string>>>;
  limits: V0Limits;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (what: string): Error => new Error(`discovery v0 inválido: ${what}`);
const isPath = (v: unknown): v is string => typeof v === 'string' && ENDPOINT_PATH_RE.test(v);

/** valida el documento de discovery de la plataforma de `baseUrl` (ver cabecera). lanza con el motivo. */
export function parseDiscovery(raw: unknown, baseUrl: string): V0Discovery {
  if (!isObj(raw)) throw invalid('no es un objeto');
  if (raw.protocol !== AGENT_RUNNER_PROTOCOL) throw invalid(`protocol ${JSON.stringify(raw.protocol)}`);
  if (!Array.isArray(raw.protocol_versions) || !raw.protocol_versions.includes(RUNNER_PROTOCOL_V0)) {
    throw invalid(`sin la versión ${RUNNER_PROTOCOL_V0} en protocol_versions`);
  }
  if (typeof raw.resource !== 'string' || !sameUrl(raw.resource, `${baseUrl}${RUNNER_API_PATH}`)) {
    throw invalid('resource no es la audiencia de esta credencial');
  }
  const endpoints = isObj(raw.endpoints) ? raw.endpoints : {};
  const names = Object.keys(V0_ENDPOINT) as V0EndpointName[];
  const bad = names.filter((n) => !isPath(endpoints[n]) || (RUN_ENDPOINTS.includes(n) && !(endpoints[n] as string).includes(V0_RUN_ID_PLACEHOLDER)));
  if (bad.length > 0) throw invalid(`endpoints no válidos (${bad.join(', ')}): rutas de este mismo server`);
  const limits = isObj(raw.limits) ? raw.limits : {};
  const badLimits = LIMIT_KEYS.filter((k) => !Number.isSafeInteger(limits[k]) || (limits[k] as number) <= 0);
  if (badLimits.length > 0) throw invalid(`topes no válidos (${badLimits.join(', ')})`);
  // una extensión mal formada se ignora: es opcional por definición.
  const extensions = (Array.isArray(raw.extensions) ? raw.extensions : []).flatMap((x): [string, Record<string, string>][] => {
    if (!isObj(x) || typeof x.ns !== 'string' || !EXT_NS_RE.test(x.ns) || !isObj(x.endpoints)) return [];
    return [[x.ns, Object.fromEntries(Object.entries(x.endpoints).filter((e): e is [string, string] => isPath(e[1])))]];
  });
  return {
    endpoints: Object.fromEntries(names.map((n) => [n, endpoints[n] as string])) as Record<V0EndpointName, string>,
    extensions: new Map(extensions),
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k] as number])) as unknown as V0Limits,
  };
}

/** lo que `login --as` usa del discovery para el oauth (M6.4): quién la emite, su metadata rfc 8414, el redirect
 *  out-of-band y la audiencia. */
export interface V0DiscoveryAuth {
  issuer: string;
  metadataUrl: string;
  oobRedirectUri: string;
  resource: string;
}

/** el oauth del discovery de `baseUrl` (ya validado con parseDiscovery): todo en el origen de la plataforma (el
 *  code, el verifier y los tokens no salen de él). lanza con el motivo. */
export function parseDiscoveryAuth(raw: unknown, baseUrl: string): V0DiscoveryAuth {
  const doc = isObj(raw) ? raw : {};
  const field = (key: string): string => {
    const v = doc[key];
    if (typeof v !== 'string' || !sameSecureOrigin(v, baseUrl)) throw invalid(`${key} fuera del origen de la plataforma`);
    return v;
  };
  return { issuer: field('issuer'), metadataUrl: field('authorization_server_metadata'), oobRedirectUri: field('oob_redirect_uri'), resource: field('resource') };
}

/** GET del discovery de `baseUrl` y su validación. lanza si no se puede leer o no vale. */
export async function fetchDiscovery(baseUrl: string): Promise<V0Discovery> {
  const res = await getDiscovery(baseUrl);
  if (!res.ok) throw new Error(`discovery v0: http ${res.status}`);
  return parseDiscovery(res.body, baseUrl);
}

/** GET del discovery de `baseUrl` sin validar: su status y su cuerpo (null si no es json). `login --as` distingue
 *  un 404 (sin discovery: el contrato legacy) de un error. lanza en un fallo de red. */
export async function getDiscovery(baseUrl: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/.well-known/${AGENT_RUNNER_WELL_KNOWN}`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  return { ok: res.ok, status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
}
