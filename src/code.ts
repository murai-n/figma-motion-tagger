import {
  AnimationSpec,
  DuplicateIdWarning,
  ExportAnimation,
  ExportElement,
  ExportJson,
  MotionTag,
  PluginToUiMessage,
  SelectionInfo,
  UiToPluginMessage,
} from "./types";
import { resolveEasingToBezier } from "./easing";
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

async function collectTaggedNodes(): Promise<SceneNode[]> {
  await figma.loadAllPagesAsync();
  const result: SceneNode[] = [];
  for (const page of figma.root.children) {
    const found = page.findAll((n) => {
      const raw = n.getPluginData(TAG_KEY);
      return !!raw;
    }) as SceneNode[];
    result.push(...found);
  }
  return result;
}

async function sendExportPreview() {
  const json = await buildExportJson();
  const duplicateIds = await findDuplicateIds();
  post({ type: "export-preview", json, duplicateIds });
}

// Computed from the live nodes (not from ExportJson, since `nodeId` is deliberately
// left out of the exported JSON but is still needed here to help locate the layer).
async function findDuplicateIds(): Promise<DuplicateIdWarning[]> {
  const nodes = await collectTaggedNodes();
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
  const nodes = await collectTaggedNodes();
  const elements: ExportElement[] = [];

  for (const node of nodes) {
    const tag = readTag(node);
    if (!tag) continue;

    const currentPos = isPositionable(node) ? { x: node.x, y: node.y } : { x: 0, y: 0 };

    const animations: ExportAnimation[] = tag.animations.map((anim: AnimationSpec) => {
      const bezier = resolveEasingToBezier(anim.easing);
      const exported: ExportAnimation = {
        id: anim.id,
        type: anim.type,
        duration: anim.duration,
        delay: anim.delay,
        easing: anim.easing,
        bezier,
      };

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

      return exported;
    });

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
  const taggedNodes = await collectTaggedNodes();
  return !taggedNodes.some((n) => {
    if (n.id === currentNodeId) return false;
    const t = readTag(n);
    return t && t.id === trimmedId;
  });
}

// IDs currently being claimed by an in-flight save-tag/save-animation message.
//
// isIdAvailable() is async (it awaits figma.loadAllPagesAsync() + a page traversal), and
// figma.ui.onmessage handlers are async too — so if two save messages that both want the
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

  const frame = findContainingFrame(seedNode);
  if (!frame) return;

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
      const startSec = anim.delay / 1000;
      const endSec = (anim.delay + anim.duration) / 1000;
      totalSeconds = Math.max(totalSeconds, endSec);
      const easing = toMotionEasing(anim.easing);

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

figma.on("selectionchange", sendSelection);

figma.ui.onmessage = async (msg: UiToPluginMessage) => {
  switch (msg.type) {
    case "ui-ready": {
      sendSelection();
      await sendExportPreview();
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
  }
};
