/** Aiguillage d'une requête du protocole vers la méthode du noyau (worker et tests). */
import type { OccKernel } from './OccKernel';
import type { KernelRequest } from './protocol';

export function run(k: OccKernel, r: KernelRequest): unknown {
  // étape intermédiaire : pas de maillage d'affichage (voir OccKernel.lazy)
  k.lazy = !!r.lazy;
  k.notes.length = 0;
  try {
    return exec(k, r);
  } finally {
    k.lazy = false;
  }
}

function exec(k: OccKernel, r: KernelRequest): unknown {
  switch (r.op) {
    case 'hlr': return k.hlr(r.shapeIds, r.dir, r.xDir, r.hidden, r.smooth);
    case 'sheetMetal': return k.sheetMetal(r.def);
    case 'release': return k.release(r.shapeIds);
    case 'box': return k.box(r.corner, r.size);
    case 'cylinder': return k.cylinder(r.center, r.radius, r.height, r.axis);
    case 'cone': return k.cone(r.center, r.radius, r.topRadius, r.height, r.axis);
    case 'sphere': return k.sphere(r.center, r.radius);
    case 'torus': return k.torus(r.center, r.radius, r.tubeRadius);
    case 'pyramid': return k.pyramid(r.center, r.sides, r.radius, r.topRadius, r.height, r.rotation);
    case 'extrude': return k.extrude(r.profile, r.height, r.taperDeg, r.surface, r.direction);
    case 'revolve': return k.revolve(r.profile, r.axisStart, r.axisEnd, r.angleDeg, r.startDeg, r.surface);
    case 'sweep': return k.sweep(r.profile, r.path, r.align, r.surface);
    case 'loft': return k.loft(r.sections, r.ruled, r.surface);
    case 'extrudeRegions': return k.extrudeRegions(r.regions, r.direction);
    case 'planeSurface': return k.planeSurface(r.profile);
    case 'patch': return k.patch(r.edges);
    case 'thicken': return k.thicken(r.shapeId, r.thickness);
    case 'slice': return k.slice(r.shapeId, r.origin, r.normal, r.keep);
    case 'check': return k.check(r.shapeId);
    case 'boolean': return k.boolean(r.kind, r.targets, r.tools, r.exact);
    case 'fillet': return k.fillet(r.shapeId, r.edges, r.radius, r.radius2);
    case 'chamfer': return k.chamfer(r.shapeId, r.edges, r.distance);
    case 'shell': return k.shell(r.shapeId, r.faces, r.thickness);
    case 'pressPull': return k.pressPull(r.shapeId, r.face, r.distance);
    case 'transform': return k.transform(r.shapeId, r.matrix);
    case 'display': return k.display(r.shapeId);
    case 'exportMesh': return k.exportMesh(r.shapeIds, r.linearDeflection, r.angularDeflectionDeg);
    case 'exportStep': return k.exportStep(r.shapeIds);
    case 'importStep': return k.importStep(r.data);
    case 'meshToSolid': return k.meshToSolid(r.positions, r.indices, r.closed, r.merge);
    case 'meshBody': return k.meshBody(r.positions, r.indices, r.closed);
    case 'convertToSolid': return k.convertToSolid(r.shapeId, r.merge);
    case 'saveBrep': return k.saveBrep(r.shapeId);
    case 'loadBrep': return k.loadBrep(r.data);
  }
}
