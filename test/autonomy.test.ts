// autonomía de las conversaciones en edición (t#527, 0.15.0): el render de cada nivel (el del server, byte a byte, y
// la sombra que casa), la criba del claim (modos × niveles, lectura, root, el bloque permissions y su origen), el argv
// y el env de claude, las capacidades que se anuncian, la entrada de la tool de permisos en el mcp-config y lo que el
// techo de una plataforma o el cable v0 no dejan pasar. sobre el claim y el toolset reales de una edición de la
// matriz del server (claim-kits/prompt-edit-full).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { announcedCapabilities } from '../src/announced-capabilities.js';
import { toolsetSummary } from '../src/audit.js';
import { buildClaudeArgs, claudeRunEnv, type ClaudeArgsInput } from '../src/claude-args.js';
import { canBypassPermissions, parseClaim, withRenderedTools, type ClaimMachine, type ClaimResponse } from '../src/claim.js';
import { claudeAtLeast, OPTIONAL_FLAGS, supportsPermissionPromptTool } from '../src/claude.js';
import { PERMISSION_ENV, PERMISSION_SUBCOMMAND } from '../src/permission-server.js';
import { CLAIM_REJECT, claimOfV0, ClaimRejectedError } from '../src/platforms/claim-v0.js';
import { LEGACY_CEILING, LEGACY_EXPOSE } from '../src/platforms/types.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { permissionMcpServers, writeRunMcpConfig } from '../src/run-mcp-config.js';
import { renderLegacyClaim } from '../src/toolset/legacy-render.js';
import { parseToolsetV1 } from '../src/toolset/parse.js';
import { renderClaudeTools } from '../src/toolset/render.js';
import { compareToolset } from '../src/toolset/shadow.js';
import {
  AGENT_AUTONOMY,
  AGENT_AUTONOMY_LEVELS,
  AGENT_AUTONOMY_PERMISSION_MODE,
  AGENT_PERMISSION_APPROVALS_MAX,
  AGENT_PERMISSION_TOOL,
  AGENT_PERMISSION_TOOL_ID,
  PERMISSION_WAIT_MAX_MS,
  RUNNER_PERMISSIONS_PATH,
  type AgentAutonomy,
  type ToolsetV1,
} from '../src/vendor/runner-protocol/index.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
type Obj = Record<string, unknown>;
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(new URL(rel, FIXTURES), 'utf8')) as T;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const KIT = readJson<Obj & { run: Obj; tools: { allowed: string[]; disallowed: string[] }; mcp: { url: string; serverName: string; token: string } }>('claim-kits/prompt-edit-full.json');
const TOOLSET = readJson<{ toolset: ToolsetV1 }>('toolset-v1/prompt-edit-full.json').toolset;
const CTX = { mcpServerName: KIT.mcp.serverName, awsCli: true };
const PLATFORM_TOOLS = TOOLSET.platformTools.map((t) => `mcp__${KIT.mcp.serverName}__${t}`);
const READ = ['Read', 'Grep', 'Glob'];
const APPROVALS = ['Bash(npm test:*)', 'Edit', 'Bash(git status:*)', 'Bash(npm test:*)'];
const PERMISSIONS = { url: `${new URL(KIT.mcp.url).origin}${RUNNER_PERMISSIONS_PATH}`, ttlMs: 1_800_000, waitMs: 20_000 };
const ROOTLESS: ClaimMachine = { canBypass: true };
const ROOT: ClaimMachine = { canBypass: false };
const allFlags = new Set(OPTIONAL_FLAGS);

