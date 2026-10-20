// config v1 (≤ 0.12: un fichero sin `version`) → modelo v2 (t#495, M2), y del modelo v2 al fichero. puro, sin fs.
// decisiones:
// - las claves de siempre (baseUrl/clientId/refreshToken/replacesClientId, label, machineId, machineHost, repos, aws,
//   defaults) siguen siendo DONDE VIVEN la credencial de duckhunt y sus repos y cuentas aws, también en un fichero
//   v2: no hay una copia que mantener al día. un daemon ≤ 0.12 sobre el mismo fichero lee y escribe esas mismas
//   claves (rotar el refresh token, `login`, `repos add`, `aws add`) y el modelo v2 lo ve al instante: nunca hay
//   dos refresh tokens (uno ya rotado, cuyo uso el server tomaría por un replay).
// - lo solo-v2 va aparte: `platforms` (la legacy sin su credencial, que ya está arriba; cualquier otra con la
//   suya) y `resources` (los tipos que no son repo ni aws). un fichero cuya parte v2 es la de por defecto se
//   escribe sin ella y sin `version`: la config de siempre sigue siendo, byte a byte, la de siempre.
// - downgrade: desde 0.10.1 un daemon solo escribe sus claves y conserva el resto (lo solo-v2 sobrevive). uno
//   anterior reescribe el fichero entero con las suyas y se lleva por delante lo solo-v2; al volver, la legacy
//   arranca con sus valores por defecto (los de fromLegacy) y las otras plataformas, sin login.
// - fromLegacy no crea `aws.default`: la identidad aws por defecto la expone el usuario a mano.
// - ninguna parte v2 se acepta a medias: una plataforma con un id que no vale, un techo con shell:'full' sin
//   `trusted`, o repo/aws dentro de `resources` (viven en repos/aws) hacen la config inválida.
// - (M6.3) protocolo, pausa y cuota de cada plataforma: un protocolo desconocido es válido (la plataforma no
//   reclama, platforms/types.ts); la legacy solo habla el suyo.
// - (M6.4) issuer y nombre de cada plataforma, y el token endpoint de su credencial si no es el de siempre: solo en
//   el origen de su base (el refresh token no sale de él).

import type { RepoConfig, AwsAccountConfig, RunnerConfigV2, RunnerCredential, ResourcesConfig } from './config.js';
import { CONFIG_VERSION } from './config.js';
import { LEGACY_PLATFORM_ID, PLATFORM_ID_RE } from './paths.js';
import { sameSecureOrigin, urlOf } from './platforms/origin.js';
import { PROTOCOL } from './platforms/platform.js';
import { DEFAULT_CEILING, EXPOSE_ALL, LEGACY_CEILING, LEGACY_EXPOSE, SHELL, type Exposure, type PlatformConfig, type ToolsetCeiling } from './platforms/types.js';
import { ACCESS, RESOURCE_TYPE } from './resources/types.js';

/** tipo de recurso → la clave del fichero v1 donde vive (también en un fichero v2). */
export const LEGACY_RESOURCE_KEYS: Readonly<Record<string, 'repos' | 'aws'>> = { [RESOURCE_TYPE.repo]: 'repos', [RESOURCE_TYPE.aws]: 'aws' };

type Raw = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const invalid = (what: string): Error => new Error(`config v${CONFIG_VERSION} inválida: ${what}`);

// la credencial de una plataforma, solo si está entera (sin `login`, o tras `logout`, no hay).
function credentialOf(raw: Raw): RunnerCredential | undefined {
  const [baseUrl, clientId, refreshToken] = [str(raw.baseUrl), str(raw.clientId), str(raw.refreshToken)];
  if (!baseUrl || !clientId || !refreshToken) return undefined;
  const replacesClientId = str(raw.replacesClientId);
  return { baseUrl, clientId, refreshToken, ...(replacesClientId ? { replacesClientId } : {}) };
}

