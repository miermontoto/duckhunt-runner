// lanzar una sonda de claude code exactamente como el daemon (t#440 P6): el kit de la sonda (toolset_v1) pasa por el
// render del daemon (toolset/render.ts) a un claim del cable legacy, que valida parseClaim, y el segmento lo prepara y
// lo corre el driver de claude de verdad (backends/claude/claude-driver.ts): el mismo mcp-config con su token per-run y
// la tool de permisos, los mismos deny (secret_paths, run-config, settings espejados), la guarda de la shell de lectura,
// el argv de buildClaudeArgs y spawnAgent. aquí no se escribe ni un flag.
// decisiones:
// - corre en el proceso de la sonda (probe-worker.ts): el HOME, DUCKHUNT_RUNNER_HOME y el env son los del entorno
//   canario, así que todo lo que el driver resuelve desde el env (run-config, secret_paths, settings de usuario) es el
//   canario.
// - lo neutral del daemon que la sonda no necesita (worktree de conversación, recursos, feed, latido) se sustituye por
//   el checkout trampa o el scratch tal cual, sin recursos ni feed.
// - el cli detectado viaja en el trabajo (versión y flags): el driver no vuelve a detectar en cada sonda.

import { ClaudeDriver } from '../../backends/claude/claude-driver.js';
import type { SegmentIo, SegmentSpec } from '../../backends/agent-driver.js';
import { parseClaim, PROMPT_PROFILE, RUN_ISOLATION, RUN_KIND, RUN_SEED, type ClaimResponse } from '../../claim.js';
import { supportedFlags } from '../../claude.js';
import { LEGACY_PLATFORM_ID } from '../../paths.js';
import type { MaterializedRun, RunMcp } from '../../resources/lifecycle.js';
import { RunLease } from '../../run-lease.js';
import { scrubEnv } from '../../scrub-env.js';
import { renderClaudeTools } from '../../toolset/render.js';
import { autonomyAsks, RUNNER_PERMISSIONS_PATH } from '../../vendor/runner-protocol/index.js';
import type { CanaryHome } from '../canary-home.js';
import type { LaunchResult, ProbeJob } from '../conformance-backend.js';
import { PLATFORM_MCP_PATH } from '../platform-stub.js';
import { PROBE_CWD, ROLE_MARKER, SCRIPT_ROLE, type Probe } from '../probe.js';
import { CLAUDE_PROBES } from './claude-probes.js';

// el run de la sonda en el cable legacy (un id que no choca con el del hermano del canario).
const PROBE_RUN_ID = 900002;
const PROBE_ENTRY_ID = 1;
const PROBE_WORKSPACE_ID = 1;
const PROBE_SEGMENT = 1;
const PROBE_REPO = 'conformance/probe';
const PLATFORM_MCP_SERVER = 'duckhunt';
const PROBE_TIER = 'act';
// el reloj del segmento (spawnAgent no baja de 60 s) y su latido (no se envía: no hay server).
const PROBE_TIMEOUT_MS = 120_000;
const PROBE_HEARTBEAT_MS = 20_000;
// la petición de permiso: la plataforma de la sonda aprueba al momento.
const PERMISSION_TTL_MS = 60_000;
const PERMISSION_WAIT_MS = 5_000;
const LOG = '[conformance]';
const FEED_BODY_MAX_CHARS = 4000;
const FEED_TOOL_ARG_MAX_CHARS = 200;
const NO_MCP: RunMcp = { servers: {}, allowed: [], deny: [] };
// el arnés para la sonda como el daemon para un run al apagarse: mata el grupo de procesos del cli.
const STOP_REASON = 'shutdown';

