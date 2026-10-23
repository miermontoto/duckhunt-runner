// la tool de permisos de una conversación en edición (t#527, 0.15.0; el cable en vendor/runner-protocol/autonomy.ts):
// `duckhunt-runner mcp-permission`, el servidor stdio que el cli del run llama por --permission-prompt-tool cuando su
// nivel pregunta (manual siempre; auto tras las paradas de su clasificador). una sola tool, `prompt`: recibe lo que
// manda el cli ({tool_name, input, tool_use_id}) y responde el texto json que espera, {behavior: allow, updatedInput}
// o {behavior: deny, message}. el cli la esconde del modelo.
// - pregunta a la plataforma: POST a permissions.url (token per-run, PermissionPromptRequest) y, mientras la decisión
//   siga pendiente, GET <url>/<id>?wait=<waitMs> (consultas cortas, por debajo del corte del proxy) hasta una decisión
//   o el plazo: el ttl de la petición más un margen (al caducar deniega la plataforma; el margen cubre que no conteste).
// - red caída, 5xx y 429: reintento con espera exponencial acotada hasta el plazo. cualquier otro 4xx (401, 403, 404,
//   409…), una redirección (el token no la sigue) o un cuerpo que no es un PermissionPromptStatus: denegado con el
//   motivo. plazo vencido: denegado. un POST reintentado tras perder la respuesta puede llegar dos veces: la plataforma
//   lo reconoce por (run, segmento, toolUseId).
// - la entrada viaja recortada si su json pasa de PERMISSION_INPUT_MAX_CHARS (truncated: true): primero los textos
//   largos, con el mayor tope común que cabe; si ni así, { preview: <principio del json> }. al permitir vuelve la
//   entrada ORIGINAL entera en updatedInput: la plataforma nunca reescribe lo que ejecuta el cli.
// - SIEMPRE responde con una decisión, nunca lanza ni devuelve isError: un fallo propio es un deny con su motivo, y sin
//   config válida en su env deniega todo (lo dice en el motivo y en stderr).
// - atiende las llamadas a la vez (serveStdioMcp concurrent): una espera de minutos no bloquea un ping ni otra
//   petición. al cerrarse la entrada (el run terminó) sale sin esperar a las que quedaban.
// - el token per-run llega por el env, desde el mismo mcp-config 0600 que lo lleva en la cabecera del mcp de la
//   plataforma (run-mcp-config.ts::permissionMcpServers).

import { serveStdioMcp, type StdioCall, type StdioTool } from './mcp-stdio.js';
import {
  AGENT_PERMISSION_TOOL,
  PERMISSION_DECISION,
  PERMISSION_INPUT_MAX_CHARS,
  PERMISSION_MESSAGE_MAX_CHARS,
  PERMISSION_TOOL_NAME_MAX_CHARS,
  PERMISSION_TOOL_USE_ID_MAX_CHARS,
  type PermissionPromptRequest,
  type PermissionPromptStatus,
} from './vendor/runner-protocol/index.js';

/** subcomando oculto del runner que sirve la tool por stdio. */
export const PERMISSION_SUBCOMMAND = 'mcp-permission';
/** variables con las que el mcp-config del run configura el servidor. */
export const PERMISSION_ENV = {
  url: 'DUCKHUNT_PERMISSION_URL',
  token: 'DUCKHUNT_PERMISSION_TOKEN',
  segment: 'DUCKHUNT_PERMISSION_SEGMENT',
  ttlMs: 'DUCKHUNT_PERMISSION_TTL_MS',
  waitMs: 'DUCKHUNT_PERMISSION_WAIT_MS',
} as const;

/** dónde y cuánto preguntar (el bloque permissions del claim y el segmento). */
export interface PermissionToolConfig {
  url: string;
  token: string;
  segment: number;
  ttlMs: number;
  waitMs: number;
}

/** márgenes de la espera (inyectables en los tests). */
export interface PermissionTiming {
  // sobre el ttl, antes de dar la petición por perdida.
  graceMs: number;
  // espera entre reintentos y entre consultas que vuelven pendientes al momento: de min a max, doblando.
  retryMinMs: number;
  retryMaxMs: number;
  // de cada petición http sobre lo que pide esperar.
  requestMarginMs: number;
}
export const PERMISSION_TIMING: PermissionTiming = { graceMs: 30_000, retryMinMs: 1_000, retryMaxMs: 30_000, requestMarginMs: 15_000 };

/** lo que espera el cli de la tool. */
export type PermissionAnswer = { behavior: typeof PERMISSION_DECISION.allow; updatedInput: Record<string, unknown> } | { behavior: typeof PERMISSION_DECISION.deny; message: string };

