// flujo oauth del runner contra el authorization server mcp de duckhunt: dcr + pkce +
// code out-of-band (el usuario aprueba en su browser y pega el code — funciona en
// máquinas headless donde un loopback redirect no llega). audiencia dedicada
// /api/runner (rfc 8707): estos tokens no valen en /mcp ni viceversa.

import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { loadConfig, saveConfig, type RunnerConfig } from './config.js';

// path del recurso runner en el server (espejo de canonicalRunnerResourceUrl).
const RUNNER_RESOURCE_PATH = '/api/runner';
// redirect out-of-band: página del server que muestra el code para pegar.
const OOB_REDIRECT_PATH = '/oauth/authorized';

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
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error_description?: string; error?: string };
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new Error(`token endpoint: ${body.error_description ?? body.error ?? `http ${res.status}`}`);
  }
  return body as TokenResponse;
}

/** login interactivo: registra el cliente, imprime la url de autorización, espera el
 *  code pegado por el usuario y persiste clientId + refresh token en la config. */
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

  const existing = loadConfig();
  const cfg: RunnerConfig = {
    baseUrl: base,
    clientId: client.client_id,
    refreshToken: tokens.refresh_token,
    label: label ?? existing?.label,
    repos: existing?.repos ?? {},
  };
  saveConfig(cfg);
  console.log(`\nconectado. config en ~/.duckhunt-runner.json — añade tus repos al mapa "repos".`);
}

export interface AccessState {
  token: string;
  expiresAt: number;
}

/** refresca el access token del runner. la rotación persiste el refresh nuevo AL
 *  INSTANTE (perder el refresh rotado invalida la cadena entera). el save parte de la
 *  config EN DISCO para no pisar un `repos add` hecho en paralelo desde otra terminal. */
export async function refreshAccess(cfg: RunnerConfig): Promise<AccessState> {
  const tokens = await postToken(cfg.baseUrl, {
    grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
  });
  cfg.refreshToken = tokens.refresh_token;
  const disk = loadConfig();
  saveConfig({ ...(disk ?? cfg), refreshToken: tokens.refresh_token });
  return { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
}
