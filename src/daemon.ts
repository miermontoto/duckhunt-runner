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
//   un run cerrado.
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
//   servicio puede no reiniciarlo con ese código: sin `login` no vuelve).
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
// - plataformas (t#495, M6): todo lo que el daemon le dice a duckhunt pasa por el seam de plataforma
//   (platforms/platform.ts): el cable legacy y su credencial viven en platforms/duckhunt42.ts y
//   platforms/http-transport.ts, con los mismos cuerpos y respuestas (test/wire-legacy.test.ts,
//   test/wire-responses.test.ts). cada plataforma tiene su supervisor (platforms/supervisor.ts) con su
//   propio poll, sus runs y su server-state; los slots de la máquina se reparten con el scheduler
//   (platforms/scheduler.ts: pool global + cuota por plataforma, reservar antes de reclamar). una credencial
//   muerta para SOLO esa plataforma; el daemon sale con EXIT_CODE_UNPAIRED cuando no queda ninguna usable.
//   con una sola plataforma con todo el pool es el loop de siempre.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  concurrency,
  mergeEntries,
  parseConfig,
  readConfigText,
  saveConfig,
  splitConfig,
  type LocalConfig,
  type RunnerConfig,
} from './config.js';
import { ensureMachineId } from './machine.js';
import { secretPathsDeny } from './secret-paths.js';
import { CLAIM_OUTCOME } from './server-state.js';
import { consumeStreamLine, detectClaude, newStreamState, type ClaudeInfo } from './claude.js';
import { buildClaudeArgs } from './claude-args.js';
import { announcedCapabilities } from './announced-capabilities.js';
import { mirroredDeny, READ_MIRRORED_TOOLS, settingsFilesFor, WRITE_TOOLS } from './user-permissions.js';
import { EVENTS_DEFAULTS, PROMPT_PROFILE, RUN_KIND, type ClaimResponse } from './claim.js';
import { EventUploader } from './event-uploader.js';
import { clip, feedEventsFromStream, systemEvent, type FeedContext } from './feed.js';
import { scrubEnv } from './scrub-env.js';
import { reportFor, type Attempt, type KillReason, type StatusReport } from './status-report.js';
import { readShellGuard, readShellLog, readShellNote } from './read-shell-guard.js';
import { clearLegacyTmpConfigs, clearRunMcpConfigs, runConfigDeny, writeRunMcpConfig } from './run-mcp-config.js';
import { CONVERSATION_GC_INTERVAL_MS, listWorktreeCandidates, removeWorktrees, selectForRemoval, type WorktreeCandidate } from './resources/repo/gc.js';
import { KeyedMutex } from './keyed-mutex.js';
import { describeFinding, REPO_HEALTH_INTERVAL_MS, repoChoices, repoFindings, repoIssues, scanRepos, type RepoChoice, type RepoIssue } from './resources/repo/health.js';
import { ProviderRegistry } from './resources/registry.js';
import { holdLocks, materializeRun, type MaterializedRun } from './resources/lifecycle.js';
import { legacyRequests, legacyResourceError, legacyScratchExclusive } from './resources/legacy.js';
import { repoProvider } from './resources/repo/provider.js';
import { AWS_ACCOUNT_ID_RE, awsProvider } from './resources/aws.js';
import { LEGACY_RESOURCE_KEYS } from './config-legacy.js';
import { RELEASE, type ReleaseOutcome } from './resources/types.js';
import { applyRepoCommand, type RepoCommandResult } from './repo-commands.js';
import { RunLease, signalGroup } from './run-lease.js';
import { compareRunIds } from './run-id.js';
import { allRunConfigDirs, LEGACY_PLATFORM_ID, logsDir, scratchDir } from './paths.js';
import { runnerVersion } from './version.js';
import { PlatformRejectedError, PROTOCOL, type ClaimAnnounce, type Platform, type PlatformFactories, type RunSegment } from './platforms/platform.js';
import { PLATFORM_FACTORIES } from './platforms/duckhunt42.js';
import { Scheduler } from './platforms/scheduler.js';
import { PLATFORM_STATE, PlatformSupervisor, type SupervisorHooks } from './platforms/supervisor.js';

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
}