// el allow que compone el server para cada nivel (sin approvals): lo que el render tiene que dar tal cual.
const EXPECTED_ALLOWED: Readonly<Record<AgentAutonomy, string[]>> = {
  manual: [...READ, ...PLATFORM_TOOLS],
  auto: [...READ, 'Edit', 'Write', 'WebFetch', 'WebSearch', ...PLATFORM_TOOLS],
  bypass: [...READ, 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', ...PLATFORM_TOOLS],
};

const toolsetAt = (level: AgentAutonomy, approvals?: string[]): ToolsetV1 => ({ ...clone(TOOLSET), autonomy: level, ...(approvals ? { approvals } : {}) });

// el claim de una conversación en edición con su nivel, como lo mandaría el server (listas del render del server).
function autonomyClaim(level: AgentAutonomy | null, patch: { run?: Obj; top?: Obj } = {}): Obj {
  const raw = clone(KIT) as Obj;
  const asks = level !== null && level !== AGENT_AUTONOMY.bypass;
  return {
    ...raw,
    run: { ...(raw.run as Obj), ...(level !== null ? { autonomy: level } : {}), ...patch.run },
    ...(level !== null ? { tools: { allowed: EXPECTED_ALLOWED[level], disallowed: KIT.tools.disallowed }, permissionMode: AGENT_AUTONOMY_PERMISSION_MODE[level] } : {}),
    ...(level !== null ? { toolset: toolsetAt(level) } : {}),
    ...(asks ? { permissions: PERMISSIONS } : {}),
    ...patch.top,
  };
}

test('render: cada nivel da el allow del server, el deny de siempre y su permission mode; sin nivel, el kit fijo', () => {
  AGENT_AUTONOMY_LEVELS.forEach((level) => {
    assert.deepEqual(
      renderClaudeTools(toolsetAt(level), CTX),
      { allowed: EXPECTED_ALLOWED[level], disallowed: KIT.tools.disallowed, permissionMode: AGENT_AUTONOMY_PERMISSION_MODE[level] },
      level,
    );
  });
  // bypass lleva el mismo allow que el kit fijo; cambia el modo.
  assert.deepEqual(EXPECTED_ALLOWED.bypass, KIT.tools.allowed);
  assert.deepEqual(renderClaudeTools(TOOLSET, CTX), { allowed: KIT.tools.allowed, disallowed: KIT.tools.disallowed, permissionMode: 'dontAsk' });
  // sin shell entera, bypass no da Bash; sin escritura ni web, auto no las da y la web va al deny.
  const narrow = { ...toolsetAt(AGENT_AUTONOMY.bypass), shell: 'read' as const, fsWrite: false, web: false };
  assert.deepEqual(renderClaudeTools(narrow, { ...CTX, awsCli: false }).allowed, [...READ, ...PLATFORM_TOOLS]);
  assert.ok(renderClaudeTools({ ...narrow, autonomy: AGENT_AUTONOMY.auto }, CTX).disallowed.includes('WebFetch'));
});

test('render: las approvals van al final del allow, en su orden y sin repetir', () => {
  const { allowed } = renderClaudeTools(toolsetAt(AGENT_AUTONOMY.manual, APPROVALS), CTX);
  assert.deepEqual(allowed, [...EXPECTED_ALLOWED.manual, 'Bash(npm test:*)', 'Edit', 'Bash(git status:*)']);
  // una approval que el nivel ya da no se repite.
  assert.deepEqual(renderClaudeTools(toolsetAt(AGENT_AUTONOMY.auto, ['Edit', 'Bash(make:*)']), CTX).allowed, [...EXPECTED_ALLOWED.auto, 'Bash(make:*)']);
});

test('auditoría local: el resumen del toolset lleva el nivel y cuántas approvals; sin nivel, como siempre', () => {
  assert.deepEqual([toolsetSummary(toolsetAt(AGENT_AUTONOMY.bypass, APPROVALS)).autonomy, toolsetSummary(toolsetAt(AGENT_AUTONOMY.bypass, APPROVALS)).approvals], ['bypass', APPROVALS.length]);
  assert.equal(toolsetSummary(toolsetAt(AGENT_AUTONOMY.manual)).approvals, 0);
  assert.equal('autonomy' in toolsetSummary(TOOLSET), false);
});

test('sombra: un claim con autonomía casa con las listas del server', () => {
  AGENT_AUTONOMY_LEVELS.forEach((level) => {
    const server = { allowed: [...EXPECTED_ALLOWED[level], ...APPROVALS.slice(0, 3)], disallowed: KIT.tools.disallowed, permissionMode: AGENT_AUTONOMY_PERMISSION_MODE[level] };
    assert.deepEqual(compareToolset(server, toolsetAt(level, APPROVALS), CTX), { match: true, explained: true, known: [], diff: null }, level);
  });
  // y el claim la trae con su nivel: parse del toolset incluido.
  const claim = parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS);
  assert.equal(claim.toolsetShadow?.toolset.autonomy, AGENT_AUTONOMY.manual);
  assert.deepEqual(compareToolset(claim.toolsetShadow!.server, claim.toolsetShadow!.toolset, CTX).match, true);
});

