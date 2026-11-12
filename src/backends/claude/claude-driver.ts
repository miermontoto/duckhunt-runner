// claude code detrás del seam (t#440 P1): el driver #0, envuelto EN SU SITIO. todo lo que era de claude en executeRun
// pasa aquí en el mismo orden y con los mismos ficheros: el mcp-config con el token per-run y la tool de permisos
// (run-mcp-config.ts), las tools de los recursos en sus listas, los deny que se espejan de los settings
// (user-permissions.ts), la guarda de la shell de lectura (read-shell-guard.ts), el argv (claude-args.ts), el reintento
// desde cero de una reanudación fallida, la lectura del stream-json (claude.ts), el stdin vivo (live-session.ts), el
// informe (status-report.ts) y el catálogo slash del init (slash-commands.ts).
// decisiones:
// - lo que se calcula al arrancar (las reglas de secret_paths, que el run-config de cada plataforma quepa en una regla
//   de permisos) es de este driver: son reglas de permisos de claude.
// - el deny de lo privado de las demás plataformas se renderiza aquí, por intento, desde las plataformas que le pasa
//   el daemon (las rutas son neutrales; la forma `Read(//…)`, de claude).
// - `info` y `secretDeny` son públicos y mutables: las pruebas los fijan sin detectar (test/daemon-harness.ts).

import fs from 'node:fs';
import { announcedCapabilities } from '../../announced-capabilities.js';
import type { AttemptFacts } from '../../audit.js';
import { PROMPT_PROFILE, RUN_KIND, type ClaimResponse } from '../../claim.js';
import { buildClaudeArgs, claudeRunEnv } from '../../claude-args.js';
import { consumeStreamLine, detectClaude, newStreamState, reportedModel, supportsPermissionPromptTool, supportsRewind, type ClaudeInfo, type StreamLine, type StreamState } from '../../claude.js';
import { feedEventsFromStream } from '../../feed.js';
import { LiveSession, type LiveTurnHooks } from '../../live-session.js';
import { allRunConfigDirs, backendsRoot } from '../../paths.js';
import { mergeShellVerdicts, readShellGuard, readShellLog, readShellNote } from '../../read-shell-guard.js';
import type { RunMcp } from '../../resources/lifecycle.js';
import { permissionMcpServers, readDenyRule, readOnlyDirDeny, runConfigDeny, writeRunMcpConfig } from '../../run-mcp-config.js';
import { browserVaultDeny, otherPlatformsDeny, otherScratchDeny, secretPathsDeny } from '../../secret-paths.js';
import { maskSecrets } from '../../secret-mask.js';
import { claudeConfigDir, resolveSlashCommands } from '../../slash-commands.js';
import { reportFor, type Attempt } from '../../status-report.js';
import { mirroredDeny, READ_MIRRORED_TOOLS, settingsFilesFor, WRITE_TOOLS } from '../../user-permissions.js';
import { V0_BACKEND } from '../../vendor/runner-protocol/index.js';
import type { AgentDriver, AgentStdin, HostFacts, PreparedSegment, SegmentIo, SegmentOutcome, SegmentSpec, TurnEnded } from '../agent-driver.js';
import { spawnAgent, type ProcessSession } from '../spawn-agent.js';