export class RunnerDaemon {
  // una por plataforma (platforms/supervisor.ts): hoy la legacy, con las rutas de siempre (paths.ts).
  private readonly supervisors = new Map<string, PlatformSupervisor>();
  // los slots de la máquina, repartidos entre plataformas.
  private readonly scheduler = new Scheduler(() => this.slots);
  // el poll de cada supervisor (la parada los espera).
  private readonly polls: Promise<void>[] = [];
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
  // proveedores de recursos de los runs (resources/registry.ts).
  private readonly registry = new ProviderRegistry([repoProvider, awsProvider]);
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
  // Read negado del directorio de mcp-configs: lo lleva todo kit (se calcula al arrancar).
  private runConfigDeny: string[] = [];
  // Read negado de las rutas reales de las credenciales de la máquina: todo kit de lectura (al arrancar).
  private secretDeny: string[] = [];
  // lo que cada supervisor necesita del daemon.
  private readonly hooks: SupervisorHooks = {
    announce: (sup) => this.announce(sup),
    rejected: (sup, err) => this.platformRejected(sup, err),
    commandsPending: (sup) => void this.syncRepoCommands(sup),
  };

  constructor(
    cfg: RunnerConfig,
    private readonly opts: DaemonOptions = {},
  ) {
    const { credential, local } = splitConfig(cfg);
    this.cfg = local;
    this.addSupervisor((opts.factories ?? PLATFORM_FACTORIES)[PROTOCOL.duckhunt42]!(LEGACY_PLATFORM_ID, credential));
  }

  // la plataforma legacy: siempre está (su credencial vive en las claves de siempre de la config).
  private get legacy(): PlatformSupervisor {
    return this.supervisors.get(LEGACY_PLATFORM_ID)!;
  }

  // runs en vuelo de todas las plataformas.
  private get leases(): RunLease[] {
    return [...this.supervisors.values()].flatMap((sup) => [...sup.leases]);
  }

  // un supervisor nuevo; con el daemon ya en marcha, arranca su poll.
  private addSupervisor(platform: Platform): PlatformSupervisor {
    const sup = new PlatformSupervisor(platform.id, platform, PLATFORM_STATE.active, this.hooks);
    this.supervisors.set(sup.id, sup);
    if (this.running) this.polls.push(this.poll(sup));
    return sup;
  }

  // slots del daemon: defaults.maxConcurrent de la config recargada.
  private get slots(): number {
    return concurrency(this.cfg.defaults);
  }

  // cuota de una plataforma: hoy todo el pool.
  private quota(_sup: PlatformSupervisor): number {
    return this.slots;
  }

  // el loop principal ya arrancó (los supervisores nuevos arrancan su poll al crearse).
  private running = false;

  private label(): string {
    return this.cfg.label ?? os.hostname();
  }

  // capacidades que se anuncian: prompt solo si el cli puede cumplir su perfil (permission mode
  // explícito, sin mcp del repo, deny list y settings solo del usuario en lectura), model solo con --model.
  private capabilities(): string[] {
    return announcedCapabilities({ hasAws: this.hasAws, supported: this.claude.supported, remoteRepoEdits: this.cfg.defaults.remoteRepoEdits });
  }

