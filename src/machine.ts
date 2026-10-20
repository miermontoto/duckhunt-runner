// identidad estable de la máquina (0.11.0, t#465 P12): un uuid que se genera una vez, vive en la config
// (machineId, con el hostname en el que nació en machineHost) y viaja en cada claim como `machine.id`.
// duckhunt lo usa para que un `login` nuevo en la misma máquina ADOPTE su fila (nombre, pausa, qué
// acepta, tope y la afinidad de sus conversaciones) y revoque la credencial vieja en vez de dejar una
// máquina fantasma; `replacesClientId` (el client_id del login anterior, hasta el primer claim con el
// nuevo) lo cubre cuando la fila vieja aún no conocía el id. no es un secreto: solo identifica, la
// autorización sigue siendo la credencial.
// decisiones:
// - ligado al hostname: una config copiada a otra máquina (dotfiles, una imagen) no se hace pasar por la
//   original. `login` allí estrena id y no dice reemplazar la credencial de la otra (si no, duckhunt le
//   revocaría la suya y se llevaría su fila). un daemon que arranca con una config copiada sin `login`
//   reclama como la original: comparten credencial, y eso ya lo rompe la rotación del refresh token
//   (una credencial por máquina, daemon-lock.ts).
// - sin machineHost (una config de 0.10 sin `start` de 0.11 todavía) no hay prueba de que sea de esta
//   máquina: `login` no manda replacesClientId; la fila vieja queda como «reemplazada» (misma etiqueta)
//   y se desvincula desde la web, como antes de 0.11.
// - un hostname que cambia (un contenedor recreado) cuenta como otra máquina: lo mismo de arriba.
// - non-goal: dos `login` seguidos sin un claim entre medias reemplazan la credencial que tiene fila (la
//   del primero que reclamó); la intermedia nunca reclamó, queda sin fila y caduca sola.

import crypto from 'node:crypto';
import os from 'node:os';
import { saveConfig, type StoredConfig } from './config.js';

/** identidad que `login` deja en la config: el id de esta máquina y, si es la misma, a quién reemplaza. */
export interface LoginIdentity {
  machineId: string;
  machineHost: string;
  // undefined = nada que reemplazar (primer login, otra instancia u otra máquina).
  replacesClientId: string | undefined;
}

/** ¿la config es de esta máquina? (generó su id aquí). */
export const ownedHere = (cfg: Pick<StoredConfig, 'machineId' | 'machineHost'>, hostname = os.hostname()): boolean =>
  typeof cfg.machineId === 'string' && cfg.machineHost === hostname;

/**
 * identidad para un `login` contra `baseUrl` sobre la config actual: conserva el id si se generó en este
 * host (si no, uno nuevo) y reemplaza la credencial anterior solo si es de esta máquina y de la misma
 * instancia. dos logins seguidos sin claim reemplazan la del primero que reclamó (la que tiene fila).
 */
export function loginIdentity(current: StoredConfig, baseUrl: string, hostname = os.hostname()): LoginIdentity {
  const here = ownedHere(current, hostname);
  const sameInstance = here && current.baseUrl === baseUrl && typeof current.clientId === 'string';
  return {
    machineId: here ? current.machineId! : crypto.randomUUID(),
    machineHost: hostname,
    replacesClientId: sameInstance ? (current.replacesClientId ?? current.clientId) : undefined,
  };
}

/** machine id con el que reclama el daemon: el de la config o, si no tiene (config de 0.10), uno nuevo que se guarda. */
export function ensureMachineId(hostname = os.hostname()): string {
  let id = '';
  saveConfig((current) => {
    if (typeof current.machineId === 'string' && current.machineId) {
      id = current.machineId;
      return null;
    }
    id = crypto.randomUUID();
    return { machineId: id, machineHost: hostname };
  });
  return id;
}

// identidad por plataforma (t#495, M6.5): a una plataforma que no es la legacy no se le manda el machine id de
// arriba sino uno derivado de un secreto de esta máquina y del emisor de la plataforma: HMAC-SHA256(secreto,
// emisor). estable para cada plataforma (adoptar su fila tras otro `login` sigue funcionando) y distinto entre
// ellas: dos plataformas que comparan sus ids no pueden saber que son la misma máquina. el secreto se genera la
// primera vez que hace falta (con una sola plataforma, nunca: la config de siempre no cambia) y vive en la config
// (0600), como el refresh token.
const MACHINE_SECRET_BYTES = 32;
const MACHINE_SECRET_RE = /^[0-9a-f]{64}$/;
const MACHINE_ID_HMAC = 'sha256';

/** el secreto de esta máquina para derivar sus ids por plataforma: el de la config o uno nuevo que se guarda. */
export function ensureMachineSecret(): string {
  let secret = '';
  saveConfig((current) => {
    const stored = (current as { machineSecret?: unknown }).machineSecret;
    if (typeof stored === 'string' && MACHINE_SECRET_RE.test(stored)) {
      secret = stored;
      return null;
    }
    secret = crypto.randomBytes(MACHINE_SECRET_BYTES).toString('hex');
    return { machineSecret: secret };
  });
  return secret;
}

// el emisor como origen (esquema + host en minúsculas + puerto): https://Duckhunt.info/ y https://duckhunt.info son
// el mismo. uno que no es una url, tal cual.
function issuerKey(issuer: string): string {
  try {
    return new URL(issuer).origin;
  } catch {
    return issuer;
  }
}

/** machine id de esta máquina para una plataforma (64 hex, cabe en RUNNER_MACHINE_ID_RE). */
export const derivedMachineId = (secret: string, issuer: string): string => crypto.createHmac(MACHINE_ID_HMAC, secret).update(issuerKey(issuer)).digest('hex');