test('parse del toolset: autonomy de un nivel conocido; approvals solo con ella y dentro de sus topes', () => {
  const raw = (patch: Obj): Obj => ({ ...clone(TOOLSET), ...patch });
  assert.deepEqual(parseToolsetV1(raw({ autonomy: 'auto', approvals: ['Bash(make:*)'] })).approvals, ['Bash(make:*)']);
  assert.equal('autonomy' in parseToolsetV1(raw({})), false, 'sin autonomía, la forma de siempre');
  assert.throws(() => parseToolsetV1(raw({ autonomy: 'yolo' })), /autonomy/);
  assert.throws(() => parseToolsetV1(raw({ approvals: ['Edit'] })), /approvals sin autonomy/);
  assert.throws(() => parseToolsetV1(raw({ autonomy: 'manual', approvals: Array.from({ length: AGENT_PERMISSION_APPROVALS_MAX + 1 }, (_, i) => `Bash(x${i})`) })), /approvals/);
  assert.throws(() => parseToolsetV1(raw({ autonomy: 'manual', approvals: [''] })), /approvals/);
});

test('claim: el permission mode es el del nivel y solo el suyo; sin nivel, dontAsk como siempre', () => {
  const modes = ['dontAsk', 'default', 'auto', 'bypassPermissions', 'acceptEdits', 'plan'];
  [null, ...AGENT_AUTONOMY_LEVELS].forEach((level) => {
    const expected = level === null ? 'dontAsk' : AGENT_AUTONOMY_PERMISSION_MODE[level];
    modes.forEach((mode) => {
      const raw = autonomyClaim(level, { top: { permissionMode: mode } });
      if (mode === expected) assert.equal(parseClaim(raw, ROOTLESS).permissionMode, mode, `${level} ${mode}`);
      else assert.throws(() => parseClaim(raw, ROOTLESS), /permission mode/, `${level} ${mode}`);
    });
  });
  const manual = parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS);
  assert.equal(manual.run.autonomy, AGENT_AUTONOMY.manual);
  assert.deepEqual(manual.tools.allowed, EXPECTED_ALLOWED.manual, 'una edición en manual sin Bash/Edit/Write en el allow es válida');
  assert.deepEqual(manual.permissions, PERMISSIONS);
  assert.equal(parseClaim(autonomyClaim(null), ROOTLESS).run.autonomy, null);
  assert.equal(parseClaim(autonomyClaim(null, { run: { autonomy: null } }), ROOTLESS).run.autonomy, null, 'null = el kit fijo');
  assert.equal('permissions' in parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass), ROOTLESS), false);
});

test('claim: un nivel desconocido, fuera de una edición o bypass como root lo invalidan', () => {
  assert.throws(() => parseClaim(autonomyClaim(null, { run: { autonomy: 'yolo' } }), ROOTLESS), /run\.autonomy "yolo" desconocida/);
  assert.throws(() => parseClaim(autonomyClaim(null, { run: { autonomy: 3 } }), ROOTLESS), /run\.autonomy \(number\)/);
  // lectura: ni con su modo.
  const read = autonomyClaim(AGENT_AUTONOMY.manual, { run: { profile: 'read' } });
  assert.throws(() => parseClaim(read, ROOTLESS), /solo vale en una conversación en edición/);
  assert.throws(() => parseClaim(autonomyClaim(null, { run: { profile: 'read' }, top: { permissionMode: 'default' } }), ROOTLESS), /permission mode/);
  // un run de reglas heredado tampoco.
  assert.throws(() => parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass, { run: { kind: 'investigate', profile: null } }), ROOTLESS), /solo vale en una conversación en edición/);
  // bypass como root: el cli lo rechazaría.
  assert.throws(() => parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass), ROOT), /root/);
  assert.equal(parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOT).run.autonomy, AGENT_AUTONOMY.manual, 'manual sí, también como root');
  assert.deepEqual([canBypassPermissions(0), canBypassPermissions(1000), canBypassPermissions(undefined)], [false, true, true]);
});

