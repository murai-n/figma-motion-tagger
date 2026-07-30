import {
  AnimationSpec,
  DuplicateIdWarning,
  ExportAnimation,
  ExportElement,
  ExportJson,
  MotionSyncResult,
  MotionTag,
  PluginToUiMessage,
  SelectionInfo,
  UiToPluginMessage,
  VariableOption,
} from "./types";
import { bezierToEasing, isValidEasingInput, resolveEasingToBezier } from "./easing";
import { resolveMovePositions } from "./move";
import { getEffectiveResizeMode } from "./resize";

const TAG_KEY = "motionTag";

figma.showUI(__html__, { width: 360, height: 600 });

function post(message: PluginToUiMessage) {
  figma.ui.postMessage(message);
}

function readTag(node: SceneNode): MotionTag | null {
  const raw = node.getPluginData(TAG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MotionTag;
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.animations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeTag(node: SceneNode, tag: MotionTag) {
  node.setPluginData(TAG_KEY, JSON.stringify(tag));
}

function clearTag(node: SceneNode) {
  node.setPluginData(TAG_KEY, "");
}

function isPositionable(node: BaseNode): node is SceneNode & { x: number; y: number } {
  return "x" in node && "y" in node;
}

function isResizable(node: BaseNode): node is SceneNode & { width: number; height: number } {
  return "width" in node && "height" in node;
}

function toSelectionInfo(node: SceneNode): SelectionInfo {
  const pos = isPositionable(node) ? { x: node.x, y: node.y } : { x: 0, y: 0 };
  const size = isResizable(node) ? { width: node.width, height: node.height } : { width: 0, height: 0 };
  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    tag: readTag(node),
  };
}

function sendSelection() {
  const selection = figma.currentPage.selection.map(toSelectionInfo);
  post({ type: "selection-changed", selection });
}

// Scoped to the current page only (not the whole file) — cross-page scanning needs
// figma.loadAllPagesAsync(), which is expensive on large multi-page files and was
// being paid on every save/delete via sendExportPreview()/tryClaimId(). Tagged
// elements on other pages are therefore not included in ID-uniqueness checks or
// JSON export.
function collectTaggedNodes(): SceneNode[] {
  return figma.currentPage.findAll((n) => {
    const raw = n.getPluginData(TAG_KEY);
    return !!raw;
  }) as SceneNode[];
}

async function sendExportPreview() {
  const json = await buildExportJson();
  const duplicateIds = await findDuplicateIds();
  post({ type: "export-preview", json, duplicateIds });
}

async function sendVariables() {
  const [localFloats, localStrings] = await Promise.all([
    figma.variables.getLocalVariablesAsync("FLOAT"),
    figma.variables.getLocalVariablesAsync("STRING"),
  ]);
  const toOption = (v: Variable): VariableOption => ({ id: v.id, name: v.name });

  // Already-imported library variables show up in getLocalVariablesAsync() too (as
  // `remote: true` local copies) — exclude their keys from the library list below so
  // they aren't offered twice under two different ids (local id vs. library key).
  const localKeys = new Set([...localFloats, ...localStrings].map((v) => v.key));
  const library = await collectLibraryVariables(localKeys);

  post({
    type: "variables",
    floatVariables: [...localFloats.map(toOption), ...library.floats],
    stringVariables: [...localStrings.map(toOption), ...library.strings],
  });
}

// Variables published from team libraries enabled for this file (via the Assets panel —
// libraries can't be enabled from the Plugin API). Not yet "imported" into this file, so
// they're listed by their library `key` rather than a local variable id; resolveVariableRef()
// imports them on demand the first time they're actually resolved. Degrades silently to
// local-only if the team library API is unavailable (e.g. no libraries enabled).
async function collectLibraryVariables(
  excludeKeys: Set<string>,
): Promise<{ floats: VariableOption[]; strings: VariableOption[] }> {
  const floats: VariableOption[] = [];
  const strings: VariableOption[] = [];
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    const perCollection = await Promise.all(
      collections.map(async (collection) => ({
        collection,
        vars: await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key),
      })),
    );
    for (const { collection, vars } of perCollection) {
      for (const v of vars) {
        if (excludeKeys.has(v.key)) continue;
        if (v.resolvedType !== "FLOAT" && v.resolvedType !== "STRING") continue;
        const option: VariableOption = { id: v.key, name: v.name, library: collection.libraryName };
        if (v.resolvedType === "FLOAT") floats.push(option);
        else strings.push(option);
      }
    }
  } catch {
    // No libraries enabled, no library access, or the request failed — local
    // variables are still fully usable, so fail open rather than surfacing an error.
  }
  return { floats, strings };
}