/** el claim del cable legacy de una sonda (ver cabecera), sin validar. */
export function probeClaimBody(probe: Probe, c: CanaryHome, providerUrl: string): Record<string, unknown> {
  const { profile, toolset, cwd } = probe.run;
  const tools = renderClaudeTools(toolset, { mcpServerName: PLATFORM_MCP_SERVER, awsCli: false });
  const autonomy = toolset.autonomy ?? null;
  const inRepo = cwd === PROBE_CWD.repo;
  return {
    run: {
      id: PROBE_RUN_ID,
      kind: RUN_KIND.prompt,
      seed: RUN_SEED.prompt,
      entryId: PROBE_ENTRY_ID,
      workspaceId: PROBE_WORKSPACE_ID,
      repo: inRepo ? PROBE_REPO : null,
      branch: null,
      repoSource: inRepo ? 'explicit' : 'none',
      repoAvailable: inRepo,
      aws: null,
      sessionId: null,
      parentRunId: null,
      profile: profile === 'read' ? PROMPT_PROFILE.read : PROMPT_PROFILE.edit,
      isolation: RUN_ISOLATION.checkout,
      segment: PROBE_SEGMENT,
      model: null,
      autonomy,
    },
    prompt: `${ROLE_MARKER(SCRIPT_ROLE.main)} ${probe.title}`,
    fallbackPrompt: null,
    tier: PROBE_TIER,
    tools: { allowed: tools.allowed, disallowed: tools.disallowed },
    permissionMode: tools.permissionMode,
    maxTurns: null,
    maxBudgetUsd: null,
    timeoutMs: PROBE_TIMEOUT_MS,
    heartbeatMs: PROBE_HEARTBEAT_MS,
    events: null,
    mcp: { serverName: PLATFORM_MCP_SERVER, url: `${providerUrl}${PLATFORM_MCP_PATH}`, token: c.ownToken, expiresAt: 0 },
    ...(autonomy !== null && autonomyAsks(autonomy) ? { permissions: { url: `${providerUrl}${RUNNER_PERMISSIONS_PATH}`, ttlMs: PERMISSION_TTL_MS, waitMs: PERMISSION_WAIT_MS } } : {}),
  };
}

// lo que el daemon materializa para el segmento, sustituido por el cwd del canario (ver cabecera).
const probeRun = (dir: string, checkout: boolean): MaterializedRun => ({
  cwd: { dir, checkout, skipPermissions: false },
  env: scrubEnv(process.env),
  note: checkout ? 'conformance · repo' : 'conformance · scratch',
  warnings: [],
  locks: [],
  addDirs: [],
  extraNotes: [],
  resources: [],
  mcp: async () => NO_MCP,
  release: async () => undefined,
});

// lo que el daemon pone a disposición del driver, sin server: solo se guardan las notas.
const probeIo = (c: CanaryHome, cwd: string, notes: string[]): SegmentIo => ({
  log: LOG,
  feed: null,
  ctx: { cwd, home: c.home, bodyMaxChars: FEED_BODY_MAX_CHARS, toolArgMaxChars: FEED_TOOL_ARG_MAX_CHARS },
  note: (text) => notes.push(text),
  progress: () => undefined,
  serveInbox: () => undefined,
  verboseLog: null,
  toolCallsAt: () => 0,
  turns: { onTurnEnd: () => undefined, onTurnStart: () => undefined, onDelivered: () => undefined },
});

/** lanza la sonda del trabajo con el driver de claude (ver cabecera); `signal` la para como una parada del daemon. un
 *  fallo va en `error`. */
export async function launchClaudeProbe(job: ProbeJob, signal: AbortSignal): Promise<LaunchResult> {
  const notes: string[] = [];
  const failed = (err: unknown): LaunchResult => ({ error: (err as Error).message, exitCode: null, killedBy: null, status: null, notes });
  const probe = CLAUDE_PROBES.find((p) => p.id === job.probe);
  if (!probe) return failed(new Error(`sonda desconocida: ${job.probe}`));
  const c = job.canary;
  let claim: ClaimResponse;
  const driver = new ClaudeDriver();
  try {
    driver.info = { version: job.cli.version, supported: supportedFlags(job.cli.flags.join('\n')) };
    driver.start();
    claim = parseClaim(probeClaimBody(probe, c, job.providerUrl));
  } catch (err) {
    return failed(err);
  }
  const inRepo = probe.run.cwd === PROBE_CWD.repo;
  const cwd = inRepo ? c.repo : c.scratch;
  const spec: SegmentSpec = {
    claim,
    res: probeRun(cwd, inRepo),
    resourceMcp: NO_MCP,
    lease: new RunLease(claim.run.id),
    platform: { id: LEGACY_PLATFORM_ID, configured: () => [] },
    defaults: () => ({ model: undefined, maxBudgetUsd: undefined }),
  };
  signal.addEventListener('abort', () => spec.lease.kill(STOP_REASON), { once: true });
  try {
    const prepared = driver.prepare(spec);
    try {
      const out = await driver.run(spec, prepared, probeIo(c, cwd, notes));
      return { error: null, exitCode: out.facts.exitCode, killedBy: out.facts.killedBy, status: out.report.status, notes };
    } finally {
      prepared.dispose();
    }
  } catch (err) {
    return failed(err);
  }
}