test('claim: permissions si y solo si el nivel pregunta, en el origen del mcp, con plazos válidos', () => {
  const withPermissions = (level: AgentAutonomy | null, permissions: unknown): Obj => autonomyClaim(level, { top: { permissions } });
  assert.throws(() => parseClaim(autonomyClaim(AGENT_AUTONOMY.manual, { top: { permissions: undefined } }), ROOTLESS), /no trae permissions/);
  assert.throws(() => parseClaim(withPermissions(AGENT_AUTONOMY.bypass, PERMISSIONS), ROOTLESS), /sin una autonomía que pregunte/);
  assert.throws(() => parseClaim(withPermissions(null, PERMISSIONS), ROOTLESS), /sin una autonomía que pregunte/);
  const bad = (patch: Obj): Obj => withPermissions(AGENT_AUTONOMY.auto, { ...PERMISSIONS, ...patch });
  ['https://otro.test/api/runner-permissions', 'http://duckhunt.test:8080/x', 'https://duckhunt.test/x', 'no es una url', 'http://u:p@duckhunt.test/x'].forEach((url) =>
    assert.throws(() => parseClaim(bad({ url }), ROOTLESS), /origen del mcp/, url),
  );
  [{ ttlMs: 0 }, { waitMs: -1 }, { ttlMs: 1.5 }, { waitMs: '20000' }].forEach((p) => assert.throws(() => parseClaim(bad(p), ROOTLESS), /enteros positivos/, JSON.stringify(p)));
  assert.equal(parseClaim(bad({ waitMs: PERMISSION_WAIT_MAX_MS * 4 }), ROOTLESS).permissions?.waitMs, PERMISSION_WAIT_MAX_MS, 'waitMs acotado');
  assert.throws(() => parseClaim(autonomyClaim(AGENT_AUTONOMY.manual, { run: { segment: null } }), ROOTLESS), /run\.segment/);
  const named = autonomyClaim(AGENT_AUTONOMY.manual, { top: { mcp: { ...KIT.mcp, serverName: AGENT_PERMISSION_TOOL.server } } });
  assert.throws(() => parseClaim(named, ROOTLESS), /no puede llamarse/);
});

test('claim: una approval que no es un id de tool no llega a argv, ni del server ni del render', () => {
  const raw = autonomyClaim(AGENT_AUTONOMY.manual, { top: { tools: { allowed: [...EXPECTED_ALLOWED.manual, 'Bash(a,b)'], disallowed: KIT.tools.disallowed } } });
  assert.throws(() => parseClaim(raw, ROOTLESS), /tools\.allowed/);
  const claim = parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS);
  const rendered = renderClaudeTools(toolsetAt(AGENT_AUTONOMY.manual, ['-x']), CTX);
  assert.throws(() => withRenderedTools(claim, rendered, ROOTLESS), /ids de tool no válidos/);
  // el render tiene que ser del nivel del run: otro modo no pasa la criba.
  assert.throws(() => withRenderedTools(claim, renderClaudeTools(toolsetAt(AGENT_AUTONOMY.bypass), CTX), ROOTLESS), /exige permission mode default/);
  assert.deepEqual(withRenderedTools(claim, renderClaudeTools(toolsetAt(AGENT_AUTONOMY.manual, ['Bash(npm test:*)']), CTX), ROOTLESS).tools.allowed.at(-1), 'Bash(npm test:*)');
});

const RUN_CONFIG_DENY = 'Read(//home/u/.duckhunt-runner/run-config/**)';
const argsFor = (claim: ClaimResponse, over: Partial<ClaudeArgsInput> = {}): string[] =>
  buildClaudeArgs({
    claim,
    prompt: 'haz algo',
    mcpConfigFile: '/home/u/.duckhunt-runner/run-config/mcp-36-abcd.json',
    supported: allFlags,
    resumeSessionId: null,
    skipPermissions: false,
    payingWithApiKey: false,
    runConfigDeny: [RUN_CONFIG_DENY],
    permissionPromptTool: true,
    ...over,
  });
const flagValue = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test('argv: el modo del nivel y la tool de permisos si pregunta; bypass sin --dangerously-skip-permissions', () => {
  const manual = argsFor(parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS));
  assert.equal(flagValue(manual, '--permission-mode'), 'default');
  assert.equal(flagValue(manual, '--permission-prompt-tool'), AGENT_PERMISSION_TOOL_ID);
  assert.equal(AGENT_PERMISSION_TOOL_ID, 'mcp__duckhunt-runner-permission__prompt');
  assert.equal(flagValue(manual, '--allowedTools'), EXPECTED_ALLOWED.manual.join(','));
  const auto = argsFor(parseClaim(autonomyClaim(AGENT_AUTONOMY.auto), ROOTLESS));
  assert.deepEqual([flagValue(auto, '--permission-mode'), flagValue(auto, '--permission-prompt-tool')], ['auto', AGENT_PERMISSION_TOOL_ID]);
  const bypass = argsFor(parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass), ROOTLESS), { skipPermissions: true });
  assert.equal(flagValue(bypass, '--permission-mode'), 'bypassPermissions');
  assert.ok(!bypass.includes('--permission-prompt-tool') && !bypass.includes('--dangerously-skip-permissions'));
  assert.ok(flagValue(bypass, '--disallowedTools')!.split(',').includes(RUN_CONFIG_DENY), 'el deny sigue mandando en bypass');
  // sin autonomía, el argv de siempre.
  const fixed = argsFor(parseClaim(autonomyClaim(null), ROOTLESS));
  assert.equal(flagValue(fixed, '--permission-mode'), 'dontAsk');
  assert.ok(!fixed.includes('--permission-prompt-tool'));
  // un cli que no la acepta: no se lanza una conversación que pregunta (bypass sí).
  assert.throws(() => argsFor(parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS), { permissionPromptTool: false }), /--permission-prompt-tool/);
  assert.doesNotThrow(() => argsFor(parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass), ROOTLESS), { permissionPromptTool: false }));
});

