// `duckhunt-runner logout` (0.11.0, t#465 P12): desvincula ESTA máquina desde ella misma. pide al server
// que la desvincule (POST /api/runner/unpair con su propia credencial: revoca la credencial, borra su fila
// y cancela sus runs en marcha, lo mismo que el × de Ajustes → Agentes → Máquinas) y borra la credencial
// local. mapas, defaults y la identidad de la máquina se quedan: un `login` posterior la vuelve a vincular.
// decisiones:
// - un 404 (duckhunt anterior a 0.11, sin el endpoint) o una credencial que ya no valía (desvinculada desde
//   la web, revocada o caducada) borran solo la local, avisando; un fallo de red o un 5xx no borran nada
//   (la credencial seguiría viva en el server): se puede reintentar.
// - con el daemon en marcha no se le manda nada: su siguiente llamada ve la credencial rechazada y para
//   solo (daemon.ts::platformRejected). desde t#510 el daemon también borra la credencial rechazada, así
//   que desvincular desde la web ya no pide este comando en la máquina.
// - (t#495, M6.4) `logout <id>` hace lo mismo con OTRA plataforma: la desvincula en su server con su credencial y su
//   protocolo, y borra solo esa credencial (su exposición, su techo y lo demás se quedan; `platforms remove` la
//   quita entera). `logout` a secas (o `logout duckhunt`) es el de siempre.

import path from 'node:path';
import { configPath, loadConfigV2, loadStoredConfig, saveConfig, saveConfigV2, type RunnerCredential } from './config.js';
import { daemonLockHolder } from './daemon-lock.js';
import { clearServerState } from './server-state.js';
import { LEGACY_PLATFORM_ID } from './paths.js';
import { Duckhunt42Platform } from './platforms/duckhunt42.js';
import { PLATFORM_FACTORIES } from './platforms/factories.js';
import { HttpTransport } from './platforms/http-transport.js';
import type { Protocol, UnpairOutcome } from './platforms/platform.js';

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

/** desvincula la plataforma `id` en su server con su credencial y su protocolo; null = un protocolo que este runner
 *  no habla (no se le puede pedir). lanza ante un fallo de red o un error del server. */
export function unpairPlatform(id: string, credential: RunnerCredential, protocol: string | undefined): Promise<UnpairOutcome> | null {
  const factory = protocol !== undefined && Object.hasOwn(PLATFORM_FACTORIES, protocol) ? PLATFORM_FACTORIES[protocol as Protocol] : undefined;
  return factory ? factory(id, credential).unpair() : null;
}

/** lo que dijo el server al desvincular la plataforma `id`, para la cli (`logout <id>`, `platforms remove`). */
export function reportUnpair(id: string, outcome: UnpairOutcome | null, protocol: string | undefined): void {
  if (outcome === null) console.warn(`aviso: este runner no habla el protocolo de ${id} (${protocol ?? 'sin protocolo'}): desvincúlala en la plataforma`);
  else if (outcome.kind === 'unsupported') console.warn(`aviso: ${id} no sabe desvincular desde la máquina: desvincúlala en la plataforma`);
  else if (outcome.kind === 'gone') console.log(`la credencial de ${id} ya no valía (desvinculada, revocada o caducada)`);
  else console.log(`${id} desvinculada${outcome.canceled > 0 ? `: ${outcome.canceled} run(s) en marcha cancelado(s)` : ''}`);
}

// `logout <id>` de una plataforma que no es duckhunt (ver cabecera).
async function platformLogout(id: string): Promise<void> {
  const platform = loadConfigV2()?.platforms[id];
  if (!platform) {
    console.error(`no hay ninguna plataforma ${id} en ${configPath()} (\`duckhunt-runner platforms list\`)`);
    process.exitCode = 1;
    return;
  }
  if (!platform.credential) {
    console.log(`${id} no tiene credencial en ${configPath()}: nada que desvincular`);
    clearServerState(id);
    return;
  }
  const daemon = daemonLockHolder();
  if (daemon?.config === path.resolve(configPath())) {
    console.warn(`aviso: el daemon en marcha (pid ${daemon.pid}) deja de reclamar para ${id} en su próxima llamada`);
  }
  const outcome = await (unpairPlatform(id, platform.credential, platform.protocol) ?? Promise.resolve(null));
  saveConfigV2((cfg) => {
    const current = cfg.platforms[id];
    if (!current?.credential) return null;
    const { credential: _, ...rest } = current;
    return { ...cfg, platforms: { ...cfg.platforms, [id]: rest } };
  });
  clearServerState(id);
  reportUnpair(id, outcome, platform.protocol);
  console.log(`credencial de ${id} borrada de ${configPath()} (su exposición y su techo se quedan). \`duckhunt-runner login <url> --as ${id}\` para volver a vincularla.`);
}

export async function logoutCommand(id?: string): Promise<void> {
  if (id !== undefined && id !== LEGACY_PLATFORM_ID) return platformLogout(id);
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