// A durationVariableId/delayVariableId/easingVariableId may be either a local variable's
// id, or a not-yet-imported library variable's key (see collectLibraryVariables above).
// Try local first (cheap, no import), then fall back to importing by key. Importing an
// already-imported key is idempotent and returns the existing local copy.
async function resolveVariableRef(id: string): Promise<Variable | null> {
  const local = await figma.variables.getVariableByIdAsync(id);
  if (local) return local;
  try {
    return await figma.variables.importVariableByKeyAsync(id);
  } catch {
    return null;
  }
}

interface ResolvedTiming {
  duration: number;
  delay: number;
  easing: string;
  durationVariable?: string;
  delayVariable?: string;
  easingVariable?: string;
}

/**
 * Resolves an animation's duration/delay/easing, substituting in the value of
 * any bound Figma Variable (resolved for this specific node, since a variable
 * can resolve differently per node depending on that node's mode overrides).
 * Falls back to the literal field if the variable is missing/deleted or its
 * resolved value isn't the expected type.
 */
async function resolveTiming(anim: AnimationSpec, node: SceneNode): Promise<ResolvedTiming> {
  const result: ResolvedTiming = { duration: anim.duration, delay: anim.delay, easing: anim.easing };

  if (anim.durationVariableId) {
    const v = await resolveVariableRef(anim.durationVariableId);
    const resolved = v?.resolveForConsumer(node);
    if (resolved && typeof resolved.value === "number") {
      result.duration = resolved.value;
      result.durationVariable = v!.name;
    }
  }

  if (anim.delayVariableId) {
    const v = await resolveVariableRef(anim.delayVariableId);
    const resolved = v?.resolveForConsumer(node);
    if (resolved && typeof resolved.value === "number") {
      result.delay = resolved.value;
      result.delayVariable = v!.name;
    }
  }

  if (anim.easingVariableId) {
    const v = await resolveVariableRef(anim.easingVariableId);
    const resolved = v?.resolveForConsumer(node);
    if (resolved && typeof resolved.value === "string" && isValidEasingInput(resolved.value)) {
      result.easing = resolved.value;
      result.easingVariable = v!.name;
    }
  }

  return result;
}

// Computed from the live nodes (not from ExportJson, since `nodeId` is deliberately
// left out of the exported JSON but is still needed here to help locate the layer).
async function findDuplicateIds(): Promise<DuplicateIdWarning[]> {
  const nodes = collectTaggedNodes();
  const groups = new Map<string, { name: string; nodeId: string }[]>();
  for (const node of nodes) {
    const tag = readTag(node);
    if (!tag || !tag.id) continue;
    const list = groups.get(tag.id) ?? [];
    list.push({ name: node.name, nodeId: node.id });
    groups.set(tag.id, list);
  }
  const duplicates: DuplicateIdWarning[] = [];
  for (const [id, elements] of groups) {
    if (elements.length > 1) duplicates.push({ id, elements });
  }
  return duplicates;
}

async function buildExportJson(): Promise<ExportJson> {
  const nodes = collectTaggedNodes();
  const elements: ExportElement[] = [];

  for (const node of nodes) {
    const tag = readTag(node);
    if (!tag) continue;

    const currentPos = isPositionable(node) ? { x: node.x, y: node.y } : { x: 0, y: 0 };

    const animations: ExportAnimation[] = [];
    for (const anim of tag.animations) {
      const timing = await resolveTiming(anim, node);
      const bezier = resolveEasingToBezier(timing.easing);
      const exported: ExportAnimation = {
        id: anim.id,
        type: anim.type,
        duration: timing.duration,
        delay: timing.delay,
        easing: timing.easing,
        bezier,
      };
      if (timing.durationVariable) exported.durationVariable = timing.durationVariable;
      if (timing.delayVariable) exported.delayVariable = timing.delayVariable;
      if (timing.easingVariable) exported.easingVariable = timing.easingVariable;

      if (anim.type === "fadeIn") {
        exported.opacity = { from: 0, to: 1 };
      } else if (anim.type === "fadeOut") {
        exported.opacity = { from: 1, to: 0 };
      } else if (anim.type === "move") {
        const positions = resolveMovePositions(anim, currentPos);
        if (positions) {
          exported.position = positions;
        }
      } else if (anim.type === "resize") {
        if (getEffectiveResizeMode(anim) === "absolute") {
          if (anim.size) exported.size = anim.size;
        } else if (anim.scale) {
          exported.scale = anim.scale;
        }
      }

      animations.push(exported);
    }

    elements.push({
      id: tag.id,
      name: node.name,
      animations,
    });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    elements,
  };
}

