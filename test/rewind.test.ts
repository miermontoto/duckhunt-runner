// volver atrás (0.17.0, t#564): el uuid del último mensaje del asistente en el stream y en el status, run.resumeAt y
// restore en el claim (validados: van al argv y a git), los flags del fork solo tras --resume y con un cli que los
// acepta, las capabilities por versión y la restauración del worktree contra un repo git real (lo cambiado vuelve,
// lo creado se va, lo ignorado no se toca, el índice queda en HEAD; con HEAD movido o la foto perdida, nada).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { announcedCapabilities } from '../src/announced-capabilities.js';
import { buildClaudeArgs } from '../src/claude-args.js';
import { consumeStreamLine, newStreamState, OPTIONAL_FLAGS, supportsRewind } from '../src/claude.js';
import { parseClaim } from '../src/claim.js';
import { headOf, restoreTree } from '../src/rewind-files.js';
import { reportFor } from '../src/status-report.js';
import { scrubEnv } from '../src/scrub-env.js';
import { snapshotTree } from '../src/turn-changes.js';
import { REWIND_CLI_MIN_VERSION, RUNNER_CAPABILITY } from '../src/vendor/runner-protocol/index.js';

const UUID = '8f14e45f-ceea-467a-9bb4-1f6c2d1e0a77';
const SESSION = '3c48e740-4128-4241-911a-7600042c8581';
const TREE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const rawClaim = (run: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  run: { id: 88, kind: 'prompt', entryId: 5, workspaceId: 1, repo: 'okt/app', branch: null, repoSource: 'explicit', repoAvailable: true, aws: null, sessionId: SESSION, parentRunId: null, profile: 'edit', segment: 3, ...run },
  prompt: 'segundo, mejor',
  fallbackPrompt: 'empieza de cero',
  tier: 'act',
  tools: { allowed: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'], disallowed: ['WebFetch'] },
  permissionMode: 'dontAsk',
  maxTurns: null,
  maxBudgetUsd: null,
  timeoutMs: 1_800_000,
  heartbeatMs: 20_000,
  events: null,
  mcp: { serverName: 'duckhunt', url: 'https://duckhunt.info/mcp', token: 'dho_x', expiresAt: 1 },
  ...extra,
});

const args = (raw: Record<string, unknown>, over: { resumeSessionId?: string | null; rewind?: boolean } = {}): string[] => {
  const claim = parseClaim(raw);
  return buildClaudeArgs({
    claim,
    prompt: claim.prompt,
    mcpConfigFile: '/tmp/mcp.json',
    supported: new Set(OPTIONAL_FLAGS),
    resumeSessionId: over.resumeSessionId === undefined ? claim.run.sessionId : over.resumeSessionId,
    skipPermissions: false,
    payingWithApiKey: false,
    runConfigDeny: ['Read(//tmp/run-config/**)'],
    resumeAt: claim.run.resumeAt,
    rewind: over.rewind ?? true,
  });
};

test('el stream guarda el uuid del último mensaje del asistente y el status lo lleva', () => {
  const state = newStreamState();
  consumeStreamLine(state, JSON.stringify({ type: 'assistant', uuid: '11111111-2222-4333-8444-555555555555', message: { content: [] } }));
  consumeStreamLine(state, JSON.stringify({ type: 'assistant', uuid: UUID, message: { content: [{ type: 'text', text: 'hecho' }] } }));
  // un uuid sin forma (o de otro evento) no lo pisa.
  consumeStreamLine(state, JSON.stringify({ type: 'assistant', uuid: '--fork', message: { content: [] } }));
  consumeStreamLine(state, JSON.stringify({ type: 'user', uuid: '99999999-2222-4333-8444-555555555555', message: { content: [] } }));
  consumeStreamLine(state, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION }));
  assert.equal(state.lastAssistantUuid, UUID);
  const report = reportFor({ exitCode: 0, killedBy: null, stream: state, stderrTail: '' }, true);
  assert.deepEqual([report.status, report.lastMessageUuid], ['done', UUID]);
  assert.equal(reportFor({ exitCode: 1, killedBy: null, stream: newStreamState(), stderrTail: '' }, undefined).lastMessageUuid, undefined);
});

test('claim: resumeAt con su sesión y forma de uuid; restore solo en una edición con repo en su worktree', () => {
  assert.equal(parseClaim(rawClaim({ resumeAt: UUID })).run.resumeAt, UUID);
  assert.equal(parseClaim(rawClaim()).run.resumeAt, null, 'server anterior');
  assert.throws(() => parseClaim(rawClaim({ resumeAt: '--dangerously-skip-permissions' })), /resumeAt/);
  assert.throws(() => parseClaim(rawClaim({ resumeAt: UUID, sessionId: null })), /sin sesión/);
  assert.deepEqual(parseClaim(rawClaim({}, { restore: { tree: TREE, head: HEAD } })).restore, { tree: TREE, head: HEAD });
  assert.equal(parseClaim(rawClaim()).restore, undefined);
  assert.throws(() => parseClaim(rawClaim({}, { restore: { tree: 'HEAD~1', head: HEAD } })), /restore/);
  assert.throws(() => parseClaim(rawClaim({ isolation: 'checkout' }, { restore: { tree: TREE, head: HEAD } })), /worktree/, 'nunca el checkout');
  const readKit = { tools: { allowed: ['Read', 'Grep', 'Glob'], disallowed: ['WebFetch'] } };
  assert.throws(() => parseClaim(rawClaim({ profile: 'read' }, { ...readKit, restore: { tree: TREE, head: HEAD } })), /edición/);
  assert.throws(() => parseClaim(rawClaim({ repo: null }, { restore: { tree: TREE, head: HEAD } })), /repo/);
});

