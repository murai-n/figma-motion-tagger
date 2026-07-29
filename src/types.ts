export type AnimationType = "fadeIn" | "fadeOut" | "move" | "resize";

export type EasingPreset =
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad";

export interface AnimationSpec {
  animId: string;
  // User-assigned animation ID. Free-form and does NOT need to be unique —
  // e.g. multiple fadeIn animations that share the same treatment can share one id.
  id: string;
  type: AnimationType;
  duration: number;
  delay: number;
  easing: string; // preset name, or "cubic-bezier(x1,y1,x2,y2)" for custom

  // "move" only, below. `moveMode` selects which of `position` / `offset` is
  // authoritative. Unset means legacy data saved before mode-switching existed,
  // which always meant delta mode. See src/move.ts for how these are resolved.
  moveMode?: "absolute" | "delta";
  // Absolute canvas coordinates for both the start ("from") and end ("to") positions.
  // Used when moveMode === "absolute" — independent of the layer's actual current
  // position, unlike delta mode where "to" is always wherever the layer already sits.
  position?: { from: { x: number; y: number }; to: { x: number; y: number } };
  // Offset the element travels from, relative to its current (final) position.
  // e.g. dx: -100 means it starts 100px to the left of its final spot. Used when
  // moveMode === "delta" (also the default interpretation when moveMode is unset).
  offset?: { dx: number; dy: number };

  // "resize" only, below. `resizeMode` selects which of `scale` / `size` is
  // authoritative. Unset defaults to "percentage" (resize's default mode).
  resizeMode?: "percentage" | "absolute";
  // Percentage mode: per-axis scale as a percentage (100 = no change, 150 = 1.5x).
  // The animation runs from this percentage to the layer's normal (100%) size —
  // mirrors "move" delta mode, where the end state is always the layer's real size.
  scale?: { x: number; y: number };
  // Absolute mode: explicit width/height in px for both start (from) and end (to),
  // independent of the layer's actual current size — mirrors "move" absolute mode.
  size?: { from: { width: number; height: number }; to: { width: number; height: number } };
}

export interface MotionTag {
  id: string;
  animations: AnimationSpec[];
}

export interface SelectionInfo {
  nodeId: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tag: MotionTag | null;
}

export interface ExportAnimation {
  id: string;
  type: AnimationType;
  duration: number;
  delay: number;
  easing: string;
  bezier: [number, number, number, number];
  opacity?: { from: number; to: number };
  position?: { from: { x: number; y: number }; to: { x: number; y: number } };
  // "resize" percentage mode only. 100 = no change.
  scale?: { from: { x: number; y: number }; to: { x: number; y: number } };
  // "resize" absolute mode only.
  size?: { from: { width: number; height: number }; to: { width: number; height: number } };
}

export interface ExportElement {
  id: string;
  name: string;
  animations: ExportAnimation[];
}

export interface ExportJson {
  version: 1;
  generatedAt: string;
  elements: ExportElement[];
}

// Reported when the same non-empty element ID appears on more than one node —
// typically because a tagged Figma layer/frame was duplicated natively in Figma,
// which copies its pluginData (and thus the ID) without going through save-tag's
// uniqueness check.
export interface DuplicateIdWarning {
  id: string;
  elements: { name: string; nodeId: string }[];
}

// UI -> Plugin messages
export type UiToPluginMessage =
  | { type: "ui-ready" }
  | { type: "save-tag"; nodeId: string; id: string }
  // `id` here is used only to auto-create the tag if the node isn't tagged yet
  // (so animations can be added without first pressing "部品IDを追加").
  | { type: "save-animation"; nodeId: string; animation: AnimationSpec; id: string }
  | { type: "delete-animation"; nodeId: string; animId: string }
  | { type: "delete-tag"; nodeId: string };

// Plugin -> UI messages
export type PluginToUiMessage =
  | { type: "selection-changed"; selection: SelectionInfo[] }
  // Sent automatically after every add/delete so the UI can keep a live JSON preview.
  | { type: "export-preview"; json: ExportJson; duplicateIds: DuplicateIdWarning[] }
  | { type: "error"; message: string };
