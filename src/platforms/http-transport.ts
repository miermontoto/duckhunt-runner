// transporte http de una plataforma (t#495, M6): su credencial oauth viva, el access token con refresh
// single-flight (access-token.ts) y el POST autenticado contra la api del runner, con timeout y un reintento tras
// refresh en un 401. lo que antes era el `api()` del daemon y su credencial en memoria, movido tal cual.
// - la credencial en memoria manda: solo la rota el refresh (oauth.ts::refreshAccess). un `login` nuevo de la
//   misma instancia (otro clientId en el fichero) o un refresh rotado que no se pudo guardar fuerzan otro
//   refresh (observe), que adopta o reescribe lo que toca.
// - replacesClientId viaja hasta que el server acepta un claim con él (accepted): entonces deja de mandarse y
//   se quita del fichero si sigue siendo de la misma credencial.

import { AccessTokenSource } from '../access-token.js';
import type { RunnerCredential } from '../config.js';
import { refreshAccess } from '../oauth.js';
import { LEGACY_CREDENTIALS, type CredentialStore } from './credentials.js';

// toda llamada al server: sin respuesta en este plazo cuenta como fallo de red.
const API_TIMEOUT_MS = 30_000;
const HTTP_UNAUTHORIZED = 401;
// path del recurso runner en el server: la audiencia oauth de sus tokens y la base de su api.
export const RUNNER_API_PATH = '/api/runner';

export class HttpTransport {
  private readonly auth: AccessTokenSource;
  // el último refresh rotado no se pudo escribir: al cambiar el fichero se fuerza otro refresh.
  private unsaved = false;

  constructor(
    private current: RunnerCredential,
    // de dónde se lee y dónde se guarda esta credencial (la de duckhunt: las claves de siempre).
    private readonly store: CredentialStore = LEGACY_CREDENTIALS,
  ) {
    this.auth = new AccessTokenSource(async () => {
      const { access, credential, saved } = await refreshAccess(this.current, this.store);
      this.current = credential;
      this.unsaved = !saved;
      return access;
    });
  }

  /** credencial viva (la rota el refresh). */
  get credential(): RunnerCredential {
    return this.current;
  }

  /** POST autenticado a la api del runner; un 401 descarta el token, refresca y reintenta una vez. */
  async post(pathname: string, body?: unknown): Promise<Response> {
    const token = await this.auth.token();
    const first = await this.send(pathname, body, token);
    if (first.status !== HTTP_UNAUTHORIZED) return first;
    this.auth.invalidate(token);
    return this.send(pathname, body, await this.auth.token());
  }

  /** POST sin reintento: para desvincular, un 401 ya es la respuesta (la credencial no valía). */
  async postOnce(pathname: string, body?: unknown): Promise<Response> {
    return this.send(pathname, body, await this.auth.token());
  }

  private send(pathname: string, body: unknown, token: string): Promise<Response> {
    return fetch(`${this.current.baseUrl}${RUNNER_API_PATH}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? '{}' : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  }

  /** la credencial del fichero tras recargarlo (ver cabecera). a otra instancia no se cambia en caliente. */
  observe(next: RunnerCredential): void {
    if (this.unsaved || (next.clientId !== this.current.clientId && next.baseUrl === this.current.baseUrl)) this.auth.reset();
  }

  /** el server aceptó un claim con el replacesClientId de esta credencial: ya adoptó (o no tenía nada que
   *  adoptar), así que deja de mandarse. el fichero solo se toca si sigue siendo de la misma credencial. */
  accepted(clientId: string, replaces: string): void {
    if (this.current.clientId !== clientId || this.current.replacesClientId !== replaces) return;
    this.current = { baseUrl: this.current.baseUrl, clientId, refreshToken: this.current.refreshToken };
    try {
      this.store.clearReplaces(clientId, replaces);
    } catch (err) {
      console.error(`[runner] no se pudo quitar replacesClientId de la config: ${(err as Error).message} — se reenvía al reiniciar (inocuo)`);
    }
  }
}
