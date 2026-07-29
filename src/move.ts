import { AnimationSpec } from "./types";

export type MoveMode = "absolute" | "delta";

// Legacy animations (saved before mode-switching existed) only ever had `offset`,
// which represented delta-mode data — so an unset `moveMode` defaults to "delta".
export function getEffectiveMoveMode(anim: AnimationSpec): MoveMode {
  return anim.moveMode ?? "delta";
}

export interface MovePositions {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/**
 * Resolves a "move" animation's absolute start ("from") and end ("to") positions.
 *
 * `currentPos` is the node's actual current position in Figma. In delta mode, `to`
 * is always `currentPos` (the animation is defined as an offset from where the layer
 * already sits) and `from` is `currentPos + offset`. In absolute mode, both `from`
 * and `to` are whatever the user explicitly entered, independent of `currentPos`.
 *
 * Returns null if the animation doesn't carry the data its mode needs.
 */
export function resolveMovePositions(
  anim: AnimationSpec,
  currentPos: { x: number; y: number },
): MovePositions | null {
  if (getEffectiveMoveMode(anim) === "absolute") {
    return anim.position ? { from: anim.position.from, to: anim.position.to } : null;
  }
  return anim.offset
    ? { from: { x: currentPos.x + anim.offset.dx, y: currentPos.y + anim.offset.dy }, to: currentPos }
    : null;
}
