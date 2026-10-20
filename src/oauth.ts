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

import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline/promises';
import { configPath, DEFAULT_BASE_URL, loadConfig, saveConfig, type RunnerCredential } from './config.js';
import { daemonLockHolder } from './daemon-lock.js';
import { loginIdentity } from './machine.js';
import { PlatformRejectedError } from './platforms/platform.js';

// path del recurso runner en el server (espejo de canonicalRunnerResourceUrl).
const RUNNER_RESOURCE_PATH = '/api/runner';
// redirect out-of-band: página del server que muestra el code para pegar.
const OOB_REDIRECT_PATH = '/oauth/authorized';
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

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

async function postToken(baseUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${baseUrl}/oauth/token`, {
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

export async function login(baseUrl: string, label?: string): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  const redirectUri = `${base}${OOB_REDIRECT_PATH}`;
  const resource = `${base}${RUNNER_RESOURCE_PATH}`;

  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: `duckhunt-runner (${label ?? 'local'})`, redirect_uris: [redirectUri] }),
  });
  const client = (await reg.json().catch(() => ({}))) as { client_id?: string };
  if (!reg.ok || !client.client_id) throw new Error(`dcr falló: http ${reg.status}`);

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', resource);

  console.log('\nabre esta url en tu navegador, autoriza y pega aquí el código:\n');
  console.log(`  ${authorizeUrl.toString()}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('código: ')).trim();
  rl.close();
  if (!code) throw new Error('código vacío');

  const tokens = await postToken(base, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    resource,
  });

  // solo la credencial, la identidad de la máquina (y la etiqueta si se pasó): mapas, defaults y lo demás
  // del fichero se quedan. replacesClientId ausente = undefined, que el json omite (borra uno viejo).
  const previous: { baseUrl?: string } = {};
  const clientId = client.client_id;
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
function credentialToRefresh(current: RunnerCredential): RunnerCredential {
  let disk: RunnerCredential | null;
  try {
    disk = loadConfig();
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
  };
}

// guarda el refresh token recién rotado si el fichero sigue siendo de su cliente (un `login` hecho
// durante el refresh gana). false = no se pudo escribir; true = guardado o ya no es de este cliente.
function persistRefreshToken(cred: RunnerCredential): boolean {
  try {
    saveConfig((current) => (current.clientId === cred.clientId ? { refreshToken: cred.refreshToken } : null));
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
export async function refreshAccess(current: RunnerCredential): Promise<RefreshResult> {
  const cred = credentialToRefresh(current);
  const tokens = await postToken(cred.baseUrl, {
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
    saved: persistRefreshToken(credential),
  };
}
