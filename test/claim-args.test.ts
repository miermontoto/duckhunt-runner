// claim → argv de claude: validación local (nada del server acaba como flag) y flags por kind.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaudeArgs, type ClaudeArgsInput } from '../src/claude-args.js';
import { AWS_OUTFILE_COMMANDS, claimRunId, parseClaim } from '../src/claim.js';
import { mirrorBashAllow } from '../src/user-permissions.js';
import { OPTIONAL_FLAGS } from '../src/claude.js';
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
const argsFor = (claimRaw: Record<string, unknown>, over: Partial<ClaudeArgsInput> = {}): string[] =>
  buildClaudeArgs({
    claim: parseClaim(claimRaw),
    prompt: '-rf: un prompt que empieza por guion',
    mcpConfigFile: '/tmp/mcp.json',
    supported: allFlags,
    resumeSessionId: null,
    skipPermissions: false,
    payingWithApiKey: true,
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
  assert.equal(claimRunId(rawClaim({ branch: '--x' })), 88);
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
  assert.deepEqual(forced.tools.disallowed, ['WebFetch', 'Edit', 'Write', 'NotebookEdit', ...outfile]);
  assert.throws(() => parseClaim(rawClaim({}, { permissionMode: 'acceptEdits' })), /exige permission mode dontAsk/);
  // un run de reglas conserva el techo local de siempre.
  assert.equal(parseClaim(rawClaim({ kind: 'investigate', profile: undefined }, { permissionMode: 'default' })).permissionMode, 'default');
});

test('prompt run de lectura: settings solo del usuario (sin hooks ni settings del checkout) y mcp estricto', () => {
  const readRaw = rawClaim({ profile: 'read' }, { tools: { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['WebFetch'] } });
  const read = argsFor(readRaw);
  assert.deepEqual(read.slice(read.indexOf('--setting-sources'), read.indexOf('--setting-sources') + 2), ['--setting-sources', 'user']);
  assert.ok(read.includes('--strict-mcp-config'));
  assert.ok(read[read.indexOf('--disallowedTools') + 1].startsWith('WebFetch,Edit,Write,NotebookEdit,Bash(aws apigateway get-export*),'));
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

test('lectura: las reglas Bash del allow del usuario se espejan al deny, solo en read', () => {
  assert.deepEqual(mirrorBashAllow({ permissions: { allow: ['mcp__x__y', 'Bash(npm run test:*)', 'Read'] } }), ['Bash(npm run test:*)']);
  assert.deepEqual(mirrorBashAllow({ permissions: { allow: 'Bash' } }), []);
  assert.deepEqual(mirrorBashAllow(null), []);
  assert.deepEqual(mirrorBashAllow({ permissions: { allow: ['Bash(echo a,b)'] } }), ['Bash'], 'no cabe en argv: Bash entero');
  const read = argsFor(rawClaim({ profile: 'read' }, { tools: { allowed: ['Read'], disallowed: [] } }), { userBashDeny: ['Bash(npm run test:*)'] });
  assert.ok(read[read.indexOf('--disallowedTools') + 1].split(',').includes('Bash(npm run test:*)'));
  const edit = argsFor(rawClaim(), { userBashDeny: ['Bash(npm run test:*)'] });
  assert.ok(!edit[edit.indexOf('--disallowedTools') + 1].includes('npm'), 'edición conserva el allow del usuario');
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