/** la legacy con lo de siempre: confiable, todo expuesto y el techo de hoy. */
export function legacyPlatform(credential?: RunnerCredential): PlatformConfig {
  return { ...(credential ? { credential } : {}), trusted: true, expose: LEGACY_EXPOSE, ceiling: LEGACY_CEILING };
}

/** modelo v2 de un fichero v1 (o de las claves v1 de uno v2). no crea `aws.default` ni nada que el fichero no diga. */
export function fromLegacy(raw: Raw): RunnerConfigV2 {
  const [label, machineId, machineHost] = [str(raw.label), str(raw.machineId), str(raw.machineHost)];
  return {
    version: CONFIG_VERSION,
    ...(label ? { label } : {}),
    ...(machineId ? { machineId } : {}),
    ...(machineHost ? { machineHost } : {}),
    resources: {
      [RESOURCE_TYPE.repo]: (isObj(raw.repos) ? raw.repos : {}) as Readonly<Record<string, RepoConfig>>,
      [RESOURCE_TYPE.aws]: (isObj(raw.aws) ? raw.aws : {}) as Readonly<Record<string, AwsAccountConfig>>,
    },
    platforms: { [LEGACY_PLATFORM_ID]: legacyPlatform(credentialOf(raw)) },
    defaults: isObj(raw.defaults) ? raw.defaults : {},
  };
}

function exposureOf(v: unknown, where: string): Exposure {
  if (v === EXPOSE_ALL) return EXPOSE_ALL;
  if (Array.isArray(v) && v.every((k) => typeof k === 'string')) return v as string[];
  throw invalid(`${where}: '${EXPOSE_ALL}' o una lista de claves`);
}

function ceilingOf(v: unknown, base: ToolsetCeiling, trusted: boolean, where: string): ToolsetCeiling {
  if (v === undefined) {
    // sin techo propio vale el de por defecto, pero quitarle `trusted` a la legacy también exige bajarle la shell.
    if (base.shell === SHELL.full && !trusted) throw invalid(`${where}.shell '${SHELL.full}' solo en una plataforma trusted`);
    return base;
  }
  if (!isObj(v)) throw invalid(`${where} no es un objeto`);
  const shells: readonly unknown[] = Object.values(SHELL);
  const levels: readonly unknown[] = Object.values(ACCESS);
  const flag = (k: keyof ToolsetCeiling): boolean => {
    if (v[k] === undefined) return base[k] as boolean;
    if (typeof v[k] !== 'boolean') throw invalid(`${where}.${k} no es booleano`);
    return v[k] as boolean;
  };
  const shell = v.shell ?? base.shell;
  if (!shells.includes(shell)) throw invalid(`${where}.shell: ${shells.join(' | ')}`);
  if (shell === SHELL.full && !trusted) throw invalid(`${where}.shell '${SHELL.full}' solo en una plataforma trusted`);
  const access = v.access ?? base.access;
  if (!isObj(access) || !Object.values(access).every((a) => levels.includes(a))) throw invalid(`${where}.access: ${levels.join(' | ')} por tipo`);
  return {
    shell: shell as ToolsetCeiling['shell'],
    fsWrite: flag('fsWrite'),
    memory: flag('memory'),
    web: flag('web'),
    vcsPush: flag('vcsPush'),
    access: access as ToolsetCeiling['access'],
    platformTools: v.platformTools === undefined ? base.platformTools : exposureOf(v.platformTools, `${where}.platformTools`),
  };
}

