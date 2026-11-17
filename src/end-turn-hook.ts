// la entrada del hook que cierra el turno (t#690, end-turn.ts): el cli del run la lanza tras cada respuesta del agente, así
// que no pasa por index.ts (cargaría el daemon entero, ~300 ms): solo lo que el hook necesita.
import { endTurnHookCommand } from './end-turn.js';

endTurnHookCommand();
