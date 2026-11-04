// el motivo de un http de error en una línea (t#617): el `{ error }` de duckhunt, el sobre de v0, y con cualquier otra
// cosa (la página html del proxy durante un deploy, texto, vacío) el status, el content-type y el tamaño, sin el cuerpo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAILURE_MESSAGE_MAX_CHARS, failureReason } from '../src/platforms/failure-reason.js';

const HTML = 'text/html; charset=UTF-8';

test('una página html (el 502 del proxy): status, content-type y tamaño, nunca el cuerpo', async () => {
  const page = `<!DOCTYPE html>\n<html>\n<head><title>502 Bad Gateway</title></head>\n${'<div class="cf-error">bad gateway</div>\n'.repeat(120)}</html>\n`;
  const reason = await failureReason(new Response(page, { status: 502, headers: { 'content-type': HTML } }));
  assert.equal(reason, `http 502 (${HTML}, ${Buffer.byteLength(page)} B)`);
  assert.doesNotMatch(reason, /[<\n]|Bad Gateway/);
});

test('el error de duckhunt: http <status>: <mensaje>, en una línea', async () => {
  assert.equal(await failureReason(Response.json({ error: 'String must contain at most 512000 character(s)' }, { status: 400 })), 'http 400: String must contain at most 512000 character(s)');
  assert.equal(await failureReason(Response.json({ error: 'línea uno\n\n   línea\tdos ', traceId: 'abc' }, { status: 500 })), 'http 500: línea uno línea dos');
});

test('el sobre de v0: <code>: <message>, como siempre', async () => {
  const res = Response.json({ error: { code: 'resource_not_exposed', message: 'grant de repo acme/api: no está expuesto' } }, { status: 409 });
  assert.equal(await failureReason(res), 'resource_not_exposed: grant de repo acme/api: no está expuesto');
  assert.equal(await failureReason(Response.json({ error: {} }, { status: 400 })), 'undefined: undefined');
});

test('sin cuerpo, texto o un json sin error: el status con su content-type y su tamaño', async () => {
  assert.equal(await failureReason(new Response(null, { status: 502 })), 'http 502 (sin content-type, 0 B)');
  assert.equal(await failureReason(new Response('boom', { status: 500 })), 'http 500 (text/plain;charset=UTF-8, 4 B)');
  assert.equal(await failureReason(Response.json({ ok: false }, { status: 503 })), 'http 503 (application/json, 12 B)');
  assert.equal(await failureReason(Response.json(['x'], { status: 503 })), 'http 503 (application/json, 5 B)');
});

test('un mensaje enorme se acota; un cuerpo que no se puede leer no lanza', async () => {
  const reason = await failureReason(Response.json({ error: `inicio ${'x'.repeat(10_000)}` }, { status: 400 }));
  assert.ok(reason.startsWith('http 400: inicio x'));
  assert.equal(reason.length, 'http 400: '.length + FAILURE_MESSAGE_MAX_CHARS + 1, 'el mensaje acotado y su elipsis');
  assert.ok(reason.endsWith('…'));
  const broken = new ReadableStream({ start: (c) => c.error(new Error('conexión cortada')) });
  assert.equal(await failureReason(new Response(broken, { status: 502 })), 'http 502 (cuerpo ilegible: conexión cortada)');
});