test('env de claude: MCP_TOOL_TIMEOUT con margen sobre el ttl, sin bajar uno mayor; sin permissions, nada', () => {
  const manual = parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS);
  assert.deepEqual(claudeRunEnv({}, manual), { MCP_TOOL_TIMEOUT: String(PERMISSIONS.ttlMs + 120_000) });
  assert.deepEqual(claudeRunEnv({ MCP_TOOL_TIMEOUT: '99999999' }, manual), { MCP_TOOL_TIMEOUT: '99999999' });
  assert.deepEqual(claudeRunEnv({ MCP_TOOL_TIMEOUT: '1000' }, manual), { MCP_TOOL_TIMEOUT: String(PERMISSIONS.ttlMs + 120_000) });
  assert.deepEqual(claudeRunEnv({ MCP_TOOL_TIMEOUT: '1000' }, parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass), ROOTLESS)), {});
});

test('versión del cli: --permission-prompt-tool desde 2.1.302', () => {
  assert.equal(supportsPermissionPromptTool('2.1.309 (Claude Code)'), true);
  assert.equal(supportsPermissionPromptTool('2.1.302 (Claude Code)'), true);
  assert.equal(supportsPermissionPromptTool('2.1.301 (Claude Code)'), false);
  assert.equal(supportsPermissionPromptTool('2.0.999'), false);
  assert.equal(supportsPermissionPromptTool('3.0.0'), true);
  assert.equal(supportsPermissionPromptTool(null), false);
  assert.equal(supportsPermissionPromptTool('claude dev'), false);
  assert.equal(claudeAtLeast('2.10.0', '2.9.9'), true, 'numérico, no lexicográfico');
});

test('capacidades: autonomy con prompt y un cli >= 2.1.302; autonomy_bypass además fuera de root; al final', () => {
  const kit = { hasAws: false, supported: allFlags };
  const base = announcedCapabilities(kit);
  assert.ok(!base.includes('autonomy'), 'sin versión, no');
  const recent = announcedCapabilities({ ...kit, claudeVersion: '2.1.309 (Claude Code)', bypassPermissions: true });
  assert.deepEqual(recent, [...base, 'autonomy', 'autonomy_bypass']);
  assert.deepEqual(announcedCapabilities({ ...kit, claudeVersion: '2.1.309 (Claude Code)', bypassPermissions: false }), [...base, 'autonomy']);
  assert.deepEqual(announcedCapabilities({ ...kit, claudeVersion: '2.1.301 (Claude Code)', bypassPermissions: true }), base);
  const noPrompt = { hasAws: false, supported: new Set(OPTIONAL_FLAGS.filter((f) => f !== '--setting-sources')), claudeVersion: '2.1.309', bypassPermissions: true };
  assert.ok(!announcedCapabilities(noPrompt).includes('autonomy'), 'sin prompt no hay conversaciones que gobernar');
});

