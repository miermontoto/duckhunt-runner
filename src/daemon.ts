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
// - kind=prompt usa un worktree POR CONVERSACIÓN que sobrevive entre segmentos (worktree.ts); lo
//   recoge conversation-gc.ts en el loop de claim. los kinds de reglas heredados (servers anteriores a
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
// - salud de los repos mapeados (repo-health.ts, t#463): el primer chequeo se ESPERA al arrancar (el
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
//   aws_strict (aws-env.ts: una cuenta sin mapear corre con la aws vacía) y seed_budget (claude-args.ts).
//   el gc anuncia en cada claim lo que conservó por guardar trabajo (worktree_report, recuentos; una
//   conversación que vuelve a reclamarse deja de anunciarse en el acto, sin esperar al siguiente gc). al
//   arrancar barre una vez los mcp-config que los daemons < 0.10.2 dejaban en el tmpdir.
// - modelo por run (0.12.0, t#465): anuncia `model` si el cli lista --model (announced-capabilities.ts)
//   y pasa a claude el del claim; sin él, `defaults.model` de la config; sin ninguno, el default del cli.
//   el claim manda sobre la config porque es la elección de la persona para esa conversación (su
//   default de ajustes, el composer, el hilo o la acción de una regla); la config queda como el default
//   de la máquina. también al reanudar: --model con --resume cambia el modelo de la sesión desde ese
//   turno, y el reintento desde cero usa el mismo. el modelo que se reporta en /status es el que de
//   verdad usó el bucle principal (claude.ts::reportedModel).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { CredentialRejectedError, refreshAccess } from './oauth.js';
import { AccessTokenSource } from './access-token.js';
import {
  concurrency,
  logsDir,
  mergeEntries,
  parseConfig,
  readConfigText,
  runConfigDir,
  saveConfig,
  scratchDir,
  splitConfig,
  type LocalConfig,
  type RepoConfig,
  type RunnerConfig,
  type RunnerCredential,
} from './config.js';
import { ensureMachineId } from './machine.js';
import { secretPathsDeny } from './secret-paths.js';
import { runAwsEnv, clearRunAwsConfigs, writeEmptyAwsConfig } from './aws-env.js';
import {
  CLAIM_OUTCOME,
  parseRunnerBlock,
  serverStateChanged,
  writeServerState,
  type KeptWorktree,
  type RunnerBlock,
  type ServerState,
} from './server-state.js';
import { consumeStreamLine, detectClaude, newStreamState, type ClaudeInfo } from './claude.js';
import { buildClaudeArgs } from './claude-args.js';
import { announcedCapabilities } from './announced-capabilities.js';
import { mirroredDeny, READ_MIRRORED_TOOLS, settingsFilesFor, WRITE_TOOLS } from './user-permissions.js';
import { claimRunId, EVENTS_DEFAULTS, parseClaim, PROMPT_PROFILE, RUN_ISOLATION, RUN_KIND, type ClaimedRun, type ClaimResponse } from './claim.js';
import { EventUploader, type SeqEvent } from './event-uploader.js';
import { clip, feedEventsFromStream, systemEvent, type FeedContext } from './feed.js';
import { scrubEnv } from './scrub-env.js';
import { clampReport, reportFor, type Attempt, type KillReason, type StatusReport } from './status-report.js';
import { prepareCheckout, prepareConversationWorktree, prepareRunWorktree, removeRunWorktree, touchWorktree } from './worktree.js';
import { readShellGuard, readShellLog, readShellNote } from './read-shell-guard.js';
import { clearLegacyTmpConfigs, clearRunMcpConfigs, runConfigDeny, writeRunMcpConfig } from './run-mcp-config.js';
import { chunk, CONVERSATION_GC_INTERVAL_MS, listWorktreeCandidates, removeWorktrees, selectForRemoval, type WorktreeCandidate } from './conversation-gc.js';
import { KeyedMutex } from './keyed-mutex.js';
import { describeFinding, REPO_HEALTH_INTERVAL_MS, repoChoices, repoFindings, repoIssues, scanRepos, type RepoChoice, type RepoIssue } from './repo-health.js';
import { applyRepoCommand, parseRepoCommands, type RepoCommandResult } from './repo-commands.js';
import { RunLease, signalGroup } from './run-lease.js';
import { runnerVersion } from './version.js';

const execFileP = promisify(execFile);

