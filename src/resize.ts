import { AnimationSpec } from "./types";

export type ResizeMode = "percentage" | "absolute";

// Unset means "percentage" — resize's default mode (no legacy data predates this,
// unlike moveMode, but the same unset-defaults-to-default-mode pattern is kept for
// consistency and safety against any future data written without this field).
export function getEffectiveResizeMode(anim: AnimationSpec): ResizeMode {
  return anim.resizeMode ?? "percentage";
}
