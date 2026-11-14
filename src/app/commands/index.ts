/** Enregistrement de toutes les commandes de l'application. */
import type { CommandRegistry } from '../../core/commands';
import { constraintCommands } from './constraints';
import { drawCommands } from './draw';
import { dimensionCommands } from './dimensions';
import { fileCommands } from './files';
import { tools3dCommands } from './tools3d';
import { holeCommands } from './holes';
import { array3dCommands } from './arrays3d';
import { drawingCommands } from './drawing';
import { sheetMetalCommands } from './sheetmetal';
import { renderCommands } from './render';
import { jointCommands } from './joints';
import { measureCommands } from './measure';
import { text3dCommands } from './text3d';
import { modifyCommands } from './modify';
import { selectCommands } from './select';
import { solidCommands } from './solids';
import { underlayCommands } from './underlays';
import { utilityCommands } from './utility';
import { interfaceCommands } from './interface';
import { updateCommands } from './updates';

export function registerAll(registry: CommandRegistry): void {
  for (const def of [...drawCommands, ...dimensionCommands, ...modifyCommands, ...solidCommands, ...constraintCommands, ...utilityCommands, ...fileCommands, ...underlayCommands, ...tools3dCommands, ...selectCommands, ...measureCommands, ...text3dCommands, ...jointCommands, ...holeCommands, ...array3dCommands, ...renderCommands, ...drawingCommands, ...sheetMetalCommands, ...interfaceCommands, ...updateCommands]) registry.register(def);
}
