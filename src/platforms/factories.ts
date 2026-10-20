// los protocolos que este runner habla y cómo se crea cada plataforma (t#495): duckhunt-42 (el cable legacy de
// duckhunt) y la spec v0. aparte de cada cable para que ninguno importe al otro.

import { createDuckhunt42Platform } from './duckhunt42.js';
import { PROTOCOL, type PlatformFactories } from './platform.js';
import { createV0Platform } from './v0.js';

export const PLATFORM_FACTORIES: PlatformFactories = {
  [PROTOCOL.duckhunt42]: createDuckhunt42Platform,
  [PROTOCOL.v0]: createV0Platform,
};