async function findNodeById(nodeId: string): Promise<SceneNode | null> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.removed) return null;
  if (!("type" in node) || node.type === "PAGE" || node.type === "DOCUMENT") return null;
  return node as SceneNode;
}

// Empty IDs are always available (multiple nodes may be left untagged with "").
async function isIdAvailable(currentNodeId: string, trimmedId: string): Promise<boolean> {
  if (!trimmedId) return true;
  const taggedNodes = collectTaggedNodes();
  return !taggedNodes.some((n) => {
    if (n.id === currentNodeId) return false;
    const t = readTag(n);
    return t && t.id === trimmedId;
  });
}

// IDs currently being claimed by an in-flight save-tag/save-animation message.
//
// figma.ui.onmessage handlers are async, so if two save messages that both want the
// same not-yet-used ID arrive back to back (e.g. typing the same ID into two different
// parts in quick succession), the second one's check can run and pass *before* the first
// one has actually written its tag, letting both through. reservedIds closes that window:
// it's a plain synchronous Set, so the very first claim for an ID marks it reserved before
// any await happens, and any overlapping claim for the same ID fails immediately.
const reservedIds = new Set<string>();

async function tryClaimId(currentNodeId: string, trimmedId: string): Promise<boolean> {
  if (!trimmedId) return true;
  if (reservedIds.has(trimmedId)) return false;
  reservedIds.add(trimmedId);
  try {
    return await isIdAvailable(currentNodeId, trimmedId);
  } finally {
    reservedIds.delete(trimmedId);
  }
}

// ---------- Figma Motion (Beta) ----------

function findContainingFrame(node: SceneNode): FrameNode | null {
  let cur: BaseNode | null = node;
  while (cur) {
    if (cur.type === "FRAME") return cur as FrameNode;
    cur = cur.parent;
  }
  return null;
}

// Motion cannot animate a top-level frame (a frame that is a direct child of a page) —
// only its descendants. See https://developers.figma.com/docs/plugins/api/Motion
function isTopLevelFrame(node: SceneNode): boolean {
  return node.type === "FRAME" && !!node.parent && node.parent.type === "PAGE";
}

function toMotionEasing(easing: string): MotionEasing {
  const [x1, y1, x2, y2] = resolveEasingToBezier(easing);
  return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1, y1, x2, y2 } };
}

function hasAnyMotionTrack(node: SceneNode): boolean {
  const tracks = node.manualKeyframeTracks;
  return !!(
    tracks.OPACITY ||
    tracks.TRANSLATION_X ||
    tracks.TRANSLATION_Y ||
    tracks.SCALE_X ||
    tracks.SCALE_Y ||
    tracks.WIDTH ||
    tracks.HEIGHT
  );
}

// Shared by applyMotionToFrame (plugin -> Motion) and syncAnimationsFromMotion (Motion ->
// plugin): both operate on "the frame containing this node, plus every descendant (and the
// frame itself) that either has plugin animation data or already has Motion keyframe tracks".
function collectFrameSyncTargets(seedNode: SceneNode): { frame: FrameNode; targets: SceneNode[] } | null {
  const frame = findContainingFrame(seedNode);
  if (!frame) return null;

  const descendantsRelevant = frame.findAll((n) => {
    const scene = n as SceneNode;
    const t = readTag(scene);
    const hasAnim = !!t && t.animations.length > 0;
    return hasAnim || hasAnyMotionTrack(scene);
  }) as SceneNode[];
  const frameTag = readTag(frame);
  const frameNeedsSync =
    !isTopLevelFrame(frame) && ((!!frameTag && frameTag.animations.length > 0) || hasAnyMotionTrack(frame));
  const targets: SceneNode[] = frameNeedsSync ? [frame, ...descendantsRelevant] : descendantsRelevant;
  return { frame, targets };
}

