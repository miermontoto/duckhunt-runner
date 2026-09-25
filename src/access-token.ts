// access token del daemon contra /api/runner con refresh SINGLE-FLIGHT. el server rota el refresh
// token en cada uso y trata la reaparición de uno ya rotado como replay: revoca la cadena entera
// (revokeRefreshChain) y el daemon muere al siguiente refresh hasta un `login` nuevo. dos llamadas
// cerca de la caducidad (latido + progreso + feed, o N runs en paralelo) refrescarían a la vez con
// el MISMO refresh token, así que todas comparten la promesa del refresh en vuelo.

import type { AccessState } from './oauth.js';

// margen para refrescar antes de que caduque.
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export class AccessTokenSource {
  private access: AccessState | null = null;
  private refreshing: Promise<AccessState> | null = null;

  constructor(
    // refresca con el refresh token vigente y persiste el rotado (oauth.ts::refreshAccess).
    private readonly refresh: () => Promise<AccessState>,
    private readonly now: () => number = Date.now,
  ) {}

  /** token vigente; si caduca pronto, refresca una sola vez aunque lo pidan N llamadas a la vez. */
  async token(): Promise<string> {
    if (this.access && this.access.expiresAt - this.now() >= TOKEN_REFRESH_MARGIN_MS) return this.access.token;
    this.refreshing ??= this.refresh()
      .then((access) => {
        this.access = access;
        return access;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return (await this.refreshing).token;
  }

  /** el server rechazó `token` (401): se descarta solo si sigue siendo el vigente. otro 401 de una
   *  llamada que salió con el token anterior no fuerza un segundo refresh. */
  invalidate(token: string): void {
    if (this.access?.token === token) this.access = null;
  }
}
