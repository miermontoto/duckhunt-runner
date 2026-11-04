// el motivo de una respuesta http fallida en UNA línea corta para el log (t#617): el `{ error: "<mensaje>" }` de
// duckhunt, el sobre de v0 (`{ error: { code, message } }`) o, con cualquier otra cosa, el status con su content-type
// y su tamaño, nunca el cuerpo: durante un deploy el proxy contesta 502 con una página html entera, que llenaba el log.

// largo del mensaje del server en el log (sin saltos de línea ni espacios repetidos).
export const FAILURE_MESSAGE_MAX_CHARS = 300;
const WHITESPACE_RE = /\s+/g;
const ELLIPSIS = '…';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// el texto en una línea y acotado.
const short = (text: string): string => {
  const flat = text.replace(WHITESPACE_RE, ' ').trim();
  return flat.length > FAILURE_MESSAGE_MAX_CHARS ? `${flat.slice(0, FAILURE_MESSAGE_MAX_CHARS)}${ELLIPSIS}` : flat;
};

// el cuerpo como json, o null si no lo es (html, texto, vacío): entonces no trae un motivo legible.
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** lee UNA vez el cuerpo de una respuesta fallida y devuelve su motivo en una línea corta (ver cabecera). nunca lanza. */
export async function failureReason(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return `http ${res.status} (cuerpo ilegible: ${short((err as Error).message)})`;
  }
  const body = jsonOf(text);
  const error = isObj(body) ? body.error : undefined;
  if (typeof error === 'string') return `http ${res.status}: ${short(error)}`;
  if (isObj(error)) return short(`${String(error.code)}: ${String(error.message)}`);
  const type = res.headers.get('content-type');
  return `http ${res.status} (${type ? short(type) : 'sin content-type'}, ${Buffer.byteLength(text)} B)`;
}