/**
 * Applies the current tag/animation data for every relevant node in the frame containing
 * `seedNodeId` onto Figma Motion's manual keyframe tracks, and removes tracks for any
 * property that no longer has animations (so deletions in the plugin are reflected too).
 *
 * Runs silently as a best-effort background sync after every add/delete — the plugin's own
 * tag data is already the source of truth, so a Motion sync failure (e.g. the Beta API isn't
 * available in this file) shouldn't interrupt the user or change their selection/viewport.
 */
async function applyMotionToFrame(seedNodeId: string) {
  const seedNode = await findNodeById(seedNodeId);
  if (!seedNode) return;
  if (!("applyManualKeyframeTrack" in seedNode)) return;

  const scoped = collectFrameSyncTargets(seedNode);
  if (!scoped) return;
  const { targets } = scoped;

  if (targets.length === 0) return;

  const byPosition = (a: ManualKeyframeInput, b: ManualKeyframeInput) => a.timelinePosition - b.timelinePosition;

  let totalSeconds = 0;
  let representativeNode: SceneNode | null = null;

  for (const node of targets) {
    if (isTopLevelFrame(node)) continue;
    const tag = readTag(node);
    const currentPos = isPositionable(node) ? { x: node.x, y: node.y } : { x: 0, y: 0 };

    const opacityKeyframes: ManualKeyframeInput[] = [];
    const translationXKeyframes: ManualKeyframeInput[] = [];
    const translationYKeyframes: ManualKeyframeInput[] = [];
    const scaleXKeyframes: ManualKeyframeInput[] = [];
    const scaleYKeyframes: ManualKeyframeInput[] = [];
    const widthKeyframes: ManualKeyframeInput[] = [];
    const heightKeyframes: ManualKeyframeInput[] = [];

    for (const anim of tag?.animations ?? []) {
      const timing = await resolveTiming(anim, node);
      const startSec = timing.delay / 1000;
      const endSec = (timing.delay + timing.duration) / 1000;
      totalSeconds = Math.max(totalSeconds, endSec);
      const easing = toMotionEasing(timing.easing);

      if (anim.type === "fadeIn" || anim.type === "fadeOut") {
        const fromValue = anim.type === "fadeIn" ? 0 : 1;
        const toValue = anim.type === "fadeIn" ? 1 : 0;
        opacityKeyframes.push({ timelinePosition: startSec, value: { type: "FLOAT", value: fromValue } });
        opacityKeyframes.push({ timelinePosition: endSec, value: { type: "FLOAT", value: toValue }, easing });
      } else if (anim.type === "move") {
        // TRANSLATION_X/Y are relative transforms (offset from resting position), so
        // both "from" and "to" — however they were specified — are converted to deltas
        // here. In delta mode "to" is always currentPos, so dxEnd/dyEnd come out as 0
        // (unchanged from before); in absolute mode "to" can differ from currentPos too.
        const positions = resolveMovePositions(anim, currentPos);
        if (positions) {
          const dxStart = positions.from.x - currentPos.x;
          const dyStart = positions.from.y - currentPos.y;
          const dxEnd = positions.to.x - currentPos.x;
          const dyEnd = positions.to.y - currentPos.y;
          translationXKeyframes.push({ timelinePosition: startSec, value: { type: "FLOAT", value: dxStart } });
          translationXKeyframes.push({ timelinePosition: endSec, value: { type: "FLOAT", value: dxEnd }, easing });
          translationYKeyframes.push({ timelinePosition: startSec, value: { type: "FLOAT", value: dyStart } });
          translationYKeyframes.push({ timelinePosition: endSec, value: { type: "FLOAT", value: dyEnd }, easing });
        }
      } else if (anim.type === "resize") {
        if (getEffectiveResizeMode(anim) === "absolute" && anim.size) {
          widthKeyframes.push({ timelinePosition: startSec, value: { type: "FLOAT", value: anim.size.from.width } });
          widthKeyframes.push({ timelinePosition: endSec, value: { type: "FLOAT", value: anim.size.to.width }, easing });
          heightKeyframes.push({ timelinePosition: startSec, value: { type: "FLOAT", value: anim.size.from.height } });
          heightKeyframes.push({
            timelinePosition: endSec,
            value: { type: "FLOAT", value: anim.size.to.height },
            easing,
          });
        } else if (anim.scale) {
          scaleXKeyframes.push({
            timelinePosition: startSec,
            value: { type: "FLOAT", value: anim.scale.from.x / 100 },
          });
          scaleXKeyframes.push({
            timelinePosition: endSec,
            value: { type: "FLOAT", value: anim.scale.to.x / 100 },
            easing,
          });
          scaleYKeyframes.push({
            timelinePosition: startSec,
            value: { type: "FLOAT", value: anim.scale.from.y / 100 },
          });
          scaleYKeyframes.push({
            timelinePosition: endSec,
            value: { type: "FLOAT", value: anim.scale.to.y / 100 },
            easing,
          });
        }
      }
    }

    let touchedThisNode = false;
    const existingTracks = node.manualKeyframeTracks;

    if (opacityKeyframes.length > 0) {
      opacityKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "OPACITY" },
        { baseValue: opacityKeyframes[0].value, keyframes: opacityKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.OPACITY) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" });
    }

    if (translationXKeyframes.length > 0) {
      translationXKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "TRANSLATION_X" },
        { baseValue: translationXKeyframes[0].value, keyframes: translationXKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.TRANSLATION_X) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_X" });
    }

    if (translationYKeyframes.length > 0) {
      translationYKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "TRANSLATION_Y" },
        { baseValue: translationYKeyframes[0].value, keyframes: translationYKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.TRANSLATION_Y) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_Y" });
    }

    if (scaleXKeyframes.length > 0) {
      scaleXKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "SCALE_X" },
        { baseValue: scaleXKeyframes[0].value, keyframes: scaleXKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.SCALE_X) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "SCALE_X" });
    }

    if (scaleYKeyframes.length > 0) {
      scaleYKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "SCALE_Y" },
        { baseValue: scaleYKeyframes[0].value, keyframes: scaleYKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.SCALE_Y) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "SCALE_Y" });
    }

    if (widthKeyframes.length > 0) {
      widthKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "WIDTH" },
        { baseValue: widthKeyframes[0].value, keyframes: widthKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.WIDTH) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "WIDTH" });
    }

    if (heightKeyframes.length > 0) {
      heightKeyframes.sort(byPosition);
      node.applyManualKeyframeTrack(
        { type: "PROPERTY", name: "HEIGHT" },
        { baseValue: heightKeyframes[0].value, keyframes: heightKeyframes },
      );
      touchedThisNode = true;
    } else if (existingTracks.HEIGHT) {
      node.removeManualKeyframeTrack({ type: "PROPERTY", name: "HEIGHT" });
    }

    if (touchedThisNode) {
      representativeNode = node;
    }
  }

  if (!representativeNode) {
    // Nothing left animated in this frame (e.g. the last animation was just deleted) —
    // any stale tracks have already been removed above, so there's nothing further to sync.
    return;
  }

  totalSeconds = Math.max(totalSeconds, 0.05);
  const [timeline] = representativeNode.timelines;
  if (timeline) {
    representativeNode.setTimelineDuration(timeline.id, totalSeconds);
  }
}