export const PERMISSION_TOOL_DEF: StdioTool = {
  name: AGENT_PERMISSION_TOOL.tool,
  description: 'pide a la persona permiso para usar una tool (la llama el cli por --permission-prompt-tool; el modelo no la ve).',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

const SERVER_NAME = AGENT_PERMISSION_TOOL.server;
const LOG = '[runner:permission]';
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const WAIT_PARAM = 'wait';
// lo que se añade a un texto recortado, y la mitad alta de un par sustituto (no se parte).
const CUT_MARK = '…';
const HIGH_SURROGATE_RE = /[\ud800-\udbff]/;
// por debajo de este tope común los textos ya no dicen nada: mejor el principio del json.
const STRING_MIN_CHARS = 64;
const DENIED = {
  expired: 'nadie respondió a tiempo a la petición de permiso: denegada',
  byPerson: 'la persona denegó el permiso',
  invalidReply: 'la plataforma respondió a la petición de permiso con algo que no es su estado: denegada',
  badCall: 'la petición de permiso del cli llegó sin tool_name o sin una entrada válida: denegada',
} as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const deny = (message: string): PermissionAnswer => ({ behavior: PERMISSION_DECISION.deny, message: message.slice(0, PERMISSION_MESSAGE_MAX_CHARS) });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const posInt = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) && Number(v) > 0 && Number.isSafeInteger(Number(v)) ? Number(v) : null);

/** la config de su env. lanza con lo que falta. */
export function permissionConfigOf(env: NodeJS.ProcessEnv): PermissionToolConfig {
  const url = URL.parse(env[PERMISSION_ENV.url] ?? '');
  const token = env[PERMISSION_ENV.token] ?? '';
  const [segment, ttlMs, waitMs] = [PERMISSION_ENV.segment, PERMISSION_ENV.ttlMs, PERMISSION_ENV.waitMs].map((k) => posInt(env[k]));
  if (url === null || token === '' || segment === null || ttlMs === null || waitMs === null) {
    throw new Error(`sin config válida en ${Object.values(PERMISSION_ENV).join(', ')}`);
  }
  return { url: url.href, token, segment, ttlMs, waitMs };
}

// un texto cortado a `n` sin partir un par sustituto, con su marca.
const cutText = (s: string, n: number): string => {
  const end = n > 0 && HIGH_SURROGATE_RE.test(s.charAt(n - 1)) ? n - 1 : n;
  return `${s.slice(0, end)}${CUT_MARK}`;
};

// la entrada con cada texto de más de `cap` caracteres cortado (en cualquier nivel).
const capStrings = (v: unknown, cap: number): unknown => {
  if (typeof v === 'string') return v.length > cap ? cutText(v, cap) : v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, cap));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, cap)]));
  return v;
};

const longestString = (v: unknown): number => {
  if (typeof v === 'string') return v.length;
  const children = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [];
  return children.reduce<number>((max, x) => Math.max(max, longestString(x)), 0);
};

const jsonLength = (v: unknown): number => JSON.stringify(v).length;

/** la entrada tal como viaja a la plataforma (ver cabecera): entera si cabe; si no, recortada y marcada. */
export function fitPermissionInput(input: Obj, max: number = PERMISSION_INPUT_MAX_CHARS): { input: Obj; truncated: boolean } {
  if (jsonLength(input) <= max) return { input, truncated: false };
  // búsqueda binaria del mayor tope común de los textos con el que cabe (más tope = json más largo).
  let [lo, hi] = [STRING_MIN_CHARS, longestString(input) - 1];
  let best: Obj | null = null;
  while (lo <= hi) {
    const cap = Math.floor((lo + hi) / 2);
    const capped = capStrings(input, cap) as Obj;
    if (jsonLength(capped) <= max) {
      best = capped;
      lo = cap + 1;
    } else {
      hi = cap - 1;
    }
  }
  if (best !== null) return { input: best, truncated: true };
  // ni con los textos al mínimo: el principio del json entero, recortado hasta que su json quepa.
  const text = JSON.stringify(input);
  const previewOf = (n: number): Obj => ({ preview: cutText(text, n) });
  let n = max;
  while (n > 0 && jsonLength(previewOf(n)) > max) n -= jsonLength(previewOf(n)) - max;
  return { input: previewOf(n), truncated: true };
}

// el estado de una petición en una respuesta de la plataforma, o null si no lo es.
function statusOf(text: string): PermissionPromptStatus | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // un cuerpo que no es json no es un estado: lo decide quien llama (deniega).
    return null;
  }
  if (!isObj(v) || typeof v.id !== 'number' || !Number.isSafeInteger(v.id) || v.id <= 0) return null;
  const decision = v.decision === PERMISSION_DECISION.allow || v.decision === PERMISSION_DECISION.deny ? v.decision : v.decision === null ? null : undefined;
  if (decision === undefined || (v.message !== null && v.message !== undefined && typeof v.message !== 'string')) return null;
  return { id: v.id, decision, message: typeof v.message === 'string' ? v.message : null };
}

type Exchange = { status: PermissionPromptStatus } | { denied: string };

