// subcomandos `duckhunt-runner platforms ...` (t#495, M6.4): las plataformas de esta máquina en la config v2. `list`
// nunca habla con un server; `remove` sí (desvincula antes de borrar). toda edición va por saveConfigV2 (solo las
// claves que cambian) y el daemon en marcha la recoge en su recarga.
// decisiones:
// - duckhunt (la legacy) se lista, se pausa y se le edita la exposición, pero no se quita (`logout` la desvincula)
//   ni deja de ser trusted: en su cable su techo no se aplica hasta toolset_v1, así que quitarle la confianza no la
//   acotaría.
// - expose/unexpose: una clave que esta máquina no mapea no se expone (`resource list`); `*` = todas las de ese
//   tipo, las de ahora y las que se mapeen después. una exposición con `*` no se recorta clave a clave.
// - untrust baja una shell entera del techo a la de lectura (solo una trusted puede tenerla) y lo dice.
// - remove deja sus directorios (scratch, logs, worktrees): pueden guardar trabajo; se dice dónde están.
// - (M7) la local (`runner run`) existe sin entrada en la config, con sus valores por defecto: editarla (expose, pausa,
//   confianza) crea su entrada; no tiene server ni credencial.

import { configPath, loadConfigV2, saveConfigV2, type RunnerConfigV2 } from './config.js';
import { reportUnpair, unpairPlatform } from './logout.js';
import { LEGACY_PLATFORM_ID, LOCAL_PLATFORM_ID, platformHome } from './paths.js';
import { PROTOCOL } from './platforms/platform.js';
import { EXPOSE_ALL, LOCAL_PLATFORM_DEFAULTS, PLATFORM_DEFAULT_SLOTS, SHELL, type Exposure, type PlatformConfig } from './platforms/types.js';
import { clearServerState } from './server-state.js';

const USAGE = `uso:
  duckhunt-runner platforms list
  duckhunt-runner platforms pause|resume <id>
  duckhunt-runner platforms remove <id>
  duckhunt-runner platforms expose|unexpose <id> <tipo> <clave|${EXPOSE_ALL}>
  duckhunt-runner platforms trust|untrust <id>
`;

const SUB = {
  list: 'list',
  pause: 'pause',
  resume: 'resume',
  remove: 'remove',
  expose: 'expose',
  unexpose: 'unexpose',
  trust: 'trust',
  untrust: 'untrust',
} as const;

// argumentos de cada subcomando: <sub> <id>, y expose/unexpose además <tipo> <clave>.
const ARGS_WITH_ID = 2;
const ARGS_WITH_KEY = 4;

const fail = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};

// la legacy primero; el resto por id.
const ordered = (platforms: RunnerConfigV2['platforms']): [string, PlatformConfig][] =>
  Object.entries(platforms).sort(([a], [b]) => (a === LEGACY_PLATFORM_ID ? -1 : b === LEGACY_PLATFORM_ID ? 1 : a.localeCompare(b)));

const exposureText = (keys: Exposure): string => (keys === EXPOSE_ALL ? EXPOSE_ALL : keys.join(', '));

/** las líneas de `list` de una plataforma: id, protocolo, a quién habla, confianza, estado, cuota y lo que ve. */
export function describePlatform(id: string, p: PlatformConfig): string[] {
  const legacy = id === LEGACY_PLATFORM_ID;
  const local = id === LOCAL_PLATFORM_ID;
  const protocol = p.protocol ?? (legacy ? PROTOCOL.duckhunt42 : local ? PROTOCOL.local : 'sin protocolo');
  const where = local ? 'esta máquina' : (p.issuer ?? p.credential?.baseUrl ?? 'sin login');
  const state = !p.credential && !local ? 'sin credencial' : p.paused ? 'en pausa' : 'activa';
  const slots = p.slots ?? (legacy ? 'todo el pool' : PLATFORM_DEFAULT_SLOTS);
  const exposed = Object.entries(p.expose).map(([type, keys]) => `${type} ${exposureText(keys)}`);
  return [
    `${id}${p.name ? ` "${p.name}"` : ''} · ${protocol} · ${where} · ${p.trusted ? 'trusted' : 'no trusted'} · ${state} · slots ${slots}`,
    `  expone: ${exposed.length > 0 ? exposed.join(' · ') : 'nada'}`,
  ];
}

// la plataforma `id` de la config; la local, con sus valores por defecto aunque no tenga entrada.
const platformIn = (cfg: RunnerConfigV2, id: string): PlatformConfig | undefined =>
  Object.hasOwn(cfg.platforms, id) ? cfg.platforms[id] : id === LOCAL_PLATFORM_ID ? LOCAL_PLATFORM_DEFAULTS : undefined;

// escribe la plataforma `id` tal como la deja `update`, calculada sobre el fichero de AHORA.
function save(id: string, update: (p: PlatformConfig) => PlatformConfig): void {
  saveConfigV2((cfg) => {
    const current = platformIn(cfg, id);
    return current ? { ...cfg, platforms: { ...cfg.platforms, [id]: update(current) } } : null;
  });
}

function setPaused(id: string, p: PlatformConfig, paused: boolean): void {
  if ((p.paused === true) === paused) return void console.log(`${id} ${paused ? 'ya está en pausa' : 'no está en pausa'}`);
  save(id, ({ paused: _, ...rest }) => (paused ? { ...rest, paused: true } : rest));
  console.log(paused ? `${id} en pausa: no reclama; sus runs en marcha acaban` : `${id} reanudada`);
}

