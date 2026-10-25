// claim → argv de claude: validación local (nada del server acaba como flag) y flags por kind. y el
// contrato del cable con el server (t#465): los claims reales que compone duckhunt (copias de sus
// fixtures en test/fixtures/claims, que genera su template-seed-kit.test.ts, y la matriz dorada del
// resolver de política en test/fixtures/claim-kits, de su claim-kit.test.ts: semilla × perfil × tier ×
// capabilities × candados × commentJira × aws anunciada) los acepta parseClaim y buildClaudeArgs los
// cumple — una investigación es un prompt run de lectura y nunca sale de ahí. el enrutado del server
// (t#465 P10, los routing-*.json) solo manda la sesión a la máquina que la tiene (si la conversación se
// movió, va sin sesión y con el prompt de respaldo como prompt) y el repo en la grafía de su mapa.
// 0.11.0 (t#465 P12): el claim de un server con lifecycle (lifecycle-*.json) es el mismo kit con el
// bloque runner al final, que parseClaim ignora; todo kit de lectura lleva además los deny de
// secret_paths y una plantilla vuelve a llevar su presupuesto (seed_budget) con api key.
// 0.12.0 (t#465): `run.model` solo pasa como alias o id de modelo y manda sobre defaults.model; una
// plantilla con la memoria nativa encendida (sin Edit/Write en el deny) se cumple igual, y el kit
// desatendido de un prompt de regla (sin web, push y remotos negados en edición) llega entero al argv.
// 0.15.0 (t#527): las conversaciones con autonomía de la matriz (autonomy-*.json) llevan el modo de su nivel y, si
// pregunta (manual, auto), la tool de permisos y el bloque permissions; bypass, ninguno de los dos.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs, type ClaudeArgsInput } from '../src/claude-args.js';
import { AWS_OUTFILE_COMMANDS, claimRunId, isAwsReadPattern, parseClaim } from '../src/claim.js';
import { parseRunnerBlock } from '../src/server-state.js';
import { mirrorAllow, mirroredDeny, READ_MIRRORED_TOOLS, settingsFilesFor, WRITE_TOOLS } from '../src/user-permissions.js';
import { OPTIONAL_FLAGS } from '../src/claude.js';
import { AGENT_AUTONOMY_PERMISSION_MODE, AGENT_PERMISSION_TOOL_ID } from '../src/vendor/runner-protocol/index.js';
import { clampReport } from '../src/status-report.js';
import { scrubEnv } from '../src/scrub-env.js';

const rawClaim = (run: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  run: { id: 88, kind: 'prompt', entryId: 5, workspaceId: 1, repo: 'okt/app', branch: 'feat/x', repoSource: 'explicit', repoAvailable: true, aws: null, sessionId: null, parentRunId: null, profile: 'edit', ...run },
  prompt: 'haz algo',
  fallbackPrompt: null,
  tier: 'act',
  tools: { allowed: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'mcp__duckhunt__duckhunt-note-add'], disallowed: ['NotebookEdit', 'WebFetch', 'WebSearch'] },
  permissionMode: 'dontAsk',
  maxTurns: null,
  maxBudgetUsd: null,
  timeoutMs: 1_800_000,
  heartbeatMs: 20_000,
  events: { enabled: true, nextSeq: 7, flushMs: 1000, flushCount: 20, batchMax: 50, bodyMaxChars: 4000, toolArgMaxChars: 200 },
  mcp: { serverName: 'duckhunt', url: 'https://duckhunt.info/mcp', token: 'dho_x', expiresAt: 1 },
  ...extra,
});

const allFlags = new Set(OPTIONAL_FLAGS);
// deny del directorio de mcp-configs (run-mcp-config.ts::runConfigDeny) que el daemon fuerza en todo kit.
const RUN_CONFIG_DENY = 'Read(//home/u/.duckhunt-runner/run-config/**)';
const argsFor = (claimRaw: Record<string, unknown>, over: Partial<ClaudeArgsInput> = {}): string[] =>
  buildClaudeArgs({
    claim: parseClaim(claimRaw),
    prompt: '-rf: un prompt que empieza por guion',
    mcpConfigFile: '/home/u/.duckhunt-runner/run-config/mcp-88-abcd.json',
    supported: allFlags,
    resumeSessionId: null,
    skipPermissions: false,
    payingWithApiKey: true,
    runConfigDeny: [RUN_CONFIG_DENY],
    ...over,
  });

test('parseClaim normaliza un prompt run con su perfil, su segmento y el bloque events', () => {
  const claim = parseClaim(rawClaim({ segment: 3 }));
  assert.equal(claim.run.kind, 'prompt');
  assert.equal(claim.run.profile, 'edit');
  assert.equal(claim.run.segment, 3);
  assert.equal(claim.maxTurns, null);
  assert.equal(claim.events?.enabled, true);
  assert.equal(claim.events?.nextSeq, 7);
  assert.deepEqual(claim.warnings, []);
  assert.equal(parseClaim(rawClaim()).run.segment, null, 'server sin segmentos');
});

