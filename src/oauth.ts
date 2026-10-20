// flujo oauth del daemon contra el authorization server mcp de duckhunt: dcr + pkce + code
// out-of-band (el usuario aprueba en su browser y pega el code — funciona en máquinas headless
// donde un loopback redirect no llega). audiencia dedicada /api/runner (rfc 8707): estos tokens
// no valen en /mcp ni viceversa.
// credencial con el daemon en marcha (0.10.1): para su clientId manda la de memoria (es el único que
// rota su refresh token: daemon-lock.ts); el fichero solo la cambia con un `login` nuevo (dcr = otro
// clientId), que el daemon adopta en su siguiente refresh si es de la misma instancia. a otra
// instancia no se cambia en caliente: los runs en vuelo latirían contra un server que no los conoce.
// ciclo de vida (0.11.0, t#465 P12): `login` deja en la config el id de la máquina y el client_id al que
// reemplaza (machine.ts::loginIdentity), y un rechazo del token endpoint (invalid_grant: credencial
// desvinculada desde duckhunt, revocada por un replay o caducada) es un CredentialRejectedError: el
// daemon para en vez de reintentar cada 5 s con una credencial que ya no vuelve.
// plataformas (t#495, M6.3): de dónde se lee y dónde se guarda la credencial es un CredentialStore
// (platforms/credentials.ts): la de duckhunt en las claves de siempre, la de otra plataforma en su entrada de
// `platforms`. cada refresh escribe solo la suya.
// (M6.4) el flujo (dcr + pkce + code pegado) va contra unos OAuthEndpoints: los de duckhunt, fijos bajo su base
// (legacyOAuth, el `login` de siempre byte a byte), o los que publica la metadata rfc 8414 de otra plataforma
// (platform-login.ts). el refresh usa el token endpoint de la credencial si lo trae.

import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline/promises';
import { configPath, DEFAULT_BASE_URL, saveConfig, type RunnerCredential } from './config.js';
import { daemonLockHolder } from './daemon-lock.js';
import { loginIdentity } from './machine.js';
import { PlatformRejectedError } from './platforms/platform.js';
import { LEGACY_CREDENTIALS, type CredentialStore } from './platforms/credentials.js';

// path del recurso runner en el server (espejo de canonicalRunnerResourceUrl).
const RUNNER_RESOURCE_PATH = '/api/runner';
// redirect out-of-band: página del server que muestra el code para pegar.
const OOB_REDIRECT_PATH = '/oauth/authorized';
// endpoints del authorization server de duckhunt bajo su base.
const REGISTER_PATH = '/oauth/register';
const AUTHORIZE_PATH = '/oauth/authorize';
const TOKEN_PATH = '/oauth/token';
const PKCE_VERIFIER_BYTES = 32;
const PKCE_METHOD = 'S256';
const CODE_PROMPT = 'código: ';
// sin respuesta del token endpoint en este plazo = fallo (un refresh colgado pararía el daemon).
const TOKEN_TIMEOUT_MS = 30_000;
// error oauth (rfc 6749) con el que el token endpoint rechaza una credencial que ya no vale.
const INVALID_GRANT = 'invalid_grant';

// el token endpoint respondió con un error oauth (su código y su descripción).
class TokenEndpointError extends Error {
  constructor(
    readonly code: string | null,
    readonly description: string,
  ) {
    super(`token endpoint: ${description}`);
    this.name = 'TokenEndpointError';
  }
}

/** el token endpoint rechazó el refresh (invalid_grant): desvinculada, revocada o caducada. no se recupera sin
 *  `login`. es el rechazo de la plataforma duckhunt (platforms/platform.ts::PlatformRejectedError). */
export class CredentialRejectedError extends PlatformRejectedError {
  constructor(description: string) {
    super(`la credencial de esta máquina ya no vale (desvinculada desde duckhunt, revocada o caducada: ${description}): vuelve a hacer \`duckhunt-runner login\``);
    this.name = 'CredentialRejectedError';
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

async function postToken(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error_description?: string; error?: string };
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new TokenEndpointError(body.error ?? null, body.error_description ?? body.error ?? `http ${res.status}`);
  }
  return body as TokenResponse;
}