async function remove(id: string, p: PlatformConfig): Promise<void> {
  if (id === LEGACY_PLATFORM_ID) return fail(`${LEGACY_PLATFORM_ID} no se quita: \`duckhunt-runner logout\` la desvincula y borra su credencial`);
  if (p.credential) reportUnpair(id, await (unpairPlatform(id, p.credential, p.protocol) ?? Promise.resolve(null)), p.protocol);
  saveConfigV2((cfg) => {
    if (!Object.hasOwn(cfg.platforms, id)) return null;
    const { [id]: _, ...platforms } = cfg.platforms;
    return { ...cfg, platforms };
  });
  clearServerState(id);
  console.log(`${id} quitada de ${configPath()}. sus directorios se quedan (pueden guardar trabajo): ${platformHome(id)}`);
}

function expose(cfg: RunnerConfigV2, id: string, p: PlatformConfig, type: string, key: string): void {
  const current = Object.hasOwn(p.expose, type) ? p.expose[type] : undefined;
  if (current === EXPOSE_ALL) return void console.log(`${id} ya ve todos sus ${type} (${EXPOSE_ALL})`);
  if (key !== EXPOSE_ALL && !Object.hasOwn(cfg.resources[type] ?? {}, key)) return fail(`${type} ${key} no está mapeado en esta máquina (\`duckhunt-runner resource list\`)`);
  if (key !== EXPOSE_ALL && current?.includes(key)) return void console.log(`${id} ya ve ${type} ${key}`);
  const next: Exposure = key === EXPOSE_ALL ? EXPOSE_ALL : [...(current ?? []), key].sort();
  save(id, (q) => ({ ...q, expose: { ...q.expose, [type]: next } }));
  console.log(`${id} ve ahora ${type} ${exposureText(next)}`);
}

function unexpose(id: string, p: PlatformConfig, type: string, key: string): void {
  const current = Object.hasOwn(p.expose, type) ? p.expose[type] : undefined;
  if (current === undefined) return void console.log(`${id} no ve ningún ${type}`);
  if (key !== EXPOSE_ALL && current === EXPOSE_ALL) {
    return fail(`${id} ve todos sus ${type} (${EXPOSE_ALL}): quítalo con \`duckhunt-runner platforms unexpose ${id} ${type} ${EXPOSE_ALL}\` y expón uno a uno los que quieras`);
  }
  if (key !== EXPOSE_ALL && !(current as readonly string[]).includes(key)) return void console.log(`${id} no ve ${type} ${key}`);
  const left = key === EXPOSE_ALL ? [] : (current as readonly string[]).filter((k) => k !== key);
  save(id, (q) => {
    const { [type]: _, ...rest } = q.expose;
    return { ...q, expose: left.length > 0 ? { ...rest, [type]: left } : rest };
  });
  console.log(left.length > 0 ? `${id} ve ahora ${type} ${left.join(', ')}` : `${id} ya no ve ningún ${type}`);
}

function setTrusted(id: string, p: PlatformConfig, trusted: boolean): void {
  if (id === LEGACY_PLATFORM_ID && !trusted) {
    return fail(`${LEGACY_PLATFORM_ID} sigue trusted: en su cable su techo no se aplica hasta toolset_v1, así que quitarle la confianza no la acotaría`);
  }
  if (p.trusted === trusted) return void console.log(`${id} ${trusted ? 'ya es trusted' : 'ya no es trusted'}`);
  const lowered = !trusted && p.ceiling.shell === SHELL.full;
  save(id, (q) => ({ ...q, trusted, ...(lowered ? { ceiling: { ...q.ceiling, shell: SHELL.read } } : {}) }));
  console.log(`${id} ${trusted ? 'es trusted' : 'ya no es trusted'}`);
  if (lowered) console.log(`su techo baja de shell entera a shell de lectura (solo una plataforma trusted puede tenerla)`);
  if (!trusted && p.protocol === PROTOCOL.duckhunt42) console.warn(`aviso: una plataforma ${PROTOCOL.duckhunt42} sin trusted no reclama: en ese cable su techo no se aplica`);
}

export async function platformsCommand(args: string[]): Promise<void> {
  const [sub, id, type, key] = args;
  const cfg = loadConfigV2();
  if (!cfg) return fail(`sin config (${configPath()}): ejecuta \`duckhunt-runner login\` primero`);
  if (sub === SUB.list && id === undefined) {
    ordered(cfg.platforms).forEach(([pid, p]) => describePlatform(pid, p).forEach((line) => console.log(line)));
    return;
  }
  const arity = sub === SUB.expose || sub === SUB.unexpose ? ARGS_WITH_KEY : ARGS_WITH_ID;
  if (sub === undefined || !Object.values(SUB).includes(sub as (typeof SUB)[keyof typeof SUB]) || sub === SUB.list || args.length !== arity) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const p = platformIn(cfg, id!);
  if (!p) return fail(`no hay ninguna plataforma ${id} en ${configPath()} (\`duckhunt-runner platforms list\`)`);
  if ((sub === SUB.expose || sub === SUB.unexpose) && !Object.hasOwn(cfg.resources, type!)) {
    return fail(`tipo de recurso desconocido: ${type} (${Object.keys(cfg.resources).join(', ')})`);
  }
  if (sub === SUB.pause || sub === SUB.resume) return setPaused(id!, p, sub === SUB.pause);
  if (sub === SUB.remove) return remove(id!, p);
  if (sub === SUB.expose) return expose(cfg, id!, p, type!, key!);
  if (sub === SUB.unexpose) return unexpose(id!, p, type!, key!);
  return setTrusted(id!, p, sub === SUB.trust);
}
