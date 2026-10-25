type Group = {
  groupId: string;
  rowIndex: number;
  count: number;
  size: number;
  [key: string]: any;
};

type UndoSnapshot = {
  context: string;
  count: number;
  groups: Group[] | null;
  entries: { file: any; index: number }[];
};

type UndoCacheEntry = UndoSnapshot & {
  anchors: { fileId: number; index: number }[];
};

export function captureTrashUndoSnapshot(context: string, files: any[], groups: Group[] | null): UndoSnapshot {
  return {
    context,
    count: files.length,
    groups: groups?.map(group => ({ ...group })) ?? null,
    entries: files.flatMap((file, index) => typeof file?.id === 'number' ? [{ file, index }] : []),
  };
}

export function createTrashUndoCache() {
  let limit = 5;
  let history: UndoCacheEntry[] = [];
  return {
    clear() { history = []; },
    setLimit(value: number) {
      limit = Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.min(100, Math.floor(Number(value))) : 5;
      history = history.slice(-limit);
    },
    remember(snapshot: UndoSnapshot, deletedIds: number[]) {
      const ids = new Set(deletedIds.map(Number));
      const entries = snapshot.entries.filter(entry => ids.has(Number(entry.file.id)));
      if (entries.length === 0) return;
      const anchors: UndoCacheEntry['anchors'] = [];
      let removed = 0;
      let previous: typeof anchors[number] | null = null;
      let needsNext = false;
      for (const entry of snapshot.entries) {
        if (ids.has(Number(entry.file.id))) {
          if (previous) anchors.push(previous);
          removed++;
          needsNext = true;
        } else {
          previous = { fileId: Number(entry.file.id), index: entry.index - removed };
          if (needsNext) anchors.push(previous);
          needsNext = false;
        }
      }
      history.push({
        ...snapshot,
        entries: entries.map(entry => ({ ...entry, file: { ...entry.file, isSelected: false } })),
        anchors,
      });
      history = history.slice(-limit);
    },
    restore(context: string, restoredIds: number[], currentFiles: any[], currentGroups: Group[] | null, focusFileId: number) {
      const ids = new Set(restoredIds.map(Number));
      let historyIndex = history.length - 1;
      while (historyIndex >= 0 && !history[historyIndex].entries.some(item => ids.has(Number(item.file.id)))) historyIndex--;
      if (historyIndex < 0) return null;
      const [snapshot] = history.splice(historyIndex, 1);
      if (snapshot.context !== context || snapshot.entries.some(entry => !ids.has(Number(entry.file.id)))) return null;
      if (currentFiles.length + snapshot.entries.length !== snapshot.count) return null;
      const existingIds = new Set(currentFiles.filter(file => file?.id).map(file => Number(file.id)));
      if (snapshot.entries.some(entry => existingIds.has(Number(entry.file.id)))) return null;
      let files = [...currentFiles];
      const groups: Group[] = [];
      if (snapshot.groups) {
        if (!currentGroups && currentFiles.length > 0) return null;
        const removedByGroup = new Map<string, number>();
        let groupIndex = 0;
        for (const entry of snapshot.entries) {
          while (groupIndex + 1 < snapshot.groups.length
            && entry.index >= snapshot.groups[groupIndex + 1].rowIndex - groupIndex - 1) groupIndex++;
          const group = snapshot.groups[groupIndex];
          const start = group?.rowIndex - groupIndex;
          if (!group || entry.index < start || entry.index >= start + group.count) return null;
          removedByGroup.set(group.groupId, (removedByGroup.get(group.groupId) || 0) + 1);
        }
        const groupIds = new Set(snapshot.groups.map(group => group.groupId));
        if (currentGroups?.some(group => !groupIds.has(group.groupId))) return null;
        const groupFiles = new Map<string, any[]>();
        let fileOffset = 0;
        for (const group of currentGroups || []) {
          groupFiles.set(group.groupId, currentFiles.slice(fileOffset, fileOffset + group.count));
          fileOffset += group.count;
        }
        if (fileOffset !== currentFiles.length) return null;
        let rowOffset = 0;
        for (const group of snapshot.groups) {
          const remaining = groupFiles.get(group.groupId) || [];
          if (remaining.length !== group.count - (removedByGroup.get(group.groupId) || 0)) return null;
          groups.push({ ...group, rowIndex: rowOffset });
          rowOffset += group.count + 1;
        }
        files = snapshot.groups.flatMap(group => groupFiles.get(group.groupId) || []);
      } else {
        if (currentGroups) return null;
      }
      if (snapshot.anchors.some(anchor => files[anchor.index]?.id != null
        && Number(files[anchor.index].id) !== anchor.fileId)) return null;
      const restoredFiles = new Array(snapshot.count);
      let entryIndex = 0;
      let fileIndex = 0;
      for (let index = 0; index < snapshot.count; index++) {
        const entry = snapshot.entries[entryIndex];
        if (entry?.index === index) {
          restoredFiles[index] = { ...entry.file, trashUndoPreview: true };
          entryIndex++;
        } else {
          restoredFiles[index] = files[fileIndex++];
        }
      }
      const selectedIndex = selectTrashUndoFile(restoredFiles, focusFileId, Number(snapshot.entries[0]?.file.id), 0);
      const addedSize = snapshot.entries.reduce((total, entry) => total + Number(entry.file.size || 0), 0);
      return { files: restoredFiles, groups, selectedIndex, addedSize };
    },
  };
}

type GroupedPage = {
  rows: any[];
  groups: Group[];
  totalItemCount: number;
  totalRowCount: number;
  totalSize: number;
};

