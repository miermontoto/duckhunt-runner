// adjuntos de una conversación en la máquina (t#680): los ficheros que cita lo que la persona escribió, bajados por el
// daemon a una carpeta del run para que el agente los abra con sus tools de fichero, sea cual sea su backend. es una
// mejora sobre el camino base, que no pide nada al daemon: todo adjunto se lee también por mcp
// (duckhunt-attachment-read), así que un fallo de bajada nunca falla el segmento.
// decisiones:
// - el claim lleva `attachments` (tras `live`) solo a un daemon con RUNNER_CAPABILITY.attachments y solo si la
//   conversación cita alguno: la lista ENTERA de la conversación en cada claim (un segmento retomado conserva los suyos).
// - el daemon los baja con su credencial de GET /api/runner/runs/:runId/attachments/:id (el cuerpo son los bytes; misma
//   puerta que el feed: run vivo y de esa máquina) a `<carpeta del run>/<id>-<name>`, verifica `size` y `sha256` y no
//   vuelve a bajar lo que ya tiene con ese hash. `name` llega saneado (un solo tramo, sin separadores); el daemon lo
//   re-valida y descarta la entrada que no lo cumpla.
// - la carpeta es por conversación, fuera de todo checkout y de lo que el kit de lectura niega, y se borra con el
//   worktree conv-<id> de la conversación. otra conversación no la lee.
// - el prompt lo escribe el server y no conoce rutas de la máquina: nombra la carpeta con RUN_ATTACHMENTS_DIR_TOKEN y el
//   daemon sustituye cada aparición (en `prompt` y `fallbackPrompt`) por su ruta absoluta. sin el bloque no hay token.
// - el contenido de un adjunto es dato: el daemon nunca lo ejecuta ni lo interpreta.
// non-goals: subir ficheros del agente (van por mcp), los mensajes que llegan en vivo por el buzón (sus adjuntos se
// leen por mcp hasta el siguiente claim).

/** ruta de un adjunto bajo /api/runner/runs/:runId (cable legacy): `${RUNNER_RUN_ATTACHMENTS_PATH}/<id>`. */
export const RUNNER_RUN_ATTACHMENTS_PATH = '/attachments';
// adjuntos por claim y bytes de cada uno (el tope de una subida del server); lo que pase se queda en el camino mcp.
export const RUN_ATTACHMENTS_MAX = 20;
export const RUN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
// largo máximo del nombre saneado.
export const RUN_ATTACHMENT_NAME_MAX_CHARS = 120;
/** forma de un nombre de adjunto en el cable: un tramo, sin separadores ni punto inicial. */
export const RUN_ATTACHMENT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** lo que el prompt lleva en lugar de la carpeta de adjuntos del run: el daemon lo sustituye por su ruta absoluta. */
export const RUN_ATTACHMENTS_DIR_TOKEN = '<<duckhunt:attachments-dir>>';

/** un adjunto de la conversación en el claim. */
export interface LegacyClaimAttachment {
  // id del adjunto en duckhunt (el de su ruta de bajada y el que el agente pasa a duckhunt-attachment-read).
  id: number;
  // nombre saneado (RUN_ATTACHMENT_NAME_RE): el fichero local es `<id>-<name>`.
  name: string;
  size: number;
  // hex, de los bytes que sirve la ruta de bajada.
  sha256: string;
}

/** bloque `attachments` del claim: los ficheros de la conversación que el daemon deja en la carpeta del run. */
export interface LegacyClaimAttachments {
  files: LegacyClaimAttachment[];
}
