// adjuntos de una conversación en la máquina (t#680, attachments.ts del protocolo): el daemon baja los ficheros que cita
// la conversación a una carpeta del run y sustituye RUN_ATTACHMENTS_DIR_TOKEN del prompt por su ruta, sea cual sea el
// backend: el driver solo ve un prompt con una ruta y abre los ficheros con sus tools. es una mejora sobre el camino base
// (duckhunt-attachment-read por mcp), así que nada de aquí falla el segmento: lo que no baja se anota y se sigue.
// decisiones:
// - la carpeta es <platformHome>/attachments/<runId>/ (paths.ts), 0700, fuera de todo checkout, del run-config y del
//   scratch. el deny de todo kit niega las de las demás conversaciones y plataformas (secret-paths.ts::attachmentsDeny).
//   no es un --add-dir: los kits permiten Read/Grep/Glob sin ruta, que llegan a todo lo no negado, y --add-dir va con
//   multi_repo y abriría la carpeta también a la shell.
// - cada fichero es `<id>-<name>`: se baja a un `.part` oculto (un nombre del cable nunca empieza por punto) creado en
//   exclusiva (un symlink que dejara ahí el agente no se sigue), se mide y se hashea al vuelo (corta al pasar de `size`) y
//   solo con size y sha256 iguales se renombra a su sitio. uno que ya está con ese hash no se vuelve a bajar.
// - la carpeta refleja la lista del claim (la entera de la conversación): un adjunto que ya no está, o que no casa, se
//   borra. solo lo que tiene forma de adjunto o de bajada a medias: lo que escriba el agente se queda hasta el barrido.
// - i/o secuencial: hasta RUN_ATTACHMENTS_MAX ficheros por claim, uno tras otro, sin cargar el server.
// - cada claim con el bloque toca la carpeta: el barrido de conversaciones (daemon.ts::collectWorktrees) cuenta su
//   inactividad desde ahí y la borra con la conversación cerrada, haya o no worktree (una sin repo no lo tiene).
// - el contenido es dato: nunca se ejecuta ni se interpreta.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ClaimResponse } from './claim.js';
import { attachmentsRoot } from './paths.js';
import type { AttachmentFetch } from './platforms/platform.js';
import { RUN_ID_RE } from './run-id.js';
import { RUN_ATTACHMENTS_DIR_TOKEN, type LegacyClaimAttachment } from './vendor/runner-protocol/index.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// la bajada a medias de `<id>-<name>`: `.<id>-<name>.part`.
const PART_PREFIX = '.';
const PART_SUFFIX = '.part';
// lo que el daemon escribe en la carpeta (un adjunto o su bajada a medias); el resto no es suyo.
const OWN_FILE_RE = /^\.?[1-9][0-9]*-.+$/;

/** cómo se piden los bytes de un adjunto a la plataforma del run (null = no los sirve). */
export type AttachmentFetcher = ((id: number, signal: AbortSignal) => Promise<AttachmentFetch>) | null;

/** lo que dejó una sincronización: cuántos están en la carpeta y cuántos no se pudieron bajar. */
export interface AttachmentsSync {
  ready: number;
  failed: number;
}

/** una carpeta de adjuntos en disco, con la forma de un candidato del barrido (resources/repo/gc.ts). */
export interface AttachmentFolder {
  kind: 'conversation';
  runId: string;
  dir: string;
  lastUsedAt: number;
}

/** nombre local de un adjunto en la carpeta del run. */
export const attachmentFileName = (a: Pick<LegacyClaimAttachment, 'id' | 'name'>): string => `${a.id}-${a.name}`;

const partName = (a: LegacyClaimAttachment): string => `${PART_PREFIX}${attachmentFileName(a)}${PART_SUFFIX}`;

// entradas de `dir`, vacío si no existe.
function listed(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
}

// ¿ya está con su tamaño y su hash? un symlink o lo que no sea un fichero, no.
async function hasContent(file: string, a: LegacyClaimAttachment): Promise<boolean> {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size !== a.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex') === a.sha256;
}