// ---------- Reading Motion timeline edits back into plugin data ----------
//
// Editing keyframes directly in Figma's native Motion timeline (dragging a keyframe,
// changing an easing curve, adding a waypoint) only changes node.manualKeyframeTracks —
// it never touches this plugin's pluginData. Since applyMotionToFrame() re-derives Motion
// state FROM pluginData on every plugin edit, a manual timeline edit is silently at risk of
// being overwritten the next time the user touches the plugin, and until then the plugin's
// own JSON export doesn't reflect what's actually playing. syncAnimationsFromMotion() reads
// the frame's current Motion tracks and writes them back into pluginData to close that gap.
//
// This is fundamentally a best-effort, one-directional (Motion -> plugin) read, not a full
// bidirectional sync, because Figma's manual keyframe model can't always be mapped back to
// our AnimationSpec model:
//   - manualKeyframeTracks holds at most ONE track per property per node (e.g. one OPACITY
//     track) with no link back to which AnimationSpec produced it. If a node has more than
//     one animation of the same kind (e.g. two fadeIns — allowed, since animId need not be
//     unique), there's no way to tell which keyframes belong to which entry, so that node's
//     property is skipped rather than guessed.
//   - Our model is strictly a 2-keyframe "from -> to" pair. If the user added extra waypoints
//     in the timeline, or only edited one of a pair's two keyframes, that can't be represented
//     and is skipped.
//   - MotionEasing includes types we have no equivalent for (springs, "back" curves, a
//     keyframe's easing bound to a Variable) — skipped rather than approximated.
//   - "delta" move mode can't represent an arbitrary end position (it always ends at the
//     node's current position), so a successfully-read move is always written back in
//     "absolute" mode.
// A durationVariableId/delayVariableId/easingVariableId on a property that gets successfully
// read back is cleared, since the Motion timeline now shows a literal value the user just set
// — keeping the binding would make the very next sync silently replace it with the variable's
// value again.
//
// Deliberately does NOT call applyMotionToFrame() afterward: that would push pluginData back
// onto Motion and, for every skipped property, immediately re-overwrite the timeline edit that
// was just left alone. The next plugin-side edit (add/edit/delete) still triggers the normal
// auto-sync as usual — this only changes what pluginData (and therefore JSON export) says.