/** login interactivo: registra el cliente, imprime la url de autorización, espera el code
 *  pegado por el usuario y persiste clientId + refresh token en la config. */
/**
 * argumentos de `login`: ambos posicionales son opcionales. el primero es la instancia si parece
 * una url (esquema, o un host con punto o puerto) y si no es la etiqueta, para que `login` a secas
 * apunte a la instancia pública y `login portatil` solo etiquete. sin esquema se asume https.
 */
export function parseLoginArgs(rest: string[]): { baseUrl: string; label?: string } {
  const [first, second] = rest;
  if (first === undefined || !(/^https?:\/\//i.test(first) || /[.:]/.test(first))) {
    return { baseUrl: DEFAULT_BASE_URL, label: first };
  }
  return { baseUrl: /^https?:\/\//i.test(first) ? first : `https://${first}`, label: second };
}

/** dónde hace el oauth una plataforma: registro (dcr), autorización, token, el redirect out-of-band y la audiencia
 *  (rfc 8707) de sus tokens. */
export interface OAuthEndpoints {
  registration: string;
  authorization: string;
  token: string;
  redirectUri: string;
  resource: string;
}

/** el oauth de duckhunt: todo fijo bajo su base (el contrato de siempre). */
export const legacyOAuth = (base: string): OAuthEndpoints => ({
  registration: `${base}${REGISTER_PATH}`,
  authorization: `${base}${AUTHORIZE_PATH}`,
  token: `${base}${TOKEN_PATH}`,
  redirectUri: `${base}${OOB_REDIRECT_PATH}`,
  resource: `${base}${RUNNER_RESOURCE_PATH}`,
});

/** token endpoint de una credencial: el suyo si lo trae, el de duckhunt bajo su base si no. */
export const tokenUrlOf = (cred: Pick<RunnerCredential, 'baseUrl' | 'tokenEndpoint'>): string => cred.tokenEndpoint ?? `${cred.baseUrl}${TOKEN_PATH}`;

/** lee el code que el usuario pega (la terminal; los tests pasan el suyo). */
export type AskCode = (prompt: string) => Promise<string>;

const askTerminal: AskCode = async (prompt) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
};

/** dcr de cliente público + pkce S256 + code out-of-band contra `ep`: el client_id y los tokens. lanza si algo falla. */
export async function authorizeClient(ep: OAuthEndpoints, clientName: string, ask: AskCode = askTerminal): Promise<{ clientId: string; tokens: TokenResponse }> {
  const reg = await fetch(ep.registration, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [ep.redirectUri] }),
  });
  const client = (await reg.json().catch(() => ({}))) as { client_id?: string };
  if (!reg.ok || !client.client_id) throw new Error(`dcr falló: http ${reg.status}`);

  const verifier = b64url(crypto.randomBytes(PKCE_VERIFIER_BYTES));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authorizeUrl = new URL(ep.authorization);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', ep.redirectUri);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', PKCE_METHOD);
  authorizeUrl.searchParams.set('resource', ep.resource);

  console.log('\nabre esta url en tu navegador, autoriza y pega aquí el código:\n');
  console.log(`  ${authorizeUrl.toString()}\n`);
  const code = (await ask(CODE_PROMPT)).trim();
  if (!code) throw new Error('código vacío');

  const tokens = await postToken(ep.token, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: ep.redirectUri,
    client_id: client.client_id,
    resource: ep.resource,
  });
  return { clientId: client.client_id, tokens };
}

