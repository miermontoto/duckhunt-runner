// barrel de @duckhunt/runner-protocol (t#495): el cable del runner que comparten el server y el daemon
// (duckhunt-runner, en su propio repo), sin dependencias. hoy es el cable legacy (contrato 42): las
// capabilities, los topes del claim, el feed, la aws en lectura, los códigos de error y la forma del claim.
// decisiones:
// - fuente única: el server importa de aquí (constants.ts lo re-exporta para no tocar a sus consumidores) y
//   el daemon lo vendorizará copiándolo, sin depender de npm, verificado contra el manifiesto de fixtures.
// - fuente ts, como los @platform/*: sin build propio, tsup lo empaqueta en el api (noExternal).
// - los fixtures del cable (fixtures/, con su manifiesto) viven aquí, y su api de node en
//   `@duckhunt/runner-protocol/fixtures`: este barrel no toca el fs, así sirve igual a quien no es node.
// - pasará a platform/ como @platform/runner-protocol cuando sus interfaces estén estables.
// toolset_v1 (M5, toolset.ts): la política neutra del run, en sombra junto a las listas de tools.
// spec v0 (M4, v0.ts): discovery, el claim con ids opacos y mcpServers[], lease, result idempotente y el sobre de
// error. recursos de la máquina (M7, resources.ts): lo que anuncia (sesiones de navegador, la aws por defecto) y su
// salud. autonomía (t#527, autonomy.ts): niveles, permission modes y el cable de las peticiones de permiso. catálogo de
// slash commands de la máquina (t#555, slash-commands.ts).
// non-goals por ahora: validación (zod), que cada lado hace con lo suyo.

export * from './autonomy.js';
export * from './aws.js';
export * from './capabilities.js';
export * from './changes.js';
export * from './claim.js';
export * from './errors.js';
export * from './events.js';
export * from './limits.js';
export * from './resources.js';
export * from './slash-commands.js';
export * from './toolset.js';
export * from './v0.js';
