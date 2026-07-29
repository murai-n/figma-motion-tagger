import { EasingPreset } from "./types";

export const EASING_PRESETS: Record<EasingPreset, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  easeInCubic: [0.55, 0.055, 0.675, 0.19],
  easeOutCubic: [0.215, 0.61, 0.355, 1],
  easeInOutCubic: [0.645, 0.045, 0.355, 1],
  easeInQuad: [0.55, 0.085, 0.68, 0.53],
  easeOutQuad: [0.25, 0.46, 0.45, 0.94],
  easeInOutQuad: [0.455, 0.03, 0.515, 0.955],
};

export const EASING_PRESET_NAMES = Object.keys(EASING_PRESETS) as EasingPreset[];

const CUBIC_BEZIER_RE =
  /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i;

/**
 * Resolves an easing value (preset name or "cubic-bezier(x1,y1,x2,y2)") to a
 * concrete [x1,y1,x2,y2] tuple. Falls back to linear if unparseable.
 */
export function resolveEasingToBezier(easing: string): [number, number, number, number] {
  const preset = EASING_PRESETS[easing as EasingPreset];
  if (preset) return preset;

  const match = CUBIC_BEZIER_RE.exec(easing.trim());
  if (match) {
    return [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]), parseFloat(match[4])];
  }

  return EASING_PRESETS.linear;
}

export function isValidEasingInput(easing: string): boolean {
  if (easing in EASING_PRESETS) return true;
  return CUBIC_BEZIER_RE.test(easing.trim());
}
