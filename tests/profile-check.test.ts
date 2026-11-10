import { describe, expect, it } from 'vitest';
import { checkClosedProfile } from '../src/core/geometry/profileCheck';

const sq = [
  { x: 0, y: 0, z: 0 },
  { x: 100, y: 0, z: 0 },
  { x: 100, y: 100, z: 0 },
  { x: 0, y: 100, z: 0 },
];

describe('contrôle des profils fermés', () => {
  it('profil plan : inchangé, sans message', () => {
    const r = checkClosedProfile(sq);
    expect(r.error).toBeUndefined();
    expect(r.warning).toBeUndefined();
    expect(r.points).toBe(sq);
  });

  it('petit écart hors plan : aplani avec avertissement', () => {
    const pts = sq.map((p, i) => (i === 2 ? { ...p, z: 0.5 } : p));
    const r = checkClosedProfile(pts);
    expect(r.error).toBeUndefined();
    expect(r.warning).toMatch(/aplani/);
    const n = { x: 0, y: 0, z: 0 };
    // tous les points sur un même plan : volume du tétraèdre formé nul
    const [a, b, c, d] = r.points;
    const u = [b!.x - a!.x, b!.y - a!.y, b!.z - a!.z], v = [c!.x - a!.x, c!.y - a!.y, c!.z - a!.z], w = [d!.x - a!.x, d!.y - a!.y, d!.z - a!.z];
    const det = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
    expect(Math.abs(det)).toBeLessThan(1e-6);
    expect(n).toBeTruthy();
  });

  it('point très hors plan : refusé en désignant le point', () => {
    const pts = [...sq, { x: 50, y: 150, z: 0 }].map((p, i) => (i >= 3 ? { ...p, z: -40 } : p));
    const r = checkClosedProfile(pts);
    expect(r.error).toMatch(/Profil non plan : le point \(.*\) sort de/);
    expect(r.error).toMatch(/APLANIR/);
  });

  it('courbe qui se croise : refusée avec le point de croisement', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 100, z: 0 },
      { x: 30, y: -50, z: 0 },
      { x: 0, y: 100, z: 0 },
    ];
    const r = checkClosedProfile(pts);
    expect(r.error).toMatch(/auto-sécant.*près du point/);
  });

  it('boucle en 8 (aire nulle) : signalée comme croisement', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 100, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 0, y: 100, z: 0 },
    ];
    expect(checkClosedProfile(pts).error).toMatch(/près du point \(50 ; 50 ; 0\)/);
  });
});