type UndoRefreshOptions = {
  files: any[];
  selectedIndex: number;
  focusFileId: number;
  viewport: { start: number; end: number };
  pageSize: number;
  grouped: boolean;
  isCurrent: () => boolean;
  count: () => Promise<number[] | null>;
  position: (fileId: number, groups: Group[]) => Promise<number | null | undefined>;
  loadFiles: (offset: number, limit: number) => Promise<any[] | null>;
  loadRows: (offset: number, limit: number) => Promise<GroupedPage | null>;
  groupHeader: (group: Group) => any;
  cachedThumbnail: (fileId: number) => string | undefined | null;
};

export function selectTrashUndoFile(files: any[], focusFileId: number, activeFileId: number, selectedIndex: number) {
  for (const fileId of [focusFileId, activeFileId]) {
    if (fileId <= 0) continue;
    const index = files.findIndex(file => Number(file?.id) === fileId);
    if (index >= 0) return index;
  }
  return files.length > 0 ? Math.max(0, Math.min(selectedIndex, files.length - 1)) : -1;
}

export async function prepareTrashUndoRefresh(options: UndoRefreshOptions) {
  const { grouped, isCurrent } = options;
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const initialPage = grouped ? await options.loadRows(0, 1) : null;
  const count = grouped ? null : await options.count();
  if (!isCurrent()) return null;
  if (grouped ? !initialPage : !count) throw new Error('Cannot refresh restored photo counts');

  const totalFileCount = grouped ? initialPage!.totalItemCount : Number(count![0]);
  const totalFileSize = grouped ? initialPage!.totalSize : Number(count![1]);
  const groups = initialPage?.groups || [];
  const totalRowCount = grouped ? initialPage!.totalRowCount : totalFileCount;
  const activeFileId = Number(options.files[options.selectedIndex]?.id || 0);
  let selectedIndex = -1;
  if (totalFileCount > 0) {
    for (const fileId of new Set([options.focusFileId, activeFileId])) {
      if (fileId <= 0) continue;
      const position = await options.position(fileId, groups);
      if (!isCurrent()) return null;
      if (position == null) throw new Error('Cannot locate restored photo');
      if (Number.isInteger(position) && position >= 0 && position < totalFileCount) {
        selectedIndex = position;
        break;
      }
    }
    if (selectedIndex < 0) selectedIndex = Math.max(0, Math.min(options.selectedIndex, totalFileCount - 1));
  }

  const selectedRow = grouped && selectedIndex >= 0
    ? (() => {
        let fileOffset = 0;
        for (const group of groups) {
          if (selectedIndex < fileOffset + group.count) return group.rowIndex + 1 + selectedIndex - fileOffset;
          fileOffset += group.count;
        }
        throw new Error('Cannot locate restored photo group');
      })()
    : selectedIndex;
  const ranges = [
    [options.viewport.start, options.viewport.end + 1],
    [selectedRow - pageSize, selectedRow + pageSize + 1],
  ].map(([start, end]) => [Math.max(0, start), Math.min(totalRowCount, end)])
    .filter(([start, end]) => start < end)
    .sort((left, right) => left[0] - right[0]);
  const mergedRanges: number[][] = [];
  for (const range of ranges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else mergedRanges.push([...range]);
  }

  const previousFiles = new Map(options.files.filter(file => typeof file?.id === 'number').map(file => [Number(file.id), file]));
  const files: any[] = new Array(totalFileCount).fill(null);
  const rows: any[] = grouped
    ? Array.from({ length: totalRowCount }, (_, index) => ({ id: 'grouped-ph-' + index, isPlaceholder: true }))
    : [];
  const prepareFile = (file: any) => {
    if (!file || typeof file.id !== 'number') throw new Error('Cannot load restored photo metadata');
    const previous = previousFiles.get(Number(file.id));
    return {
      ...file,
      isSelected: false,
      rotate: previous?.rotate ?? file.rotate ?? 0,
      thumbnail: previous?.thumbnail || file.thumbnail || options.cachedThumbnail(Number(file.id)),
      rawThumbnailStale: previous?.rawThumbnailStale ?? file.rawThumbnailStale,
      trashUndoPreview: previous?.trashUndoPreview,
    };
  };
  for (const group of groups) rows[group.rowIndex] = options.groupHeader(group);
  const loadPage = async (offset: number, limit: number) => {
    if (grouped) {
      const page = await options.loadRows(offset, limit);
      if (!isCurrent()) return;
      if (!page || page.rows.length !== limit) throw new Error('Cannot load restored photo rows');
      for (let index = 0; index < page.rows.length; index++) {
        const row = { ...page.rows[index] };
        if (row.type === 'item') {
          row.file = prepareFile(row.file);
          files[row.file_index] = row.file;
        }
        rows[offset + index] = row;
      }
    } else {
      const page = await options.loadFiles(offset, limit);
      if (!isCurrent()) return;
      if (!Array.isArray(page) || page.length !== limit) throw new Error('Cannot load restored photo metadata');
      for (let index = 0; index < page.length; index++) files[offset + index] = prepareFile(page[index]);
    }
  };
  const pending: Promise<void>[] = [];
  for (const [start, end] of mergedRanges) {
    for (let offset = start; offset < end; offset += pageSize) {
      pending.push(loadPage(offset, Math.min(pageSize, end - offset)));
    }
  }
  await Promise.all(pending);
  if (!isCurrent()) return null;
  if (selectedIndex >= 0 && !files[selectedIndex]) throw new Error('Restored photo is not ready');
  return { files, rows, groups, selectedIndex, totalFileCount, totalRowCount, totalFileSize };
}
