// subida del feed: seq monotónico desde nextSeq, lotes, reintento acotado y parada con 409.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENTS_DEFAULTS, type EventsConfig } from '../src/claim.js';
import { EventUploader, type SeqEvent } from '../src/event-uploader.js';

// flushMs alto: los tests controlan cuándo se sube (flushCount o close()).
const cfg = (over: Partial<EventsConfig> = {}): EventsConfig => ({ ...EVENTS_DEFAULTS, enabled: true, flushMs: 60_000, ...over });
const ev = (body: string) => ({ kind: 'text' as const, body });

test('numera desde nextSeq y sube en lotes de batchMax al cerrar', async () => {
  const batches: SeqEvent[][] = [];
  const up = new EventUploader(async (events) => (batches.push(events), 200), cfg({ nextSeq: 7, flushCount: 100, batchMax: 2 }), 'run 1');
  ['a', 'b', 'c'].forEach((b) => up.push(ev(b)));
  await up.close();
  assert.deepEqual(
    batches.map((b) => b.map((e) => e.seq)),
    [[7, 8], [9]],
  );
  // tras cerrar no se encola nada más.
  up.push(ev('d'));
  assert.equal(batches.flat().length, 3);
});

test('flushCount dispara la subida sin esperar al tick', async () => {
  const batches: SeqEvent[][] = [];
  const up = new EventUploader(async (events) => (batches.push(events), 200), cfg({ flushCount: 2 }), 'run 2');
  up.push(ev('a'));
  up.push(ev('b'));
  await up.flush();
  assert.equal(batches.length, 1);
  await up.close();
});

test('reintento acotado: un lote que siempre falla se descarta y el resto no retiene el cierre', async () => {
  let calls = 0;
  const up = new EventUploader(
    async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    },
    cfg({ flushCount: 100, batchMax: 1 }),
    'run 3',
  );
  ['a', 'b', 'c'].forEach((b) => up.push(ev(b)));
  await up.close();
  // 3 intentos del primer lote; los otros dos se descartan sin intentarlo.
  assert.equal(calls, 3);
});

test('un fallo transitorio se reintenta y el lote llega', async () => {
  const statuses = [503, 200];
  const seen: number[][] = [];
  const up = new EventUploader(
    async (events) => {
      seen.push(events.map((e) => e.seq));
      return statuses.shift() ?? 200;
    },
    cfg({ flushCount: 100 }),
    'run 4',
  );
  up.push(ev('a'));
  await up.close();
  assert.deepEqual(seen, [[1], [1]]);
});

test('409 = run cerrado: se para y no vuelve a llamar', async () => {
  let calls = 0;
  const up = new EventUploader(async () => (calls++, 409), cfg({ flushCount: 100, batchMax: 1 }), 'run 5');
  ['a', 'b'].forEach((b) => up.push(ev(b)));
  await up.close();
  assert.equal(calls, 1);
});
