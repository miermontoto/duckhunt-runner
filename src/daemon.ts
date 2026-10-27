// loop del daemon (contrato 42 + prompts libres t#378): reclama runs por poll, lanza `claude -p`
// headless en un worktree del checkout del repo (o en el scratch dir si no hay repo) con el mcp de
// duckhunt adjunto y el perfil de tools del claim, sube el feed de progreso y reporta el cierre.
// hasta `defaults.maxConcurrent` runs a la vez (slots, default 1): el cómputo es la máquina del
// usuario. el server nunca ve paths ni perfiles — el mapa repo→checkout y cuenta→perfil vive en la
// config local.
// decisiones:
// - claude corre en su PROPIO grupo de procesos (detached): cancelar, el timeout o parar el daemon
//   matan también lo que lanzó la tool Bash (tests, servidores). por eso el daemon instala sus
//   handlers de SIGINT/SIGTERM: ctrl-c ya no le llega al hijo por la terminal.
// - kind=prompt usa un worktree POR CONVERSACIÓN que sobrevive entre segmentos (resources/repo/worktree.ts); lo
//   recoge resources/repo/gc.ts en el loop de claim. los kinds de reglas heredados (servers anteriores a
//   t#465 P6, que ya manda toda conversación como prompt run) siguen con su worktree efímero.
//   si el usuario abrió la conversación en el checkout (run.isolation, 0.6.0), corre en el checkout
//   tal cual, sin worktree, y se turna con los demás runs de ese checkout (cwdLocks).
// - runs en paralelo (r#105): el server ya reclama atómicamente y una conversación es UNA fila, así
//   que nunca corre dos veces a la vez. lo compartido en la máquina se serializa aquí: git sobre un
//   mismo checkout (gitLocks: preparar, borrar, gc) y el cwd de los runs no aislados (cwdLocks:
//   checkout con `worktree: false`, scratch en perfil edit). el latido arranca en el claim
//   (run-lease.ts), así un run que espera turno sigue vivo para el server.
// - el worktree de un run se toca (touch / borrado) ANTES de reportar el status: el server puede
//   re-encolar la misma fila al recibirlo y otro slot la reclamaría sobre el worktree que se borra.
// - el feed (event-uploader.ts) se vacía ANTES de reportar el status: el server rechaza eventos de
//   un run cerrado. igual el diff del turno (t#514, turn-changes.ts): si el claim trae `changes`, foto del árbol
//   tras tomar el turno del cwd y otra antes de soltar los recursos (el worktree puede borrarse); su diff se sube
//   tras el feed y antes del status, y un fallo solo se loguea.
// - volver atrás (0.17.0, t#564): con `restore` en el claim, el worktree vuelve a esa foto (rewind-files.ts) ANTES de
//   la foto de turn-changes, ya con el turno del cwd tomado; si no puede, el segmento falla con REWIND_RESTORE_ERROR y
//   claude no se lanza. el status lleva la foto del inicio (startTree, la de turn-changes) con su HEAD, y el uuid del
//   último mensaje del asistente; con `run.resumeAt`, la reanudación va en una sesión nueva desde ese mensaje.
// - el segmento del claim viaja en heartbeat/progress/events/status: es lo que distingue a ESTE
//   proceso del siguiente turno de la misma fila. el latido mata claude en cuanto el run deja de ser
//   suyo (cancelado, re-encolado tras detenerlo, dado por fallido, borrado → 404, reclamado por otro
//   segmento), no solo con `cancel`: un proceso detenido no puede seguir 30 min con Bash.
// - salud de los repos mapeados (resources/repo/health.ts, t#463): el primer chequeo se ESPERA al arrancar (el
//   primer claim ya la lleva) y luego se refresca en segundo plano sin frenar el claim. se imprime
//   al cambiar y viaja en cada claim como `repoIssues` + `repoCandidates` (sin paths). si la
//   respuesta del claim trae la cabecera de comandos pendientes, el daemon los pide, los aplica a SU
//   config (repo-commands.ts), la guarda, re-chequea y reporta; luego reclama ya para que la
//   presencia nueva llegue sin esperar al poll.
// - config en caliente (0.10.1): en cada vuelta del loop (antes del claim, y también con los slots
//   llenos) relee el fichero (solo si su texto cambió) y toma mapas, etiqueta y defaults (slots
//   incluidos), así `repos add`, `aws add` o una edición a mano valen sin reiniciar; si cambian los
//   repos, re-chequea su salud antes del claim. la credencial NO se recarga: vive en memoria y solo
//   la cambia el refresh (oauth.ts). un `login` nuevo de la misma instancia (otro clientId) o un
//   refresh rotado que no se pudo guardar fuerzan un refresh, que adopta o reescribe lo que toca. al
//   guardar, el daemon solo escribe sus claves (config.ts).
// - sandbox de lectura (0.10.2, t#465): el mcp-config de cada segmento (token per-run) va a
//   <runnerHome>/run-config/ (0700) y todo kit niega Read de ese directorio (run-mcp-config.ts); al
//   arrancar se borran los que dejó un daemon muerto. y antes de cada segmento con shell de lectura se
//   revisan los symlinks commiteados del cwd: si alguno sale de él, ese segmento va sin shell
//   (read-shell-guard.ts; los paths solo al log local, al feed el recuento).
// - ciclo de vida (0.11.0, t#465 P12): reclama con el machine id de la config (machine.ts; lo genera al
//   arrancar si no lo hay) y, hasta su primer claim aceptado, con el client_id que su `login` reemplaza:
//   duckhunt adopta así la fila de esta máquina en vez de dejar una fantasma. guarda lo que el server dice
//   de ella (bloque runner, motivo de la cabecera, worktrees conservados) en server-state.json para
//   `status`. con todos los slots ocupados el loop no reclama: la adopción de un `login` llega con el
//   siguiente claim (al liberarse uno); mientras, los latidos ya van con la credencial nueva. si el refresh
//   de la credencial se rechaza (desvinculada desde duckhunt o con `logout`, revocada o caducada), lo vea el
//   claim o el latido de un run, para: corta sus runs, no reintenta y sale con EXIT_CODE_UNPAIRED (un
//   servicio puede no reiniciarlo con ese código: sin `login` no vuelve). además borra esa credencial del
//   fichero (t#510): desvincular desde la web hace en la máquina lo mismo que `logout`, sin ir a ella.
// - endurecimiento de lectura (0.11.0): secret_paths (secret-paths.ts) al deny de todo kit de lectura,
//   aws_strict (resources/aws.ts: una cuenta sin mapear corre con la aws vacía) y seed_budget (claude-args.ts).
//   el gc anuncia en cada claim lo que conservó por guardar trabajo (worktree_report, recuentos; una
//   conversación que vuelve a reclamarse deja de anunciarse en el acto, sin esperar al siguiente gc). al
//   arrancar barre una vez los mcp-config que los daemons < 0.10.2 dejaban en el tmpdir.
// - ids de run opacos (t#495, M1): por dentro todo id es texto (run-id.ts); el cable legacy sigue idéntico
//   byte a byte. las rutas /runs/<id> salen con el mismo texto y los dos cuerpos que llevan ids
//   (/conversations y keptWorktrees del claim) los pasan a número con legacyWireRunId, que lanza si le llega
//   uno opaco: antes se filtran con isLegacyRunId (un worktree con id opaco solo lo recoge el ttl).
// - modelo por run (0.12.0, t#465): anuncia `model` si el cli lista --model (announced-capabilities.ts)
//   y pasa a claude el del claim; sin él, `defaults.model` de la config; sin ninguno, el default del cli.
//   el claim manda sobre la config porque es la elección de la persona para esa conversación (su
//   default de ajustes, el composer, el hilo o la acción de una regla); la config queda como el default
//   de la máquina. también al reanudar: --model con --resume cambia el modelo de la sesión desde ese
//   turno, y el reintento desde cero usa el mismo. el modelo que se reporta en /status es el que de
//   verdad usó el bucle principal (claude.ts::reportedModel).
// - recursos (t#495, M2): el cwd del run (y lo que se suelta al cerrar) sale del ciclo de vida de recursos
//   (resources/lifecycle.ts) con las peticiones que se derivan del claim legacy (resources/legacy.ts): todo o
//   nada, al revés al soltar, y los turnos exclusivos ordenados. el plan que ve claude es el de siempre
//   (test/spawn-plan.test.ts lo fija byte a byte).
// - toolset_v1 en sombra (t#495, M5): con `toolset_v1` anunciado, el claim puede traer `toolset`. el daemon lo corta
//   con el techo de la plataforma, lo renderiza (toolset/) y lo compara con las listas del claim, que siguen
//   mandando; el resultado va en el status del segmento (toolsetShadow) y lo que no casa, al log. claim.toolset
//   sigue null: un toolset en sombra no aísla la aws ni cambia nada del spawn.
// - el flip (t#495, M5, `toolset_render`): por defecto ese toolset MANDA (enforceToolset → toolset/legacy-render.ts):
//   las listas del render, los recursos de sus grants y la aws aislada sin grant; las del server pasan a ser la
//   comparación. `defaults.toolsetRender: false` vuelve a la sombra de arriba (el cable y los runs sin el flip). al
//   arrancar avisa si la máquina tiene aws y duckhunt no ve su identidad por defecto (`resource add aws default`):
//   un run sin cuenta ya no la hereda.
// - plataformas (t#495, M6): todo lo que el daemon le dice a duckhunt pasa por el seam de plataforma
//   (platforms/platform.ts): el cable legacy y su credencial viven en platforms/duckhunt42.ts y
//   platforms/http-transport.ts, con los mismos cuerpos y respuestas (test/wire-legacy.test.ts,
//   test/wire-responses.test.ts). cada plataforma tiene su supervisor (platforms/supervisor.ts) con su
//   propio poll, sus runs y su server-state; los slots de la máquina se reparten con el scheduler
//   (platforms/scheduler.ts: pool global + cuota por plataforma, reservar antes de reclamar). una credencial
//   muerta para SOLO esa plataforma; el daemon sale con EXIT_CODE_UNPAIRED cuando no queda ninguna usable.
//   con una sola plataforma con todo el pool es el loop de siempre.
// - plataformas en la config (t#495, M6.3): los supervisores salen de `platforms` de la config v2 y se ajustan
//   en cada vuelta (alta, pausa, retirada, otra credencial). la de duckhunt sigue con su credencial en las claves
//   de siempre; otra, en su entrada (platforms/credentials.ts), y cada una rota y guarda solo la suya. una sin
//   credencial o con un protocolo que este runner no habla se avisa y no reclama. cuota de slots por plataforma
//   (la legacy, todo el pool; una nueva, PLATFORM_DEFAULT_SLOTS) y lo que ve de la máquina, su `expose` (lo que
//   anuncia y lo que un run suyo puede usar; la legacy, todo). una que no es la legacy corre con la aws aislada,
//   sin machine id (M6.5) y sin comandos de repos.
// - deny de todo kit por segmento (t#495): el run-config de todas las plataformas con estado en disco, el scratch
//   de las demás y lo privado de las demás (su estado y su auditoría), recalculados al lanzar cada segmento y
//   añadidos detrás del deny de siempre: una plataforma añadida en caliente queda cubierta y, con una sola, el deny
//   de la legacy no cambia.
// - reparto justo (t#495, M6.5): un slot que se libera se ofrece a la siguiente plataforma en round-robin de las que
//   esperan uno (platforms/scheduler.ts), y una sin trabajo pasa el turno en el acto. a una plataforma que no es la
//   legacy se le anuncia un machine id derivado (machine.ts: HMAC del secreto de la máquina y su emisor) y su
//   etiqueta propia si la tiene. sus líneas del log van con `[runner:<id>]`; las de la legacy, como siempre.
// - auditoría local (t#495, M6.6, audit.ts): claimed, rejected y closed de cada plataforma en
//   <runnerHome>/audit/<id>/, sin prompts, resultados, argumentos, paths ni tokens; podada al arrancar y a diario.
//   la cuota diaria de una plataforma (budgetUsdPerDay, runsPerDay) se cuenta ahí: agotada, no reclama hasta
//   medianoche (estado budget).
// - plataforma local (t#495, M7, platforms/local.ts): el daemon la aloja y la sirve en local.sock (local/socket.ts)
//   para `runner run`; sus runs comparten slots, cuota, lock de git y auditoría con los demás. no cuenta para el exit
//   78 (no tiene credencial que muera), no sale de la config y su estado solo entra en el deny de las demás desde que
//   existe en disco. sin daemon, `runner run` arranca este mismo núcleo solo con ella (localOnly): sin duckhunt ni
//   las demás de la config, sin socket ni señales propias (las lleva el cli).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  concurrency,
  configPath,
  mergeEntries,
  parseConfig,
  parseConfigV2,
  parseStoredConfig,
  readConfigText,
  saveConfig,
  splitConfig,
  type LocalConfig,
  type RunnerConfig,
  type RunnerConfigV2,
  type RunnerCredential,
  type StoredConfig,
} from './config.js';
import { derivedMachineId, ensureMachineId, ensureMachineSecret } from './machine.js';
import { browserVaultDeny, otherPlatformsDeny, otherScratchDeny, secretPathsDeny } from './secret-paths.js';
import { CLAIM_OUTCOME } from './server-state.js';
import { consumeStreamLine, detectClaude, newStreamState, supportsPermissionPromptTool, supportsRewind, type ClaudeInfo } from './claude.js';
import { buildClaudeArgs, claudeRunEnv } from './claude-args.js';
import { announcedCapabilities } from './announced-capabilities.js';
import { mirroredDeny, READ_MIRRORED_TOOLS, settingsFilesFor, WRITE_TOOLS } from './user-permissions.js';
import { canBypassPermissions, EVENTS_DEFAULTS, PROMPT_PROFILE, RUN_ISOLATION, RUN_KIND, type ClaimResponse } from './claim.js';
import { EventUploader } from './event-uploader.js';
import { clip, feedEventsFromStream, systemEvent, type FeedContext } from './feed.js';
import { scrubEnv } from './scrub-env.js';
import { reportFor, type Attempt, type KillReason, type StatusReport } from './status-report.js';
import { snapshotTree, turnChanges } from './turn-changes.js';
import { headOf, restoreTree } from './rewind-files.js';
import { AuditLog, AUDIT_OUTCOME, claimedRecord, closedRecord, DAY_MS, nextMidnight, outcomeCode, pruneAudit, rejectedRecord, retentionDays, toolsetSummary, type AttemptFacts, type AuditSubject, type ClaimedRecord } from './audit.js';
import { readShellGuard, readShellLog, readShellNote } from './read-shell-guard.js';
import { clearLegacyTmpConfigs, clearRunMcpConfigs, permissionMcpServers, runConfigDeny, writeRunMcpConfig } from './run-mcp-config.js';
import { CONVERSATION_GC_INTERVAL_MS, listWorktreeCandidates, removeWorktrees, selectForRemoval, type WorktreeCandidate } from './resources/repo/gc.js';
import { KeyedMutex } from './keyed-mutex.js';
import { describeFinding, REPO_HEALTH_INTERVAL_MS, repoChoices, repoFindings, repoIssues, scanRepos, type RepoChoice, type RepoIssue } from './resources/repo/health.js';
import { ProviderRegistry } from './resources/registry.js';
import { holdLocks, materializeRun, type MaterializedRun, type RunMcp } from './resources/lifecycle.js';
import { browserProvider } from './resources/browser/provider.js';
import { vaultDirOf, type BrowserRef, type ProvidersConfig } from './resources/browser/config.js';
import { BROWSER_HEALTH_INTERVAL_MS, browserHealth, PROBE_MODE, type BrowserFinding } from './resources/browser/health.js';
import { detectOdysea, type OdyseaDetection } from './resources/browser/odysea-cli.js';
import { legacyRequests, legacyResourceError, legacyScratchExclusive } from './resources/legacy.js';
import { repoProvider } from './resources/repo/provider.js';
import { AWS_ACCOUNT_ID_RE, AWS_DEFAULT_KEY, awsProvider, machineHasAws } from './resources/aws.js';
import { LEGACY_RESOURCE_KEYS, legacyPlatform } from './config-legacy.js';
import { RELEASE, RESOURCE_TYPE, ResourceUnavailableError, type ReleaseOutcome } from './resources/types.js';
import { applyRepoCommand, type RepoCommandResult } from './repo-commands.js';
import { RunLease, signalGroup } from './run-lease.js';
import { compareRunIds } from './run-id.js';
import { allRunConfigDirs, LEGACY_PLATFORM_ID, LOCAL_PLATFORM_ID, logsDir, platformHome, runConfigDir, scratchDir, slashCommandsPath } from './paths.js';
import { claudeConfigDir, resolveSlashCommands, SlashCommandCatalog } from './slash-commands.js';
import { runnerVersion } from './version.js';
import { PlatformRejectedError, PROTOCOL, type ClaimAnnounce, type Platform, type PlatformContext, type PlatformFactories, type Protocol, type RunSegment } from './platforms/platform.js';
import { DEFAULT_CEILING, EXPOSE_ALL, isExposed, LOCAL_PLATFORM_DEFAULTS, PLATFORM_DEFAULT_SLOTS, type PlatformConfig } from './platforms/types.js';
import { credentialStore } from './platforms/credentials.js';
import { PLATFORM_FACTORIES } from './platforms/factories.js';
import { Scheduler } from './platforms/scheduler.js';
import { PLATFORM_STATE, PlatformSupervisor, type SupervisorHooks } from './platforms/supervisor.js';
import { REWIND_RESTORE_ERROR, RUNNER_LABEL_MAX_CHARS, type ToolsetShadow } from './vendor/runner-protocol/index.js';
import { shadowOf } from './toolset/shadow.js';
import { intersectToolset } from './toolset/intersect.js';
import { v0Announce } from './platforms/v0.js';
import { CLAIM_REJECT, ClaimRejectedError } from './platforms/claim-v0.js';
import { renderLegacyClaim } from './toolset/legacy-render.js';
import { LocalPlatform } from './platforms/local.js';
import { evaluateRequest, type LocalRequest } from './local/policy.js';
import { serveLocal, type LocalEvaluation } from './local/socket.js';

