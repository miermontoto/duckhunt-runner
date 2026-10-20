// `duckhunt-runner logout` (0.11.0, t#465 P12): desvincula ESTA máquina desde ella misma. pide al server
// que la desvincule (POST /api/runner/unpair con su propia credencial: revoca la credencial, borra su fila
// y cancela sus runs en marcha, lo mismo que el × de Ajustes → Agentes → Máquinas) y borra la credencial
// local. mapas, defaults y la identidad de la máquina se quedan: un `login` posterior la vuelve a vincular.
// decisiones:
// - un 404 (duckhunt anterior a 0.11, sin el endpoint) o una credencial que ya no valía (desvinculada desde
//   la web, revocada o caducada) borran solo la local, avisando; un fallo de red o un 5xx no borran nada
//   (la credencial seguiría viva en el server): se puede reintentar.
// - con el daemon en marcha no se le manda nada: su siguiente llamada ve la credencial rechazada y para
//   solo (daemon.ts::stopUnpaired).

import path from 'node:path';
import { configPath, loadStoredConfig, saveConfig, type RunnerCredential } from './config.js';
import { daemonLockHolder } from './daemon-lock.js';
import { clearServerState } from './server-state.js';
import { LEGACY_PLATFORM_ID } from './paths.js';
import { Duckhunt42Platform } from './platforms/duckhunt42.js';
import { HttpTransport } from './platforms/http-transport.js';
import type { UnpairOutcome } from './platforms/platform.js';

export type { UnpairOutcome };

/** pide al server que desvincule la máquina de esta credencial (platforms/duckhunt42.ts::unpair). lanza ante un
 *  fallo de red o un error del server. */
export function unpairOnServer(cred: RunnerCredential): Promise<UnpairOutcome> {
  return new Duckhunt42Platform(LEGACY_PLATFORM_ID, new HttpTransport(cred)).unpair();
}

/** borra la credencial de la config (y lo último que dijo el server), dejando todo lo demás. */
export function wipeCredential(): void {
  saveConfig(() => ({ clientId: undefined, refreshToken: undefined, replacesClientId: undefined }));
  clearServerState(LEGACY_PLATFORM_ID);
}

export async function logoutCommand(): Promise<void> {
  const cfg = loadStoredConfig();
  if (!cfg?.baseUrl || !cfg.clientId || !cfg.refreshToken) {
    console.log(`sin credencial en ${configPath()}: nada que desvincular`);
    clearServerState(LEGACY_PLATFORM_ID);
    return;
  }
  const daemon = daemonLockHolder();
  if (daemon?.config === path.resolve(configPath())) {
    console.warn(`aviso: el daemon en marcha (pid ${daemon.pid}) se detendrá en su próxima llamada al server`);
  }
  const outcome = await unpairOnServer({ baseUrl: cfg.baseUrl, clientId: cfg.clientId, refreshToken: cfg.refreshToken });
  wipeCredential();
  if (outcome.kind === 'unsupported') {
    console.warn(`aviso: ${cfg.baseUrl} no sabe desvincular desde la máquina (anterior a duckhunt-runner 0.11): desvincúlala en Ajustes → Agentes → Máquinas`);
  } else if (outcome.kind === 'gone') {
    console.log('la credencial ya no valía (desvinculada desde duckhunt, revocada o caducada)');
  } else if (outcome.canceled > 0) {
    console.log(`desvinculada de ${cfg.baseUrl}: ${outcome.canceled} run(s) en marcha cancelado(s)`);
  } else {
    console.log(`desvinculada de ${cfg.baseUrl}`);
  }
  console.log(`credencial borrada de ${configPath()} (mapas y defaults se quedan). \`duckhunt-runner login\` para volver a vincularla.`);
}
