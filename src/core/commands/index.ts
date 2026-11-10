export * from './types';
export * from './InputParser';
export * from './CommandRegistry';
export * from './CommandProcessor';
export { circleCommand, circumcircle } from './definitions/circle';
export { lineCommand } from './definitions/line';

import { CommandRegistry } from './CommandRegistry';
import { circleCommand } from './definitions/circle';
import { lineCommand } from './definitions/line';

/** Registre par défaut ; chaque module (2D, Solides, Sortie…) y ajoute ses commandes. */
export function createDefaultRegistry(): CommandRegistry {
  return new CommandRegistry().register(lineCommand).register(circleCommand);
}