test('parseClaim: isolation checkout solo en prompt runs; ausente o desconocida = worktree', () => {
  assert.equal(parseClaim(rawClaim({ isolation: 'checkout' })).run.isolation, 'checkout');
  assert.equal(parseClaim(rawClaim()).run.isolation, 'worktree', 'server anterior a 0.6.0');
  assert.equal(parseClaim(rawClaim({ isolation: '../fuera' })).run.isolation, 'worktree');
  const rule = parseClaim(rawClaim({ kind: 'investigate', profile: undefined, isolation: 'checkout' }));
  assert.equal(rule.run.isolation, 'worktree', 'un run de reglas lo decide la config local');
});

test('parseClaim rechaza lo que acabaría en argv o en paths', () => {
  assert.throws(() => parseClaim(rawClaim({ id: '../../x' })), /run\.id/);
  // una rama que parece un flag no llega a git: se ignora con aviso y el run sigue (base por defecto).
  const evil = parseClaim(rawClaim({ branch: '--upload-pack=evil' }));
  assert.equal(evil.run.branch, null);
  assert.match(evil.warnings[0] ?? '', /ignorada/);
  assert.equal(parseClaim(rawClaim({ branch: 'con espacio' })).run.branch, null);
  assert.throws(() => parseClaim(rawClaim({ sessionId: '--dangerously-skip-permissions' })), /sessionId/);
  assert.throws(() => parseClaim(rawClaim({ profile: null })), /perfil/);
  assert.throws(() => parseClaim(rawClaim({}, { permissionMode: 'bypassPermissions' })), /permission mode/);
  assert.throws(() => parseClaim(rawClaim({}, { tools: { allowed: ['--dangerously-skip-permissions'], disallowed: [] } })), /tools\.allowed/);
  assert.equal(claimRunId(rawClaim({ branch: '--x' })), '88');
  // server anterior a t#378: sin events y con topes numéricos.
  const legacy = parseClaim(rawClaim({ kind: 'investigate', profile: undefined }, { events: undefined, maxTurns: 40, maxBudgetUsd: 20 }));
  assert.equal(legacy.events, null);
  assert.equal(legacy.maxTurns, 40);
});