const CLAUDE_COMMAND = 'claude';
// el tope del texto final de un turno (el mismo que el del status en el server).
const TURN_RESULT_MAX_CHARS = 20_000;

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** lo que un `result` cuenta de su turno (t#636, fase 3): el total de la sesión, sus vueltas y las tool calls desde `toolCallsAt`. */
export function turnEndedOf(ev: StreamLine, stream: StreamState, toolCallsAt: number): TurnEnded {
  const cost = finite(ev.total_cost_usd);
  const turns = finite(ev.num_turns);
  const model = reportedModel(stream.initModel, ev.modelUsage);
  return {
    toolCallsTotal: stream.toolCalls,
    report: {
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(turns !== undefined ? { numTurns: turns } : {}),
      toolCalls: Math.max(0, stream.toolCalls - toolCallsAt),
      ...(stream.sessionId ? { sessionId: stream.sessionId } : {}),
      ...(model ? { model } : {}),
      // enmascarado como el status (clampReport): el texto de un turno también sale de la máquina.
      ...(typeof ev.result === 'string' ? { result: maskSecrets(ev.result).slice(0, TURN_RESULT_MAX_CHARS) } : {}),
      ...(stream.lastAssistantUuid ? { lastMessageUuid: stream.lastAssistantUuid } : {}),
    },
  };
}

// lo que la auditoría sabe del intento que cerró un segmento: cómo acabó, nunca su salida.
const attemptFacts = (a: Attempt): AttemptFacts => ({ killedBy: a.killedBy, exitCode: a.exitCode, isError: a.stream.result?.isError ?? false, subtype: a.stream.result?.subtype ?? null });

// las tools de los recursos del run (mcp__res_<tipo>_<clave>__*, t#495 M7) en las listas con que se lanza: al allow
// las suyas, al deny las que se le niegan. sin recursos mcp, el claim tal cual (el argv de siempre).
const withResourceTools = (claim: ClaimResponse, mcp: RunMcp): ClaimResponse =>
  mcp.allowed.length === 0 && mcp.deny.length === 0
    ? claim
    : { ...claim, tools: { allowed: [...claim.tools.allowed, ...mcp.allowed], disallowed: [...claim.tools.disallowed, ...mcp.deny] } };

// el mcp-config del segmento (0600 en el run-config 0700 de su plataforma): se borra al cerrarlo.
interface ClaudePrepared extends PreparedSegment {
  readonly mcpFile: string;
}

// un proceso vivo (t#636): el prompt por stdin, cuánto espera el buzón y si parte turnos en el mismo proceso.
interface LiveLaunch {
  prompt: string;
  waitMs: number;
  turns: boolean;
}

/** claude code (`claude -p` con stream-json) como driver del daemon. */
export class ClaudeDriver implements AgentDriver {
  readonly id = V0_BACKEND.claudeCode;
  readonly command = CLAUDE_COMMAND;
  info: ClaudeInfo = { version: null, supported: new Set() };
  // las reglas de secret_paths de esta máquina (0.11.0), calculadas al arrancar.
  secretDeny: string[] = [];

  get version(): string | null {
    return this.info.version;
  }

  async detect(): Promise<void> {
    this.info = await detectClaude();
  }

  start(): void {
    if (!this.info.version) {
      throw new Error('no se encuentra `claude` en el PATH: instala claude code y haz login antes de arrancar el daemon');
    }
    // lanza si la ruta no cabe en una regla de permisos: sin ese deny el daemon no arranca. cubre el run-config de cada
    // plataforma con estado en disco; cada segmento lo recalcula (platformDeny).
    allRunConfigDirs().forEach(runConfigDeny);
    const secrets = secretPathsDeny(process.env);
    this.secretDeny = secrets.rules;
    secrets.skipped.forEach((p) => console.warn(`[runner] secret_paths: ${p} no cabe en una regla de permisos de claude: queda solo la lista genérica del server`));
  }

  // prompt solo si el cli puede cumplir su perfil (permission mode explícito, sin mcp del repo, deny list y settings solo
  // del usuario en lectura), model solo con --model.
  capabilities(facts: HostFacts): string[] {
    return announcedCapabilities({ ...facts, supported: this.info.supported, claudeVersion: this.info.version });
  }

  prepare(spec: SegmentSpec): ClaudePrepared {
    const { claim, resourceMcp } = spec;
    // la tool de permisos (t#527) junto a los de los recursos: res_<tipo>_<clave> nunca choca con su nombre.
    const mcpFile = writeRunMcpConfig(claim.run.id, claim.mcp, spec.platform.id, claim.extraMcp, { ...permissionMcpServers(claim), ...resourceMcp.servers });
    return { mcpFile, dispose: () => fs.rmSync(mcpFile, { force: true }) };
  }

  // uno o dos intentos: reanudación fallida antes de que el asistente hablara (sesión inexistente en esta máquina,
  // borrada, de otro daemon) → un solo reintento desde cero con el prompt de respaldo.
  async run(spec: SegmentSpec, prepared: PreparedSegment, io: SegmentIo): Promise<SegmentOutcome> {
    const { res } = spec;
    const claim = withResourceTools(spec.claim, spec.resourceMcp);
    const { run } = claim;
    const { mcpFile } = prepared as ClaudePrepared;
    // settings leídos por run (pueden cambiar con el daemon vivo): lectura solo carga los de usuario y espeja su shell y
    // su escritura; un run de reglas carga todos y espeja su escritura; edición, nada.
    const readPrompt = run.kind === RUN_KIND.prompt && run.profile === PROMPT_PROFILE.read;
    const deny = readPrompt
      ? mirroredDeny(settingsFilesFor(res.cwd.dir, true), READ_MIRRORED_TOOLS)
      : run.kind !== RUN_KIND.prompt
        ? mirroredDeny(settingsFilesFor(res.cwd.dir, false), WRITE_TOOLS)
        : [];
    // shell de lectura solo en un checkout del que una lectura recursiva no pueda salir (el scratch no es un checkout:
    // no se revisa). una vez por segmento: el reintento desde cero usa el mismo cwd. con repos adicionales (t#597) se
    // revisa también cada uno: una lectura recursiva tampoco puede salir de ellos.
    const guarded = [res.cwd.checkout ? res.cwd.dir : null, ...res.addDirs.filter((a) => a.checkout).map((a) => a.dir)];
    const shell = mergeShellVerdicts(await Promise.all(guarded.map((dir) => readShellGuard(dir, claim.tools, deny, res.env))));
    if (shell.dropShell) {
      console.warn(`${io.log} run ${run.id}: shell de lectura fuera en este segmento: ${readShellLog(shell)}`);
      io.note(readShellNote(shell)!);
    }
    const readOnlyDeny = res.addDirs.filter((a) => a.readOnly).flatMap((a) => readOnlyDirDeny(a.dir));
    const supported = this.info.supported;
    // el buzón del proceso vivo (t#636, fase 2): solo si el claim lo trae y el cli tiene stdin en stream-json. los límites
    // de turno dentro del proceso (fase 3): con `live.turns` y un cli que acusa los mensajes de stdin.
    const live = claim.live && supported.has('--input-format') ? claim.live : null;
    const liveTurns = claim.live?.turns === true && supported.has('--input-format') && supported.has('--replay-user-messages');
    const args = (prompt: string, resumeSessionId: string | null): string[] => {
      const defaults = spec.defaults();
      return buildClaudeArgs({
        claim,
        prompt,
        mcpConfigFile: mcpFile,
        supported,
        resumeSessionId,
        // el que pide duckhunt para esta conversación; si no pide ninguno, el default de la máquina.
        model: run.model ?? defaults.model,
        configBudgetUsd: defaults.maxBudgetUsd,
        skipPermissions: res.cwd.skipPermissions,
        payingWithApiKey: !!process.env.ANTHROPIC_API_KEY,
        mirroredDeny: deny,
        runConfigDeny: this.platformDeny(spec.platform),
        secretPathsDeny: this.secretDeny,
        withoutShell: shell.dropShell,
        permissionPromptTool: supportsPermissionPromptTool(this.info.version),
        // volver atrás (t#564): solo con --resume; el reintento desde cero (resumeSessionId null) no lo lleva.
        resumeAt: run.resumeAt,
        rewind: supportsRewind(this.info.version),
        // los repos adicionales (t#597) y el deny de los de solo lectura.
        addDirs: res.addDirs.map((a) => a.dir),
        readOnlyDirsDeny: readOnlyDeny,
        liveInput: live !== null,
        liveTurns: live !== null && liveTurns,
      });
    };
    // reanudar o no lo decide el server: manda sessionId solo cuando hay sesión que retomar.
    const resume = run.sessionId;
    const liveOf = (prompt: string): LiveLaunch | null => (live ? { prompt, waitMs: live.waitMs, turns: liveTurns } : null);
    let attempt = await this.attempt(spec, claim, io, args(claim.prompt, resume), liveOf(claim.prompt));
    let resumed: boolean | undefined = resume ? true : undefined;
    if (resume && attempt.killedBy === null && attempt.exitCode !== 0 && !attempt.stream.sawAssistant && claim.fallbackPrompt) {
      console.log(`${io.log} run ${run.id}: la sesión ${resume} no se pudo reanudar`);
      io.note('la sesión anterior no se pudo reanudar en este runner: reintento desde cero');
      attempt = await this.attempt(spec, claim, io, args(claim.fallbackPrompt, null), liveOf(claim.fallbackPrompt));
      resumed = false;
    }
    const last = attempt;
    return {
      report: reportFor(last, resumed),
      facts: attemptFacts(last),
      toolsByName: last.stream.toolsByName,
      commands: (projectCwd) => {
        const init = last.stream.initCatalog;
        return init ? resolveSlashCommands(init, { configDir: claudeConfigDir(), projectCwd }) : null;
      },
    };
  }

  // el run-config de todas las plataformas, el scratch y lo privado de las demás, y el vault de las sesiones de
  // navegador (t#495, M7) a todo kit, no solo a los de lectura: una edición tampoco lo lee. con una sola plataforma, lo
  // de las demás es vacío: el deny de siempre.
  /** el deny de todo kit de un segmento de `platform` (por intento: una plataforma añadida en caliente queda cubierta). */
  platformDeny(platform: SegmentSpec['platform']): string[] {
    const configured = platform.configured();
    // los homes de agente por conversación (t#440, <runnerHome>/backends/): aún no existen; se niegan desde ya para que
    // un run de lectura no lea la auth/sesión de los futuros backends. dir, puede no existir (readDenyRule no toca fs).
    // constante de la máquina (como el run-config), va DELANTE: lo que crece al añadir una plataforma se añade detrás.
    const backendsDeny = [readDenyRule(backendsRoot(), true)].filter((r): r is string => r !== null);
    return [...backendsDeny, ...allRunConfigDirs().flatMap(runConfigDeny), ...otherScratchDeny(platform.id, configured), ...otherPlatformsDeny(platform.id, configured), ...browserVaultDeny()];
  }

  // un intento: claude en su grupo de procesos, con su stream-json → contadores + feed y, con `live` (t#636, fase 2), el
  // prompt por stdin, que sigue abierto mientras haga falta (live-session.ts), y el buzón del run mientras vive.
  private async attempt(spec: SegmentSpec, claim: ClaimResponse, io: SegmentIo, args: string[], live: LiveLaunch | null): Promise<Attempt> {
    const { res } = spec;
    const stream = newStreamState();
    const exit = await spawnAgent(
      { command: this.command, args, cwd: res.cwd.dir, env: { ...res.env, ...claudeRunEnv(res.env, claim) }, stdin: live !== null, timeoutMs: claim.timeoutMs },
      spec.lease,
      { log: io.log, runId: claim.run.id, verboseLog: io.verboseLog, workdir: res.note, progress: (n, workdir) => io.progress(n, workdir), toolCallsAt: () => io.toolCallsAt() },
      (stdin) => this.session(stream, stdin, live, io),
    );
    return { ...exit, stream };
  }

  // lo que se hace con el proceso mientras vive: su stdout al stream (y al feed) y, vivo, su stdin y el buzón.
  private session(stream: StreamState, stdin: AgentStdin, live: LiveLaunch | null, io: SegmentIo): ProcessSession {
    const session = live && stdin ? new LiveSession(stdin, undefined, live.turns ? this.turnHooks(stream, io) : null) : null;
    const inboxAbort = new AbortController();
    if (session && live) {
      session.start(live.prompt);
      io.serveInbox(session, live.waitMs, inboxAbort.signal);
    }
    return {
      line: (line) => {
        const ev = consumeStreamLine(stream, line);
        if (ev && session) session.observe(ev);
        if (ev && io.feed) feedEventsFromStream(ev, io.ctx).forEach((e) => io.feed!.push(e));
      },
      toolCalls: () => stream.toolCalls,
      closed: () => {
        inboxAbort.abort();
        session?.end();
      },
    };
  }

  // los límites de turno de live-session.ts traducidos a los del daemon: el `result` que cierra un turno, a TurnEnded.
  private turnHooks(stream: StreamState, io: SegmentIo): LiveTurnHooks {
    return {
      onTurnEnd: (ev) => io.turns.onTurnEnd(turnEndedOf(ev, stream, io.toolCallsAt())),
      onTurnStart: (delivered) => io.turns.onTurnStart(delivered),
      onDelivered: (ids) => io.turns.onDelivered(ids),
    };
  }
}