// una plataforma del fichero sobre sus valores por defecto (los de la legacy o los de una nueva).
function platformOf(id: string, v: unknown, base: PlatformConfig): PlatformConfig {
  const where = `platforms.${id}`;
  if (!PLATFORM_ID_RE.test(id)) throw invalid(`${where}: id de plataforma no válido`);
  if (!isObj(v)) throw invalid(`${where} no es un objeto`);
  const legacy = id === LEGACY_PLATFORM_ID;
  if (legacy && v.credential !== undefined) throw invalid(`${where}.credential: la de ${LEGACY_PLATFORM_ID} vive en baseUrl/clientId/refreshToken`);
  const own = !legacy && isObj(v.credential) ? credentialOf(v.credential) : undefined;
  if (!legacy && v.credential !== undefined && !own) throw invalid(`${where}.credential incompleta (baseUrl, clientId, refreshToken)`);
  const tokenEndpoint = own && isObj(v.credential) ? str(v.credential.tokenEndpoint) : undefined;
  if (own && tokenEndpoint && !sameSecureOrigin(tokenEndpoint, own.baseUrl)) throw invalid(`${where}.credential.tokenEndpoint fuera del origen de su baseUrl`);
  const credential = legacy ? base.credential : own && { ...own, ...(tokenEndpoint ? { tokenEndpoint } : {}) };
  if (v.issuer !== undefined && (typeof v.issuer !== 'string' || !urlOf(v.issuer))) throw invalid(`${where}.issuer no es una url`);
  if (v.name !== undefined && (typeof v.name !== 'string' || !v.name)) throw invalid(`${where}.name no es un texto`);
  if (v.trusted !== undefined && typeof v.trusted !== 'boolean') throw invalid(`${where}.trusted no es booleano`);
  const trusted = (v.trusted as boolean | undefined) ?? base.trusted;
  if (v.expose !== undefined && !isObj(v.expose)) throw invalid(`${where}.expose no es un objeto`);
  const expose = isObj(v.expose) ? Object.fromEntries(Object.entries(v.expose).map(([type, keys]) => [type, exposureOf(keys, `${where}.expose.${type}`)])) : base.expose;
  if (v.protocol !== undefined && (typeof v.protocol !== 'string' || !v.protocol)) throw invalid(`${where}.protocol no es un texto`);
  if (legacy && v.protocol !== undefined && v.protocol !== PROTOCOL.duckhunt42) throw invalid(`${where}.protocol: ${LEGACY_PLATFORM_ID} solo habla ${PROTOCOL.duckhunt42}`);
  if (v.paused !== undefined && typeof v.paused !== 'boolean') throw invalid(`${where}.paused no es booleano`);
  if (v.slots !== undefined && !(typeof v.slots === 'number' && Number.isSafeInteger(v.slots) && v.slots >= 1)) throw invalid(`${where}.slots: un entero desde 1`);
  if (v.label !== undefined && (typeof v.label !== 'string' || !v.label.trim())) throw invalid(`${where}.label no es un texto`);
  if (v.budgetUsdPerDay !== undefined && !(typeof v.budgetUsdPerDay === 'number' && Number.isFinite(v.budgetUsdPerDay) && v.budgetUsdPerDay >= 0)) {
    throw invalid(`${where}.budgetUsdPerDay: un número desde 0`);
  }
  if (v.runsPerDay !== undefined && !(typeof v.runsPerDay === 'number' && Number.isSafeInteger(v.runsPerDay) && v.runsPerDay >= 0)) throw invalid(`${where}.runsPerDay: un entero desde 0`);
  return {
    ...(credential ? { credential } : {}),
    trusted,
    expose,
    ceiling: ceilingOf(v.ceiling, base.ceiling, trusted, `${where}.ceiling`),
    ...(v.protocol !== undefined ? { protocol: v.protocol as string } : {}),
    ...(v.paused !== undefined ? { paused: v.paused as boolean } : {}),
    ...(v.slots !== undefined ? { slots: v.slots as number } : {}),
    ...(v.issuer !== undefined ? { issuer: v.issuer as string } : {}),
    ...(v.name !== undefined ? { name: v.name as string } : {}),
    ...(v.label !== undefined ? { label: v.label as string } : {}),
    ...(v.budgetUsdPerDay !== undefined ? { budgetUsdPerDay: v.budgetUsdPerDay as number } : {}),
    ...(v.runsPerDay !== undefined ? { runsPerDay: v.runsPerDay as number } : {}),
  };
}