const execFileP = promisify(execFile);

const CLAIM_POLL_MS = 5_000;
// SIGTERM → SIGKILL (al grupo) si el proceso no muere en este margen.
const KILL_GRACE_MS = 10_000;
// tras la salida de claude, espera máxima a que se cierren sus pipes: un proceso en background que
// los heredó retendría el 'close' para siempre.
const EXIT_DRAIN_MS = 5_000;
// throttle del reporte de tool calls al server.
const PROGRESS_MIN_INTERVAL_MS = 5_000;
const PROGRESS_TICK_MS = 1_000;
const MIN_HEARTBEAT_MS = 5_000;
const MIN_RUN_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_CHARS = 4000;
// tras SIGINT/SIGTERM: margen para cerrar el run en curso antes de salir a la fuerza.
const SHUTDOWN_GRACE_MS = 20_000;
const EXIT_CODE_SIGINT = 130;
const EXIT_CODE_SIGTERM = 143;
// la credencial ya no vale (desvinculada, revocada o caducada): EX_CONFIG de sysexits, sin `login` no vuelve.
export const EXIT_CODE_UNPAIRED = 78;
// tope de la nota de workdir.
const WORKDIR_MAX_CHARS = 300;
// prefijo del log del daemon; el de una plataforma que no es la legacy lleva su id (`[runner:<id>]`).
const LOG_PREFIX = 'runner';
// el código de un claim rechazado por el runner (platforms/claim-v0.ts): `claim rechazado por el runner (<código>: …)`.
const REJECT_CODE_RE = /\(([a-z_]+):/;
const REJECT_CODES: ReadonlySet<string> = new Set(Object.values(CLAIM_REJECT));

// el código de un claim que no se aceptó: el del runner si lo lleva; si no (un claim legacy que no parsea), inválido.
function rejectCode(error: string): string {
  const code = REJECT_CODE_RE.exec(error)?.[1];
  return code !== undefined && REJECT_CODES.has(code) ? code : CLAIM_REJECT.invalid;
}

// lo que la auditoría sabe del intento que cerró un segmento: cómo acabó, nunca su salida.
const attemptFacts = (a: Attempt): AttemptFacts => ({ killedBy: a.killedBy, exitCode: a.exitCode, isError: a.stream.result?.isError ?? false, subtype: a.stream.result?.subtype ?? null });

// las tools de los recursos del run (mcp__res_<tipo>_<clave>__*, t#495 M7) en las listas con que se lanza: al allow
// las suyas, al deny las que se le niegan. sin recursos mcp, el claim tal cual (el argv de siempre).
const withResourceTools = (claim: ClaimResponse, mcp: RunMcp): ClaimResponse =>
  mcp.allowed.length === 0 && mcp.deny.length === 0
    ? claim
    : { ...claim, tools: { allowed: [...claim.tools.allowed, ...mcp.allowed], disallowed: [...claim.tools.disallowed, ...mcp.deny] } };

// cómo suelta sus recursos un run según su cierre.
const RELEASE_BY_STATUS: Readonly<Record<StatusReport['status'], ReleaseOutcome>> = {
  done: RELEASE.done,
  failed: RELEASE.failed,
  canceled: RELEASE.canceled,
};

export interface DaemonOptions {
  verboseLog?: boolean;
  // cómo se crea la plataforma de cada protocolo (platforms/duckhunt42.ts; las pruebas, una falsa).
  factories?: PlatformFactories;
  // `runner run` sin daemon (t#495, M7): el núcleo solo con la plataforma local (ver cabecera).
  localOnly?: boolean;
}

// la parte de la config que el daemon recarga (sin la credencial de duckhunt, que un `runner run` no necesita).
const localPart = (cfg: StoredConfig): LocalConfig => {
  const { baseUrl: _b, clientId: _c, refreshToken: _r, replacesClientId: _p, ...local } = cfg;
  return local;
};

export class RunnerDaemon {
  // una por plataforma (platforms/supervisor.ts): hoy la legacy, con las rutas de siempre (paths.ts).
  private readonly supervisors = new Map<string, PlatformSupervisor>();
  // los slots de la máquina, repartidos entre plataformas.
  private readonly scheduler = new Scheduler(() => this.slots);
  // el poll de cada supervisor (la parada los espera).
  private readonly polls: Promise<void>[] = [];
  // cómo se crea la plataforma de cada protocolo que este runner habla.
  private readonly factories: PlatformFactories;
  // la config de cada plataforma (config v2, se recarga con el fichero); hasta leerlo, la legacy con lo de siempre.
  private platformsCfg: Readonly<Record<string, PlatformConfig>> = { [LEGACY_PLATFORM_ID]: legacyPlatform() };
  // la credencial de duckhunt en el fichero (las claves de siempre): con otro clientId reaviva su supervisor. null en
  // un `runner run` sin daemon (localOnly).
  private legacyCredential: RunnerCredential | null;
  // la plataforma local alojada aquí (null hasta hostLocal) y con qué cerrar su socket.
  private local: LocalPlatform | null = null;
  private closeLocalSocket: (() => Promise<void>) | null = null;
  // plataformas de la config que no reclaman (sin credencial, o con un protocolo que este runner no habla) y por qué.
  private readonly skipped = new Map<string, string>();
  private claude: ClaudeInfo = { version: null, supported: new Set() };
  private hasAws = false;
  // mapas, etiqueta y defaults: los recarga reloadConfig en cada vuelta del loop.
  private cfg: LocalConfig;
  // texto del fichero en la última recarga (undefined = aún sin leer).
  private configText: string | null | undefined;
  // git sobre un mismo checkout (clave: path resuelto del checkout) y turnos exclusivos de los recursos
  // compartidos (clave: la del recurso, hoy el cwd resuelto).
  private readonly gitLocks = new KeyedMutex();
  private readonly cwdLocks = new KeyedMutex();
  // sesiones de navegador de la config v2 (resources.browser), dónde están odysea y su vault, odysea hallado (null =
  // sin sesiones configuradas: ni se busca), la última salud de cada sesión y el mutex de los ficheros del vault.
  private browserRefs: Readonly<Record<string, BrowserRef>> = {};
  private providersCfg: ProvidersConfig | undefined;
  private odysea: OdyseaDetection | null = null;
  private browserFindings: BrowserFinding[] = [];
  private lastBrowserHealthAt = 0;
  private browserHealthRun: Promise<void> | null = null;
  private readonly lastProbe = new Map<string, number>();
  private readonly vaultLocks = new KeyedMutex();
  // proveedores de recursos de los runs (resources/registry.ts).
  private readonly registry = new ProviderRegistry([
    repoProvider,
    awsProvider,
    browserProvider({
      odysea: () => this.odysea,
      vaultDir: () => vaultDirOf(this.providersCfg),
      vaultLocks: this.vaultLocks,
      health: (key) => this.browserFindings.filter((f) => f.key === key).map((f) => f.kind),
    }),
  ]);
  private stopping = false;
  private exitCode = 0;
  // espera del loop principal (la parada y el cierre de los runs en vuelo).
  private wake: (() => void) | null = null;
  // última foto de la salud de los repos (lo que anuncia el claim; null = aún sin chequeo que haya
  // terminado: el claim no la manda, nunca un [] que el server leería como "todo sano") y su huella.
  private repoHealth: RepoIssue[] | null = null;
  // repos con carpeta que elegir (lo que se anuncia) y el path local de cada id (lo que se acepta).
  private repoChoices: RepoChoice[] | null = null;
  private candidatePaths: ReadonlyMap<string, { repo: string; path: string }> = new Map();
  private repoCommandsInFlight = false;
  private repoHealthPrint: string | null = null;
  private lastRepoHealthAt = 0;
  // chequeo en curso: los forzados lo esperan en vez de solaparse con él.
  private repoHealthRun: Promise<void> | null = null;
  // Read negado de las rutas reales de las credenciales de la máquina: todo kit de lectura (al arrancar).
  private secretDeny: string[] = [];
  // auditoría local de cada plataforma (audit.ts) y cuándo se podó por última vez.
  private readonly audit = new AuditLog();
  private lastAuditPruneAt = 0;
  // secreto de la máquina para los machine id por plataforma (undefined = aún sin pedir; null = no se pudo guardar).
  private machineSecret: string | null | undefined;
  // catálogo de slash commands de cada plataforma (t#555, slash-commands.ts: solo lo que cargaron sus runs) y las que
  // están subiendo el suyo.
  private readonly slashCatalogs = new Map<string, SlashCommandCatalog>();
  private readonly slashUploads = new Set<string>();
  // lo que cada supervisor necesita del daemon.
  private readonly hooks: SupervisorHooks = {
    announce: (sup) => this.announce(sup),
    rejected: (sup, err) => this.platformRejected(sup, err),
    commandsPending: (sup) => void this.syncRepoCommands(sup),
    rejectedClaim: (sup, runId, error) => this.audit.append(rejectedRecord(this.auditSubject(sup), runId, rejectCode(error))),
  };

  constructor(
    cfg: RunnerConfig | StoredConfig,
    private readonly opts: DaemonOptions = {},
  ) {
    this.factories = opts.factories ?? PLATFORM_FACTORIES;
    if (opts.localOnly) {
      this.cfg = localPart(cfg);
      this.legacyCredential = null;
      return;
    }
    const { credential, local } = splitConfig(cfg as RunnerConfig);
    this.cfg = local;
    this.legacyCredential = credential;
    this.addSupervisor(this.factories[PROTOCOL.duckhunt42]!(LEGACY_PLATFORM_ID, credential, this.platformContext(LEGACY_PLATFORM_ID)));
  }

  // la plataforma legacy: siempre está (su credencial vive en las claves de siempre de la config).
  private get legacy(): PlatformSupervisor {
    return this.supervisors.get(LEGACY_PLATFORM_ID)!;
  }

  // runs en vuelo de todas las plataformas.
  private get leases(): RunLease[] {
    return [...this.supervisors.values()].flatMap((sup) => [...sup.leases]);
  }

  // un supervisor nuevo (sustituye al que hubiera con su id); con el daemon ya en marcha, arranca su poll.
  private addSupervisor(platform: Platform, paused = false): PlatformSupervisor {
    const sup = new PlatformSupervisor(platform.id, platform, paused ? PLATFORM_STATE.paused : PLATFORM_STATE.active, this.hooks);
    this.supervisors.set(sup.id, sup);
    if (this.running) this.polls.push(this.poll(sup));
    return sup;
  }

  // slots del daemon: defaults.maxConcurrent de la config recargada.
  private get slots(): number {
    return concurrency(this.cfg.defaults);
  }

  // cuota de una plataforma dentro del pool: la de su config; sin ella, la legacy todo el pool y una nueva
  // PLATFORM_DEFAULT_SLOTS.
  private quota(sup: PlatformSupervisor): number {
    const slots = this.platformCfg(sup.id)?.slots ?? (sup.id === LEGACY_PLATFORM_ID ? this.slots : PLATFORM_DEFAULT_SLOTS);
    return Math.min(slots, this.slots);
  }

  // lo que una plataforma que manda con toolset_v1 (v0) aplica a sus claims: su techo y su exposición de la config de
  // AHORA (sin config, el techo más bajo y nada expuesto), los tipos de recurso de este daemon y su aws cli.
  private platformContext(id: string): PlatformContext {
    return {
      enforcement: () => ({
        ceiling: this.platformCfg(id)?.ceiling ?? DEFAULT_CEILING,
        expose: this.platformCfg(id)?.expose ?? {},
        resourceTypes: this.registry.types(),
        awsCli: this.hasAws,
      }),
    };
  }

  // lo que la plataforma ve de la máquina (su `expose`; sin config, nada).
  private exposure(sup: PlatformSupervisor): PlatformConfig['expose'] {
    return this.platformCfg(sup.id)?.expose ?? {};
  }

  // la config de una plataforma; la local, con sus valores por defecto aunque no tenga entrada (t#495, M7).
  private platformCfg(id: string): PlatformConfig | undefined {
    return this.platformsCfg[id] ?? (id === LOCAL_PLATFORM_ID ? LOCAL_PLATFORM_DEFAULTS : undefined);
  }

  /**
   * aloja la plataforma local (t#495, M7): su servidor mcp, su supervisor y, con el daemon, local.sock. una vez; la
   * devuelve (null si no se pudo: el daemon sigue sin ella). un `runner run` sin daemon la pide antes de run().
   */
  async hostLocal(): Promise<LocalPlatform | null> {
    if (this.local) return this.local;
    const local = new LocalPlatform(this.platformContext(LOCAL_PLATFORM_ID));
    try {
      await local.start();
    } catch (err) {
      console.warn(`[${LOG_PREFIX}] plataforma local: no arranca su mcp: ${(err as Error).message}`);
      return null;
    }
    // lo que dejó un daemon muerto, solo si ya hay estado suyo en disco (sin él, nada que barrer ni que crear).
    if (fs.existsSync(platformHome(LOCAL_PLATFORM_ID))) this.prepare(LOCAL_PLATFORM_ID);
    const sup = this.addSupervisor(local);
    local.onWork = () => sup.wake();
    this.local = local;
    if (this.opts.localOnly) return local;
    try {
      this.closeLocalSocket = await serveLocal({ platform: local, evaluate: (request) => this.evaluateLocal(request) });
    } catch (err) {
      console.warn(`[${LOG_PREFIX}] plataforma local: sin local.sock (\`runner run\` no llegará a este daemon): ${(err as Error).message}`);
    }
    return local;
  }

  /** una petición de `runner run` contra la plataforma local de AHORA (local/policy.ts); lanza RequestRefusedError. */
  evaluateLocal(request: LocalRequest): LocalEvaluation {
    const platform = this.platformCfg(LOCAL_PLATFORM_ID)!;
    return { toolset: evaluateRequest(request, platform, this.registry.types()).toolset, unattendedEscalation: platform.unattendedEscalation === true };
  }

  /** relee la config (lo que hace cada vuelta del poll), para un `runner run` sin daemon antes de evaluar. */
  async refreshConfig(): Promise<void> {
    await this.reloadConfig();
  }

  /** para el núcleo: cada run en vuelo se corta y run() vuelve en cuanto cierran (un `runner run` sin daemon). */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.leases.forEach((lease) => lease.kill('shutdown'));
    this.wakeAll();
  }

  /** mata en el acto el grupo de procesos de cada run en vuelo (la segunda señal de un `runner run`). */
  forceStop(): void {
    this.leases.forEach((lease) => lease.forceKill());
  }

  // el loop principal ya arrancó (los supervisores nuevos arrancan su poll al crearse).
  private running = false;

  // la etiqueta que se anuncia, dentro de lo que el server acepta: recortada, sin quedarse vacía y como mucho
  // RUNNER_LABEL_MAX_CHARS. una más larga (o en blanco) tumbaba cada claim con un 400. una plataforma puede tener la
  // suya (M6.5); si no, la de la máquina.
  private label(sup?: PlatformSupervisor): string {
    const own = sup ? this.platformsCfg[sup.id]?.label?.trim() : undefined;
    return clip(own || this.cfg.label?.trim() || os.hostname(), RUNNER_LABEL_MAX_CHARS);
  }

  // el machine id que se anuncia a una plataforma: el de siempre a la legacy (su adopción de la fila sigue igual) y a
  // otra uno derivado de su emisor (machine.ts). sin secreto guardable (config de solo lectura), ninguno.
  private machineIdFor(sup: PlatformSupervisor): string | null {
    if (sup.id === LEGACY_PLATFORM_ID) return this.cfg.machineId ?? null;
    // la local no tiene server al que anunciarse.
    if (sup.id === LOCAL_PLATFORM_ID) return null;
    if (this.machineSecret === undefined) {
      try {
        this.machineSecret = ensureMachineSecret();
      } catch (err) {
        console.warn(`${this.tagOf(sup)} no se pudo guardar el secreto de la máquina en la config: ${(err as Error).message} — reclamo sin machine id`);
        this.machineSecret = null;
      }
    }
    // firma el emisor que guardó su `login --as` (M6.4); una escrita a mano, sin él, la base de su credencial.
    return this.machineSecret === null ? null : derivedMachineId(this.machineSecret, this.platformsCfg[sup.id]?.issuer ?? sup.platform.identity().baseUrl);
  }

  // prefijo del log de una plataforma: el de siempre para la legacy, con su id para las demás.
  private tagOf(sup: PlatformSupervisor): string {
    return sup.id === LEGACY_PLATFORM_ID ? `[${LOG_PREFIX}]` : `[${LOG_PREFIX}:${sup.id}]`;
  }

  // de qué plataforma es un registro de la auditoría, ahora.
  private auditSubject(sup: PlatformSupervisor): AuditSubject {
    return { platform: sup.id, protocol: sup.platform.protocol, at: Date.now() };
  }

  // capacidades que se anuncian: prompt solo si el cli puede cumplir su perfil (permission mode
  // explícito, sin mcp del repo, deny list y settings solo del usuario en lectura), model solo con --model.
  private capabilities(): string[] {
    return announcedCapabilities({
      hasAws: this.hasAws,
      supported: this.claude.supported,
      claudeVersion: this.claude.version,
      bypassPermissions: canBypassPermissions(),
      remoteRepoEdits: this.cfg.defaults.remoteRepoEdits,
      toolsetRender: this.cfg.defaults.toolsetRender,
      // odysea hallado: solo se busca con alguna sesión de navegador configurada.
      browser: this.odysea?.ok === true,
    });
  }

  /** loop principal: gc → claim → ejecutar en un slot libre → repetir, hasta SIGINT/SIGTERM.
   *  devuelve el exit code tras esperar el cierre de los runs en vuelo. */
  // el flip de toolset_v1 (t#495, M5): los runs de duckhunt-42 que traen `toolset` se lanzan con el render del daemon,
  // salvo el interruptor de la config (defaults.toolsetRender: false = solo en sombra, sin el flip).
  private get toolsetRender(): boolean {
    return this.cfg.defaults.toolsetRender !== false;
  }

  // ¿duckhunt ve la identidad aws por defecto de esta máquina? (`resource add aws default`, expuesta a la legacy).
  private awsDefaultExposed(sup: PlatformSupervisor): boolean {
    return Object.hasOwn(this.cfg.aws, AWS_DEFAULT_KEY) && isExposed(this.exposure(sup), RESOURCE_TYPE.aws, AWS_DEFAULT_KEY);
  }

  // aviso del arranque (una vez): con el flip, un run de duckhunt sin cuenta aws ya no hereda la aws de la máquina;
  // solo si la hay y su identidad por defecto no está expuesta a duckhunt.
  private warnAwsDefault(): void {
    if (this.opts.localOnly || !this.toolsetRender || this.awsDefaultExposed(this.legacy) || !machineHasAws(process.env, this.hasAws, os.homedir())) return;
    console.warn(
      `[runner] los runs de duckhunt sin cuenta aws ya no heredan la aws de esta máquina (toolset_v1): para dársela, \`duckhunt-runner resource add aws ${AWS_DEFAULT_KEY} <perfil>\` (o defaults.toolsetRender: false para volver a como era)`,
    );
  }

  async run(): Promise<number> {
    this.claude = await detectClaude();
    if (!this.claude.version) {
      throw new Error('no se encuentra `claude` en el PATH: instala claude code y haz login antes de arrancar el daemon');
    }
    this.hasAws = await execFileP('aws', ['--version']).then(
      () => true,
      () => false,
    );
    // lanza si la ruta no cabe en una regla de permisos: sin ese deny el daemon no arranca. cubre el
    // run-config de cada plataforma con estado en disco; cada segmento lo recalcula (runDeny).
    allRunConfigDirs().forEach(runConfigDeny);
    const stale = clearRunMcpConfigs(LEGACY_PLATFORM_ID) + this.registry.sweep(LEGACY_PLATFORM_ID);
    if (stale > 0) console.log(`[runner] ${stale} config(s) de runs anteriores borrada(s)`);
    const legacy = clearLegacyTmpConfigs();
    if (legacy > 0) console.log(`[runner] ${legacy} mcp-config(s) de daemons < 0.10.2 borrado(s) del tmpdir`);
    const secrets = secretPathsDeny(process.env);
    this.secretDeny = secrets.rules;
    secrets.skipped.forEach((p) => console.warn(`[runner] secret_paths: ${p} no cabe en una regla de permisos de claude: queda solo la lista genérica del server`));
    this.pruneAudit();
    if (!this.opts.localOnly) {
      this.adoptMachineId();
      this.warnAwsDefault();
      this.installSignalHandlers();
      console.log(
        `[runner] duckhunt-runner ${runnerVersion() ?? '?'} · ${this.label()} → ${this.legacy.platform.identity().baseUrl} (claude ${this.claude.version}, aws cli ${this.hasAws ? 'sí' : 'no'}, ${Object.keys(this.cfg.repos).length} repos, ${Object.keys(this.cfg.aws).length} cuentas aws, capacidades ${this.capabilities().join(',')}, ${this.slots} slot${this.slots === 1 ? '' : 's'}, poll ${CLAIM_POLL_MS / 1000}s)`,
      );
      await this.refreshRepoHealth();
    }
    // la salud de las sesiones de navegador (y odysea) antes del primer claim, también sin daemon (`runner run`).
    await this.refreshBrowserHealth();
    await this.hostLocal();
    this.running = true;
    this.supervisors.forEach((sup) => this.polls.push(this.poll(sup)));
    while (!this.stopping) {
      await this.idle(CLAIM_POLL_MS);
      if (Date.now() - this.lastAuditPruneAt >= DAY_MS) this.pruneAudit();
    }
    await Promise.all(this.polls);
    // parada: cada run en vuelo recibió kill('shutdown'); se espera a que reporte su cierre.
    while (this.leases.length > 0) await this.idle(CLAIM_POLL_MS);
    await this.closeLocalSocket?.();
    await this.local?.close();
    console.log('[runner] detenido');
    return this.exitCode;
  }

  // poll de una plataforma: recargar la config → reservar un slot → gc → claim → ejecutar → repetir, hasta la
  // parada (o hasta que el supervisor deje de ser el de su id).
  private async poll(sup: PlatformSupervisor): Promise<void> {
    while (!this.stopping && this.supervisors.get(sup.id) === sup) {
      // también con los slots llenos: un maxConcurrent más alto vale sin esperar a que acabe un run.
      await this.reloadConfig();
      if (!this.opts.localOnly) void this.refreshRepoHealth();
      void this.refreshBrowserHealth();
      if (this.supervisors.get(sup.id) !== sup) break;
      if (!(await this.pollOnce(sup)) && !this.stopping) await sup.idle(CLAIM_POLL_MS);
    }
  }

  // una vuelta del poll: con un slot reservado (pool y cuota), gc y claim. true = reclamó un run: la siguiente
  // vuelta va en el acto. sin slot, espera a que se libere uno (o al siguiente poll).
  private async pollOnce(sup: PlatformSupervisor): Promise<boolean> {
    sup.blocked = false;
    this.checkBudget(sup);
    if (!sup.claiming) {
      // un slot que se le guardaba (en pausa, sin cuota, retirada) pasa a la siguiente.
      this.scheduler.withdraw(sup.id);
      this.offerFreeSlots();
      return false;
    }
    if (!this.scheduler.tryReserve(sup.id, this.quota(sup))) {
      sup.blocked = true;
      return false;
    }
    await this.collectWorktrees(sup);
    const claim = this.stopping ? null : await sup.claim();
    // el server ya contestó (y la fila de la máquina existe): si no tiene el catálogo de ahora, se le sube aparte.
    void this.syncSlashCommands(sup);
    if (!claim) {
      this.scheduler.release(sup.id);
      // sin trabajo: el turno pasa en el acto a la siguiente que espera slot.
      this.offerFreeSlots();
      return false;
    }
    this.start(sup, claim);
    return true;
  }

  // los slots libres, uno a uno, a la siguiente plataforma en round-robin de las que esperan (platforms/scheduler.ts),
  // que se despierta para reservarlo.
  private offerFreeSlots(): void {
    const waiting = [...this.supervisors.values()].filter((s) => s.blocked && s.claiming).map((s) => ({ id: s.id, quota: this.quota(s) }));
    const next = this.scheduler.offer([...this.supervisors.keys()], waiting);
    if (next === null) return;
    this.supervisors.get(next)?.wake();
    this.offerFreeSlots();
  }

  // la cuota del día de una plataforma (M6.6, contada en su auditoría): agotada, no reclama hasta medianoche; con
  // cuota otra vez (otro día, o la config se la sube), vuelve.
  private checkBudget(sup: PlatformSupervisor): void {
    const over = this.overBudget(sup);
    if (sup.state === PLATFORM_STATE.active && over !== null) {
      sup.state = PLATFORM_STATE.budget;
      console.log(`${this.tagOf(sup)} plataforma ${sup.id}: cuota del día agotada (${over}): no reclama hasta las ${new Date(nextMidnight(Date.now())).toLocaleString()}`);
    } else if (sup.state === PLATFORM_STATE.budget && over === null) {
      sup.state = PLATFORM_STATE.active;
      console.log(`${this.tagOf(sup)} plataforma ${sup.id}: con cuota otra vez, reclama`);
    }
  }

  // qué cuota del día agotó la plataforma, o null (sin cuota configurada, nunca: ni se lee la auditoría).
  private overBudget(sup: PlatformSupervisor): string | null {
    const cfg = this.platformsCfg[sup.id];
    if (cfg?.budgetUsdPerDay === undefined && cfg?.runsPerDay === undefined) return null;
    const used = this.audit.usageToday(sup.id);
    if (cfg.runsPerDay !== undefined && used.runs >= cfg.runsPerDay) return `${used.runs}/${cfg.runsPerDay} segmentos`;
    if (cfg.budgetUsdPerDay !== undefined && used.costUsd >= cfg.budgetUsdPerDay) return `${used.costUsd.toFixed(2)}/${cfg.budgetUsdPerDay} usd`;
    return null;
  }

  // poda la auditoría de todas las plataformas (al arrancar y una vez al día). nunca lanza.
  private pruneAudit(): void {
    this.lastAuditPruneAt = Date.now();
    try {
      const removed = pruneAudit(Date.now(), retentionDays(this.cfg.defaults.auditRetentionDays));
      if (removed > 0) console.log(`[${LOG_PREFIX}] auditoría: ${removed} fichero(s) viejo(s) borrado(s)`);
    } catch (err) {
      console.error(`[${LOG_PREFIX}] auditoría: no se pudo podar: ${(err as Error).message}`);
    }
  }

  // el machine id de la config o uno nuevo que se guarda (config de 0.10). una config que no se puede
  // escribir (montada de solo lectura) reclama sin él: duckhunt la reconoce igual por su credencial.
  private adoptMachineId(): void {
    if (this.cfg.machineId) return;
    try {
      this.cfg = { ...this.cfg, machineId: ensureMachineId() };
    } catch (err) {
      console.warn(`[runner] no se pudo guardar el machine id en la config: ${(err as Error).message} — reclamo sin él`);
    }
  }

  // la credencial de una plataforma ya no vale: esa plataforma para (sin reintentar) y se cortan sus runs (el
  // server ya los canceló al desvincular; sin credencial no pueden ni latir). si era la última usable, el daemon
  // se detiene y sale con EXIT_CODE_UNPAIRED. la credencial muerta se borra del fichero (wipeRejected).
  private platformRejected(sup: PlatformSupervisor, err: PlatformRejectedError): void {
    if (this.stopping || sup.state === PLATFORM_STATE.unpaired) return;
    // la local no cuenta: no tiene credencial que muera y un daemon solo con ella no reclamaría nada de nadie.
    const last = ![...this.supervisors.values()].some((other) => other !== sup && other.id !== LOCAL_PLATFORM_ID && other.usable);
    console.error(`${this.tagOf(sup)} ${err.message}. ${last ? 'el daemon se detiene' : `la plataforma ${sup.id} deja de reclamar`}`);
    sup.state = PLATFORM_STATE.unpaired;
    sup.recordServerState(CLAIM_OUTCOME.unpaired, null);
    if (err.clientId !== undefined) this.wipeRejected(sup, err.clientId);
    if (last) {
      this.stopping = true;
      this.exitCode = EXIT_CODE_UNPAIRED;
    }
    sup.leases.forEach((lease) => lease.kill('cancel'));
    if (last) this.wakeAll();
    else sup.wake();
  }

  // desvincular la máquina desde la web es su `logout` (t#510): la credencial que el server rechazó se borra del
  // fichero, como haría `duckhunt-runner logout`, para que no quede una muerta en disco ni la recoja un reinicio.
  // solo si el fichero sigue siendo de esa credencial (CredentialStore.clear): un `login` hecho mientras tanto gana.
  // una config que no se puede escribir (montada de solo lectura) se queda como está: se avisa y el daemon sigue
  // parando igual.
  private wipeRejected(sup: PlatformSupervisor, clientId: string): void {
    try {
      if (credentialStore(sup.id).clear(clientId)) {
        console.log(`${this.tagOf(sup)} credencial borrada de ${configPath()}: \`duckhunt-runner login\` para volver a vincularla`);
      }
    } catch (err) {
      console.error(`${this.tagOf(sup)} no se pudo borrar la credencial de ${configPath()}: ${(err as Error).message}`);
    }
  }

  // despierta todos los polls y el loop principal (parada).
  private wakeAll(): void {
    this.supervisors.forEach((sup) => sup.wake());
    this.wake?.();
  }

  // un slot libre: lo prueba en el acto su plataforma, y se ofrece a la siguiente en round-robin de las que esperaban
  // uno (y la parada, si espera). una retirada de la config que ya no tiene runs se suelta.
  private slotFreed(sup: PlatformSupervisor): void {
    if (sup.state === PLATFORM_STATE.removing) this.retire(sup);
    sup.wake();
    this.offerFreeSlots();
    this.wake?.();
  }

  // espera interrumpible por una señal de parada.
  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  // primera señal: parar tras cerrar los runs en curso (se mata cada grupo y se reporta); segunda
  // señal o margen agotado: salida inmediata matando todos los grupos.
  private installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals, code: number): void => {
      const forceExit = (): never => {
        this.leases.forEach((lease) => lease.forceKill());
        process.exit(code);
      };
      if (this.stopping) forceExit();
      this.stopping = true;
      this.exitCode = code;
      const leases = this.leases;
      console.log(`[runner] ${signal}: deteniendo${leases.length > 0 ? ` ${leases.length} run(s) en curso` : ''} (otra señal fuerza la salida)`);
      leases.forEach((lease) => lease.kill('shutdown'));
      this.wakeAll();
      setTimeout(forceExit, SHUTDOWN_GRACE_MS).unref();
    };
    process.on('SIGINT', () => onSignal('SIGINT', EXIT_CODE_SIGINT));
    process.on('SIGTERM', () => onSignal('SIGTERM', EXIT_CODE_SIGTERM));
  }

  // --- claim ---

  // lo que esta máquina anuncia a una plataforma en su claim (platforms/platform.ts::ClaimAnnounce): sus slots
  // son su cuota (nunca los libres del pool, que dirían cuánto trabajo traen las demás), y de los repos y cuentas
  // aws solo los que expone (la legacy, todos). los candidatos de carpeta, solo a la legacy: los comandos de repos son
  // solo suyos. el machine id de una que no es la legacy sale derivado (machineIdFor, M6.5).
  private announce(sup: PlatformSupervisor): ClaimAnnounce {
    const legacy = sup.id === LEGACY_PLATFORM_ID;
    const expose = this.exposure(sup);
    const seen = (type: string) => (key: string): boolean => isExposed(expose, type, key);
    const repos = Object.keys(this.cfg.repos).filter(seen(RESOURCE_TYPE.repo));
    const allRepos = expose[RESOURCE_TYPE.repo] === EXPOSE_ALL;
    return {
      label: this.label(sup),
      machineId: this.machineIdFor(sup),
      capabilities: this.capabilities(),
      slots: this.quota(sup),
      version: runnerVersion(),
      claudeVersion: this.claude.version,
      repos,
      repoIssues: allRepos ? this.repoHealth : (this.repoHealth?.filter((i) => i.repo !== null && repos.includes(i.repo)) ?? null),
      repoCandidates: !legacy ? null : allRepos ? this.repoChoices : (this.repoChoices?.filter((c) => repos.includes(c.repo)) ?? null),
      // solo ids de cuenta: `default` (y cualquier otra clave) no es una cuenta que duckhunt conozca.
      awsAccounts: Object.keys(this.cfg.aws).filter((key) => AWS_ACCOUNT_ID_RE.test(key) && seen(RESOURCE_TYPE.aws)(key)),
      // el cable v0 anuncia recursos por clave: también `default` si el usuario la expone.
      awsKeys: Object.keys(this.cfg.aws).filter(seen(RESOURCE_TYPE.aws)),
      // el legacy, aparte y solo con el flip: con el interruptor, el cable sin el flip.
      awsDefault: this.toolsetRender ? this.awsDefaultExposed(sup) : null,
      browsers: this.browsersFor(sup),
      kept: sup.keptWorktrees,
    };
  }

  // las sesiones de navegador expuestas a una plataforma y su salud (t#495, M7): solo con el flip (el interruptor deja
  // el cable sin el flip, que no las conoce) y alguna expuesta; si no, null y el claim de siempre.
  private browsersFor(sup: PlatformSupervisor): ClaimAnnounce['browsers'] {
    if (!this.toolsetRender) return null;
    const keys = Object.keys(this.browserRefs).filter((key) => isExposed(this.exposure(sup), RESOURCE_TYPE.browser, key));
    if (keys.length === 0) return null;
    return { keys, health: this.browserFindings.filter((f) => keys.includes(f.key)).map(({ key, kind }) => ({ key, kind })) };
  }

  // salud de las sesiones de navegador (t#495, M7, resources/browser/health.ts) cada BROWSER_HEALTH_INTERVAL_MS (o ya,
  // con `force`), con odysea buscado de nuevo; sin ninguna configurada, ni se busca odysea. nunca lanza.
  private refreshBrowserHealth(force = false): Promise<void> {
    if (this.browserHealthRun) return this.browserHealthRun;
    if (!force && this.lastBrowserHealthAt !== 0 && Date.now() - this.lastBrowserHealthAt < BROWSER_HEALTH_INTERVAL_MS) return Promise.resolve();
    this.lastBrowserHealthAt = Date.now();
    this.browserHealthRun = (async () => {
      if (Object.keys(this.browserRefs).length === 0) {
        this.odysea = null;
        this.browserFindings = [];
        return;
      }
      try {
        this.odysea = await detectOdysea(this.providersCfg?.browser?.bin);
        this.browserFindings = await browserHealth({
          entries: this.browserRefs,
          vaultDir: vaultDirOf(this.providersCfg),
          odysea: this.odysea,
          probe: PROBE_MODE.due,
          lastProbe: this.lastProbe,
          nowMs: Date.now(),
        });
      } catch (err) {
        console.error(`[runner] salud de las sesiones de navegador: ${(err as Error).message}`);
      }
    })().finally(() => (this.browserHealthRun = null));
    return this.browserHealthRun;
  }

  // registra el run en el slot que reservó su plataforma y lo ejecuta en segundo plano; al terminar libera el
  // slot y despierta el poll para reclamar el siguiente sin esperar.
  private start(sup: PlatformSupervisor, claim: ClaimResponse): void {
    const lease = new RunLease(claim.run.id);
    sup.leases.add(lease);
    // la conversación vuelve a trabajar en su worktree («pedir commit» o cualquier mensaje): deja de
    // anunciarse como conservada, o su hilo volvería a enseñar los recuentos viejos hasta el siguiente gc.
    if (sup.keptWorktrees?.some((k) => k.runId === claim.run.id)) sup.keptWorktrees = sup.keptWorktrees.filter((k) => k.runId !== claim.run.id);
    if (this.stopping) lease.kill('shutdown');
    void this.executeRun(sup, claim, lease)
      .catch((err) => console.error(`${this.tagOf(sup)} run ${lease.runId} reventó: ${(err as Error).message}`))
      .finally(() => {
        sup.leases.delete(lease);
        this.scheduler.release(sup.id);
        this.slotFreed(sup);
      });
  }

  // --- salud de los repos (en el loop de claim, throttled y sin esperarla) ---

  // force: tras cambiar el mapa, sin esperar a la cadencia (espera antes al chequeo en curso, que
  // mide el mapa viejo).
  private async refreshRepoHealth(force = false): Promise<void> {
    if (this.repoHealthRun) {
      if (!force) return;
      await this.repoHealthRun;
    }
    if (!force && Date.now() - this.lastRepoHealthAt < REPO_HEALTH_INTERVAL_MS) return;
    this.lastRepoHealthAt = Date.now();
    this.repoHealthRun = this.checkRepos().finally(() => (this.repoHealthRun = null));
    await this.repoHealthRun;
  }

  private async checkRepos(): Promise<void> {
    try {
      const env = scrubEnv(process.env);
      const scan = await scanRepos(this.cfg.repos, env);
      const findings = repoFindings(scan);
      const { choices, paths } = await repoChoices(scan, env);
      this.repoHealth = repoIssues(findings);
      this.repoChoices = choices;
      this.candidatePaths = paths;
      const lines = findings.map((f) => describeFinding(f));
      const print = lines.join('\n');
      if (print !== this.repoHealthPrint) {
        if (lines.length === 0) console.log('[runner] repos: sin avisos');
        else lines.forEach((line) => console.warn(`[runner] repos: ${line}`));
        this.repoHealthPrint = print;
      }
    } catch (err) {
      console.error(`[runner] chequeo de repos falló: ${(err as Error).message}`);
    }
  }

  // comandos de repos pendientes (los avisa la cabecera del claim): pedir, aplicar en orden sobre el
  // mapa, guardar UNA vez, re-chequear y reportar. con las ediciones remotas apagadas se rechazan.
  private async syncRepoCommands(sup: PlatformSupervisor): Promise<void> {
    if (this.repoCommandsInFlight) return;
    this.repoCommandsInFlight = true;
    try {
      const commands = await sup.platform.commands(this.label(sup));
      if (!commands || commands.length === 0) return;
      const env = scrubEnv(process.env);
      // solo la legacy cambia el mapa de repos de la máquina, y solo si el usuario no lo apagó.
      const disabled = sup.id !== LEGACY_PLATFORM_ID || this.cfg.defaults.remoteRepoEdits === false;
      // i/o secuencial: cada comando se aplica sobre el mapa que dejó el anterior.
      const before = this.cfg.repos;
      let repos = before;
      const results: RepoCommandResult[] = [];
      for (const cmd of commands) {
        if (disabled) {
          results.push({
            id: cmd.id,
            ok: false,
            error: sup.id === LEGACY_PLATFORM_ID ? 'este runner no acepta cambios de repos desde duckhunt (defaults.remoteRepoEdits)' : `este runner solo acepta cambios de repos de ${LEGACY_PLATFORM_ID}`,
          });
          continue;
        }
        const applied = await applyRepoCommand(repos, cmd, this.candidatePaths, env);
        repos = applied.repos;
        results.push(applied.result);
        if (applied.log) console.log(`[runner] repos: ${applied.log}`);
      }
      if (repos !== before) {
        // solo lo que cambiaron los comandos, sobre el mapa del fichero: un `repos add` de la cli
        // hecho mientras tanto se conserva.
        const after = repos;
        this.cfg = { ...this.cfg, repos: saveConfig((current) => ({ repos: mergeEntries(current.repos, before, after) })).repos };
        await this.refreshRepoHealth(true);
      }
      await sup.platform.ackCommands(results);
      sup.wake();
    } catch (err) {
      console.error(`[runner] repos: comandos de duckhunt fallaron: ${(err as Error).message}`);
    } finally {
      this.repoCommandsInFlight = false;
    }
  }

  // --- config en caliente (cada vuelta del loop) ---

  // relee la config y pone al día los supervisores de sus plataformas.
  private async reloadConfig(): Promise<void> {
    await this.readConfig();
    this.syncSupervisors();
  }

  // relee el fichero si su texto cambió: mapas, etiqueta, defaults y plataformas se toman tal cual; un fichero
  // ausente o ilegible deja la config cargada (se avisa una vez por cambio). la credencial no se
  // toca: un `login` de la misma instancia o un refresh sin guardar fuerzan el refresh que lo resuelve.
  private async readConfig(): Promise<void> {
    let text: string | null;
    try {
      text = readConfigText();
    } catch (err) {
      console.error(`[runner] config ilegible: ${(err as Error).message} — sigo con la cargada`);
      return;
    }
    if (text === this.configText) return;
    this.configText = text;
    if (text === null) {
      console.warn('[runner] el fichero de config ya no existe: sigo con la cargada');
      return;
    }
    let credential: RunnerCredential | null;
    let local: LocalConfig;
    let platforms: RunnerConfigV2['platforms'];
    let browser: { refs: Readonly<Record<string, BrowserRef>>; providers: ProvidersConfig | undefined };
    try {
      // sin daemon (`runner run`) la credencial de duckhunt no hace falta: el fichero vale sin ella. con él, tampoco
      // cuando duckhunt ya está fuera (su credencial se rechazó y se borró, o ya faltaba): otra plataforma puede
      // seguir reclamando y la config se sigue recargando; un `login` la devuelve (syncPlatform).
      const stored = parseStoredConfig(text);
      const legacyOut = this.legacyCredential === null || this.supervisors.get(LEGACY_PLATFORM_ID)?.state === PLATFORM_STATE.unpaired;
      const legacyMissing = !(stored.baseUrl && stored.clientId && stored.refreshToken);
      ({ credential, local } =
        this.opts.localOnly || (legacyOut && legacyMissing) ? { credential: null, local: localPart(stored) } : splitConfig(parseConfig(text)));
      const v2 = parseConfigV2(text);
      platforms = v2.platforms;
      browser = { refs: (v2.resources[RESOURCE_TYPE.browser] ?? {}) as Readonly<Record<string, BrowserRef>>, providers: v2.providers };
    } catch (err) {
      console.error(`[runner] ${(err as Error).message} — sigo con la config cargada`);
      return;
    }
    this.legacyCredential = credential;
    this.platformsCfg = platforms;
    // otras sesiones de navegador (o su odysea, su vault): su salud se rehace ya.
    const browserChanged = JSON.stringify(browser) !== JSON.stringify({ refs: this.browserRefs, providers: this.providersCfg });
    this.browserRefs = browser.refs;
    this.providersCfg = browser.providers;
    if (browserChanged) void this.refreshBrowserHealth(true);
    // la credencial del fichero, a cada plataforma que ya corre (las nuevas nacen con ella: syncSupervisors).
    this.supervisors.forEach((sup) => {
      const cred = sup.id === LEGACY_PLATFORM_ID ? credential : platforms[sup.id]?.credential;
      if (cred) sup.platform.observe(cred);
    });
    if (JSON.stringify(local) === JSON.stringify(this.cfg)) return;
    const reposChanged = JSON.stringify(local.repos) !== JSON.stringify(this.cfg.repos);
    this.cfg = local;
    console.log(`[runner] config recargada: ${Object.keys(local.repos).length} repos, ${Object.keys(local.aws).length} cuentas aws, ${this.slots} slot${this.slots === 1 ? '' : 's'}`);
    if (reposChanged) await this.refreshRepoHealth(true);
  }

  // --- plataformas de la config (en cada vuelta de cada poll; idempotente) ---

  // alta de las nuevas, pausa y reanudación, reavivar la que perdió la credencial tras un `login` nuevo,
  // sustituir la que cambió de instancia o protocolo (sin runs en vuelo) y retirar las que ya no están.
  private syncSupervisors(): void {
    // sin daemon solo corre la local; con él, la local la aloja el daemon (hostLocal), no la config.
    if (this.opts.localOnly) return;
    Object.entries(this.platformsCfg)
      .filter(([id]) => id !== LOCAL_PLATFORM_ID)
      .forEach(([id, cfg]) => this.syncPlatform(id, cfg));
    [...this.supervisors.values()].filter((sup) => sup.id !== LOCAL_PLATFORM_ID && !Object.hasOwn(this.platformsCfg, sup.id)).forEach((sup) => this.retire(sup));
    [...this.skipped.keys()].filter((id) => !Object.hasOwn(this.platformsCfg, id)).forEach((id) => this.skipped.delete(id));
  }

  private syncPlatform(id: string, cfg: PlatformConfig): void {
    const legacy = id === LEGACY_PLATFORM_ID;
    const credential = (legacy ? this.legacyCredential : cfg.credential) ?? undefined;
    const protocol = cfg.protocol ?? (legacy ? PROTOCOL.duckhunt42 : undefined);
    const factory = protocol !== undefined && Object.hasOwn(this.factories, protocol) ? this.factories[protocol as Protocol] : undefined;
    const current = this.supervisors.get(id);
    // el cable duckhunt-42 no lleva toolset_v1: el techo de la plataforma no se le puede aplicar y sus runs reciben el
    // kit entero que mande su server, shell incluida. fuera de la legacy, solo en una plataforma trusted.
    const uncapped = !legacy && protocol === PROTOCOL.duckhunt42 && !cfg.trusted;
    const why = !factory
      ? `protocolo ${protocol ?? '(sin protocolo)'} sin soporte en este runner`
      : !credential
        ? 'sin credencial (`login`)'
        : uncapped
          ? `el protocolo ${protocol} no lleva toolset_v1 y su techo no se puede aplicar: solo en una plataforma trusted`
          : null;
    if (!factory || !credential || uncapped) {
      if (this.skipped.get(id) !== why) console.warn(`[runner] plataforma ${id}: ${why}: no reclama`);
      this.skipped.set(id, why!);
      // la legacy siempre está (sin credencial, rechazada: ya no reclama); el resto se retira.
      if (current && !legacy) this.retire(current);
      return;
    }
    this.skipped.delete(id);
    // una retirada que vuelve a la config: se suelta al acabar sus runs (retire) y entonces nace otra.
    if (current?.state === PLATFORM_STATE.removing) return;
    // otra plataforma por la misma: tras un `login` nuevo la que perdió la credencial; una que cambió de instancia o
    // de protocolo, sin runs en vuelo. la legacy no cambia de instancia en caliente (oauth.ts): pide reiniciar.
    const identity = current?.platform.identity();
    const replace =
      current !== undefined &&
      current.leases.size === 0 &&
      (current.state === PLATFORM_STATE.unpaired
        ? identity!.clientId !== credential.clientId
        : !legacy && (current.platform.protocol !== protocol || identity!.baseUrl !== credential.baseUrl));
    if (!current || replace) {
      if (!legacy) this.prepare(id);
      this.addSupervisor(factory(id, credential, this.platformContext(id)), cfg.paused === true);
      // el poll de la sustituida termina en cuanto despierta.
      current?.wake();
      if (!legacy || current) console.log(`[runner] plataforma ${id} → ${credential.baseUrl}${cfg.paused ? ' (en pausa)' : ''}`);
      return;
    }
    if ((current.state === PLATFORM_STATE.active || current.state === PLATFORM_STATE.budget) && cfg.paused) {
      current.state = PLATFORM_STATE.paused;
      console.log(`[runner] plataforma ${id} en pausa: no reclama, sus runs siguen`);
    } else if (current.state === PLATFORM_STATE.paused && !cfg.paused) {
      current.state = PLATFORM_STATE.active;
      console.log(`[runner] plataforma ${id} reanudada`);
      current.wake();
    }
  }

  // lo que una plataforma no legacy necesita antes de su primer run: su run-config (0700) ya creado, así el deny
  // de los segmentos de las demás lo cubre desde ya, y sin lo que dejó un daemon muerto (no tiene runs en vuelo).
  private prepare(id: string): void {
    runConfigDir(id);
    const stale = clearRunMcpConfigs(id) + this.registry.sweep(id);
    if (stale > 0) console.log(`[runner] plataforma ${id}: ${stale} config(s) de runs anteriores borrada(s)`);
  }

  // una plataforma que sale de la config (o se queda sin credencial o sin protocolo): no reclama más y, en cuanto
  // no le quedan runs, se suelta (su poll termina).
  private retire(sup: PlatformSupervisor): void {
    if (sup.state !== PLATFORM_STATE.removing) {
      console.log(`[runner] plataforma ${sup.id} fuera de la config${sup.leases.size > 0 ? `: deja de reclamar, ${sup.leases.size} run(s) acaban` : ''}`);
      sup.state = PLATFORM_STATE.removing;
    }
    if (sup.leases.size > 0 || this.supervisors.get(sup.id) !== sup) return;
    this.supervisors.delete(sup.id);
    sup.wake();
  }

  // --- gc de worktrees (en el loop de claim, throttled) ---

  // los worktrees de una plataforma (su espacio en cada checkout), con lo que su server dice abierto.
  private async collectWorktrees(sup: PlatformSupervisor): Promise<void> {
    if (Date.now() - sup.lastGcAt < CONVERSATION_GC_INTERVAL_MS) return;
    sup.lastGcAt = Date.now();
    try {
      const candidates = listWorktreeCandidates(Object.values(this.cfg.repos).map((r) => r.path), sup.id);
      if (candidates.length === 0) {
        sup.keptWorktrees = [];
        return;
      }
      const open = await sup.platform.openConversations(candidates.filter((c) => c.kind === 'conversation').map((c) => c.runId));
      const inFlight = new Set([...sup.leases].map((lease) => lease.runId));
      const targets = selectForRemoval(candidates, open, Date.now(), inFlight);
      if (targets.length === 0) {
        sup.keptWorktrees = [];
        return;
      }
      const env = scrubEnv(process.env);
      const byRepo = targets.reduce((acc, c) => acc.set(c.repoPath, [...(acc.get(c.repoPath) ?? []), c]), new Map<string, WorktreeCandidate[]>());
      const collected = await Promise.all(
        [...byRepo].map(([repoPath, group]) => this.gitLocks.run(path.resolve(repoPath), () => removeWorktrees(group, env))),
      );
      const removed = collected.reduce((n, c) => n + c.removed, 0);
      // lo que se anuncia al server: recuentos por conversación, nunca paths (worktree_report).
      sup.keptWorktrees = collected.flatMap((c) => c.kept).sort((a, b) => compareRunIds(a.runId, b.runId));
      if (removed > 0) console.log(`${this.tagOf(sup)} gc: ${removed} worktree(s) recogido(s)`);
    } catch (err) {
      console.error(`${this.tagOf(sup)} gc de worktrees falló: ${(err as Error).message}`);
    }
  }

  // --- recursos del run ---

  // entrada de la config local de un recurso para un run de esa plataforma (null = sin mapear en esta máquina, o
  // no expuesto a ella: el run lo ve igual que uno sin mapear). repo y aws viven en las claves de siempre de la
  // config (config-legacy.ts).
  private refOf(sup: PlatformSupervisor, type: string, key: string | null): unknown {
    const field = Object.hasOwn(LEGACY_RESOURCE_KEYS, type) ? LEGACY_RESOURCE_KEYS[type] : undefined;
    // las sesiones de navegador viven en la config v2 (resources.browser).
    const map: Readonly<Record<string, unknown>> | undefined = field ? this.cfg[field] : type === RESOURCE_TYPE.browser ? this.browserRefs : undefined;
    return key !== null && map && Object.hasOwn(map, key) && isExposed(this.exposure(sup), type, key) ? map[key] : null;
  }

  // deny de todo kit para un segmento de la plataforma: el run-config de todas (con estado en disco), el scratch de
  // las demás y lo privado de las demás (su estado y su auditoría). por segmento: una plataforma añadida en caliente
  // queda cubierta en el siguiente. con una sola plataforma, lo de las demás es vacío: el deny de siempre.
  private runDeny(sup: PlatformSupervisor): string[] {
    // la local solo desde que tiene estado en disco: un daemon que nunca sirvió un `runner run` deja el deny como estaba.
    const localOnDisk = fs.existsSync(platformHome(LOCAL_PLATFORM_ID));
    const configured = [...new Set([...Object.keys(this.platformsCfg), ...this.supervisors.keys()])].filter((id) => id !== LOCAL_PLATFORM_ID || localOnDisk);
    // el vault de las sesiones de navegador (t#495, M7) a todo kit, no solo a los de lectura: una edición tampoco lo
    // lee. sin navegador configurado, nada.
    return [...allRunConfigDirs().flatMap(runConfigDeny), ...otherScratchDeny(sup.id, configured), ...otherPlatformsDeny(sup.id, configured), ...browserVaultDeny()];
  }

  // latido del run desde el claim hasta el cierre: transporta el soft-cancel del server (y refresca
  // la presencia del runner). el run muere si ya no es suyo (platforms/platform.ts::heartbeat).
  private startHeartbeat(sup: PlatformSupervisor, lease: RunLease, heartbeatMs: number, seg: RunSegment): NodeJS.Timeout {
    const runId = lease.runId;
    return setInterval(() => {
      void sup.platform
        .heartbeat(runId, seg)
        .then((verdict) => {
          if (!verdict.stop) return;
          console.log(`${this.tagOf(sup)} run ${runId} ${verdict.reason}; deteniéndolo`);
          lease.kill('cancel');
        })
        .catch((err: Error) => {
          // con los slots llenos el loop no reclama: el latido es quien se entera de que la credencial murió.
          if (err instanceof PlatformRejectedError) this.platformRejected(sup, err);
          else console.error(`${this.tagOf(sup)} heartbeat del run ${runId} falló: ${err.message}`);
        });
    }, Math.max(MIN_HEARTBEAT_MS, heartbeatMs));
  }

  // --- ejecución ---

  private async executeRun(sup: PlatformSupervisor, offered: ClaimResponse, lease: RunLease): Promise<void> {
    const claim = await this.enforceToolset(sup, offered);
    if (claim === null) return;
    const { run } = claim;
    const tag = `run ${run.id}`;
    const log = this.tagOf(sup);
    console.log(
      `${log} ${tag} reclamado (${run.kind}${run.profile ? `, perfil ${run.profile}` : ''}, entry ${run.entryId}${claim.tier ? `, tier ${claim.tier}` : ''}${run.repo ? `, repo ${run.repo}${run.branch ? `@${run.branch}` : ''}` : ''}${run.sessionId ? `, sesión ${run.sessionId}` : ''}${run.model ? `, modelo ${run.model}` : ''})`,
    );
    // env base del run: el del usuario saneado. el perfil aws de su cuenta (o la aws vacía de una cuenta sin
    // mapear, aws_strict) lo pone el recurso aws (resources/aws.ts) y se suelta al cerrar el segmento.
    const env = { ...scrubEnv(process.env), AWS_PAGER: '' };
    // identidad del proceso en cada llamada del run (servers anteriores a los segmentos: nada).
    const seg = run.segment !== null ? { segment: run.segment } : {};
    const heartbeat = this.startHeartbeat(sup, lease, claim.heartbeatMs, seg);
    const feed = claim.events?.enabled ? new EventUploader((events) => sup.platform.events(run.id, events, seg), claim.events, tag) : null;
    // toolset_v1 en sombra: viaja en todo status de este segmento (nada si el claim no lo trajo).
    const shadow = this.toolsetShadow(sup, claim, tag);
    const withShadow = shadow !== null ? { toolsetShadow: shadow } : {};
    // los recursos de un claim que manda con toolset_v1 (v0) son los de sus grants, ya validados contra el techo y
    // la exposición (platforms/claim-v0.ts); los de uno legacy salen de sus campos.
    const requests = claim.resources ?? legacyRequests(run);
    const startedAt = Date.now();
    this.audit.append(claimedRecord(this.auditSubject(sup), claim, { grants: requests, toolset: this.auditToolset(sup, claim), attestations: v0Announce(this.capabilities()).attestations }));
    // el cierre del segmento en la auditoría (sin el texto del status: solo números, nombres y un código).
    const audited = (c: { lockWaitMs: number; materialized: MaterializedRun['resources']; report: StatusReport; toolsByName: Record<string, number>; code: string | null }): void =>
      this.audit.append(closedRecord(this.auditSubject(sup), claim, { startedAt, ...c }));

    let res: MaterializedRun;
    try {
      // un claim toolset_v1 aísla lo que no pide (la aws de la máquina), y uno de cualquier plataforma que no sea la
      // legacy también: sin compatibilidad que guardar, una plataforma nueva no hereda la aws del usuario. uno
      // legacy de duckhunt, nunca.
      const isolate = claim.toolset !== null || sup.id !== LEGACY_PLATFORM_ID;
      const plan = this.registry.plan(requests, (type, key) => this.refOf(sup, type, key), isolate);
      res = await materializeRun(plan, { platform: sup.id, runId: run.id, env, gitLocks: this.gitLocks, toolset: claim.toolset !== null }, { dir: () => scratchDir(sup.id), exclusive: legacyScratchExclusive(run) });
    } catch (err) {
      clearInterval(heartbeat);
      await feed?.close();
      const failed: StatusReport = { status: 'failed', error: legacyResourceError(err) };
      audited({ lockWaitMs: 0, materialized: [], report: failed, toolsByName: {}, code: err instanceof ResourceUnavailableError ? AUDIT_OUTCOME.resourceUnavailable : AUDIT_OUTCOME.runnerError });
      await sup.platform.result(run.id, { ...failed, ...withShadow, ...seg });
      return;
    }
    const ctx: FeedContext = {
      cwd: res.cwd.dir,
      home: os.homedir(),
      bodyMaxChars: claim.events?.bodyMaxChars ?? EVENTS_DEFAULTS.bodyMaxChars,
      toolArgMaxChars: claim.events?.toolArgMaxChars ?? EVENTS_DEFAULTS.toolArgMaxChars,
      platformServer: claim.mcp.serverName,
    };
    const note = (text: string): void => {
      console.log(`${log} ${tag}: ${text}`);
      feed?.push(systemEvent(text, ctx));
    };
    note(res.note);
    [...claim.warnings, ...res.warnings].forEach(note);
    // con el interruptor del flip el daemon no anuncia sesiones de navegador: un grant que llegara se queda sin usar.
    if (!this.toolsetRender && claim.toolsetShadow?.toolset.grants.some((g) => g.type === RESOURCE_TYPE.browser)) {
      note('la sesión de navegador del run no se usa: defaults.toolsetRender está en false (solo en sombra)');
    }

    const lockStart = Date.now();
    const releaseLocks = await holdLocks(res.locks, this.cwdLocks, lease.killed, note);
    const lockWaitMs = Date.now() - lockStart;
    // volver atrás con los ficheros (t#564, ver cabecera): antes de la foto del turno y con el cwd ya tomado.
    const restoreError = claim.restore ? await this.restoreFiles(claim, res, note) : null;
    // diff del turno (t#514, turn-changes.ts): la foto de antes, ya con el turno del cwd tomado.
    const changesFrom = restoreError === null && claim.changes && res.cwd.checkout ? await snapshotTree(res.cwd.dir, res.env) : null;
    // y su HEAD (t#564): con la foto, el punto al que podrá volver este turno.
    const startHead = changesFrom !== null ? await headOf(res.cwd.dir, res.env) : null;
    const start = changesFrom !== null && startHead !== null ? { startTree: changesFrom, startHead } : {};
    // mcp-config con el token per-run (run-mcp-config.ts: 0600 en un directorio 0700; se borra al terminar).
    let mcpFile: string | null = null;
    let report: StatusReport;
    let attempt: Attempt | null = null;
    // los servidores mcp de los recursos (t#495, M7), con los turnos ya tomados; null = no se pudieron preparar.
    let resourceMcp: RunMcp | null = null;
    try {
      if (restoreError !== null) throw restoreError;
      resourceMcp = await res.mcp();
      // la tool de permisos (t#527) junto a los de los recursos: res_<tipo>_<clave> nunca choca con su nombre.
      mcpFile = writeRunMcpConfig(run.id, claim.mcp, sup.id, claim.extraMcp, { ...permissionMcpServers(claim), ...resourceMcp.servers });
      ({ report, attempt } = await this.runAttempts(sup, withResourceTools(claim, resourceMcp), lease, res, mcpFile, feed, ctx, note));
    } catch (err) {
      report = { status: 'failed', error: err === restoreError || resourceMcp !== null ? (err as Error).message : legacyResourceError(err) };
    } finally {
      if (mcpFile !== null) fs.rmSync(mcpFile, { force: true });
      clearInterval(heartbeat);
    }
    // los slash commands que cargó el segmento (t#555), con el cwd aún en pie: sus ficheros dan las descripciones. los del
    // proyecto solo cuentan en edición (lectura va con --setting-sources user).
    // nunca lanza: un fallo aquí no puede saltarse la liberación de los recursos ni el informe.
    const init = attempt?.stream.initCatalog ?? null;
    const edit = run.profile === PROMPT_PROFILE.edit;
    try {
      if (init) this.slashCatalogOf(sup.id).record({ edit, repo: run.repo, commands: resolveSlashCommands(init, { configDir: claudeConfigDir(), projectCwd: edit ? res.cwd.dir : null }) });
    } catch (err) {
      console.error(`${log} ${tag}: slash commands sin registrar: ${(err as Error).message}`);
    }
    // la foto de después y su diff, antes de soltar los recursos (el worktree puede borrarse) y con el cwd aún tomado.
    const changes = changesFrom !== null && claim.changes ? await turnChanges(res.cwd.dir, res.env, changesFrom, claim.changes) : null;
    // los recursos se sueltan (el worktree se marca o se borra) ANTES de reportar: ver cabecera. y con sus
    // turnos aún tomados: un recurso exclusivo se suelta entero antes de que lo reciba el siguiente run.
    // un recurso que no se pudo preparar: nada se lanzó, se suelta todo como aborted (sin devolver nada al vault).
    await res.release(resourceMcp === null ? RELEASE.aborted : RELEASE_BY_STATUS[report.status]);
    releaseLocks();

    await feed?.close();
    // tras el feed y antes del cierre: con el run aún corriendo, el server lo acepta (ver turn-changes.ts).
    if (changes !== null) await sup.platform.changes?.(run.id, changes, seg);
    const code =
      restoreError !== null ? AUDIT_OUTCOME.runnerError : resourceMcp === null ? AUDIT_OUTCOME.resourceUnavailable : outcomeCode(report.status, attempt && attemptFacts(attempt));
    audited({ lockWaitMs, materialized: res.resources, report, toolsByName: attempt?.stream.toolsByName ?? {}, code });
    await sup.platform.result(run.id, { ...report, ...start, ...withShadow, ...seg });
    console.log(`${log} ${tag} terminado (${report.status}${report.error ? `: ${report.error}` : ''})`);
    void this.syncSlashCommands(sup);
  }

  // el worktree de la conversación a la foto del claim (t#564, rewind-files.ts): null si volvió; si no, el error con el
  // que falla el segmento (sin lanzar claude). parseClaim ya exige worktree; aquí además un cwd que sea un checkout.
  private async restoreFiles(claim: ClaimResponse, res: MaterializedRun, note: (text: string) => void): Promise<Error | null> {
    if (!claim.restore) return null;
    try {
      if (claim.run.isolation !== RUN_ISOLATION.worktree || !res.cwd.checkout) throw new Error('el run no trabaja en un worktree');
      await restoreTree(res.cwd.dir, res.env, claim.restore);
      note('ficheros restaurados a como estaban al empezar ese turno');
      return null;
    } catch (err) {
      const error = new Error(`${REWIND_RESTORE_ERROR}: ${(err as Error).message}`);
      note(`no se pudieron restaurar los ficheros (${(err as Error).message}): el turno no se lanza`);
      return error;
    }
  }

  // sube el catálogo de slash commands a la plataforma si no tiene el de ahora (una subida a la vez por plataforma; el
  // catálogo espacia los reintentos de un fallo). nunca lanza.
  private async syncSlashCommands(sup: PlatformSupervisor): Promise<void> {
    const upload = sup.platform.slashCommands?.bind(sup.platform);
    const catalog = upload && !this.slashUploads.has(sup.id) ? this.slashCatalogOf(sup.id) : null;
    const pending = catalog?.pending() ?? null;
    if (!upload || !catalog || !pending) return;
    this.slashUploads.add(sup.id);
    try {
      catalog.settle(pending.hash, await upload(pending.catalog));
    } finally {
      this.slashUploads.delete(sup.id);
    }
  }

  // el catálogo de la plataforma, cargado de su fichero la primera vez.
  private slashCatalogOf(id: string): SlashCommandCatalog {
    const known = this.slashCatalogs.get(id);
    if (known) return known;
    const fresh = new SlashCommandCatalog(slashCommandsPath(id));
    this.slashCatalogs.set(id, fresh);
    return fresh;
  }

  // el flip de toolset_v1 (t#495, M5): un claim de duckhunt-42 con `toolset` se lanza con el render del daemon
  // (toolset/legacy-render.ts) salvo el interruptor; uno sin toolset (un server anterior) o de v0 (ya aplicado), tal
  // cual. un grant que no se puede cumplir (un tipo que el daemon no sirve, una clave no expuesta) rechaza el claim:
  // se cierra como failed con su código, a la auditoría, y devuelve null.
  private async enforceToolset(sup: PlatformSupervisor, claim: ClaimResponse): Promise<ClaimResponse | null> {
    if (!this.toolsetRender || sup.platform.protocol !== PROTOCOL.duckhunt42 || claim.toolset !== null || claim.toolsetShadow === null) return claim;
    try {
      return renderLegacyClaim(claim, {
        ceiling: this.platformsCfg[sup.id]?.ceiling ?? legacyPlatform().ceiling,
        expose: this.exposure(sup),
        resourceTypes: this.registry.types(),
        awsCli: this.hasAws,
      }).claim;
    } catch (err) {
      if (!(err instanceof ClaimRejectedError)) throw err;
      const error = `claim rechazado por el runner (${err.message})`;
      console.error(`${this.tagOf(sup)} run ${claim.run.id}: ${error}`);
      this.audit.append(rejectedRecord(this.auditSubject(sup), claim.run.id, rejectCode(error)));
      await sup.platform.result(claim.run.id, { status: 'failed', error, ...(claim.run.segment !== null ? { segment: claim.run.segment } : {}) });
      return null;
    }
  }

  // el toolset de un claim para la auditoría: el de un claim v0 tal como se aplicó (platforms/claim-v0.ts); el de uno
  // legacy en sombra, cortado por el techo de la plataforma; sin toolset, null.
  private auditToolset(sup: PlatformSupervisor, claim: ClaimResponse): ClaimedRecord['toolset'] {
    if (claim.policyAudit) return { requested: toolsetSummary(claim.policyAudit.requested), effective: toolsetSummary(claim.policyAudit.effective), narrowed: claim.policyAudit.narrowed };
    if (claim.toolsetShadow === null) return null;
    const { toolset, narrowed } = intersectToolset(claim.toolsetShadow.toolset, this.platformsCfg[sup.id]?.ceiling ?? legacyPlatform().ceiling);
    return { requested: toolsetSummary(claim.toolsetShadow.toolset), effective: toolsetSummary(toolset), narrowed };
  }

  // toolset_v1 en sombra de un claim (t#495, M5): su toolset ∩ el techo de la plataforma, renderizado y comparado
  // con las listas que mandan (toolset/shadow.ts). lo que el techo recorta y lo que no casa, al log: aviso si la
  // diferencia no es la buscada. null = el claim no trajo toolset.
  private toolsetShadow(sup: PlatformSupervisor, claim: ClaimResponse, tag: string): ToolsetShadow | null {
    if (claim.toolsetShadow === null) return null;
    const ceiling = this.platformsCfg[sup.id]?.ceiling ?? legacyPlatform().ceiling;
    const { shadow, narrowed } = shadowOf(claim.toolsetShadow, ceiling, { mcpServerName: claim.mcp.serverName, awsCli: this.hasAws });
    if (narrowed.length > 0) console.log(`${this.tagOf(sup)} ${tag}: toolset_v1 acotado por el techo de ${sup.id}: ${narrowed.join(', ')}`);
    if (!shadow.match) {
      const known = shadow.known.length > 0 ? ` (${shadow.known.join(', ')})` : '';
      if (shadow.explained) console.log(`${this.tagOf(sup)} ${tag}: toolset_v1 en sombra: solo la diferencia buscada${known}`);
      else console.warn(`${this.tagOf(sup)} ${tag}: toolset_v1 en sombra no casa con las listas del server${known}`);
    }
    return shadow;
  }

  // uno o dos intentos: reanudación fallida antes de que el asistente hablara (sesión inexistente
  // en esta máquina, borrada, de otro daemon) → un solo reintento desde cero con el prompt de respaldo.
  private async runAttempts(
    sup: PlatformSupervisor,
    claim: ClaimResponse,
    lease: RunLease,
    res: MaterializedRun,
    mcpFile: string,
    feed: EventUploader | null,
    ctx: FeedContext,
    note: (text: string) => void,
  ): Promise<{ report: StatusReport; attempt: Attempt }> {
    const { run } = claim;
    // settings leídos por run (pueden cambiar con el daemon vivo): lectura solo carga los de usuario y
    // espeja su shell y su escritura; un run de reglas carga todos y espeja su escritura; edición, nada.
    const readPrompt = run.kind === RUN_KIND.prompt && run.profile === PROMPT_PROFILE.read;
    const deny = readPrompt
      ? mirroredDeny(settingsFilesFor(res.cwd.dir, true), READ_MIRRORED_TOOLS)
      : run.kind !== RUN_KIND.prompt
        ? mirroredDeny(settingsFilesFor(res.cwd.dir, false), WRITE_TOOLS)
        : [];
    // shell de lectura solo en un checkout del que una lectura recursiva no pueda salir (el scratch no
    // es un checkout: no se revisa). una vez por segmento: el reintento desde cero usa el mismo cwd.
    const shell = await readShellGuard(res.cwd.checkout ? res.cwd.dir : null, claim.tools, deny, res.env);
    if (shell.dropShell) {
      console.warn(`${this.tagOf(sup)} run ${run.id}: shell de lectura fuera en este segmento: ${readShellLog(shell)}`);
      note(readShellNote(shell)!);
    }
    const args = (prompt: string, resumeSessionId: string | null): string[] =>
      buildClaudeArgs({
        claim,
        prompt,
        mcpConfigFile: mcpFile,
        supported: this.claude.supported,
        resumeSessionId,
        // el que pide duckhunt para esta conversación; si no pide ninguno, el default de la máquina.
        model: run.model ?? this.cfg.defaults.model,
        configBudgetUsd: this.cfg.defaults.maxBudgetUsd,
        skipPermissions: res.cwd.skipPermissions,
        payingWithApiKey: !!process.env.ANTHROPIC_API_KEY,
        mirroredDeny: deny,
        runConfigDeny: this.runDeny(sup),
        secretPathsDeny: this.secretDeny,
        withoutShell: shell.dropShell,
        permissionPromptTool: supportsPermissionPromptTool(this.claude.version),
        // volver atrás (t#564): solo con --resume; el reintento desde cero (resumeSessionId null) no lo lleva.
        resumeAt: run.resumeAt,
        rewind: supportsRewind(this.claude.version),
      });
    // reanudar o no lo decide el server: manda sessionId solo cuando hay sesión que retomar.
    const resume = run.sessionId;
    let attempt = await this.spawnClaude(sup, claim, lease, args(claim.prompt, resume), res, feed, ctx);
    let resumed: boolean | undefined = resume ? true : undefined;
    if (resume && attempt.killedBy === null && attempt.exitCode !== 0 && !attempt.stream.sawAssistant && claim.fallbackPrompt) {
      console.log(`${this.tagOf(sup)} run ${run.id}: la sesión ${resume} no se pudo reanudar`);
      note('la sesión anterior no se pudo reanudar en este runner: reintento desde cero');
      attempt = await this.spawnClaude(sup, claim, lease, args(claim.fallbackPrompt, null), res, feed, ctx);
      resumed = false;
    }
    return { report: reportFor(attempt, resumed), attempt };
  }

  // spawnea claude en su propio grupo de procesos, consume stdout (stream-json → contadores + feed)
  // y stderr (tail), bombea el progreso y aplica el timeout wall-clock. si el run ya murió (cancel o
  // parada mientras esperaba turno) no lo lanza. resuelve siempre (nunca rechaza).
  private spawnClaude(
    sup: PlatformSupervisor,
    claim: ClaimResponse,
    lease: RunLease,
    args: string[],
    res: MaterializedRun,
    feed: EventUploader | null,
    ctx: FeedContext,
  ): Promise<Attempt> {
    const runId = claim.run.id;
    const seg = claim.run.segment !== null ? { segment: claim.run.segment } : {};
    if (lease.killedBy) return Promise.resolve({ exitCode: null, killedBy: lease.killedBy, stream: newStreamState(), stderrTail: '' });
    return new Promise((resolve) => {
      const stream = newStreamState();
      const stderrTail: string[] = [];
      let killedBy: KillReason | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let drainTimer: NodeJS.Timeout | null = null;
      let logFile: number | null = null;
      if (this.opts.verboseLog) {
        try {
          logFile = fs.openSync(path.join(logsDir(sup.id), `${runId}.jsonl`), 'a');
        } catch (err) {
          console.error(`${this.tagOf(sup)} no se pudo abrir el log del run: ${(err as Error).message}`);
        }
      }

      let child: ChildProcess;
      try {
        child = spawn('claude', args, { cwd: res.cwd.dir, env: { ...res.env, ...claudeRunEnv(res.env, claim) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        if (logFile !== null) fs.closeSync(logFile);
        resolve({ exitCode: null, killedBy: null, stream, stderrTail: `no se pudo lanzar claude: ${(err as Error).message}` });
        return;
      }

      const kill = (reason: KillReason): void => {
        if (killedBy) return;
        killedBy = reason;
        signalGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      };
      lease.attach(child, kill);

      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        const ev = consumeStreamLine(stream, line);
        if (ev && feed) feedEventsFromStream(ev, ctx).forEach((e) => feed.push(e));
        if (logFile !== null) fs.writeSync(logFile, `${line}\n`);
      });
      readline.createInterface({ input: child.stderr! }).on('line', (line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        if (logFile !== null) fs.writeSync(logFile, `${JSON.stringify({ type: 'stderr', line })}\n`);
      });

      // progreso: tool calls del segmento (throttled) + la nota de workdir en el primer envío.
      this.postProgress(sup, runId, 0, seg, clip(res.note, WORKDIR_MAX_CHARS));
      let reportedToolCalls = 0;
      let lastProgressAt = Date.now();
      const progress = setInterval(() => {
        const now = Date.now();
        if (stream.toolCalls === reportedToolCalls || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
        reportedToolCalls = stream.toolCalls;
        lastProgressAt = now;
        this.postProgress(sup, runId, reportedToolCalls, seg);
      }, PROGRESS_TICK_MS);

      const timeout = setTimeout(() => {
        console.log(`${this.tagOf(sup)} run ${runId} superó ${Math.round(claim.timeoutMs / 1000)}s; deteniendo claude`);
        kill('timeout');
      }, Math.max(MIN_RUN_TIMEOUT_MS, claim.timeoutMs));

      child.on('error', (err) => {
        stderrTail.push(`[runner] no se pudo lanzar claude: ${err.message}`);
      });
      child.on('exit', () => {
        // claude salió: si algo en background retiene sus pipes, se dejan de esperar.
        drainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, EXIT_DRAIN_MS);
      });
      child.on('close', (code) => {
        clearInterval(progress);
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (logFile !== null) fs.closeSync(logFile);
        lease.detach();
        resolve({ exitCode: code, killedBy, stream, stderrTail: stderrTail.join('\n').slice(-STDERR_TAIL_MAX_CHARS) });
      });
    });
  }

  // progreso del segmento: fuego y olvido (el siguiente envío lo corrige).
  private postProgress(sup: PlatformSupervisor, runId: string, toolCalls: number, seg: RunSegment, workdir?: string): void {
    void sup.platform.progress(runId, toolCalls, seg, workdir).catch((err) => console.error(`${this.tagOf(sup)} progress falló: ${(err as Error).message}`));
  }
}
