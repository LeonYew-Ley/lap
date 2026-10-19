import { ref } from 'vue';
import { getDragPayload, isDirectoryAccessible } from '@/common/api';
import { isMac } from '@/common/utils';
import { getExternalDropKind, getExternalDropPaths, type ExternalDropKind } from './externalDrop';

// One classification for the entire window, shared by Albums and Content.
export const externalDragKind = ref<ExternalDropKind>('unknown');
let generation = 0;
let probing = false;
let lastProbe = 0;
let finishQueued = false;
const seenEvents = new WeakSet<DragEvent>();

export function resetExternalDrag() {
  if (externalDragKind.value === 'unknown' && !probing && lastProbe === 0) return;
  generation++;
  probing = false;
  lastProbe = 0;
  externalDragKind.value = 'unknown';
}

// Capture and bubble listeners share one deferred cleanup after drop.
export function finishExternalDrag() {
  if (finishQueued) return;
  finishQueued = true;
  queueMicrotask(() => {
    finishQueued = false;
    resetExternalDrag();
  });
}

export function updateExternalDrag(event: DragEvent) {
  if (seenEvents.has(event)) return;
  seenEvents.add(event);
  // Hover events cannot change the source payload. Drop may reveal previously
  // protected entries, so always inspect it again before accepting anything.
  if (event.type !== 'drop' && externalDragKind.value !== 'unknown') return;
  const kind = getExternalDropKind(event.dataTransfer);
  if (kind !== 'unknown') {
    generation++;
    probing = false;
    externalDragKind.value = kind;
    return;
  }
  // Protected drag data may be empty on child enter/leave events. Keep a known
  // classification until the drag ends, rather than flashing the wrong target.
  if (externalDragKind.value !== 'unknown' || probing || Date.now() - lastProbe < 250) return;
  const paths = getExternalDropPaths(event.dataTransfer);
  if (!paths.length && !isMac) return;
  probing = true;
  lastProbe = Date.now();
  const current = generation;
  const native = !paths.length && isMac ? getDragPayload() : Promise.resolve(null);
  void (async () => {
    try {
      const payload = await native;
      paths.push(...(payload?.filePaths || []));
      if (!paths.length) return;
      const uniquePaths = [...new Set(paths)];
      let folders = false, files = false;
      // Bound metadata IPC, especially for large drops from network storage.
      for (let offset = 0; offset < uniquePaths.length; offset += 4) {
        if (current !== generation) return;
        const batch = await Promise.all(uniquePaths.slice(offset, offset + 4).map(path => isDirectoryAccessible(path)));
        folders ||= batch.some(Boolean);
        files ||= batch.some(directory => !directory);
        if (folders && files) break;
      }
      if (current !== generation) return;
      externalDragKind.value = folders && files ? 'mixed' : folders ? 'folders' : 'files';
    } finally {
      if (current === generation) probing = false;
    }
  })().catch(console.error);
}