function numericKeyframeValue(v: KeyframeValue): number | null {
  return v.type === "FLOAT" ? v.value : null;
}

// LINEAR/EASE_IN/EASE_OUT/EASE_IN_AND_OUT map onto our own preset names directly (same
// concept, same name). Everything else (springs, "back" curves, HOLD, a Variable-bound
// easing) has no equivalent in our duration+bezier model and is treated as unsupported.
function motionEasingToString(easing: MotionEasing | VariableAlias | undefined): string | null {
  if (!easing || easing.type === "VARIABLE_ALIAS") return null;
  switch (easing.type) {
    case "CUSTOM_CUBIC_BEZIER": {
      const b = easing.easingFunctionCubicBezier;
      return b ? bezierToEasing([b.x1, b.y1, b.x2, b.y2]) : null;
    }
    case "LINEAR":
      return "linear";
    case "EASE_IN":
      return "easeIn";
    case "EASE_OUT":
      return "easeOut";
    case "EASE_IN_AND_OUT":
      return "easeInOut";
    default:
      return null;
  }
}

interface ReadPropertyPair {
  delayMs: number;
  durationMs: number;
  easing: string;
  fromValue: number;
  toValue: number;
}

// Reads a single-property Motion track expected to hold exactly one from->to pair.
function readPropertyPair(track: ManualKeyframeBinding | undefined): ReadPropertyPair | "removed" | "unsupported" {
  if (!track) return "removed";
  if (track.keyframes.length !== 2) return "unsupported";
  const [a, b] = [...track.keyframes].sort((x, y) => x.timelinePosition - y.timelinePosition);
  const fromValue = numericKeyframeValue(a.value);
  const toValue = numericKeyframeValue(b.value);
  const easing = motionEasingToString(b.easing);
  if (fromValue === null || toValue === null || easing === null) return "unsupported";
  return {
    delayMs: Math.round(a.timelinePosition * 1000),
    durationMs: Math.round((b.timelinePosition - a.timelinePosition) * 1000),
    easing,
    fromValue,
    toValue,
  };
}

