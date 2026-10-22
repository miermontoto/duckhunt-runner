// dónde vive la credencial de cada plataforma (t#495, M6.3): la de duckhunt en las claves de siempre de la config
// (baseUrl/clientId/refreshToken/replacesClientId, M2), la de cualquier otra en `platforms.<id>.credential`. el
// refresh (oauth.ts) lee y escribe a través de esto, así cada plataforma rota y guarda SOLO la suya: el cambio se
// calcula sobre el fichero de ese momento (saveConfig/saveConfigV2), lo del resto se queda como está.
// el mutex en proceso que pedía el diseño para estas escrituras no hace falta: releer, cambiar y escribir el
// fichero es síncrono (config.ts::saveConfig), así que dentro del daemon dos escrituras nunca se intercalan. entre
// procesos (la cli con el daemon en marcha) sigue el footgun aceptado de config.ts.

import { loadConfig, loadConfigV2, saveConfig, saveConfigV2, type RunnerConfigV2, type RunnerCredential } from '../config.js';
import { LEGACY_PLATFORM_ID } from '../paths.js';

export interface CredentialStore {
  /** la credencial del fichero (null = no hay). lanza si el fichero no se puede leer. */
  load(): RunnerCredential | null;
  /** guarda el refresh token rotado si el fichero sigue siendo de su cliente (un `login` hecho durante el refresh
   *  gana). lanza si no se pudo escribir. */
  saveRefreshToken(cred: RunnerCredential): void;
  /** quita replacesClientId si el fichero sigue siendo de esa credencial. lanza si no se pudo escribir. */
  clearReplaces(clientId: string, replaces: string): void;
  /** borra la credencial (rechazada por su server) si el fichero sigue siendo de ese cliente: un `login` hecho
   *  mientras tanto gana. true = borrada. lanza si no se pudo escribir. */
  clear(clientId: string): boolean;
}

/** la de duckhunt: las claves de siempre (un daemon ≤ 0.12 sobre el mismo fichero lee y escribe las mismas). */
export const LEGACY_CREDENTIALS: CredentialStore = {
  load: loadConfig,
  saveRefreshToken: (cred) => {
    saveConfig((current) => (current.clientId === cred.clientId ? { refreshToken: cred.refreshToken } : null));
  },
  clearReplaces: (clientId, replaces) => {
    saveConfig((current) => (current.clientId === clientId && current.replacesClientId === replaces ? { replacesClientId: undefined } : null));
  },
  // las mismas claves que borra `logout` (logout.ts::wipeCredential); mapas, defaults y la máquina se quedan.
  clear: (clientId) => {
    let wiped = false;
    saveConfig((current) => {
      if (current.clientId !== clientId) return null;
      wiped = true;
      return { clientId: undefined, refreshToken: undefined, replacesClientId: undefined };
    });
    return wiped;
  },
};

// el modelo v2 con la credencial de `id` cambiada por `change` (null = nada que escribir).
const withCredential =
  (id: string, change: (cred: RunnerCredential) => RunnerCredential | null) =>
  (cfg: RunnerConfigV2): RunnerConfigV2 | null => {
    const platform = cfg.platforms[id];
    const next = platform?.credential ? change(platform.credential) : null;
    return platform && next ? { ...cfg, platforms: { ...cfg.platforms, [id]: { ...platform, credential: next } } } : null;
  };

/** la de una plataforma en `platforms.<id>.credential`; la legacy, en las claves de siempre. */
export function credentialStore(id: string): CredentialStore {
  if (id === LEGACY_PLATFORM_ID) return LEGACY_CREDENTIALS;
  return {
    load: () => loadConfigV2()?.platforms[id]?.credential ?? null,
    saveRefreshToken: (cred) => {
      saveConfigV2(withCredential(id, (current) => (current.clientId === cred.clientId ? { ...current, refreshToken: cred.refreshToken } : null)));
    },
    clearReplaces: (clientId, replaces) => {
      saveConfigV2(
        withCredential(id, ({ replacesClientId, ...rest }) => (rest.clientId === clientId && replacesClientId === replaces ? rest : null)),
      );
    },
    // como `logout <id>` (logout.ts::platformLogout): fuera solo la credencial; su exposición y su techo se quedan.
    clear: (clientId) => {
      let wiped = false;
      saveConfigV2((cfg) => {
        const platform = cfg.platforms[id];
        if (platform?.credential?.clientId !== clientId) return null;
        wiped = true;
        const { credential: _, ...rest } = platform;
        return { ...cfg, platforms: { ...cfg.platforms, [id]: rest } };
      });
      return wiped;
    },
  };
}