// una petición a la plataforma con sus reintentos hasta el plazo (ver cabecera).
async function exchange(cfg: PermissionToolConfig, timing: PermissionTiming, req: { url: URL; body?: PermissionPromptRequest; waitMs: number }, deadline: number): Promise<Exchange> {
  const method = req.body === undefined ? 'GET' : 'POST';
  // i/o secuencial: cada intento espera al anterior.
  for (let delay = timing.retryMinMs; Date.now() < deadline; delay = Math.min(delay * 2, timing.retryMaxMs)) {
    let reply: { ok: boolean; status: number; text: string } | null = null;
    try {
      const res = await fetch(req.url, {
        method,
        headers: { Authorization: `Bearer ${cfg.token}`, ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        // el token no sigue una redirección: un 3xx es una respuesta más (denegada).
        redirect: 'manual',
        signal: AbortSignal.timeout(req.waitMs + timing.requestMarginMs),
      });
      reply = { ok: res.ok, status: res.status, text: await res.text() };
    } catch (err) {
      console.error(`${LOG} ${method} de la petición de permiso falló (${(err as Error).message}): reintento`);
    }
    if (reply !== null && reply.status < HTTP_SERVER_ERROR && reply.status !== HTTP_TOO_MANY_REQUESTS) {
      if (!reply.ok) return { denied: `la plataforma rechazó la petición de permiso (HTTP ${reply.status}): denegada` };
      const status = statusOf(reply.text);
      return status !== null ? { status } : { denied: DENIED.invalidReply };
    }
    if (reply !== null) console.error(`${LOG} ${method} de la petición de permiso: HTTP ${reply.status}: reintento`);
    await sleep(Math.min(delay, deadline - Date.now()));
  }
  return { denied: DENIED.expired };
}

// la url de consulta de una petición: <url>/<id>?wait=<ms>.
const pollUrl = (base: string, id: number, waitMs: number): URL => {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${id}`;
  url.searchParams.set(WAIT_PARAM, String(waitMs));
  return url;
};

// la decisión de la plataforma, sin capturar nada (askPermission lo hace).
async function decide(args: Obj, cfg: PermissionToolConfig, timing: PermissionTiming): Promise<PermissionAnswer> {
  const { input } = args;
  const toolName = typeof args.tool_name === 'string' ? args.tool_name.slice(0, PERMISSION_TOOL_NAME_MAX_CHARS) : '';
  if (!isObj(input) || toolName === '') return deny(DENIED.badCall);
  const toolUseId = typeof args.tool_use_id === 'string' && args.tool_use_id !== '' && args.tool_use_id.length <= PERMISSION_TOOL_USE_ID_MAX_CHARS ? args.tool_use_id : null;
  const deadline = Date.now() + cfg.ttlMs + timing.graceMs;
  const fitted = fitPermissionInput(input);
  const body: PermissionPromptRequest = { segment: cfg.segment, toolName, input: fitted.input, truncated: fitted.truncated, toolUseId };
  let outcome = await exchange(cfg, timing, { url: new URL(cfg.url), body, waitMs: 0 }, deadline);
  // i/o secuencial: consulta tras consulta mientras siga pendiente.
  while ('status' in outcome && outcome.status.decision === null) {
    const { id } = outcome.status;
    const startedAt = Date.now();
    const waitMs = Math.max(0, Math.min(cfg.waitMs, deadline - startedAt));
    outcome = await exchange(cfg, timing, { url: pollUrl(cfg.url, id, waitMs), waitMs }, deadline);
    if ('status' in outcome && outcome.status.id !== id) outcome = { denied: DENIED.invalidReply };
    // una plataforma que contesta «pendiente» al momento no se consulta en bucle.
    if ('status' in outcome && outcome.status.decision === null) await sleep(Math.min(timing.retryMinMs - (Date.now() - startedAt), deadline - Date.now()));
  }
  if ('denied' in outcome) return deny(outcome.denied);
  return outcome.status.decision === PERMISSION_DECISION.allow
    ? { behavior: PERMISSION_DECISION.allow, updatedInput: input }
    : deny(outcome.status.message ?? DENIED.byPerson);
}

/** la respuesta a una llamada del cli (ver cabecera): nunca lanza; un fallo propio es un deny con su motivo. */
export async function askPermission(args: Obj, cfg: PermissionToolConfig, timing: PermissionTiming = PERMISSION_TIMING): Promise<PermissionAnswer> {
  try {
    return await decide(args, cfg, timing);
  } catch (err) {
    console.error(`${LOG} la petición de permiso falló: ${(err as Error).message}`);
    return deny(`la petición de permiso falló en el runner (${(err as Error).message}): denegada`);
  }
}

// la tool con la config del env; sin ella, un deny con el motivo en cada llamada.
function callFor(env: NodeJS.ProcessEnv): StdioCall {
  try {
    const cfg = permissionConfigOf(env);
    return async (_tool, args) => JSON.stringify(await askPermission(args, cfg));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`${LOG} ${message}: deniego todo`);
    return async () => JSON.stringify(deny(`la tool de permisos del runner no está configurada (${message}): denegada`));
  }
}

/** `duckhunt-runner mcp-permission`: el servidor stdio con la config de su env. */
export async function permissionMcpCommand(): Promise<void> {
  await serveStdioMcp({ name: SERVER_NAME, tools: [PERMISSION_TOOL_DEF], call: callFor(process.env), concurrent: true });
  // la entrada se cerró (el run terminó): lo que seguía esperando ya no tiene a quién responder.
  process.exit(0);
}