test('prompt run: permission mode explícito, sin topes ni skip-permissions, prompt tras --', () => {
  const args = argsFor(rawClaim(), { configBudgetUsd: 5, skipPermissions: true, model: 'opus', resumeSessionId: 'abc-123' });
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  assert.ok(!args.includes('--max-turns'));
  assert.ok(!args.includes('--max-budget-usd'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args.slice(-2), ['--', '-rf: un prompt que empieza por guion']);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Bash,Edit,Write,mcp__duckhunt__duckhunt-note-add');
  assert.equal(args[args.indexOf('--resume') + 1], 'abc-123');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('run de reglas: conserva --max-turns, presupuesto solo con api key y skip-permissions local', () => {
  const rule = rawClaim({ kind: 'investigate', profile: undefined }, { maxTurns: 40, maxBudgetUsd: 20 });
  const paying = argsFor(rule, { skipPermissions: true });
  assert.equal(paying[paying.indexOf('--max-turns') + 1], '40');
  assert.equal(paying[paying.indexOf('--max-budget-usd') + 1], '20');
  assert.ok(paying.includes('--dangerously-skip-permissions'));
  assert.ok(!argsFor(rule, { payingWithApiKey: false }).includes('--max-budget-usd'));
  assert.ok(!argsFor(rule, { configBudgetUsd: 0 }).includes('--max-budget-usd'));
});

test('sin --permission-mode en el cli no se lanza nada', () => {
  assert.throws(() => argsFor(rawClaim(), { supported: new Set() }), /permission-mode/);
});

test('scrubEnv quita los marcadores de sesión y conserva la config del usuario', () => {
  const env = scrubEnv(
    {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_SOCKET: '/run/x',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      CLAUDE_CONFIG_DIR: '/cfg',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: 'https://proxy',
      SSH_AUTH_SOCK: '/tmp/dead.sock',
    },
    () => false,
  );
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'keep',
    CLAUDE_CONFIG_DIR: '/cfg',
    ANTHROPIC_BASE_URL: 'https://proxy',
    GIT_TERMINAL_PROMPT: '0',
  });
  assert.equal(scrubEnv({ SSH_AUTH_SOCK: '/tmp/live.sock' }, () => true).SSH_AUTH_SOCK, '/tmp/live.sock');
});

test('clampReport recorta al tope del server', () => {
  const r = clampReport({ status: 'done', result: 'x'.repeat(25_000), error: '', stderrTail: `${'a'.repeat(5000)}FIN` });
  assert.equal(r.result?.length, 20_000);
  assert.equal(r.error, 'error');
  assert.ok(r.stderrTail?.endsWith('FIN'));
  assert.equal(r.stderrTail?.length, 4000);
});

test('ramas reales de prs (ñ, +, #) llegan tal cual al worktree: decide git check-ref-format', () => {
  const branches = ['feature/OKT-12_añadir-login', 'hotfix/v1.2+1', 'feat/x#3'];
  assert.deepEqual(branches.map((branch) => parseClaim(rawClaim({ branch })).run.branch), branches);
});

test('perfil read de un prompt run: el daemon lo hace cumplir aunque el server se equivoque', () => {
  const readClaim = (tools: { allowed: string[]; disallowed: string[] }, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    rawClaim({ profile: 'read' }, { tools, ...extra });
  assert.throws(() => parseClaim(readClaim({ allowed: ['Read', 'Bash'], disallowed: [] })), /lectura no puede permitir Bash/);
  assert.throws(() => parseClaim(readClaim({ allowed: ['Read', 'Bash(git log:*)'], disallowed: [] })), /Bash\(git log:\*\)/);
  assert.throws(() => parseClaim(readClaim({ allowed: ['Read', 'Write(src/**)'], disallowed: [] })), /Write\(src/);
  const forced = parseClaim(readClaim({ allowed: ['Read', 'Grep'], disallowed: ['WebFetch'] }));
  const outfile = AWS_OUTFILE_COMMANDS.map((c) => `Bash(aws ${c}*)`);
  // Edit/Write no se fuerzan (t#434): sin regla solo alcanzan la memoria nativa del cli.
  assert.deepEqual(forced.tools.disallowed, ['WebFetch', 'NotebookEdit', ...outfile]);
  // un server sin native_memory las sigue negando: se respetan.
  assert.ok(parseClaim(readClaim({ allowed: ['Read'], disallowed: ['Edit', 'Write'] })).tools.disallowed.includes('Edit'));
  assert.throws(() => parseClaim(rawClaim({}, { permissionMode: 'acceptEdits' })), /exige permission mode dontAsk/);
  // un run de reglas conserva el techo local de siempre.
  assert.equal(parseClaim(rawClaim({ kind: 'investigate', profile: undefined }, { permissionMode: 'default' })).permissionMode, 'default');
});

test('prompt run de lectura: settings solo del usuario (sin hooks ni settings del checkout) y mcp estricto', () => {
  const readRaw = rawClaim({ profile: 'read' }, { tools: { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['WebFetch'] } });
  const read = argsFor(readRaw);
  assert.deepEqual(read.slice(read.indexOf('--setting-sources'), read.indexOf('--setting-sources') + 2), ['--setting-sources', 'user']);
  assert.ok(read.includes('--strict-mcp-config'));
  assert.ok(read[read.indexOf('--disallowedTools') + 1].startsWith('WebFetch,NotebookEdit,Bash(aws apigateway get-export*),'));
  assert.ok(!argsFor(rawClaim()).includes('--setting-sources'), 'edición conserva el CLAUDE.md y los settings del repo');
  const without = (flag: string): Set<(typeof OPTIONAL_FLAGS)[number]> => new Set(OPTIONAL_FLAGS.filter((f) => f !== flag));
  assert.throws(() => argsFor(readRaw, { supported: without('--setting-sources') }), /--setting-sources/);
  assert.throws(() => argsFor(rawClaim(), { supported: without('--strict-mcp-config') }), /--strict-mcp-config/);
  // un run de reglas no exige los flags de los prompt runs.
  const rule = rawClaim({ kind: 'investigate', profile: undefined }, { maxTurns: 40 });
  assert.ok(argsFor(rule, { supported: without('--setting-sources') }).includes('--permission-mode'));
});

test('lectura con shell (t#385): aws solo fijada en servicio + operación y escritores de fichero siempre negados', () => {
  const read = (allowed: string[]) => parseClaim(rawClaim({ profile: 'read' }, { tools: { allowed, disallowed: ['Edit'] } }));
  const ok = read(['Read', 'Bash(aws cloudwatch describe-*)', 'Bash(aws logs tail*)', 'Bash(aws s3 ls*)']);
  assert.deepEqual(ok.tools.allowed, ['Read', 'Bash(aws cloudwatch describe-*)', 'Bash(aws logs tail*)', 'Bash(aws s3 ls*)']);
  assert.deepEqual(ok.warnings, []);
  assert.ok(ok.tools.disallowed.includes('Bash(aws s3api get-object*)') && !ok.tools.disallowed.includes('Bash'));
  // comodín antes de la operación (casó `aws s3 rm … --exclude list-x`), escrituras o una lectura
  // desconocida: fuera con aviso, sin tumbar el run (el cli niega lo no permitido).
  const dropped = read(['Read', 'Bash(aws * list-*)', 'Bash(aws s3 rm*)', 'Bash(aws ec2 terminate-instances*)', 'Bash(aws ec2 describe-* ; rm -rf x)', 'Bash(aws logs describe-*)']);
  assert.deepEqual(dropped.tools.allowed, ['Read', 'Bash(aws logs describe-*)']);
  assert.match(dropped.warnings.join('\n'), /aws descartada en lectura/);
  // una shell que no es la aws cli tumba el claim, como Bash entero.
  assert.throws(() => read(['Bash(cat:*)']), /Bash\(cat:\*\)/);
  // edición no se toca.
  assert.ok(parseClaim(rawClaim()).tools.allowed.includes('Bash'));
});

test('lectura: las reglas Bash y de escritura del allow del usuario se espejan al deny; edición las conserva', () => {
  const bash = [READ_MIRRORED_TOOLS[0]!];
  assert.deepEqual(mirrorAllow({ permissions: { allow: ['mcp__x__y', 'Bash(npm run test:*)', 'Read'] } }, bash), ['Bash(npm run test:*)']);
  assert.deepEqual(mirrorAllow({ permissions: { allow: 'Bash' } }, bash), []);
  assert.deepEqual(mirrorAllow(null, bash), []);
  assert.deepEqual(mirrorAllow({ permissions: { allow: ['Bash(echo a,b)'] } }, bash), ['Bash'], 'no cabe en argv: Bash entero');
  const settings = { permissions: { allow: ['Read', 'Edit', 'Write(src/**)', 'Bash(git log:*)', 'Edit(a,b)', 'NotebookEditor'] } };
  assert.deepEqual(mirrorAllow(settings, READ_MIRRORED_TOOLS), ['Edit', 'Write(src/**)', 'Bash(git log:*)']);
  assert.deepEqual(mirrorAllow(settings, WRITE_TOOLS), ['Edit', 'Write(src/**)'], 'reglas: su Bash va entero, no se espeja');
  const read = argsFor(rawClaim({ profile: 'read' }, { tools: { allowed: ['Read'], disallowed: [] } }), { mirroredDeny: ['Bash(npm run test:*)', 'Edit'] });
  assert.ok(['Bash(npm run test:*)', 'Edit'].every((t) => read[read.indexOf('--disallowedTools') + 1].split(',').includes(t)));
  const edit = argsFor(rawClaim(), { mirroredDeny: ['Bash(npm run test:*)', 'Edit'] });
  assert.deepEqual(edit[edit.indexOf('--disallowedTools') + 1], `NotebookEdit,WebFetch,WebSearch,${RUN_CONFIG_DENY}`, 'edición conserva el allow del usuario');
});

test('memoria nativa en reglas (t#434): deny espejado y, con skip-permissions, Edit/Write de vuelta al deny', () => {
  const rule = rawClaim({ kind: 'investigate', profile: undefined }, { tools: { allowed: ['Bash', 'Read'], disallowed: ['NotebookEdit'] } });
  const plain = argsFor(rule, { mirroredDeny: ['Edit(src/**)'] });
  assert.equal(plain[plain.indexOf('--disallowedTools') + 1], `NotebookEdit,Edit(src/**),${RUN_CONFIG_DENY}`);
  assert.ok(!plain.includes('--dangerously-skip-permissions'));
  const skip = argsFor(rule, { skipPermissions: true });
  assert.equal(skip[skip.indexOf('--disallowedTools') + 1], `NotebookEdit,Edit,Write,${RUN_CONFIG_DENY}`, 'sin dontAsk, Edit/Write sin negar abrirían el repo');
  assert.ok(skip.includes('--dangerously-skip-permissions'));
});

test('settings que carga un run: usuario siempre, proyecto y local solo sin --setting-sources user; ilegibles = tools enteras', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-settings-'));
  try {
    const [user, project, local] = settingsFilesFor(dir, false);
    assert.deepEqual(settingsFilesFor(dir, true), [user]);
    assert.deepEqual([project, local], [path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json')]);
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(project!, JSON.stringify({ permissions: { allow: ['Edit(src/**)', 'Read'] } }));
    fs.writeFileSync(local!, '{ no es json');
    assert.deepEqual(mirroredDeny([project!], WRITE_TOOLS), ['Edit(src/**)']);
    assert.deepEqual(mirroredDeny([project!, local!, path.join(dir, 'no-existe.json')], WRITE_TOOLS), ['Edit(src/**)', ...WRITE_TOOLS]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clampReport enmascara secretos del result, el error y el stderr', () => {
  const r = clampReport({
    status: 'failed',
    result: 'ok ghp_abcdefghijklmnopqrstuvwxyz0123',
    error: 'push a https://x-token-auth:ATBBabcdefghijklmnopqrstuv12@bitbucket.org/o/r falló',
    stderrTail: 'DB_PASSWORD=hunter2',
  });
  assert.ok(!r.result?.includes('ghp_') && !r.error?.includes('ATBB') && !r.stderrTail?.includes('hunter2'));
  assert.match(r.error ?? '', /https:\/\/\*\*\*@bitbucket\.org/);
});

// espejo de AGENT_SECRET_READ_DENY del server: todo kit de lectura lo lleva al deny.
const SERVER_SECRET_READ_DENY = [
  'Read(~/.aws/**)',
  'Read(~/.ssh/**)',
  'Read(~/.duckhunt-runner.json)',
  'Read(~/.claude/.credentials.json)',
  'Read(~/.config/gh/**)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.docker/config.json)',
  'Read(//tmp/duckhunt-runner-*)',
];
const fixturesIn = (dir: string) => {
  const url = new URL(`../../test/fixtures/${dir}/`, import.meta.url);
  return fs
    .readdirSync(url)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => ({ name: `${dir}/${name}`, raw: JSON.parse(fs.readFileSync(new URL(name, url), 'utf8')) as Record<string, unknown> }));
};
const goldenClaims = fixturesIn('claim-kits');
const claimFixtures = [...fixturesIn('claims'), ...goldenClaims];
const flagValue = (args: string[], flag: string): string[] => {
  const i = args.indexOf(flag);
  return i === -1 ? [] : args[i + 1]!.split(',');
};

test('claims del server (t#465): las investigaciones viajan como prompt run de lectura y el daemon las cumple', () => {
  const seeds = claimFixtures.map(({ raw }) => (raw.run as { seed?: string }).seed);
  assert.ok(seeds.includes('template') && seeds.includes('prompt'), 'hay fixtures de las dos semillas');
  const levels = claimFixtures.map(({ raw }) => (raw.run as { autonomy?: string | null }).autonomy).filter((l): l is string => typeof l === 'string');
  assert.deepEqual([...new Set(levels)].sort(), ['auto', 'bypass', 'manual'], 'hay conversaciones de los tres niveles (t#527)');
  claimFixtures.forEach(({ name, raw }) => {
    // bypass se cumple fuera de root: la máquina del test lo es (ver autonomy.test.ts para root).
    const claim = parseClaim(raw, { canBypass: true });
    assert.deepEqual(claim.warnings, [], `${name}: el server no manda nada que este daemon descarte`);
    assert.equal(claim.run.kind, 'prompt', name);
    // skip-permissions local a propósito: un prompt run (una investigación incluida) nunca lo hereda.
    const args = buildClaudeArgs({
      claim,
      prompt: claim.prompt,
      mcpConfigFile: '/home/u/.duckhunt-runner/run-config/mcp-1-abcd.json',
      supported: allFlags,
      resumeSessionId: claim.run.sessionId,
      skipPermissions: true,
      payingWithApiKey: true,
      runConfigDeny: [RUN_CONFIG_DENY],
      permissionPromptTool: true,
    });
    const allowed = flagValue(args, '--allowedTools');
    const disallowed = flagValue(args, '--disallowedTools');
    // autonomía (t#527): el modo de su nivel; la tool de permisos y el bloque permissions solo si pregunta.
    const level = claim.run.autonomy;
    const asks = level === 'manual' || level === 'auto';
    assert.equal(args[args.indexOf('--permission-mode') + 1], level === null ? 'dontAsk' : AGENT_AUTONOMY_PERMISSION_MODE[level], name);
    assert.deepEqual(flagValue(args, '--permission-prompt-tool'), asks ? [AGENT_PERMISSION_TOOL_ID] : [], `${name}: la tool de permisos solo si pregunta`);
    assert.equal(claim.permissions !== undefined, asks, `${name}: permissions solo si pregunta`);
    assert.ok(disallowed.includes(RUN_CONFIG_DENY), `${name}: los mcp-config de los runs, vetados a Read`);
    assert.ok(args.includes('--strict-mcp-config'), `${name}: sin el .mcp.json del checkout`);
    assert.ok(!args.includes('--dangerously-skip-permissions'), `${name}: nunca salta permisos`);
    assert.ok(!args.includes('--max-turns'), `${name}: sin tope de turnos, el tope es el wall clock`);
    // seed_budget (0.11.0): pagando con api key, una plantilla lleva su presupuesto; una conversación libre, nunca.
    const template = (raw.run as { seed?: string }).seed === 'template';
    assert.deepEqual(flagValue(args, '--max-budget-usd'), template ? [String(claim.maxBudgetUsd)] : [], `${name}: presupuesto solo en plantillas`);
    if (claim.run.profile === 'edit') {
      // en manual y auto Bash se pregunta (o lo decide el cli): no va en el allow.
      assert.equal(allowed.includes('Bash'), !asks, `${name}: Bash entero solo sin preguntar`);
      assert.ok(!args.includes('--setting-sources'), `${name}: edición, como siempre`);
      return;
    }
    assert.equal(level, null, `${name}: lectura sin autonomía`);
    assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', 'user'], `${name}: ni hooks ni settings del checkout`);
    assert.ok(!allowed.includes('Bash'), `${name}: nunca Bash entero en lectura`);
    assert.deepEqual(allowed.filter((t) => ['Edit', 'Write', 'NotebookEdit'].includes(t)), [], `${name}: lectura no escribe`);
    assert.deepEqual(allowed.filter((t) => t.startsWith('Bash(') && !isAwsReadPattern(t)), [], `${name}: solo aws fijada en lectura`);
    assert.ok(SERVER_SECRET_READ_DENY.every((t) => disallowed.includes(t)), `${name}: credenciales vetadas`);
    if ((raw.run as { seed?: string }).seed !== 'template') return;
    assert.deepEqual(allowed.filter((t) => ['WebFetch', 'WebSearch'].includes(t)), [], `${name}: una plantilla no navega`);
    assert.ok(['WebFetch', 'WebSearch', 'NotebookEdit'].every((t) => disallowed.includes(t)), `${name}: sin web`);
    // memoria nativa (t#465, lote 9): la decide el server con el ajuste de la persona. Edit/Write nunca
    // en el allow (arriba) y, en el deny, las dos (memoria apagada) o ninguna (encendida).
    assert.equal(disallowed.includes('Edit'), disallowed.includes('Write'), `${name}: memoria entera o nada`);
    if (claim.run.aws === null) assert.ok(!allowed.some((t) => t.startsWith('Bash(aws ')), `${name}: sin la cuenta anunciada, sin aws`);
    if (!allowed.some((t) => t.startsWith('Bash(aws '))) assert.equal(claim.run.aws, null, `${name}: sin aws, sin perfil que mapear`);
  });
});

test('matriz dorada del resolver (t#465 P7): cubre las dos semillas, los tres tiers, los dos perfiles y las dos isolations', () => {
  const runs = goldenClaims.map(({ raw }) => ({ run: raw.run as { seed: string; profile: string; isolation: string | null }, tier: raw.tier as string }));
  assert.ok(goldenClaims.length >= 60, 'la matriz entera, no una muestra');
  assert.deepEqual([...new Set(runs.map((r) => r.run.seed))].sort(), ['prompt', 'template']);
  assert.deepEqual([...new Set(runs.map((r) => r.tier))].sort(), ['act', 'investigate', 'world']);
  assert.deepEqual([...new Set(runs.map((r) => r.run.profile))].sort(), ['edit', 'read']);
  assert.deepEqual([...new Set(runs.map((r) => r.run.isolation))].sort(), ['checkout', 'worktree', null].sort());
  // el perfil edit y el checkout solo los recibe una conversación libre.
  assert.ok(runs.filter((r) => r.run.seed === 'template').every((r) => r.run.profile === 'read' && r.run.isolation !== 'checkout'));
});

test('enrutado del server (t#465 P10): --resume solo con la sesión que el server manda, y el repo tal cual llega', () => {
  const golden = (name: string) => {
    const fixture = goldenClaims.find((g) => g.name === `claim-kits/${name}.json`);
    assert.ok(fixture, name);
    const claim = parseClaim(fixture.raw);
    const args = buildClaudeArgs({
      claim,
      prompt: claim.prompt,
      mcpConfigFile: '/tmp/mcp.json',
      supported: allFlags,
      resumeSessionId: claim.run.sessionId,
      skipPermissions: false,
      payingWithApiKey: false,
      runConfigDeny: [RUN_CONFIG_DENY],
    });
    return { claim, args };
  };
  // la misma máquina tras un re-login: reanuda, con el respaldo por si la sesión no está.
  const relogin = golden('routing-relogin-resume');
  assert.deepEqual(relogin.args.slice(relogin.args.indexOf('--resume'), relogin.args.indexOf('--resume') + 2), ['--resume', 's1']);
  assert.notEqual(relogin.claim.fallbackPrompt, null);
  // otra máquina tras la gracia: arranca sin sesión con el prompt de respaldo (el que recupera el hilo).
  const moved = golden('routing-moved-fallback');
  assert.equal(moved.claim.run.sessionId, null);
  assert.ok(!moved.args.includes('--resume'));
  assert.equal(moved.claim.fallbackPrompt, null);
  assert.match(moved.claim.prompt, /sesión no está disponible aquí/);
  // el repo en la grafía del mapa de esta máquina: la búsqueda de su carpeta es por la clave exacta.
  assert.equal(golden('routing-machine-spelling').claim.run.repo, 'OKT/Api');
});

test('lifecycle (t#465 P12): el claim de 0.11 es el kit de 0.10 más el bloque runner, que parseClaim ignora', () => {
  const pairs = [
    ['lifecycle-prompt-read', 'prompt-read-full'],
    ['lifecycle-template', 'template-full-aws-announced'],
  ] as const;
  pairs.forEach(([name, like]) => {
    const fixture = goldenClaims.find((g) => g.name === `claim-kits/${name}.json`);
    const base = goldenClaims.find((g) => g.name === `claim-kits/${like}.json`);
    assert.ok(fixture && base, name);
    const block = parseRunnerBlock(fixture.raw);
    assert.ok(block && block.id > 0 && block.paused === false && block.accepts === 'all' && block.maxSlots === null, `${name}: el bloque runner`);
    assert.equal(parseRunnerBlock(base.raw), null, `${like}: un server sin lifecycle no lo manda`);
    const claim = parseClaim(fixture.raw);
    assert.deepEqual(claim.warnings, [], name);
    assert.deepEqual(claim.tools, parseClaim(base.raw).tools, `${name}: el mismo kit`);
    assert.ok(!('runner' in claim), `${name}: el bloque no es del run`);
  });
});

test('secret_paths (0.11.0): todo kit de lectura niega las rutas reales de las credenciales; edición no', () => {
  const secret = ['Read(//home/u/dotfiles/duckhunt-runner.json)', 'Read(//home/u/.duckhunt-runner/logs/**)'];
  const denied = (raw: Record<string, unknown>) => flagValue(argsFor(raw, { secretPathsDeny: secret }), '--disallowedTools');
  const read = denied(rawClaim({ profile: 'read' }, { tools: { allowed: ['Read'], disallowed: [] } }));
  assert.ok(secret.every((r) => read.includes(r)), 'lectura');
  const rule = denied(rawClaim({ kind: 'investigate', profile: undefined }, { tools: { allowed: ['Bash', 'Read'], disallowed: [] } }));
  assert.ok(secret.every((r) => rule.includes(r)), 'reglas heredadas');
  assert.ok(!secret.some((r) => denied(rawClaim()).includes(r)), 'edición: con Bash entero no acotarían nada');
  // y en todo claim de lectura real del server.
  claimFixtures
    .filter(({ raw }) => (raw.run as { profile?: string }).profile === 'read')
    .forEach(({ name, raw }) => assert.ok(secret.every((r) => denied(raw).includes(r)), name));
});

test('seed_budget (0.11.0): una plantilla aplica maxBudgetUsd con api key o la config; una conversación libre nunca', () => {
  const template = rawClaim({ profile: 'read', seed: 'template' }, { tools: { allowed: ['Read'], disallowed: [] }, maxTurns: 40, maxBudgetUsd: 20 });
  const budget = (raw: Record<string, unknown>, over: Partial<ClaudeArgsInput> = {}) => flagValue(argsFor(raw, over), '--max-budget-usd');
  assert.deepEqual(budget(template), ['20']);
  assert.deepEqual(budget(template, { payingWithApiKey: false }), [], 'con suscripción el coste es nominal');
  assert.deepEqual(budget(template, { payingWithApiKey: false, configBudgetUsd: 5 }), ['5'], 'la config manda');
  assert.deepEqual(budget(template, { configBudgetUsd: 0 }), [], '0 = nunca');
  assert.ok(!argsFor(template).includes('--max-turns'), 'el tope de turnos no vuelve');
  assert.equal(parseClaim(template).run.seed, 'template');
  const prompt = rawClaim({ profile: 'read', seed: 'prompt' }, { tools: { allowed: ['Read'], disallowed: [] }, maxBudgetUsd: 20 });
  assert.deepEqual(budget(prompt, { configBudgetUsd: 5 }), [], 'una conversación libre no lleva presupuesto');
  assert.equal(parseClaim(rawClaim({ seed: 'otro' })).run.seed, null);
});

test('modelo (0.12.0): parseClaim guarda un alias o un id de modelo; cualquier otra cosa, null con aviso', () => {
  assert.equal(parseClaim(rawClaim({ model: 'opus' })).run.model, 'opus');
  assert.equal(parseClaim(rawClaim({ model: 'claude-opus-5-5' })).run.model, 'claude-opus-5-5');
  assert.equal(parseClaim(rawClaim({ model: 'claude-sonnet-4.5' })).run.model, 'claude-sonnet-4.5');
  const absent = parseClaim(rawClaim());
  assert.equal(absent.run.model, null, 'un server o un daemon sin la capability');
  assert.deepEqual(absent.warnings, []);
  const none = parseClaim(rawClaim({ model: null }));
  assert.equal(none.run.model, null, "'machine': el modelo de esta máquina");
  assert.deepEqual(none.warnings, []);
  ['-x', 'opus; rm', 'OPUS', `a${'b'.repeat(64)}`, '--dangerously-skip-permissions', '', 42, { id: 'opus' }].forEach((model) => {
    const claim = parseClaim(rawClaim({ model }));
    assert.equal(claim.run.model, null, JSON.stringify(model));
    assert.equal(claim.warnings.length, 1, JSON.stringify(model));
    assert.match(claim.warnings[0]!, /modelo .* ignorado \(no es un alias ni un id de modelo\)/);
  });
  assert.equal(parseClaim(rawClaim({ model: `a${'b'.repeat(63)}` })).run.model?.length, 64, '64 caracteres sí');
  assert.match(parseClaim(rawClaim({ model: 7 })).warnings[0]!, /modelo \(number\) ignorado/, 'de un valor que no es texto solo su tipo');
});

test('modelo (0.12.0): el del claim manda sobre defaults.model; sin ninguno no hay --model', () => {
  // así lo resuelve el daemon: run.model ?? defaults.model.
  const modelArgs = (claimModel: unknown, configModel: string | undefined) => {
    const claim = parseClaim(rawClaim({ model: claimModel }));
    return flagValue(argsFor(rawClaim({ model: claimModel }), { model: claim.run.model ?? configModel }), '--model');
  };
  assert.deepEqual(modelArgs('sonnet', 'opus'), ['sonnet'], 'la elección de la persona');
  assert.deepEqual(modelArgs(null, 'opus'), ['opus'], 'sin elección, el de la máquina');
  assert.deepEqual(modelArgs(undefined, 'opus'), ['opus'], 'server sin la capability');
  assert.deepEqual(modelArgs('-x', 'opus'), ['opus'], 'uno inválido cae al de la máquina');
  assert.deepEqual(modelArgs(null, undefined), [], 'ni uno ni otro: el default del cli');
  // también al reanudar: --model con --resume cambia el modelo de la sesión.
  const resumed = argsFor(rawClaim({ model: 'haiku', sessionId: 's1' }), { model: 'haiku', resumeSessionId: 's1' });
  assert.deepEqual(flagValue(resumed, '--model'), ['haiku']);
  assert.deepEqual(flagValue(resumed, '--resume'), ['s1']);
  assert.ok(resumed.indexOf('--model') < resumed.indexOf('--'), 'antes del prompt');
});

test('memoria nativa de las plantillas (t#465, lote 9): sin Edit/Write en el deny del server el daemon no las añade', () => {
  // los dos kits reales del server ante un daemon native_memory: el ajuste ruleMemory encendido (el
  // default) y apagado (template-rule-memory-off).
  const base = goldenClaims.find((g) => g.name === 'claim-kits/template-full-aws-announced.json');
  const memoryOff = goldenClaims.find((g) => g.name === 'claim-kits/template-rule-memory-off.json');
  assert.ok(base && memoryOff);
  const tools = base.raw.tools as { allowed: string[]; disallowed: string[] };
  assert.ok(!tools.disallowed.includes('Edit') && !tools.disallowed.includes('Write'), 'encendida, el server ya no las niega');
  const claim = parseClaim(base.raw);
  assert.deepEqual(claim.warnings, []);
  assert.equal(claim.run.seed, 'template');
  assert.equal(claim.run.profile, 'read');
  assert.ok(!claim.tools.disallowed.includes('Edit') && !claim.tools.disallowed.includes('Write'), 'parseClaim no las fuerza');
  // skip-permissions local a propósito: una plantilla es un prompt run y nunca lo hereda.
  const args = buildClaudeArgs({
    claim,
    prompt: claim.prompt,
    mcpConfigFile: '/home/u/.duckhunt-runner/run-config/mcp-1-abcd.json',
    supported: allFlags,
    resumeSessionId: null,
    skipPermissions: true,
    payingWithApiKey: false,
    mirroredDeny: ['Write(src/**)'],
    runConfigDeny: [RUN_CONFIG_DENY],
  });
  const disallowed = flagValue(args, '--disallowedTools');
  const allowed = flagValue(args, '--allowedTools');
  assert.ok(!disallowed.includes('Edit') && !disallowed.includes('Write'), 'su memoria nativa queda al alcance (dontAsk)');
  assert.ok(!allowed.includes('Edit') && !allowed.includes('Write'), 'pero ninguna regla las permite');
  assert.ok(disallowed.includes('Write(src/**)'), 'las reglas de escritura del usuario, espejadas');
  assert.ok(['WebFetch', 'WebSearch', 'NotebookEdit', RUN_CONFIG_DENY].every((t) => disallowed.includes(t)));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  // con la memoria apagada el server las niega enteras y el daemon lo respeta.
  const off = flagValue(argsFor(memoryOff.raw), '--disallowedTools');
  assert.ok(off.includes('Edit') && off.includes('Write'));
  assert.equal((memoryOff.raw.run as { seed?: string }).seed, 'template');
});

test('prompts de reglas (t#465, lote 9): el kit desatendido del server llega entero al argv', () => {
  const rulePrompts = goldenClaims.filter((g) => g.name.startsWith('claim-kits/rule-prompt-'));
  assert.ok(rulePrompts.length >= 7, 'los del motor y los del kit desatendido');
  rulePrompts.forEach(({ name, raw }) => {
    const claim = parseClaim(raw);
    assert.deepEqual(claim.warnings, [], name);
    const serverDeny = (raw.tools as { disallowed: string[] }).disallowed;
    const args = argsFor(raw);
    const allowed = flagValue(args, '--allowedTools');
    const disallowed = flagValue(args, '--disallowedTools');
    // sin web (tampoco tras el sí) y nunca en el checkout de la persona.
    assert.ok(['WebFetch', 'WebSearch'].every((t) => disallowed.includes(t) && !allowed.includes(t)), `${name}: sin web`);
    assert.notEqual((raw.run as { isolation?: string | null }).isolation, 'checkout', name);
    // en edición, el deny de push y remotos que manda el server (por debajo de world) va tal cual.
    const pushDeny = ['Bash(git push*)', 'Bash(git remote*)', 'Bash(gh *)'];
    if (pushDeny.every((t) => serverDeny.includes(t))) assert.ok(pushDeny.every((t) => disallowed.includes(t)), `${name}: push y remotos negados`);
  });
});