interface ReadAxisPair {
  delayMs: number;
  durationMs: number;
  easing: string;
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

// Reads two single-property tracks that together form one animation (move's TRANSLATION_X +
// TRANSLATION_Y, resize's WIDTH + HEIGHT, or SCALE_X + SCALE_Y) — both axes must agree on
// timing and easing, since AnimationSpec only has one duration/delay/easing for the pair.
function readAxisPair(
  trackA: ManualKeyframeBinding | undefined,
  trackB: ManualKeyframeBinding | undefined,
): ReadAxisPair | "removed" | "unsupported" {
  const a = readPropertyPair(trackA);
  const b = readPropertyPair(trackB);
  if (a === "removed" && b === "removed") return "removed";
  if (a === "removed" || a === "unsupported" || b === "removed" || b === "unsupported") return "unsupported";
  if (a.delayMs !== b.delayMs || a.durationMs !== b.durationMs || a.easing !== b.easing) return "unsupported";
  return {
    delayMs: a.delayMs,
    durationMs: a.durationMs,
    easing: a.easing,
    aFrom: a.fromValue,
    aTo: a.toValue,
    bFrom: b.fromValue,
    bTo: b.toValue,
  };
}

function clearVariableBindings(anim: AnimationSpec) {
  delete anim.durationVariableId;
  delete anim.delayVariableId;
  delete anim.easingVariableId;
}

async function syncAnimationsFromMotion(seedNodeId: string): Promise<MotionSyncResult> {
  const result: MotionSyncResult = { updated: 0, removed: 0, skipped: [] };

  const seedNode = await findNodeById(seedNodeId);
  if (!seedNode || !("manualKeyframeTracks" in seedNode)) return result;

  const scoped = collectFrameSyncTargets(seedNode);
  if (!scoped) return result;

  for (const node of scoped.targets) {
    if (isTopLevelFrame(node)) continue;
    const tag = readTag(node);
    if (!tag || tag.animations.length === 0) continue;

    const currentPos = isPositionable(node) ? { x: node.x, y: node.y } : { x: 0, y: 0 };
    const tracks = node.manualKeyframeTracks;
    let animations = [...tag.animations];
    let changed = false;
    const skip = (reason: string) => result.skipped.push({ name: node.name, reason });

    const opacityAnims = animations.filter((a) => a.type === "fadeIn" || a.type === "fadeOut");
    if (opacityAnims.length > 1) {
      skip("同じレイヤーに複数のフェードがあるため同期できません");
    } else if (opacityAnims.length === 1) {
      const pair = readPropertyPair(tracks.OPACITY);
      if (pair === "removed") {
        animations = animations.filter((a) => a !== opacityAnims[0]);
        changed = true;
        result.removed++;
      } else if (pair === "unsupported") {
        skip("フェードのタイムラインが対応範囲外のため同期できません(キーフレーム数やイージングの種類)");
      } else {
        opacityAnims[0].duration = pair.durationMs;
        opacityAnims[0].delay = pair.delayMs;
        opacityAnims[0].easing = pair.easing;
        clearVariableBindings(opacityAnims[0]);
        changed = true;
        result.updated++;
      }
    }

    const moveAnims = animations.filter((a) => a.type === "move");
    if (moveAnims.length > 1) {
      skip("同じレイヤーに複数のムーブがあるため同期できません");
    } else if (moveAnims.length === 1) {
      const anim = moveAnims[0];
      const pair = readAxisPair(tracks.TRANSLATION_X, tracks.TRANSLATION_Y);
      if (pair === "removed") {
        animations = animations.filter((a) => a !== anim);
        changed = true;
        result.removed++;
      } else if (pair === "unsupported") {
        skip("ムーブのタイムラインが対応範囲外のため同期できません(X/Yの不一致・キーフレーム数・イージングの種類)");
      } else {
        anim.moveMode = "absolute";
        anim.position = {
          from: { x: currentPos.x + pair.aFrom, y: currentPos.y + pair.bFrom },
          to: { x: currentPos.x + pair.aTo, y: currentPos.y + pair.bTo },
        };
        delete anim.offset;
        anim.duration = pair.durationMs;
        anim.delay = pair.delayMs;
        anim.easing = pair.easing;
        clearVariableBindings(anim);
        changed = true;
        result.updated++;
      }
    }

    const resizeAbsAnims = animations.filter((a) => a.type === "resize" && getEffectiveResizeMode(a) === "absolute");
    if (resizeAbsAnims.length > 1) {
      skip("同じレイヤーに複数の「幅・高さ」サイズ変更があるため同期できません");
    } else if (resizeAbsAnims.length === 1) {
      const anim = resizeAbsAnims[0];
      const pair = readAxisPair(tracks.WIDTH, tracks.HEIGHT);
      if (pair === "removed") {
        animations = animations.filter((a) => a !== anim);
        changed = true;
        result.removed++;
      } else if (pair === "unsupported") {
        skip("サイズ変更(幅・高さ)のタイムラインが対応範囲外のため同期できません");
      } else {
        anim.size = {
          from: { width: pair.aFrom, height: pair.bFrom },
          to: { width: pair.aTo, height: pair.bTo },
        };
        anim.duration = pair.durationMs;
        anim.delay = pair.delayMs;
        anim.easing = pair.easing;
        clearVariableBindings(anim);
        changed = true;
        result.updated++;
      }
    }

    const resizePctAnims = animations.filter((a) => a.type === "resize" && getEffectiveResizeMode(a) !== "absolute");
    if (resizePctAnims.length > 1) {
      skip("同じレイヤーに複数の「パーセンテージ」サイズ変更があるため同期できません");
    } else if (resizePctAnims.length === 1) {
      const anim = resizePctAnims[0];
      const pair = readAxisPair(tracks.SCALE_X, tracks.SCALE_Y);
      if (pair === "removed") {
        animations = animations.filter((a) => a !== anim);
        changed = true;
        result.removed++;
      } else if (pair === "unsupported") {
        skip("サイズ変更(パーセンテージ)のタイムラインが対応範囲外のため同期できません");
      } else {
        anim.scale = {
          from: { x: pair.aFrom * 100, y: pair.bFrom * 100 },
          to: { x: pair.aTo * 100, y: pair.bTo * 100 },
        };
        anim.duration = pair.durationMs;
        anim.delay = pair.delayMs;
        anim.easing = pair.easing;
        clearVariableBindings(anim);
        changed = true;
        result.updated++;
      }
    }

    if (changed) {
      writeTag(node, { id: tag.id, animations });
    }
  }

  return result;
}

// Variables are re-sent on every selection change too (not just ui-ready) since
// a Variable created/renamed after the plugin panel was opened would otherwise
// never appear in the duration/delay/easing dropdowns until the panel is reopened.
figma.on("selectionchange", () => {
  sendSelection();
  void sendVariables();
});

figma.ui.onmessage = async (msg: UiToPluginMessage) => {
  switch (msg.type) {
    case "ui-ready": {
      sendSelection();
      await sendExportPreview();
      await sendVariables();
      break;
    }

    case "save-tag": {
      const node = await findNodeById(msg.nodeId);
      if (!node) {
        post({ type: "error", message: "対象のレイヤーが見つかりませんでした。" });
        return;
      }
      const trimmedId = msg.id.trim();
      if (!(await tryClaimId(node.id, trimmedId))) {
        post({ type: "error", message: `ID "${trimmedId}" は既に使用されています。` });
        return;
      }
      const existing = readTag(node);
      const tag: MotionTag = { id: trimmedId, animations: existing ? existing.animations : [] };
      writeTag(node, tag);
      sendSelection();
      await sendExportPreview();
      break;
    }

    case "save-animation": {
      const node = await findNodeById(msg.nodeId);
      if (!node) {
        post({ type: "error", message: "対象のレイヤーが見つかりませんでした。" });
        return;
      }
      let existing = readTag(node);
      if (!existing) {
        // Not tagged yet — auto-create the tag using whatever ID is currently
        // entered (may be empty; IDs are optional) so animations can be added directly.
        const trimmedId = msg.id.trim();
        if (!(await tryClaimId(node.id, trimmedId))) {
          post({ type: "error", message: `ID "${trimmedId}" は既に使用されています。` });
          return;
        }
        existing = { id: trimmedId, animations: [] };
      }
      const existingIndex = existing.animations.findIndex((a) => a.animId === msg.animation.animId);
      const animations =
        existingIndex >= 0
          ? existing.animations.map((a, i) => (i === existingIndex ? msg.animation : a))
          : [...existing.animations, msg.animation];
      writeTag(node, { id: existing.id, animations });
      sendSelection();
      await sendExportPreview();
      await applyMotionToFrame(msg.nodeId);
      break;
    }

    case "delete-animation": {
      const node = await findNodeById(msg.nodeId);
      if (!node) return;
      const existing = readTag(node);
      if (!existing) return;
      const animations = existing.animations.filter((a) => a.animId !== msg.animId);
      writeTag(node, { id: existing.id, animations });
      sendSelection();
      await sendExportPreview();
      await applyMotionToFrame(msg.nodeId);
      break;
    }

    case "delete-tag": {
      const node = await findNodeById(msg.nodeId);
      if (!node) return;
      clearTag(node);
      sendSelection();
      await sendExportPreview();
      await applyMotionToFrame(msg.nodeId);
      break;
    }

    case "sync-from-motion": {
      const syncResult = await syncAnimationsFromMotion(msg.nodeId);
      sendSelection();
      await sendExportPreview();
      post({ type: "motion-sync-result", ...syncResult });
      break;
    }
  }
};
