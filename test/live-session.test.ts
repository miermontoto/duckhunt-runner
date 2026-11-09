// sesión viva de claude (t#636, fase 2): el prompt como primer mensaje, la cuenta de tareas y cuándo se cierra stdin.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { StreamLine } from '../src/claude.js';
import { LiveSession, userMessageLine } from '../src/live-session.js';

// un stdin de mentira que guarda lo escrito y si se cerró.
function stdin(): { stream: PassThrough; lines: () => unknown[]; ended: () => boolean } {
  const stream = new PassThrough();
  let text = '';
  let ended = false;
  stream.on('data', (d: Buffer) => (text += d.toString()));
  stream.on('end', () => (ended = true));
  stream.on('finish', () => (ended = true));
  return { stream, lines: () => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown), ended: () => ended };
}

const result = (over: Partial<StreamLine> = {}): StreamLine => ({ type: 'result', subtype: 'success', is_error: false, ...over });
const started = (id: string): StreamLine => ({ type: 'system', subtype: 'task_started', task_id: id });
const notified = (id: string): StreamLine => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' });
const said = (parent?: string): StreamLine => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] }, ...(parent ? { parent_tool_use_id: parent } : {}) });

test('el prompt va como primer mensaje y un result sin tareas cierra stdin', () => {
  const s = stdin();
  const live = new LiveSession(s.stream, { wakeGraceMs: 10_000, silenceMaxMs: 10_000 });
  live.start('hola');
  assert.deepEqual(s.lines(), [JSON.parse(userMessageLine('hola'))]);
  live.observe(said());
  assert.equal(live.open, true);
  live.observe(result());
  assert.equal(live.open, false);
});

test('con un subagente en segundo plano sigue abierto, atiende la orden de parar y cierra en el result que ya no deja tareas', () => {
  const s = stdin();
  const live = new LiveSession(s.stream, { wakeGraceMs: 10_000, silenceMaxMs: 10_000 });
  live.start('reparte');
  live.observe(started('bg1'));
  live.observe(result());
  assert.equal(live.open, true, 'una tarea en marcha lo retiene');
  assert.equal(live.command({ id: 'c1', kind: 'stop_task', taskId: 'bg1' }), true);
  assert.deepEqual(s.lines().at(-1), { type: 'control_request', request_id: 'c1', request: { subtype: 'stop_task', task_id: 'bg1' } });
  live.observe(notified('bg1'));
  live.observe(said('toolu_x'));
  assert.equal(live.open, true, 'lo que dice un subagente no despierta al principal');
  live.observe(said());
  live.observe(result());
  assert.equal(live.open, false);
  assert.equal(live.command({ id: 'c2', kind: 'stop_task', taskId: 'bg1' }), false, 'cerrado, nadie la atiende');
});

test('un result con error cierra aunque queden tareas', () => {
  const s = stdin();
  const live = new LiveSession(s.stream, { wakeGraceMs: 10_000, silenceMaxMs: 10_000 });
  live.observe(started('bg1'));
  live.observe(result({ is_error: true }));
  assert.equal(live.open, false);
});

test('si el principal no despierta tras su última tarea, o la tarea no avisa nunca, se cierra igual', async () => {
  const a = stdin();
  const woke = new LiveSession(a.stream, { wakeGraceMs: 20, silenceMaxMs: 10_000 });
  woke.observe(started('bg1'));
  woke.observe(result());
  woke.observe(notified('bg1'));
  assert.equal(woke.open, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(woke.open, false, 'la gracia para despertar venció');
  const b = stdin();
  const silent = new LiveSession(b.stream, { wakeGraceMs: 10_000, silenceMaxMs: 20 });
  silent.observe(started('bg1'));
  silent.observe(result());
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(silent.open, false, 'el tope de silencio venció');
});