test('argv: el fork solo tras --resume; sin un cli que sepa, el turno no se lanza', () => {
  const forked = args(rawClaim({ resumeAt: UUID }));
  const at = forked.indexOf('--resume');
  assert.deepEqual(forked.slice(at, at + 5), ['--resume', SESSION, '--resume-session-at', UUID, '--fork-session']);
  assert.ok(forked.indexOf('--fork-session') < forked.indexOf('--'), 'antes del prompt');
  const fresh = args(rawClaim({ resumeAt: UUID }), { resumeSessionId: null });
  assert.ok(!fresh.includes('--resume-session-at') && !fresh.includes('--fork-session'), 'el reintento desde cero no lo lleva');
  assert.ok(!args(rawClaim()).includes('--fork-session'));
  assert.throws(() => args(rawClaim({ resumeAt: UUID }), { rewind: false }), /--resume-session-at/);
});

test('capabilities: rewind y rewind_files con prompt y un cli desde la versión mínima', () => {
  const kit = (claudeVersion: string | null) => ({ hasAws: false, supported: new Set(OPTIONAL_FLAGS), claudeVersion });
  const has = (v: string | null) => announcedCapabilities(kit(v)).filter((c) => c === RUNNER_CAPABILITY.rewind || c === RUNNER_CAPABILITY.rewindFiles);
  assert.deepEqual(has(`${REWIND_CLI_MIN_VERSION} (Claude Code)`), [RUNNER_CAPABILITY.rewind, RUNNER_CAPABILITY.rewindFiles]);
  assert.deepEqual(has('2.1.310 (Claude Code)'), []);
  assert.deepEqual(has(null), []);
  assert.equal(supportsRewind('2.2.0'), true);
  assert.deepEqual(announcedCapabilities({ ...kit('2.2.0'), supported: new Set() }).filter((c) => c === RUNNER_CAPABILITY.rewind), [], 'sin prompt no hay conversación');
});

// --- restaurar los ficheros, contra un repo real ---

const env: NodeJS.ProcessEnv = {
  ...scrubEnv(process.env),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env, encoding: 'utf-8' }).trim();
const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

// checkout con un commit y el worktree de una conversación encima (como conv-<id>).
function worktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-rewind-'));
  roots.push(dir);
  const main = path.join(dir, 'checkout');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(main, 'gone.ts'), 'export const gone = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(dir, 'conv-1');
  git(main, 'worktree', 'add', '-q', '-b', 'conv', wt);
  return wt;
}
const read = (wt: string, f: string): string | null => (fs.existsSync(path.join(wt, f)) ? fs.readFileSync(path.join(wt, f), 'utf8') : null);

test('restaurar: lo cambiado vuelve, lo creado se va, lo borrado reaparece; lo ignorado no se toca y el índice queda en HEAD', async () => {
  const wt = worktree();
  // el turno 1 deja un fichero sin commitear: la foto con la que empieza el 2 lo incluye.
  fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 1;\n');
  const tree = await snapshotTree(wt, env);
  const head = await headOf(wt, env);
  assert.ok(tree && head);
  // el turno 2 (el que se descarta): cambia, crea, borra, prepara para commit y toca algo ignorado.
  fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(wt, 'src'));
  fs.writeFileSync(path.join(wt, 'src', 'nuevo.ts'), 'export const n = 1;\n');
  fs.rmSync(path.join(wt, 'gone.ts'));
  fs.mkdirSync(path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'dep.js'), 'x\n');
  git(wt, 'add', 'a.ts');
  await restoreTree(wt, env, { tree, head });
  assert.deepEqual(
    ['a.ts', 'b.ts', 'gone.ts', 'src/nuevo.ts', 'node_modules/dep.js'].map((f) => read(wt, f)),
    ['export const a = 1;\n', 'export const b = 1;\n', 'export const gone = 1;\n', null, 'x\n'],
  );
  assert.equal(await snapshotTree(wt, env), tree, 'el árbol es el de la foto');
  assert.equal(git(wt, 'diff', '--cached', '--name-only'), '', 'nada preparado de lo descartado');
  assert.equal(git(wt, 'status', '--porcelain'), '?? b.ts', 'lo del turno 1 sigue como estaba: sin commitear');
});

test('restaurar: con HEAD movido o la foto perdida no toca nada', async () => {
  const wt = worktree();
  const tree = (await snapshotTree(wt, env))!;
  const head = (await headOf(wt, env))!;
  fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 2;\n');
  git(wt, 'commit', '-q', '-am', 'el agente commitea');
  fs.writeFileSync(path.join(wt, 'c.ts'), 'export const c = 1;\n');
  await assert.rejects(restoreTree(wt, env, { tree, head }), /HEAD cambió/);
  assert.equal(read(wt, 'c.ts'), 'export const c = 1;\n');
  const moved = (await headOf(wt, env))!;
  await assert.rejects(restoreTree(wt, env, { tree: 'c'.repeat(40), head: moved }), /ya no está/);
  assert.deepEqual([read(wt, 'a.ts'), read(wt, 'c.ts')], ['export const a = 2;\n', 'export const c = 1;\n']);
});