const newPlatform: PlatformConfig = { trusted: false, expose: {}, ceiling: DEFAULT_CEILING };

/** modelo v2 de un fichero: v1 (sin `version`) vía fromLegacy; v2, sus claves v1 más lo solo-v2. */
export function fromFile(raw: Raw): RunnerConfigV2 {
  const base = fromLegacy(raw);
  if (raw.version === undefined) return base;
  if (raw.version !== CONFIG_VERSION) throw new Error(`config de otra versión (version ${JSON.stringify(raw.version)}): este runner lee hasta la ${CONFIG_VERSION}, actualízalo`);
  if (raw.platforms !== undefined && !isObj(raw.platforms)) throw invalid('platforms no es un objeto');
  if (raw.resources !== undefined && !isObj(raw.resources)) throw invalid('resources no es un objeto');
  const platforms = Object.entries(isObj(raw.platforms) ? raw.platforms : {}).map(([id, v]) => [id, platformOf(id, v, base.platforms[id] ?? newPlatform)] as const);
  const resources = Object.entries(isObj(raw.resources) ? raw.resources : {}).map(([type, entries]) => {
    if (Object.hasOwn(LEGACY_RESOURCE_KEYS, type)) throw invalid(`resources.${type}: vive en ${LEGACY_RESOURCE_KEYS[type]}`);
    if (!isObj(entries)) throw invalid(`resources.${type} no es un objeto`);
    return [type, entries] as const;
  });
  return { ...base, resources: { ...base.resources, ...Object.fromEntries(resources) }, platforms: { ...base.platforms, ...Object.fromEntries(platforms) } };
}

/**
 * el fichero de un modelo v2: TODAS sus claves (undefined = ausente, para que un parche la quite). las v1 donde
 * siempre; lo solo-v2 y `version`, solo si difiere de lo que fromLegacy daría (ver cabecera).
 */
export function fileOf(cfg: RunnerConfigV2): Record<string, unknown> {
  const legacy = cfg.platforms[LEGACY_PLATFORM_ID];
  const credential = legacy?.credential;
  const { credential: _, ...legacySettings } = legacy ?? legacyPlatform();
  const { credential: __, ...defaults } = legacyPlatform();
  const platforms = Object.fromEntries([
    ...(sameJson(legacySettings, defaults) ? [] : [[LEGACY_PLATFORM_ID, legacySettings] as const]),
    ...Object.entries(cfg.platforms).filter(([id]) => id !== LEGACY_PLATFORM_ID),
  ]);
  const resources: ResourcesConfig = Object.fromEntries(Object.entries(cfg.resources).filter(([type, entries]) => !Object.hasOwn(LEGACY_RESOURCE_KEYS, type) && Object.keys(entries).length > 0));
  const extra = Object.keys(platforms).length > 0 || Object.keys(resources).length > 0;
  return {
    baseUrl: credential?.baseUrl,
    clientId: credential?.clientId,
    refreshToken: credential?.refreshToken,
    replacesClientId: credential?.replacesClientId,
    label: cfg.label,
    machineId: cfg.machineId,
    machineHost: cfg.machineHost,
    repos: cfg.resources[RESOURCE_TYPE.repo] ?? {},
    aws: cfg.resources[RESOURCE_TYPE.aws] ?? {},
    defaults: cfg.defaults,
    version: extra ? CONFIG_VERSION : undefined,
    platforms: Object.keys(platforms).length > 0 ? platforms : undefined,
    resources: Object.keys(resources).length > 0 ? resources : undefined,
  };
}

/** el parche que lleva el fichero de `before` a `after`: solo las claves que cambian (como saveConfig). */
export function filePatch(before: RunnerConfigV2, after: RunnerConfigV2): Record<string, unknown> {
  const [a, b] = [fileOf(before), fileOf(after)];
  return Object.fromEntries(Object.keys({ ...a, ...b }).filter((k) => !sameJson(a[k], b[k])).map((k) => [k, b[k]]));
}