let home = '';
let prevHome: string | undefined;
before(() => {
  prevHome = process.env.DUCKHUNT_RUNNER_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-autonomy-')));
  process.env.DUCKHUNT_RUNNER_HOME = home;
});
after(() => {
  if (prevHome === undefined) delete process.env.DUCKHUNT_RUNNER_HOME;
  else process.env.DUCKHUNT_RUNNER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('mcp-config: la tool de permisos como servidor stdio del propio runner, con su env; sin permissions, nada', () => {
  const claim = parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS);
  const servers = permissionMcpServers(claim);
  const entry = servers[AGENT_PERMISSION_TOOL.server]!;
  assert.equal(entry.type, 'stdio');
  assert.equal(entry.command, process.execPath);
  assert.equal(path.basename(entry.args[0]!), 'index.js');
  assert.ok(fs.existsSync(entry.args[0]!), 'el entrypoint del runner');
  assert.equal(entry.args[1], PERMISSION_SUBCOMMAND);
  assert.deepEqual(entry.env, {
    [PERMISSION_ENV.url]: PERMISSIONS.url,
    [PERMISSION_ENV.token]: KIT.mcp.token,
    [PERMISSION_ENV.segment]: '1',
    [PERMISSION_ENV.ttlMs]: String(PERMISSIONS.ttlMs),
    [PERMISSION_ENV.waitMs]: String(PERMISSIONS.waitMs),
  });
  assert.deepEqual(permissionMcpServers(parseClaim(autonomyClaim(AGENT_AUTONOMY.bypass), ROOTLESS)), {});
  assert.deepEqual(permissionMcpServers(parseClaim(autonomyClaim(null), ROOTLESS)), {});
  // en el fichero del segmento, tras el mcp de la plataforma y con el mismo token (0600).
  const file = writeRunMcpConfig(claim.run.id, claim.mcp, LEGACY_PLATFORM_ID, [], servers);
  const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, Obj> };
  assert.deepEqual(Object.keys(written.mcpServers), [KIT.mcp.serverName, AGENT_PERMISSION_TOOL.server]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

const ENFORCEMENT = { ceiling: LEGACY_CEILING, expose: LEGACY_EXPOSE, resourceTypes: ['repo', 'aws'], awsCli: true };
const rejectedWith = (fn: () => unknown, code: string): void =>
  assert.throws(fn, (err: unknown) => err instanceof ClaimRejectedError && err.code === code, `esperaba ${code}`);

test('flip: el claim se lanza con el render de su nivel; un techo que recorta lo que el allow ya no cumple lo rechaza', () => {
  // el render pasa la criba con este proceso: como root, bypass no se puede lanzar.
  AGENT_AUTONOMY_LEVELS.filter((level) => level !== AGENT_AUTONOMY.bypass || canBypassPermissions()).forEach((level) => {
    const { claim } = renderLegacyClaim(parseClaim(autonomyClaim(level), ROOTLESS), ENFORCEMENT);
    assert.deepEqual([claim.tools.allowed, claim.permissionMode], [EXPECTED_ALLOWED[level], AGENT_AUTONOMY_PERMISSION_MODE[level]], level);
  });
  const manual = parseClaim(autonomyClaim(AGENT_AUTONOMY.manual), ROOTLESS);
  rejectedWith(() => renderLegacyClaim(manual, { ...ENFORCEMENT, ceiling: { ...LEGACY_CEILING, shell: 'read' } }), CLAIM_REJECT.notAllowed);
  rejectedWith(() => renderLegacyClaim(manual, { ...ENFORCEMENT, ceiling: { ...LEGACY_CEILING, platformTools: ['duckhunt-entry-get'] } }), CLAIM_REJECT.notAllowed);
  // el push sí se cumple con el deny: no se rechaza.
  const noPush = renderLegacyClaim(manual, { ...ENFORCEMENT, ceiling: { ...LEGACY_CEILING, vcsPush: false } });
  assert.ok(noPush.claim.tools.disallowed.includes('Bash(git push*)'));
  // sin autonomía, el mismo techo solo acota.
  assert.doesNotThrow(() => renderLegacyClaim(parseClaim(autonomyClaim(null, { top: { toolset: clone(TOOLSET) } }), ROOTLESS), { ...ENFORCEMENT, ceiling: { ...LEGACY_CEILING, shell: 'read' } }));
});

test('v0: un toolset con autonomía se rechaza (el cable v0 no la lleva)', () => {
  const v0 = readJson<{ run: Obj }>('v0/prompt-edit-full.json').run;
  const run: Obj = { ...v0, mcpServers: (v0.mcpServers as Obj[]).map((s) => ({ ...s, url: String(s.url).replace('http://duckhunt.test', 'https://duckhunt.test') })) };
  const enforcement = { ...ENFORCEMENT, platformBaseUrl: 'https://duckhunt.test' };
  assert.doesNotThrow(() => claimOfV0(run, enforcement));
  const withAutonomy = clone(run);
  ((withAutonomy.policy as Obj).toolset as Obj).autonomy = AGENT_AUTONOMY.bypass;
  rejectedWith(() => claimOfV0(withAutonomy, enforcement), CLAIM_REJECT.invalid);
});
