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
// non-goals por ahora: validación (zod) y el cable v0, que llegan con su router (M4).

export * from './aws.js';
export * from './capabilities.js';
export * from './claim.js';
export * from './errors.js';
export * from './events.js';
export * from './limits.js';
export * from './toolset.js';
