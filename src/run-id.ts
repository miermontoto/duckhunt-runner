// id de un run (t#495, M1): opaco por dentro del runner. el cable legacy de duckhunt (contrato 42) lo manda y
// lo espera como entero positivo; el de spec v0 lo mandará como texto opaco. por dentro todo es texto que
// cumple RUN_ID_RE (vale como trozo de nombre de fichero y de directorio: conv-<id>, run-<id>, mcp-<id>-…,
// aws-<id>-…, logs/<id>.jsonl) y la conversión a número vive en UN sitio, en la frontera del cable legacy.
// decisiones:
// - parseClaim acepta hoy solo el id numérico legacy y lo pasa a texto con String(): el cable no cambia ni un
//   byte (las rutas /runs/<id> salen con el mismo texto y los cuerpos que llevan ids siguen llevando números).
// - un id no numérico NUNCA llega al cable legacy: legacyWireRunId lanza (un fallo ruidoso, no un NaN que viaje
//   en silencio). quien junta ids para ese cable filtra antes con isLegacyRunId y decide qué hace con el resto.

export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// id del cable legacy: entero positivo en decimal, sin ceros a la izquierda (lo que String() da de él).
const LEGACY_RUN_ID_RE = /^[1-9]\d*$/;

/** id de run de un claim legacy (entero positivo) como texto, o null si no lo es. */
export function runIdFromLegacy(v: unknown): string | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : null;
}

/** ¿cabe este id en el cable legacy? (el texto de un entero positivo seguro). */
export function isLegacyRunId(id: string): boolean {
  return LEGACY_RUN_ID_RE.test(id) && Number.isSafeInteger(Number(id));
}

/** el id como número para un cuerpo del cable legacy. lanza si no cabe: un id opaco nunca debe llegar aquí. */
export function legacyWireRunId(id: string): number {
  if (!isLegacyRunId(id)) throw new Error(`id de run "${id}" no cabe en el cable legacy (entero positivo)`);
  return Number(id);
}

/** orden estable de ids: los numéricos por valor (el orden que el cable legacy ya mandaba), el resto detrás por texto. */
export function compareRunIds(a: string, b: string): number {
  const [legacyA, legacyB] = [isLegacyRunId(a), isLegacyRunId(b)];
  if (legacyA && legacyB) return Number(a) - Number(b);
  if (legacyA !== legacyB) return legacyA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