const CLAIM_POLL_MS = 5_000;
// cabecera de la respuesta del claim con los comandos de repos pendientes para esta máquina.
const REPO_COMMANDS_HEADER = 'x-duckhunt-repo-commands';
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
// toda llamada al server: sin respuesta en este plazo cuenta como fallo de red.
const API_TIMEOUT_MS = 30_000;
// POST /status: intentos con backoff exponencial (2 s, 4 s, 8 s, 16 s).
const STATUS_POST_ATTEMPTS = 5;
const STATUS_POST_BACKOFF_MS = 2_000;
// tras SIGINT/SIGTERM: margen para cerrar el run en curso antes de salir a la fuerza.
const SHUTDOWN_GRACE_MS = 20_000;
const EXIT_CODE_SIGINT = 130;
const EXIT_CODE_SIGTERM = 143;
// la credencial ya no vale (desvinculada, revocada o caducada): EX_CONFIG de sysexits, sin `login` no vuelve.
export const EXIT_CODE_UNPAIRED = 78;
// cabecera del 204 (o del 200 sin trabajo de un server >= t#465 P12) con el motivo de no recibir trabajo.
const RUNNER_STATE_HEADER = 'x-duckhunt-runner-state';
// topes de lo que el claim anuncia (RUNNER_CLAUDE_VERSION_MAX_CHARS) y de la nota de workdir.
const CLAUDE_VERSION_MAX_CHARS = 80;
const WORKDIR_MAX_CHARS = 300;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const HTTP_TIMEOUT = 408;
// estado del run que el latido espera mientras el proceso es su dueño.
const RUN_STATUS_RUNNING = 'running';
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

// cwd del run y lo que hay que hacer con él al terminar.
interface Workdir {
  workdir: string;
  repoCfg: RepoConfig | null;
  // worktree creado o reutilizado por el daemon (null = scratch o checkout directo).
  worktree: string | null;
  // conv-<id> de un prompt run: se conserva siempre.
  conversation: boolean;
  // nota para agent_run.workdir y el feed (sin paths absolutos).
  note: string;
  warnings: string[];
}

export interface DaemonOptions {
  verboseLog?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isTransient = (status: number): boolean => status === HTTP_TIMEOUT || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR;

export class RunnerDaemon {
  private readonly auth: AccessTokenSource;
  private claude: ClaudeInfo = { version: null, supported: new Set() };
  private hasAws = false;
  // runs en vuelo, uno por slot ocupado. por objeto y no por id: la misma fila re-encolada puede
  // reclamarse mientras el segmento anterior aún cierra.
  private readonly leases = new Set<RunLease>();
  // mapas, etiqueta y defaults: los recarga reloadConfig en cada vuelta del loop.
  private cfg: LocalConfig;
  // credencial viva: la rota el refresh y solo la cambia un `login` (oauth.ts::refreshAccess).
  private credential: RunnerCredential;
  // el último refresh rotado no se pudo escribir: al cambiar el fichero se fuerza otro refresh.
  private credentialUnsaved = false;
  // texto del fichero en la última recarga (undefined = aún sin leer).
  private configText: string | null | undefined;
  // git sobre un mismo checkout (clave: path resuelto del checkout) y cwd compartidos (clave: cwd).
  private readonly gitLocks = new KeyedMutex();
  private readonly cwdLocks = new KeyedMutex();
  private stopping = false;
  private exitCode = 0;
  private wake: (() => void) | null = null;
  private lastGcAt = 0;
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
  // conversaciones que el último gc conservó por guardar trabajo (null = aún no recogió: no se anuncia).
  private keptWorktrees: KeptWorktree[] | null = null;
  // lo último escrito en server-state.json.
  private serverState: ServerState | null = null;

  constructor(
    cfg: RunnerConfig,
    private readonly opts: DaemonOptions = {},
  ) {
    const { credential, local } = splitConfig(cfg);
    this.credential = credential;
    this.cfg = local;
    this.auth = new AccessTokenSource(async () => {
      const { access, credential, saved } = await refreshAccess(this.credential);
      this.credential = credential;
      this.credentialUnsaved = !saved;
      return access;
    });
  }

  // slots del daemon: defaults.maxConcurrent de la config recargada.
  private get slots(): number {
    return concurrency(this.cfg.defaults);
  }