  /** loop principal: gc → claim → ejecutar en un slot libre → repetir, hasta SIGINT/SIGTERM.
   *  devuelve el exit code tras esperar el cierre de los runs en vuelo. */
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
    // run-config de cada plataforma con estado en disco (hoy solo el de la legacy).
    this.runConfigDeny = allRunConfigDirs().flatMap(runConfigDeny);
    const stale = clearRunMcpConfigs(LEGACY_PLATFORM_ID) + this.registry.sweep(LEGACY_PLATFORM_ID);
    if (stale > 0) console.log(`[runner] ${stale} config(s) de runs anteriores borrada(s)`);
    const legacy = clearLegacyTmpConfigs();
    if (legacy > 0) console.log(`[runner] ${legacy} mcp-config(s) de daemons < 0.10.2 borrado(s) del tmpdir`);
    const secrets = secretPathsDeny(process.env);
    this.secretDeny = secrets.rules;
    secrets.skipped.forEach((p) => console.warn(`[runner] secret_paths: ${p} no cabe en una regla de permisos de claude: queda solo la lista genérica del server`));
    this.adoptMachineId();
    this.installSignalHandlers();
    console.log(
      `[runner] duckhunt-runner ${runnerVersion() ?? '?'} · ${this.label()} → ${this.legacy.platform.identity().baseUrl} (claude ${this.claude.version}, aws cli ${this.hasAws ? 'sí' : 'no'}, ${Object.keys(this.cfg.repos).length} repos, ${Object.keys(this.cfg.aws).length} cuentas aws, capacidades ${this.capabilities().join(',')}, ${this.slots} slot${this.slots === 1 ? '' : 's'}, poll ${CLAIM_POLL_MS / 1000}s)`,
    );
    await this.refreshRepoHealth();
    this.running = true;
    this.supervisors.forEach((sup) => this.polls.push(this.poll(sup)));
    while (!this.stopping) await this.idle(CLAIM_POLL_MS);
    await Promise.all(this.polls);
    // parada: cada run en vuelo recibió kill('shutdown'); se espera a que reporte su cierre.
    while (this.leases.length > 0) await this.idle(CLAIM_POLL_MS);
    console.log('[runner] detenido');
    return this.exitCode;
  }

  // poll de una plataforma: recargar la config → reservar un slot → gc → claim → ejecutar → repetir, hasta la
  // parada (o hasta que el supervisor deje de ser el de su id).
  private async poll(sup: PlatformSupervisor): Promise<void> {
    while (!this.stopping && this.supervisors.get(sup.id) === sup) {
      // también con los slots llenos: un maxConcurrent más alto vale sin esperar a que acabe un run.
      await this.reloadConfig();
      void this.refreshRepoHealth();
      if (!(await this.pollOnce(sup)) && !this.stopping) await sup.idle(CLAIM_POLL_MS);
    }
  }

  // una vuelta del poll: con un slot reservado (pool y cuota), gc y claim. true = reclamó un run: la siguiente
  // vuelta va en el acto. sin slot, espera a que se libere uno (o al siguiente poll).
  private async pollOnce(sup: PlatformSupervisor): Promise<boolean> {
    sup.blocked = false;
    if (!sup.claiming) return false;
    if (!this.scheduler.tryReserve(sup.id, this.quota(sup))) {
      sup.blocked = true;
      return false;
    }
    await this.collectWorktrees(sup);
    const claim = this.stopping ? null : await sup.claim();
    if (!claim) {
      this.scheduler.release(sup.id);
      return false;
    }
    this.start(sup, claim);
    return true;
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
  // se detiene y sale con EXIT_CODE_UNPAIRED.
  private platformRejected(sup: PlatformSupervisor, err: PlatformRejectedError): void {
    if (this.stopping || sup.state === PLATFORM_STATE.unpaired) return;
    const last = ![...this.supervisors.values()].some((other) => other !== sup && other.usable);
    console.error(`[runner] ${err.message}. ${last ? 'el daemon se detiene' : `la plataforma ${sup.id} deja de reclamar`}`);
    sup.state = PLATFORM_STATE.unpaired;
    sup.recordServerState(CLAIM_OUTCOME.unpaired, null);
    if (last) {
      this.stopping = true;
      this.exitCode = EXIT_CODE_UNPAIRED;
    }
    sup.leases.forEach((lease) => lease.kill('cancel'));
    if (last) this.wakeAll();
    else sup.wake();
  }

  // despierta todos los polls y el loop principal (parada).
  private wakeAll(): void {
    this.supervisors.forEach((sup) => sup.wake());
    this.wake?.();
  }

  // un slot libre: lo prueba en el acto su plataforma y cualquiera que esperara slot (y la parada, si espera).
  private slotFreed(sup: PlatformSupervisor): void {
    sup.wake();
    this.supervisors.forEach((other) => other.blocked && other.wake());
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
  // son su cuota (nunca los libres del pool, que dirían cuánto trabajo traen las demás).
  private announce(sup: PlatformSupervisor): ClaimAnnounce {
    return {
      label: this.label(),
      machineId: this.cfg.machineId ?? null,
      capabilities: this.capabilities(),
      slots: this.quota(sup),
      version: runnerVersion(),
      claudeVersion: this.claude.version,
      repos: Object.keys(this.cfg.repos),
      repoIssues: this.repoHealth,
      repoCandidates: this.repoChoices,
      // solo ids de cuenta: `default` (y cualquier otra clave) no es una cuenta que duckhunt conozca.
      awsAccounts: Object.keys(this.cfg.aws).filter((key) => AWS_ACCOUNT_ID_RE.test(key)),
      kept: sup.keptWorktrees,
    };
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
      .catch((err) => console.error(`[runner] run ${lease.runId} reventó: ${(err as Error).message}`))
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
      const commands = await sup.platform.commands(this.label());
      if (!commands || commands.length === 0) return;
      const env = scrubEnv(process.env);
      const disabled = this.cfg.defaults.remoteRepoEdits === false;
      // i/o secuencial: cada comando se aplica sobre el mapa que dejó el anterior.
      const before = this.cfg.repos;
      let repos = before;
      const results: RepoCommandResult[] = [];
      for (const cmd of commands) {
        if (disabled) {
          results.push({ id: cmd.id, ok: false, error: 'este runner no acepta cambios de repos desde duckhunt (defaults.remoteRepoEdits)' });
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

  // relee el fichero si su texto cambió: mapas, etiqueta y defaults se toman tal cual; un fichero
  // ausente o ilegible deja la config cargada (se avisa una vez por cambio). la credencial no se
  // toca: un `login` de la misma instancia o un refresh sin guardar fuerzan el refresh que lo resuelve.
  private async reloadConfig(): Promise<void> {
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
    let next: RunnerConfig;
    try {
      next = parseConfig(text);
    } catch (err) {
      console.error(`[runner] ${(err as Error).message} — sigo con la config cargada`);
      return;
    }
    const { credential, local } = splitConfig(next);
    this.legacy.platform.observe(credential);
    if (JSON.stringify(local) === JSON.stringify(this.cfg)) return;
    const reposChanged = JSON.stringify(local.repos) !== JSON.stringify(this.cfg.repos);
    this.cfg = local;
    console.log(`[runner] config recargada: ${Object.keys(local.repos).length} repos, ${Object.keys(local.aws).length} cuentas aws, ${this.slots} slot${this.slots === 1 ? '' : 's'}`);
    if (reposChanged) await this.refreshRepoHealth(true);
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
      if (removed > 0) console.log(`[runner] gc: ${removed} worktree(s) recogido(s)`);
    } catch (err) {
      console.error(`[runner] gc de worktrees falló: ${(err as Error).message}`);
    }
  }

  // --- recursos del run ---

  // entrada de la config local de un recurso (null = sin mapear en esta máquina). repo y aws viven en las claves
  // de siempre de la config (config-legacy.ts).
  private refOf(type: string, key: string | null): unknown {
    const field = Object.hasOwn(LEGACY_RESOURCE_KEYS, type) ? LEGACY_RESOURCE_KEYS[type] : undefined;
    const map: Readonly<Record<string, unknown>> | undefined = field ? this.cfg[field] : undefined;
    return key !== null && map && Object.hasOwn(map, key) ? map[key] : null;
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
          console.log(`[runner] run ${runId} ${verdict.reason}; deteniéndolo`);
          lease.kill('cancel');
        })
        .catch((err: Error) => {
          // con los slots llenos el loop no reclama: el latido es quien se entera de que la credencial murió.
          if (err instanceof PlatformRejectedError) this.platformRejected(sup, err);
          else console.error(`[runner] heartbeat del run ${runId} falló: ${err.message}`);
        });
    }, Math.max(MIN_HEARTBEAT_MS, heartbeatMs));
  }

  // --- ejecución ---

  private async executeRun(sup: PlatformSupervisor, claim: ClaimResponse, lease: RunLease): Promise<void> {
    const { run } = claim;
    const tag = `run ${run.id}`;
    console.log(
      `[runner] ${tag} reclamado (${run.kind}${run.profile ? `, perfil ${run.profile}` : ''}, entry ${run.entryId}${claim.tier ? `, tier ${claim.tier}` : ''}${run.repo ? `, repo ${run.repo}${run.branch ? `@${run.branch}` : ''}` : ''}${run.sessionId ? `, sesión ${run.sessionId}` : ''}${run.model ? `, modelo ${run.model}` : ''})`,
    );
    // env base del run: el del usuario saneado. el perfil aws de su cuenta (o la aws vacía de una cuenta sin
    // mapear, aws_strict) lo pone el recurso aws (resources/aws.ts) y se suelta al cerrar el segmento.
    const env = { ...scrubEnv(process.env), AWS_PAGER: '' };
    // identidad del proceso en cada llamada del run (servers anteriores a los segmentos: nada).
    const seg = run.segment !== null ? { segment: run.segment } : {};
    const heartbeat = this.startHeartbeat(sup, lease, claim.heartbeatMs, seg);
    const feed = claim.events?.enabled ? new EventUploader((events) => sup.platform.events(run.id, events, seg), claim.events, tag) : null;

    let res: MaterializedRun;
    try {
      // solo un claim toolset_v1 aísla lo que no pide (la aws de la máquina); uno legacy, nunca.
      const plan = this.registry.plan(legacyRequests(run), (type, key) => this.refOf(type, key), claim.toolset !== null);
      res = await materializeRun(plan, { platform: sup.id, runId: run.id, env, gitLocks: this.gitLocks }, { dir: () => scratchDir(sup.id), exclusive: legacyScratchExclusive(run) });
    } catch (err) {
      clearInterval(heartbeat);
      await feed?.close();
      await sup.platform.result(run.id, { status: 'failed', error: legacyResourceError(err), ...seg });
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
      console.log(`[runner] ${tag}: ${text}`);
      feed?.push(systemEvent(text, ctx));
    };
    note(res.note);
    [...claim.warnings, ...res.warnings].forEach(note);

    const releaseLocks = await holdLocks(res.locks, this.cwdLocks, lease.killed, note);
    // mcp-config con el token per-run (run-mcp-config.ts: 0600 en un directorio 0700; se borra al terminar).
    let mcpFile: string | null = null;
    let report: StatusReport;
    try {
      mcpFile = writeRunMcpConfig(run.id, claim.mcp, sup.id);
      report = await this.runAttempts(sup, claim, lease, res, mcpFile, feed, ctx, note);
    } catch (err) {
      report = { status: 'failed', error: (err as Error).message };
    } finally {
      if (mcpFile !== null) fs.rmSync(mcpFile, { force: true });
      clearInterval(heartbeat);
    }
    // los recursos se sueltan (el worktree se marca o se borra) ANTES de reportar: ver cabecera. y con sus
    // turnos aún tomados: un recurso exclusivo se suelta entero antes de que lo reciba el siguiente run.
    await res.release(RELEASE_BY_STATUS[report.status]);
    releaseLocks();

    await feed?.close();
    await sup.platform.result(run.id, { ...report, ...seg });
    console.log(`[runner] ${tag} terminado (${report.status}${report.error ? `: ${report.error}` : ''})`);
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
  ): Promise<StatusReport> {
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
      console.warn(`[runner] run ${run.id}: shell de lectura fuera en este segmento: ${readShellLog(shell)}`);
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
        runConfigDeny: this.runConfigDeny,
        secretPathsDeny: this.secretDeny,
        withoutShell: shell.dropShell,
      });
    // reanudar o no lo decide el server: manda sessionId solo cuando hay sesión que retomar.
    const resume = run.sessionId;
    let attempt = await this.spawnClaude(sup, claim, lease, args(claim.prompt, resume), res, feed, ctx);
    let resumed: boolean | undefined = resume ? true : undefined;
    if (resume && attempt.killedBy === null && attempt.exitCode !== 0 && !attempt.stream.sawAssistant && claim.fallbackPrompt) {
      console.log(`[runner] run ${run.id}: la sesión ${resume} no se pudo reanudar`);
      note('la sesión anterior no se pudo reanudar en este runner: reintento desde cero');
      attempt = await this.spawnClaude(sup, claim, lease, args(claim.fallbackPrompt, null), res, feed, ctx);
      resumed = false;
    }
    return reportFor(attempt, resumed);
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
          console.error(`[runner] no se pudo abrir el log del run: ${(err as Error).message}`);
        }
      }

      let child: ChildProcess;
      try {
        child = spawn('claude', args, { cwd: res.cwd.dir, env: res.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
        console.log(`[runner] run ${runId} superó ${Math.round(claim.timeoutMs / 1000)}s; deteniendo claude`);
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
    void sup.platform.progress(runId, toolCalls, seg, workdir).catch((err) => console.error(`[runner] progress falló: ${(err as Error).message}`));
  }
}
