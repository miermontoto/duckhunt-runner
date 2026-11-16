// abrir la autorización en el navegador de esta máquina (t#660): `login` y `setup` lanzan el navegador con la url que
// vuelve sola al daemon por loopback (loopback.ts) y dejan el code pegado como alternativa (otro ordenador, ssh, un
// navegador que no se abrió). aquí solo se decide si hay un navegador que la persona vea y se lanza el de cada sistema.
// decisiones:
// - linux: hace falta un display (x11 o wayland). con x reenviado por ssh también vale: el navegador corre en esta
//   máquina y el loopback le llega. macos y windows: sin display aparte, una sesión ssh es la señal de que la
//   persona está en otro ordenador.
// - la url va como un argumento suelto, nunca por un shell (un `&` de la query cortaría el comando en cmd).
// - lanzado = arrancó el lanzador; un xdg-open sin navegador configurado sale con error después y la url pegable se
//   imprime siempre, así que no se espera a su código de salida.

import { spawn } from 'node:child_process';

/** flag de `login` y `setup` para no abrir el navegador (solo el code pegado). */
export const NO_BROWSER_FLAG = '--no-browser';

/** ¿hay en esta máquina un navegador que la persona vea? (ver cabecera) */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === 'darwin' || platform === 'win32') return !(env.SSH_CONNECTION || env.SSH_TTY);
  return false;
}

/** cómo autoriza un `login` interactivo: navegador con vuelta por loopback si lo hay y no se pidió `--no-browser`, y
 *  el code pegado si hay terminal (o si no hay navegador: el `login` de siempre, que también lee un pipe). */
export function interactiveAuth(args: readonly string[], stdinIsTty = Boolean(process.stdin.isTTY)): { browser: boolean; paste: boolean } {
  const browser = !args.includes(NO_BROWSER_FLAG) && canOpenBrowser();
  return { browser, paste: stdinIsTty || !browser };
}

// el lanzador de cada sistema y sus argumentos.
function opener(url: string, platform: NodeJS.Platform): [string, string[]] | null {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'linux') return ['xdg-open', [url]];
  return null;
}

/** lanza el navegador con `url` sin esperarlo. false si este sistema no tiene lanzador o no arrancó. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const cmd = opener(url, platform);
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.once('error', (err) => {
      console.error(`[runner] no se pudo abrir el navegador (${cmd[0]}): ${err.message}`);
      resolve(false);
    });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
