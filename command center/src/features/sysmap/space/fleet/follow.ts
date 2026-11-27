import * as THREE from "three";

/**
 * Follow-cam targets: Fleet3D writes each ship's pose here every frame; the star map's camera
 * rig reads it when `useSpace().follow` names a `ship:*` key. A plain module map (no React
 * state), so the per-frame writes never re-render anything.
 */
export interface FollowTarget {
  pos: THREE.Vector3;
  /** Unit heading (the chase view sits behind and above it). */
  fwd: THREE.Vector3;
  /** Chase distance, world units. */
  dist: number;
  label: string;
  /** On stage this frame (in a flight / always for the capital ship). */
  visible: boolean;
  /** Seconds hidden while followed (the follow releases after a while). */
  hiddenFor: number;
}

export const FOLLOW = new Map<string, FollowTarget>();

export const isShipKey = (k: string | null | undefined): boolean => !!k && k.startsWith("ship:");

export function followTarget(key: string, dist: number, label: string): FollowTarget {
  let t = FOLLOW.get(key);
  if (!t) {
    t = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), dist, label, visible: false, hiddenFor: 0 };
    FOLLOW.set(key, t);
  }
  return t;
}

/** Chase offset: behind the heading and above it. */
export function chaseOffset(t: FollowTarget, out = new THREE.Vector3()) {
  return out.copy(t.fwd).negate().add(new THREE.Vector3(0, 0.42, 0)).normalize().multiplyScalar(t.dist);
}