// cuenta y hashea lo que pasa; corta en cuanto pasa de `max` bytes.
function meter(max: number): { stream: Transform; bytes(): number; digest(): string } {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
      bytes += chunk.length;
      if (bytes > max) return done(new Error(`más de los ${max} bytes anunciados`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { stream, bytes: () => bytes, digest: () => hash.digest('hex') };
}

// un adjunto en su sitio: null si está (ya estaba o se bajó y casa), o el motivo de que no.
async function place(a: LegacyClaimAttachment, dir: string, fetch: AttachmentFetcher, signal: AbortSignal): Promise<string | null> {
  const target = path.join(dir, attachmentFileName(a));
  if (await hasContent(target, a)) return null;
  // lo que había con ese nombre no casa: fuera, la carpeta solo guarda lo verificado.
  fs.rmSync(target, { force: true });
  if (fetch === null) return 'la plataforma no sirve adjuntos';
  const got = await fetch(a.id, signal);
  if (!got.ok) return got.reason;
  const part = path.join(dir, partName(a));
  fs.rmSync(part, { force: true });
  const m = meter(a.size);
  try {
    await pipeline(got.body, m.stream, fs.createWriteStream(part, { flags: 'wx', mode: FILE_MODE }), { signal });
    if (m.bytes() !== a.size) throw new Error(`${m.bytes()} bytes de los ${a.size} anunciados`);
    if (m.digest() !== a.sha256) throw new Error('el sha256 no casa');
    fs.renameSync(part, target);
    return null;
  } catch (err) {
    fs.rmSync(part, { force: true });
    return (err as Error).message;
  }
}

/** deja en `dir` exactamente los adjuntos de `files` que se pudieron verificar (ver cabecera). `note` recibe cada fallo
 *  (sin rutas: id y nombre). lanza solo si la carpeta no se puede crear o leer: quien llama lo anota y sigue. */
export async function syncAttachments(
  files: readonly LegacyClaimAttachment[],
  dir: string,
  fetch: AttachmentFetcher,
  note: (text: string) => void,
  signal: AbortSignal,
): Promise<AttachmentsSync> {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  const wanted = new Set(files.map(attachmentFileName));
  listed(dir)
    .filter((d) => OWN_FILE_RE.test(d.name) && !wanted.has(d.name))
    .forEach((d) => fs.rmSync(path.join(dir, d.name), { recursive: true, force: true }));
  let ready = 0;
  // i/o secuencial: un adjunto tras otro (ver cabecera).
  for (const a of files) {
    const reason = await place(a, dir, fetch, signal).catch((err: Error) => err.message);
    if (reason === null) ready++;
    else note(`adjunto ${a.id} (${a.name}) sin bajar: ${reason}; el agente lo lee por mcp`);
  }
  const now = new Date();
  fs.utimesSync(dir, now, now);
  return { ready, failed: files.length - ready };
}

/** el claim con cada RUN_ATTACHMENTS_DIR_TOKEN de `prompt` y `fallbackPrompt` cambiado por `dir` (sin patrones de
 *  reemplazo: una ruta con `$` queda tal cual). */
export function withAttachmentsDir(claim: ClaimResponse, dir: string): ClaimResponse {
  const put = (text: string): string => text.split(RUN_ATTACHMENTS_DIR_TOKEN).join(dir);
  return { ...claim, prompt: put(claim.prompt), fallbackPrompt: claim.fallbackPrompt === null ? null : put(claim.fallbackPrompt) };
}

/** las carpetas de adjuntos de una plataforma en disco (las de nombre con forma de id de run). */
export function attachmentFolders(platform: string): AttachmentFolder[] {
  const root = attachmentsRoot(platform);
  return listed(root)
    .filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name))
    .map((d) => {
      const dir = path.join(root, d.name);
      return { kind: 'conversation' as const, runId: d.name, dir, lastUsedAt: fs.statSync(dir).mtimeMs };
    });
}

/** borra las carpetas dadas (las de conversaciones cerradas o inactivas, gc.ts::selectForRemoval): cuántas borró. un
 *  fallo se loguea con `log` (el prefijo de su plataforma); nunca lanza. */
export function removeAttachmentFolders(targets: readonly AttachmentFolder[], log: string): number {
  return targets.filter((f) => {
    try {
      fs.rmSync(f.dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      console.error(`${log} gc: no se pudieron borrar los adjuntos del run ${f.runId}: ${(err as Error).message}`);
      return false;
    }
  }).length;
}
