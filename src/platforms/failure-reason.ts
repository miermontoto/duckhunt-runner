// el motivo de una respuesta http fallida en UNA línea corta para el log (t#617), siempre con su status: el
// `{ error: "<mensaje>" }` de duckhunt, el sobre de v0 (`{ error: { code, message } }`) o un cuerpo de texto (el
// `error code: 1015` de un cdn). una página html o xml, o un json sin motivo, salen como el status con su content-type
// y su tamaño, nunca el cuerpo: durante un deploy el proxy contesta 502 con una página html entera, que llenaba el log.

// largo del mensaje del server en el log (sin saltos de línea ni espacios repetidos).
export const FAILURE_MESSAGE_MAX_CHARS = 300;
const WHITESPACE_RE = /\s+/g;
const ELLIPSIS = '…';
// separador del code y el message del sobre de v0.
const ENVELOPE_SEPARATOR = ': ';
// marcado (html, xml): por su content-type o porque el cuerpo empieza por una etiqueta aunque no lo declare.
const MARKUP_TYPE_RE = /html|xml/i;
const MARKUP_BODY_RE = /^\s*</;
// el cuerpo no era json.
const NOT_JSON = Symbol('not-json');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// el texto en una línea y acotado.
const short = (text: string): string => {
  const flat = text.replace(WHITESPACE_RE, ' ').trim();
  return flat.length > FAILURE_MESSAGE_MAX_CHARS ? `${flat.slice(0, FAILURE_MESSAGE_MAX_CHARS)}${ELLIPSIS}` : flat;
};

// el cuerpo como json, o NOT_JSON (html, texto, vacío).
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
};

// el motivo de un json: el error de duckhunt o las piezas del sobre de v0 que traiga (code, message); '' sin ninguno.
const jsonMessage = (body: unknown): string => {
  const error = isObj(body) ? body.error : undefined;
  if (typeof error === 'string') return error;
  if (!isObj(error)) return '';
  return [error.code, error.message]
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .filter((s) => s.trim() !== '')
    .join(ENVELOPE_SEPARATOR);
};

// el motivo legible del cuerpo, o '' si no lo trae (marcado, vacío, json sin error).
const bodyMessage = (text: string, type: string | null): string => {
  const body = jsonOf(text);
  if (body !== NOT_JSON) return jsonMessage(body);
  return MARKUP_TYPE_RE.test(type ?? '') || MARKUP_BODY_RE.test(text) ? '' : text;
};

/** lee UNA vez el cuerpo de una respuesta fallida y devuelve su motivo en una línea corta (ver cabecera). nunca lanza. */
export async function failureReason(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return `http ${res.status} (cuerpo ilegible: ${short((err as Error).message)})`;
  }
  const type = res.headers.get('content-type');
  const message = short(bodyMessage(text, type));
  if (message) return `http ${res.status}: ${message}`;
  return `http ${res.status} (${type ? short(type) : 'sin content-type'}, ${Buffer.byteLength(text)} B)`;
}
