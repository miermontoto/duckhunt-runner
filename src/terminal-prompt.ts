// una pregunta en la terminal (t#660): el code de `login` y las preguntas de `setup`. una interfaz de readline por
// pregunta (dos a la vez sobre stdin se pisan) y ctrl-c corta el comando entero, como en cualquier cli: readline sin
// oyente de SIGINT solo pausaba la entrada y dejaba el proceso colgado.

import readline from 'node:readline/promises';

/** lee una línea de stdin tras `prompt`. `signal` la corta (rechaza con un AbortError). */
export async function askLine(prompt: string, signal?: AbortSignal): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.once('SIGINT', () => {
    rl.close();
    process.stdout.write('\n');
    process.kill(process.pid, 'SIGINT');
  });
  try {
    return await rl.question(prompt, signal ? { signal } : {});
  } finally {
    rl.close();
  }
}