export async function login(baseUrl: string, label?: string): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  const { clientId, tokens } = await authorizeClient(legacyOAuth(base), `duckhunt-runner (${label ?? 'local'})`);

  // solo la credencial, la identidad de la máquina (y la etiqueta si se pasó): mapas, defaults y lo demás
  // del fichero se quedan. replacesClientId ausente = undefined, que el json omite (borra uno viejo).
  const previous: { baseUrl?: string } = {};
  saveConfig((current) => {
    previous.baseUrl = current.baseUrl;
    const identity = loginIdentity(current, base);
    return {
      baseUrl: base,
      clientId,
      refreshToken: tokens.refresh_token,
      replacesClientId: identity.replacesClientId,
      machineId: identity.machineId,
      machineHost: identity.machineHost,
      ...(label ? { label } : {}),
      repos: current.repos,
      aws: current.aws,
      defaults: current.defaults,
    };
  });
  console.log(`\nconectado. config en ${configPath()} — mapea tus repos (\`repos discover ~/dev\`) y cuentas aws (\`aws add\`).`);
  const daemon = daemonLockHolder();
  if (daemon?.config === path.resolve(configPath())) {
    console.warn(
      previous.baseUrl === undefined || previous.baseUrl === base
        ? `aviso: el daemon en marcha (pid ${daemon.pid}) pasa a esta credencial antes de su próximo claim`
        : `aviso: el daemon en marcha (pid ${daemon.pid}) sigue conectado a ${previous.baseUrl}: reinícialo para usar ${base}`,
    );
  }
}

export interface AccessState {
  token: string;
  expiresAt: number;
}

export interface RefreshResult {
  access: AccessState;
  // credencial vigente tras la rotación (la de `login` si se adoptó).
  credential: RunnerCredential;
  // false = el refresh rotado no se pudo escribir y vive solo en memoria: el daemon fuerza otro
  // refresh (que vuelve a intentarlo) cuando el fichero cambia.
  saved: boolean;
}

// credencial con la que refrescar: la del fichero si `login` cambió el cliente con el daemon en marcha
// y es de la misma instancia; si no, la de memoria.
function credentialToRefresh(current: RunnerCredential, store: CredentialStore): RunnerCredential {
  let disk: RunnerCredential | null;
  try {
    disk = store.load();
  } catch (err) {
    console.error(`[runner] ${(err as Error).message}: refresco con la credencial en memoria`);
    return current;
  }
  if (!disk || disk.clientId === current.clientId) return current;
  if (disk.baseUrl !== current.baseUrl) {
    console.warn(`[runner] \`login\` apunta a otra instancia (${disk.baseUrl}): este daemon sigue con ${current.baseUrl} hasta que lo reinicies`);
    return current;
  }
  console.log('[runner] credencial nueva de `login`: el daemon la adopta');
  return {
    baseUrl: disk.baseUrl,
    clientId: disk.clientId,
    refreshToken: disk.refreshToken,
    ...(disk.replacesClientId ? { replacesClientId: disk.replacesClientId } : {}),
    ...(disk.tokenEndpoint ? { tokenEndpoint: disk.tokenEndpoint } : {}),
  };
}

// guarda el refresh token recién rotado si el fichero sigue siendo de su cliente (un `login` hecho
// durante el refresh gana). false = no se pudo escribir; true = guardado o ya no es de este cliente.
function persistRefreshToken(cred: RunnerCredential, store: CredentialStore): boolean {
  try {
    store.saveRefreshToken(cred);
    return true;
  } catch (err) {
    console.error(
      `[runner] no se pudo guardar el refresh token rotado en ${configPath()}: ${(err as Error).message} — sigue en memoria y se reintenta cuando el fichero cambie; no reinicies el daemon hasta entonces`,
    );
    return false;
  }
}

/** refresca el access token del daemon. la rotación persiste el refresh nuevo AL INSTANTE (perder el
 *  refresh rotado invalida la cadena entera), y un fallo al guardarlo no tumba el refresh: el server
 *  ya rotó, así que la credencial nueva vuelve igual y el daemon la sigue usando. */
export async function refreshAccess(current: RunnerCredential, store: CredentialStore = LEGACY_CREDENTIALS): Promise<RefreshResult> {
  const cred = credentialToRefresh(current, store);
  const tokens = await postToken(tokenUrlOf(cred), {
    grant_type: 'refresh_token',
    refresh_token: cred.refreshToken,
    client_id: cred.clientId,
  }).catch((err: unknown) => {
    throw err instanceof TokenEndpointError && err.code === INVALID_GRANT ? new CredentialRejectedError(err.description) : err;
  });
  const credential = { ...cred, refreshToken: tokens.refresh_token };
  return {
    access: { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 },
    credential,
    saved: persistRefreshToken(credential, store),
  };
}
