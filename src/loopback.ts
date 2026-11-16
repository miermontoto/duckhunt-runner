// receptor loopback del oauth (t#660, rfc 8252 §7.3): un servidor http en 127.0.0.1 y un puerto libre que recibe la
// vuelta del navegador tras aprobar (`/callback?code&state`), para que `login` no pida pegar nada.
// decisiones:
// - solo 127.0.0.1, nunca 0.0.0.0: el code no sale de la máquina. la uri se registra con su puerto (un server estricto
//   casa exacto; duckhunt deja el puerto libre en loopback).
// - state obligatorio y comparado: otra página local no puede colar un code suyo (inyección de login, rfc 6749
//   §10.12). uno que no casa recibe un 400 y se sigue esperando: no corta el login de la persona.
// - tras la vuelta el navegador va a `returnUrl` (la página de duckhunt, con `?connected=1` o `?error=`) y, sin ella
//   (otra plataforma), a una página mínima de aquí.
// - la promesa del resultado nunca rechaza: el error del authorize (access_denied) es un resultado más. cerrar sin
//   resultado (el code se pegó antes) la deja pendiente, y nadie la espera ya.

import crypto from 'node:crypto';
import http from 'node:http';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
// parámetro con el que la página de vuelta sabe que la máquina quedó conectada.
const CONNECTED_PARAM = 'connected';
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTML_TYPE = 'text/html; charset=utf-8';

/** lo que volvió del navegador: el code, o el error del authorize. */
export type LoopbackOutcome = { code: string } | { error: string };

export interface LoopbackReceiver {
  // la redirect_uri de esta escucha (con su puerto).
  redirectUri: string;
  outcome: Promise<LoopbackOutcome>;
  close: () => void;
}

// comparación en tiempo constante (el state es un secreto de este intento).
function sameState(got: string | null, want: string): boolean {
  if (got === null) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>duckhunt-runner</title><p style="font:16px system-ui;margin:3rem">${escapeHtml(text)}</p>`;

// adónde va el navegador tras la vuelta: la página de duckhunt con el resultado.
function returnTo(returnUrl: string, outcome: LoopbackOutcome): string {
  const url = new URL(returnUrl);
  if ('code' in outcome) url.searchParams.set(CONNECTED_PARAM, '1');
  else url.searchParams.set('error', outcome.error);
  return url.toString();
}

/** escucha en 127.0.0.1 en un puerto libre la vuelta del authorize con este `state` (ver cabecera). */
export function startLoopback(state: string, returnUrl?: string): Promise<LoopbackReceiver> {
  let settle: (outcome: LoopbackOutcome) => void = () => {};
  const outcome = new Promise<LoopbackOutcome>((resolve) => (settle = resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(HTTP_NOT_FOUND, { 'Content-Type': HTML_TYPE }).end(page('no encontrado'));
      return;
    }
    if (!sameState(url.searchParams.get('state'), state)) {
      res.writeHead(HTTP_BAD_REQUEST, { 'Content-Type': HTML_TYPE }).end(page('esta vuelta no es del login en curso: vuelve a la terminal.'));
      return;
    }
    const code = url.searchParams.get('code');
    const result: LoopbackOutcome = code ? { code } : { error: url.searchParams.get('error') ?? 'invalid_request' };
    res.once('finish', () => settle(result));
    if (returnUrl) {
      res.writeHead(HTTP_FOUND, { Location: returnTo(returnUrl, result) }).end();
    } else {
      res.writeHead('code' in result ? 200 : HTTP_BAD_REQUEST, { 'Content-Type': HTML_TYPE }).end(
        page('code' in result ? 'máquina conectada: ya puedes cerrar esta pestaña y volver a la terminal.' : `autorización denegada (${result.error}).`),
      );
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('loopback: el servidor no dio su puerto'));
        return;
      }
      resolve({
        redirectUri: `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`,
        outcome,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
