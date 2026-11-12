// los backends de agente que sabe medir el arnés de conformidad (t#440 P6), por id de backend: claude code hoy; codex
// llega con su driver (P7).

import { claudeConformance } from './claude/claude-conformance.js';
import type { ConformanceBackend } from './conformance-backend.js';

const BACKENDS: ReadonlyMap<string, ConformanceBackend> = new Map([claudeConformance].map((b) => [b.id, b]));

/** el backend `id` del arnés, o null si no lo sabe medir. */
export const conformanceBackend = (id: string): ConformanceBackend | null => BACKENDS.get(id) ?? null;

/** los ids que sabe medir, para la ayuda y los errores. */
export const conformanceBackendIds = (): string[] => [...BACKENDS.keys()];