  // fetch autenticado contra /api/runner con timeout y un reintento tras refresh en 401.
  private async api(pathname: string, body?: unknown): Promise<Response> {
    const call = async (token: string): Promise<Response> =>
      fetch(`${this.credential.baseUrl}/api/runner${pathname}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? '{}' : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    const token = await this.auth.token();
    const first = await call(token);
    if (first.status !== 401) return first;
    this.auth.invalidate(token);
    return call(await this.auth.token());
  }

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
    // lanza si la ruta no cabe en una regla de permisos: sin ese deny el daemon no arranca.
    this.runConfigDeny = runConfigDeny(runConfigDir());
    const stale = clearRunMcpConfigs() + clearRunAwsConfigs();
    if (stale > 0) console.log(`[runner] ${stale} config(s) de runs anteriores borrada(s)`);
    const legacy = clearLegacyTmpConfigs();
    if (legacy > 0) console.log(`[runner] ${legacy} mcp-config(s) de daemons < 0.10.2 borrado(s) del tmpdir`);
    const secrets = secretPathsDeny(process.env);
    this.secretDeny = secrets.rules;
    secrets.skipped.forEach((p) => console.warn(`[runner] secret_paths: ${p} no cabe en una regla de permisos de claude: queda solo la lista genérica del server`));
    this.adoptMachineId();
    this.installSignalHandlers();
    console.log(
      `[runner] duckhunt-runner ${runnerVersion() ?? '?'} · ${this.label()} → ${this.credential.baseUrl} (claude ${this.claude.version}, aws cli ${this.hasAws ? 'sí' : 'no'}, ${Object.keys(this.cfg.repos).length} repos, ${Object.keys(this.cfg.aws).length} cuentas aws, capacidades ${this.capabilities().join(',')}, ${this.slots} slot${this.slots === 1 ? '' : 's'}, poll ${CLAIM_POLL_MS / 1000}s)`,
    );
    await this.refreshRepoHealth();
    while (!this.stopping) {
      // también con los slots llenos: un maxConcurrent más alto vale sin esperar a que acabe un run.
      await this.reloadConfig();
      void this.refreshRepoHealth();
      // slots llenos: el cierre de un run despierta el loop (o el siguiente poll).
      if (this.leases.size >= this.slots) {
        await this.idle(CLAIM_POLL_MS);
        continue;
      }
      await this.collectWorktrees();
      const claim = this.stopping ? null : await this.claim();
      if (claim) this.start(claim);
      else if (!this.stopping) await this.idle(CLAIM_POLL_MS);
    }
    // parada: cada run en vuelo recibió kill('shutdown'); se espera a que reporte su cierre.
    while (this.leases.size > 0) await this.idle(CLAIM_POLL_MS);
    console.log('[runner] detenido');
    return this.exitCode;
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

  // la credencial ya no vale: se para (sin reintentar), se cortan los runs (duckhunt ya los canceló al
  // desvincular; sin credencial no pueden ni latir) y se sale con EXIT_CODE_UNPAIRED.
  private stopUnpaired(err: CredentialRejectedError): void {
    if (this.stopping) return;
    console.error(`[runner] ${err.message}. el daemon se detiene`);
    this.recordServerState(CLAIM_OUTCOME.unpaired, null);
    this.stopping = true;
    this.exitCode = EXIT_CODE_UNPAIRED;
    this.leases.forEach((lease) => lease.kill('cancel'));
    this.wake?.();
  }

  // guarda lo que el server acaba de decir de esta máquina para `status` (solo si cambió o envejeció).
  private recordServerState(state: string | null, runner: RunnerBlock | null): void {
    const next: ServerState = { at: Date.now(), baseUrl: this.credential.baseUrl, clientId: this.credential.clientId, state, runner, kept: this.keptWorktrees };
    if (!serverStateChanged(this.serverState, next)) return;
    try {
      writeServerState(next);
      this.serverState = next;
    } catch (err) {
      console.error(`[runner] no se pudo guardar el estado del server: ${(err as Error).message}`);
    }
  }

  // el server aceptó un claim con el replacesClientId de esta credencial: ya adoptó (o no tenía nada que
  // adoptar), así que deja de mandarse. el fichero solo se toca si sigue siendo de la misma credencial.
  private replacementDelivered(clientId: string, replaces: string): void {
    if (this.credential.clientId !== clientId || this.credential.replacesClientId !== replaces) return;
    this.credential = { baseUrl: this.credential.baseUrl, clientId, refreshToken: this.credential.refreshToken };
    try {
      saveConfig((current) => (current.clientId === clientId && current.replacesClientId === replaces ? { replacesClientId: undefined } : null));
    } catch (err) {
      console.error(`[runner] no se pudo quitar replacesClientId de la config: ${(err as Error).message} — se reenvía al reiniciar (inocuo)`);
    }
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
      console.log(`[runner] ${signal}: deteniendo${this.leases.size > 0 ? ` ${this.leases.size} run(s) en curso` : ''} (otra señal fuerza la salida)`);
      this.leases.forEach((lease) => lease.kill('shutdown'));
      this.wake?.();
      setTimeout(forceExit, SHUTDOWN_GRACE_MS).unref();
    };
    process.on('SIGINT', () => onSignal('SIGINT', EXIT_CODE_SIGINT));
    process.on('SIGTERM', () => onSignal('SIGTERM', EXIT_CODE_SIGTERM));
  }

  // --- claim ---

  private async claim(): Promise<ClaimResponse | null> {
    let res: Response;
    // la credencial de la que sale este claim y a quién reemplaza (hasta que el server lo acepte).
    const { clientId, replacesClientId } = this.credential;
    try {
      res = await this.api('/claim', {
        runnerLabel: this.label(),
        repos: Object.keys(this.cfg.repos),
        ...(this.repoHealth ? { repoIssues: this.repoHealth } : {}),
        ...(this.repoChoices ? { repoCandidates: this.repoChoices } : {}),
        awsAccounts: Object.keys(this.cfg.aws),
        capabilities: this.capabilities(),
        slots: this.slots,
        ...(runnerVersion() ? { version: runnerVersion() } : {}),
        ...(this.claude.version ? { claudeVersion: this.claude.version.slice(0, CLAUDE_VERSION_MAX_CHARS) } : {}),
        ...(this.cfg.machineId ? { machine: { id: this.cfg.machineId } } : {}),
        ...(replacesClientId ? { replacesClientId } : {}),
        ...(this.keptWorktrees ? { keptWorktrees: this.keptWorktrees } : {}),
      });
    } catch (err) {
      if (err instanceof CredentialRejectedError) this.stopUnpaired(err);
      else console.error(`[runner] claim inaccesible: ${(err as Error).message}`);
      return null;
    }
    if (res.ok && replacesClientId) this.replacementDelivered(clientId, replacesClientId);
    if (Number(res.headers.get(REPO_COMMANDS_HEADER)) > 0) void this.syncRepoCommands();
    const header = res.headers.get(RUNNER_STATE_HEADER);
    // 204 = nada que hacer, de un server anterior a t#465 P12 (o en pausa, sin slot, actualizar: la cabecera).
    if (res.status === 204) {
      this.recordServerState(header, null);
      return null;
    }
    if (res.status !== 200) {
      console.error(`[runner] claim falló: http ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const raw: unknown = await res.json().catch((err: Error) => {
      console.error(`[runner] claim con json ilegible: ${err.message}`);
      return null;
    });
    // sin trabajo con la fila de esta máquina (server >= t#465 P12): 200 { run: null, runner, state }.
    if (raw !== null && typeof raw === 'object' && 'run' in raw && raw.run === null) {
      this.recordServerState(header, parseRunnerBlock(raw));
      return null;
    }
    this.recordServerState(CLAIM_OUTCOME.claimed, parseRunnerBlock(raw));
    try {
      return parseClaim(raw);
    } catch (err) {
      // el run ya está reclamado (running): si su id es usable se cierra con el motivo; si no, lo
      // cerrará el sweeper del server.
      const message = (err as Error).message;
      console.error(`[runner] ${message}`);
      const id = claimRunId(raw);
      if (id !== null) await this.postStatus(id, { status: 'failed', error: message });
      return null;
    }
  }

  // registra el run en su slot y lo ejecuta en segundo plano; al terminar libera el slot y despierta
  // el loop para reclamar el siguiente sin esperar al poll.
  private start(claim: ClaimResponse): void {
    const lease = new RunLease(claim.run.id);
    this.leases.add(lease);
    // la conversación vuelve a trabajar en su worktree («pedir commit» o cualquier mensaje): deja de
    // anunciarse como conservada, o su hilo volvería a enseñar los recuentos viejos hasta el siguiente gc.
    if (this.keptWorktrees?.some((k) => k.runId === claim.run.id)) this.keptWorktrees = this.keptWorktrees.filter((k) => k.runId !== claim.run.id);
    if (this.stopping) lease.kill('shutdown');
    void this.executeRun(claim, lease)
      .catch((err) => console.error(`[runner] run ${lease.runId} reventó: ${(err as Error).message}`))
      .finally(() => {
        this.leases.delete(lease);
        this.wake?.();
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
  private async syncRepoCommands(): Promise<void> {
    if (this.repoCommandsInFlight) return;
    this.repoCommandsInFlight = true;
    try {
      const res = await this.api('/repo-commands', { runnerLabel: this.label() });
      if (!res.ok) {
        console.error(`[runner] repos: /repo-commands respondió http ${res.status}`);
        return;
      }
      const commands = parseRepoCommands(await res.json().catch(() => null));
      if (commands.length === 0) return;
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
      const ack = await this.api('/repo-commands/results', { results });
      if (!ack.ok) console.error(`[runner] repos: /repo-commands/results respondió http ${ack.status}`);
      this.wake?.();
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
    const { baseUrl, clientId } = credential;
    if (this.credentialUnsaved || (clientId !== this.credential.clientId && baseUrl === this.credential.baseUrl)) this.auth.reset();
    if (JSON.stringify(local) === JSON.stringify(this.cfg)) return;
    const reposChanged = JSON.stringify(local.repos) !== JSON.stringify(this.cfg.repos);
    this.cfg = local;
    console.log(`[runner] config recargada: ${Object.keys(local.repos).length} repos, ${Object.keys(local.aws).length} cuentas aws, ${this.slots} slot${this.slots === 1 ? '' : 's'}`);
    if (reposChanged) await this.refreshRepoHealth(true);
  }

  // --- gc de worktrees (en el loop de claim, throttled) ---

  // conversaciones abiertas según el server. si no contesta (o es anterior a t#378), todas se dan
  // por abiertas: entonces solo actúa el ttl de inactividad, que nunca pierde trabajo.
  private async openConversations(runIds: number[]): Promise<Set<number>> {
    const open = new Set<number>();
    // i/o secuencial: pocas llamadas, en orden.
    for (const ids of chunk(runIds)) {
      const res = await this.api('/conversations', { runIds: ids }).catch((err: Error) => {
        console.error(`[runner] gc: /conversations inaccesible: ${err.message}`);
        return null;
      });
      const body = res?.ok ? ((await res.json().catch(() => null)) as { open?: unknown } | null) : null;
      if (!body || !Array.isArray(body.open)) {
        if (res && !res.ok) console.error(`[runner] gc: /conversations respondió http ${res.status}: solo se aplica el ttl`);
        ids.forEach((id) => open.add(id));
        continue;
      }
      body.open.filter((id): id is number => Number.isSafeInteger(id)).forEach((id) => open.add(id));
    }
    return open;
  }

  private async collectWorktrees(): Promise<void> {
    if (Date.now() - this.lastGcAt < CONVERSATION_GC_INTERVAL_MS) return;
    this.lastGcAt = Date.now();
    try {
      const candidates = listWorktreeCandidates(Object.values(this.cfg.repos).map((r) => r.path));
      if (candidates.length === 0) {
        this.keptWorktrees = [];
        return;
      }
      const open = await this.openConversations(candidates.filter((c) => c.kind === 'conversation').map((c) => c.runId));
      const inFlight = new Set([...this.leases].map((lease) => lease.runId));
      const targets = selectForRemoval(candidates, open, Date.now(), inFlight);
      if (targets.length === 0) {
        this.keptWorktrees = [];
        return;
      }
      const env = scrubEnv(process.env);
      const byRepo = targets.reduce((acc, c) => acc.set(c.repoPath, [...(acc.get(c.repoPath) ?? []), c]), new Map<string, WorktreeCandidate[]>());
      const collected = await Promise.all(
        [...byRepo].map(([repoPath, group]) => this.gitLocks.run(path.resolve(repoPath), () => removeWorktrees(group, env))),
      );
      const removed = collected.reduce((n, c) => n + c.removed, 0);
      // lo que se anuncia al server: recuentos por conversación, nunca paths (worktree_report).
      this.keptWorktrees = collected.flatMap((c) => c.kept).sort((a, b) => a.runId - b.runId);
      if (removed > 0) console.log(`[runner] gc: ${removed} worktree(s) recogido(s)`);
    } catch (err) {
      console.error(`[runner] gc de worktrees falló: ${(err as Error).message}`);
    }
  }

  // --- cwd del run: worktree de conversación, worktree por run, checkout o scratch ---

  private async prepareWorkdir(run: ClaimedRun, env: NodeJS.ProcessEnv): Promise<Workdir> {
    const repoCfg = run.repo && Object.hasOwn(this.cfg.repos, run.repo) ? this.cfg.repos[run.repo]! : null;
    const scratch = (note: string, warnings: string[] = []): Workdir => ({ workdir: scratchDir(), repoCfg: null, worktree: null, conversation: false, note, warnings });
    if (!run.repo) return scratch('scratch · sin repo');
    if (!repoCfg) return scratch('scratch · sin repo mapeado', [`repo ${run.repo} no mapeado en este runner: corriendo en scratch`]);
    if (!fs.existsSync(repoCfg.path)) {
      console.log(`[runner] run ${run.id}: el checkout ${repoCfg.path} no existe`);
      return scratch('scratch · checkout no encontrado', [`el checkout de ${run.repo} no existe en este runner: corriendo en scratch`]);
    }
    if (run.kind === RUN_KIND.prompt && run.isolation === RUN_ISOLATION.checkout) {
      const co = await this.gitLocks.run(path.resolve(repoCfg.path), () => prepareCheckout(repoCfg.path, env));
      return { ...co, repoCfg, worktree: null, conversation: false };
    }
    if (run.kind === RUN_KIND.prompt) {
      // worktree salvo que el usuario eligiera el checkout: `worktree: false` y skip-permissions del
      // repo son solo para los kinds de reglas heredados (un server anterior a t#465 P6).
      const wt = await this.gitLocks.run(path.resolve(repoCfg.path), () => prepareConversationWorktree(repoCfg.path, run.id, run.branch, env));
      return { ...wt, repoCfg, worktree: wt.workdir, conversation: true };
    }
    if (repoCfg.worktree === false) return { workdir: repoCfg.path, repoCfg, worktree: null, conversation: false, note: 'checkout · sin worktree', warnings: [] };
    const wt = await this.gitLocks.run(path.resolve(repoCfg.path), () => prepareRunWorktree(repoCfg.path, run.id, run.branch, env));
    return { ...wt, repoCfg, worktree: wt.workdir, conversation: false };
  }

  // runs que comparten un cwd no aislado se turnan: el checkout (un repo con `worktree: false` o una
  // conversación abierta en el checkout) y el scratch en perfil edit (dos runs de reglas en scratch
  // conviven: la auto-memory compartida es la gracia del cwd fijo). devuelve con qué soltar el turno: no-op si no hacía falta, o si el run
  // murió esperándolo (entonces se suelta en cuanto llega).
  private async holdCwd(run: ClaimedRun, prepared: Workdir, lease: RunLease, note: (text: string) => void): Promise<() => void> {
    const shared = prepared.worktree === null && (prepared.repoCfg !== null || run.profile === PROMPT_PROFILE.edit);
    if (!shared) return () => {};
    const key = path.resolve(prepared.workdir);
    if (this.cwdLocks.busy(key)) note('esperando turno: otro run trabaja en este mismo directorio');
    const acquiring = this.cwdLocks.acquire(key);
    const release = await Promise.race([acquiring, lease.killed.then(() => null)]);
    if (release) return release;
    void acquiring.then((r) => r());
    return () => {};
  }

  // latido del run desde el claim hasta el cierre: transporta el soft-cancel del server (y refresca
  // la presencia del runner). el run muere si ya no es suyo: cancel, un estado que no es running, o
  // el run no existe.
  private startHeartbeat(lease: RunLease, heartbeatMs: number, seg: { segment?: number }): NodeJS.Timeout {
    const runId = lease.runId;
    return setInterval(() => {
      void this.api(`/runs/${runId}/heartbeat`, seg)
        .then(async (res) => {
          if (res.status === HTTP_NOT_FOUND) {
            console.log(`[runner] run ${runId} ya no existe en el server; deteniéndolo`);
            lease.kill('cancel');
            return;
          }
          if (!res.ok) return;
          const body = (await res.json().catch(() => null)) as { cancel?: boolean; status?: string } | null;
          if (body?.cancel || (typeof body?.status === 'string' && body.status !== RUN_STATUS_RUNNING)) {
            console.log(`[runner] run ${runId} ya no es de este proceso (${body?.status ?? 'cancelado'}); deteniéndolo`);
            lease.kill('cancel');
          }
        })
        .catch((err: Error) => {
          // con los slots llenos el loop no reclama: el latido es quien se entera de que la credencial murió.
          if (err instanceof CredentialRejectedError) this.stopUnpaired(err);
          else console.error(`[runner] heartbeat del run ${runId} falló: ${err.message}`);
        });
    }, Math.max(MIN_HEARTBEAT_MS, heartbeatMs));
  }


  // --- ejecución ---

  private async executeRun(claim: ClaimResponse, lease: RunLease): Promise<void> {
    const { run } = claim;
    const tag = `run ${run.id}`;
    console.log(
      `[runner] ${tag} reclamado (${run.kind}${run.profile ? `, perfil ${run.profile}` : ''}, entry ${run.entryId}${claim.tier ? `, tier ${claim.tier}` : ''}${run.repo ? `, repo ${run.repo}${run.branch ? `@${run.branch}` : ''}` : ''}${run.sessionId ? `, sesión ${run.sessionId}` : ''}${run.model ? `, modelo ${run.model}` : ''})`,
    );
    // env del run: el del usuario saneado + el perfil aws de su cuenta; una cuenta que esta máquina no
    // mapea, con la aws vacía del propio run (aws_strict), que se borra al cerrar el segmento.
    let awsDir: string | null = null;
    const dropAwsDir = (): void => {
      if (awsDir !== null) fs.rmSync(awsDir, { recursive: true, force: true });
    };
    const aws = runAwsEnv({ ...scrubEnv(process.env), AWS_PAGER: '' }, run.aws, this.cfg.aws, () => (awsDir = writeEmptyAwsConfig(run.id)));
    const env = aws.env;
    const awsWarnings = aws.unmapped
      ? [`cuenta aws ${aws.unmapped} sin mapear en esta máquina: la aws cli corre sin credenciales (\`duckhunt-runner aws add ${aws.unmapped} <perfil>\`)`]
      : [];
    // identidad del proceso en cada llamada del run (servers anteriores a los segmentos: nada).
    const seg = run.segment !== null ? { segment: run.segment } : {};
    const heartbeat = this.startHeartbeat(lease, claim.heartbeatMs, seg);
    const feed = claim.events?.enabled ? new EventUploader((events) => this.postEvents(run.id, events, seg), claim.events, tag) : null;

    let prepared: Workdir;
    try {
      prepared = await this.prepareWorkdir(run, env);
    } catch (err) {
      clearInterval(heartbeat);
      dropAwsDir();
      await feed?.close();
      await this.postStatus(run.id, { status: 'failed', error: `no se pudo preparar el directorio del run: ${(err as Error).message}`, ...seg });
      return;
    }
    const ctx: FeedContext = {
      cwd: prepared.workdir,
      home: os.homedir(),
      bodyMaxChars: claim.events?.bodyMaxChars ?? EVENTS_DEFAULTS.bodyMaxChars,
      toolArgMaxChars: claim.events?.toolArgMaxChars ?? EVENTS_DEFAULTS.toolArgMaxChars,
    };
    const note = (text: string): void => {
      console.log(`[runner] ${tag}: ${text}`);
      feed?.push(systemEvent(text, ctx));
    };
    note(prepared.note);
    [...claim.warnings, ...prepared.warnings, ...awsWarnings].forEach(note);

    const releaseCwd = await this.holdCwd(run, prepared, lease, note);
    // mcp-config con el token per-run (run-mcp-config.ts: 0600 en un directorio 0700; se borra al terminar).
    let mcpFile: string | null = null;
    let report: StatusReport;
    try {
      mcpFile = writeRunMcpConfig(run.id, claim.mcp);
      report = await this.runAttempts(claim, lease, prepared, env, mcpFile, feed, ctx, note);
    } catch (err) {
      report = { status: 'failed', error: (err as Error).message };
    } finally {
      if (mcpFile !== null) fs.rmSync(mcpFile, { force: true });
      dropAwsDir();
      releaseCwd();
      clearInterval(heartbeat);
    }

    await feed?.close();
    const { worktree, repoCfg } = prepared;
    if (worktree && prepared.conversation) {
      touchWorktree(worktree);
    } else if (worktree && repoCfg) {
      if (report.status === 'done') await this.gitLocks.run(path.resolve(repoCfg.path), () => removeRunWorktree(repoCfg.path, worktree, env));
      else console.log(`[runner] worktree conservado para autopsia: ${worktree}`);
    }
    await this.postStatus(run.id, { ...report, ...seg });
    console.log(`[runner] ${tag} terminado (${report.status}${report.error ? `: ${report.error}` : ''})`);
  }

  // uno o dos intentos: reanudación fallida antes de que el asistente hablara (sesión inexistente
  // en esta máquina, borrada, de otro daemon) → un solo reintento desde cero con el prompt de respaldo.
  private async runAttempts(
    claim: ClaimResponse,
    lease: RunLease,
    prepared: Workdir,
    env: NodeJS.ProcessEnv,
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
      ? mirroredDeny(settingsFilesFor(prepared.workdir, true), READ_MIRRORED_TOOLS)
      : run.kind !== RUN_KIND.prompt
        ? mirroredDeny(settingsFilesFor(prepared.workdir, false), WRITE_TOOLS)
        : [];
    // shell de lectura solo en un checkout del que una lectura recursiva no pueda salir (el scratch no
    // es un checkout: no se revisa). una vez por segmento: el reintento desde cero usa el mismo cwd.
    const shell = await readShellGuard(prepared.repoCfg ? prepared.workdir : null, claim.tools, deny, env);
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
        skipPermissions: prepared.repoCfg?.dangerouslySkipPermissions === true,
        payingWithApiKey: !!process.env.ANTHROPIC_API_KEY,
        mirroredDeny: deny,
        runConfigDeny: this.runConfigDeny,
        secretPathsDeny: this.secretDeny,
        withoutShell: shell.dropShell,
      });
    // reanudar o no lo decide el server: manda sessionId solo cuando hay sesión que retomar.
    const resume = run.sessionId;
    let attempt = await this.spawnClaude(claim, lease, args(claim.prompt, resume), prepared, env, feed, ctx);
    let resumed: boolean | undefined = resume ? true : undefined;
    if (resume && attempt.killedBy === null && attempt.exitCode !== 0 && !attempt.stream.sawAssistant && claim.fallbackPrompt) {
      console.log(`[runner] run ${run.id}: la sesión ${resume} no se pudo reanudar`);
      note('la sesión anterior no se pudo reanudar en este runner: reintento desde cero');
      attempt = await this.spawnClaude(claim, lease, args(claim.fallbackPrompt, null), prepared, env, feed, ctx);
      resumed = false;
    }
    return reportFor(attempt, resumed);
  }

  // spawnea claude en su propio grupo de procesos, consume stdout (stream-json → contadores + feed)
  // y stderr (tail), bombea el progreso y aplica el timeout wall-clock. si el run ya murió (cancel o
  // parada mientras esperaba turno) no lo lanza. resuelve siempre (nunca rechaza).
  private spawnClaude(
    claim: ClaimResponse,
    lease: RunLease,
    args: string[],
    prepared: Workdir,
    env: NodeJS.ProcessEnv,
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
          logFile = fs.openSync(path.join(logsDir(), `${runId}.jsonl`), 'a');
        } catch (err) {
          console.error(`[runner] no se pudo abrir el log del run: ${(err as Error).message}`);
        }
      }

      let child: ChildProcess;
      try {
        child = spawn('claude', args, { cwd: prepared.workdir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
      const postProgress = (toolCalls: number, workdir?: string): void => {
        void this.api(`/runs/${runId}/progress`, { toolCalls, ...(workdir ? { workdir } : {}), ...seg }).catch((err) =>
          console.error(`[runner] progress falló: ${(err as Error).message}`),
        );
      };
      postProgress(0, clip(prepared.note, WORKDIR_MAX_CHARS));
      let reportedToolCalls = 0;
      let lastProgressAt = Date.now();
      const progress = setInterval(() => {
        const now = Date.now();
        if (stream.toolCalls === reportedToolCalls || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
        reportedToolCalls = stream.toolCalls;
        lastProgressAt = now;
        postProgress(reportedToolCalls);
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

  private async postEvents(runId: number, events: SeqEvent[], seg: { segment?: number }): Promise<number> {
    const res = await this.api(`/runs/${runId}/events`, { events, ...seg });
    return res.status;
  }

  // cierre con reintento acotado: es lo único del run que el server no puede reconstruir.
  private async postStatus(runId: number, report: StatusReport): Promise<void> {
    const body = clampReport(report);
    // i/o secuencial con backoff exponencial.
    for (let attempt = 1; attempt <= STATUS_POST_ATTEMPTS; attempt++) {
      let rejected = false;
      const res = await this.api(`/runs/${runId}/status`, body).catch((err: Error) => {
        rejected = err instanceof CredentialRejectedError;
        console.error(`[runner] status post falló (intento ${attempt}/${STATUS_POST_ATTEMPTS}): ${err.message}`);
        return null;
      });
      // sin credencial no hay reintento que valga (duckhunt ya lo cerró al desvincular la máquina).
      if (rejected) return;
      // 409 = el server ya cerró el run (cancel del usuario, sweeper): benigno.
      if (res && (res.ok || res.status === HTTP_CONFLICT)) return;
      if (res && !isTransient(res.status)) {
        console.error(`[runner] status post rechazado: http ${res.status} ${await res.text().catch(() => '')}`);
        return;
      }
      if (res) console.error(`[runner] status post: http ${res.status} (intento ${attempt}/${STATUS_POST_ATTEMPTS})`);
      if (attempt < STATUS_POST_ATTEMPTS) await sleep(STATUS_POST_BACKOFF_MS * 2 ** (attempt - 1));
    }
    console.error(`[runner] status del run ${runId} sin entregar: el server lo cerrará por inactividad`);
  }
}
