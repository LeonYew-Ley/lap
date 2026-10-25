import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref, watch, nextTick } from 'vue';

const helperSource = await readFile(new URL('../src/common/trashUndoRefresh.ts', import.meta.url), 'utf8');
const helper = {};
new Function('exports', ts.transpile(helperSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(helper);
const { captureTrashUndoSnapshot, createTrashUndoCache, prepareTrashUndoRefresh, selectTrashUndoFile } = helper;
const photo = (id, extra = {}) => ({ id, name: 'photo-' + id, file_path: '/photos/' + id + '.jpg', size: id * 10, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
};

test('the display cache retains five successful deletions by default and follows limit changes', () => {
  const cache = createTrashUndoCache();
  for (let fileId = 1; fileId <= 6; fileId++) {
    cache.remember(captureTrashUndoSnapshot('view', [photo(fileId)], null), [fileId]);
  }
  assert.equal(cache.restore('view', [1], [], null, 1), null);
  assert.equal(cache.restore('view', [6], [], null, 6).files[0].id, 6);
  cache.setLimit(2);
  assert.equal(cache.restore('view', [3], [], null, 3), null);
  assert.equal(cache.restore('view', [5], [], null, 5).files[0].id, 5);
  cache.clear();
  assert.equal(cache.restore('view', [4], [], null, 4), null);
});

test('display cache restores only successful batch deletions, preserving failed items and virtual slots', () => {
  const cache = createTrashUndoCache();
  cache.remember(captureTrashUndoSnapshot('view', [null, photo(1), photo(2), photo(3)], null), [1, 3]);
  const draft = cache.restore('view', [3, 1], [null, photo(2)], null, 3);
  assert.deepEqual(draft.files.map(file => file?.id ?? null), [null, 1, 2, 3]);
  assert.equal(draft.selectedIndex, 3);
  assert.equal(draft.addedSize, 40);
  assert.equal(cache.restore('view', [1, 3], [null, photo(2)], null, 1), null);
});

test('display cache rejects a different library, filter, ordering, count or already restored item', () => {
  for (const [context, files] of [
    ['other-library', [photo(2), photo(3)]], ['other-sort', [photo(2), photo(3)]],
    ['view', [photo(3), photo(2)]], ['view', [photo(2)]], ['view', [photo(1), photo(2)]],
  ]) {
    const cache = createTrashUndoCache();
    cache.remember(captureTrashUndoSnapshot('view', [photo(1), photo(2), photo(3)], null), [1]);
    assert.equal(cache.restore(context, [1], files, null, 1), null);
  }
});

test('grouped cache restores a disappeared group and reverses deletion-driven group reordering', () => {
  const cache = createTrashUndoCache();
  const originalGroups = [
    { groupId: 'a', rowIndex: 0, count: 2, size: 30, label: 'A' },
    { groupId: 'b', rowIndex: 3, count: 1, size: 30, label: 'B' },
  ];
  cache.remember(captureTrashUndoSnapshot('view', [photo(1), photo(2), photo(3)], originalGroups), [1]);
  const draft = cache.restore('view', [1], [photo(3), photo(2)], [
    { groupId: 'b', rowIndex: 0, count: 1, size: 30 },
    { groupId: 'a', rowIndex: 2, count: 1, size: 20 },
  ], 1);
  assert.deepEqual(draft.files.map(file => file.id), [1, 2, 3]);
  assert.deepEqual(draft.groups, originalGroups);
  cache.remember(captureTrashUndoSnapshot('view', [photo(1), photo(2), photo(3)], originalGroups), [1, 2]);
  assert.deepEqual(cache.restore('view', [1, 2], [photo(3)], [
    { groupId: 'b', rowIndex: 0, count: 1, size: 30 },
  ], 2).files.map(file => file.id), [1, 2, 3]);
  cache.remember(captureTrashUndoSnapshot('view', [photo(3)], [
    { groupId: 'b', rowIndex: 0, count: 1, size: 30 },
  ]), [3]);
  assert.equal(cache.restore('view', [3], [], null, 3).files[0].id, 3);
});

function optionsFor(files, extra = {}) {
  return {
    files: [photo(2, { thumbnail: 'loaded-2', rotate: 90 }), photo(3, { thumbnail: 'loaded-3' })],
    selectedIndex: 0, focusFileId: 1, viewport: { start: 0, end: 2 }, pageSize: 32,
    grouped: false, isCurrent: () => true,
    count: async () => [files.length, files.reduce((total, file) => total + file.size, 0)],
    position: async fileId => files.findIndex(file => file.id === fileId),
    loadFiles: async (offset, limit) => files.slice(offset, offset + limit),
    loadRows: async () => { throw new Error('Unexpected grouped query'); },
    groupHeader: group => ({ type: 'group', id: 'group-row-' + group.groupId, group_id: group.groupId, count: group.count }),
    cachedThumbnail: fileId => fileId === 1 ? 'cached-1' : null,
    ...extra,
  };
}

test('undo stages metadata without clearing the old list and preserves thumbnails by file ID, not index', async () => {
  const gate = deferred();
  const files = [photo(1), photo(2), photo(3)];
  const options = optionsFor(files, { loadFiles: async () => { await gate.promise; return files; } });
  const previous = options.files;
  const refreshing = prepareTrashUndoRefresh(options);
  await nextTick();
  assert.deepEqual(previous.map(file => file.id), [2, 3]);
  assert.equal(previous[0].isSelected, undefined);
  gate.resolve();
  const draft = await refreshing;
  assert.equal(draft.selectedIndex, 0);
  assert.deepEqual(draft.files.map(file => file.thumbnail), ['cached-1', 'loaded-2', 'loaded-3']);
  assert.equal(draft.files[1].rotate, 90);
  assert.equal(draft.totalFileSize, 60);
  assert.deepEqual(previous.map(file => file.id), [2, 3]);
});

test('a far-away restored photo loads only the old viewport and a bounded target neighborhood', async () => {
  const files = Array.from({ length: 20_000 }, (_, index) => photo(index + 1));
  const calls = [];
  const draft = await prepareTrashUndoRefresh(optionsFor(files, {
    focusFileId: 15_001, viewport: { start: 1000, end: 1010 },
    loadFiles: async (offset, limit) => { calls.push([offset, limit]); return files.slice(offset, offset + limit); },
  }));
  assert.equal(draft.selectedIndex, 15_000);
  assert.equal(draft.files[15_000].id, 15_001);
  assert.equal(draft.files[1000].id, 1001);
  assert.equal(draft.files[5000], null);
  assert.ok(calls.reduce((total, [, limit]) => total + limit, 0) < 100);
  assert.ok(calls.every(([, limit]) => limit <= 32));
});

test('restoring a filtered-out photo keeps the current photo selected instead of flashing the first item', async () => {
  const draft = await prepareTrashUndoRefresh(optionsFor([photo(3), photo(2)], { focusFileId: 99 }));
  assert.equal(draft.selectedIndex, 1);
  assert.equal(draft.files[draft.selectedIndex].id, 2);
});

test('empty views do not request pages or select a nonexistent photo', async () => {
  const draft = await prepareTrashUndoRefresh(optionsFor([], {
    loadFiles: async () => { throw new Error('Unexpected page'); },
    position: async () => { throw new Error('Unexpected position'); },
  }));
  assert.deepEqual(draft.files, []);
  assert.equal(draft.selectedIndex, -1);
});

test('a failed count, position or page query cannot publish an empty or incomplete replacement', async () => {
  for (const extra of [
    { count: async () => null },
    { position: async () => undefined },
    { loadFiles: async () => null },
    { loadFiles: async () => [] },
  ]) {
    const options = optionsFor([photo(1), photo(2), photo(3)], extra);
    await assert.rejects(prepareTrashUndoRefresh(options));
    assert.deepEqual(options.files.map(file => file.id), [2, 3]);
    assert.equal(options.files[0].thumbnail, 'loaded-2');
  }
});

function groupedOptions() {
  const groups = [
    { groupId: 'day-a', rowIndex: 0, count: 2, size: 30 },
    { groupId: 'day-b', rowIndex: 3, count: 1, size: 30 },
  ];
  const rows = [
    { type: 'group', group_id: 'day-a', count: 2 },
    { type: 'item', group_id: 'day-a', file_index: 0, file: photo(1) },
    { type: 'item', group_id: 'day-a', file_index: 1, file: photo(2) },
    { type: 'group', group_id: 'day-b', count: 1 },
    { type: 'item', group_id: 'day-b', file_index: 2, file: photo(3) },
  ];
  return optionsFor([photo(1), photo(2), photo(3)], {
    grouped: true, pageSize: 2, viewport: { start: 0, end: 4 },
    loadRows: async (offset, limit) => ({ rows: rows.slice(offset, offset + limit), groups, totalItemCount: 3, totalRowCount: 5, totalSize: 60 }),
    count: async () => { throw new Error('Unexpected flat count'); },
    loadFiles: async () => { throw new Error('Unexpected flat page'); },
  });
}

test('grouped undo stages headers, positions and thumbnails together before exposing any rows', async () => {
  const options = groupedOptions();
  options.focusFileId = 3;
  const draft = await prepareTrashUndoRefresh(options);
  assert.equal(draft.selectedIndex, 2);
  assert.deepEqual(draft.groups.map(group => group.count), [2, 1]);
  assert.equal(draft.totalRowCount, 5);
  assert.equal(draft.rows[2].file, draft.files[1]);
  assert.equal(draft.rows[4].file, draft.files[2]);
  assert.equal(draft.files[1].thumbnail, 'loaded-2');
  assert.equal(draft.files[2].thumbnail, 'loaded-3');
});

test('navigation during background preparation discards the old result', async () => {
  const gate = deferred();
  let current = true;
  const options = optionsFor([photo(1), photo(2), photo(3)], {
    isCurrent: () => current,
    loadFiles: async () => { await gate.promise; return [photo(1), photo(2), photo(3)]; },
  });
  const refreshing = prepareTrashUndoRefresh(options);
  await nextTick();
  current = false;
  gate.resolve();
  assert.equal(await refreshing, null);
  assert.deepEqual(options.files.map(file => file.id), [2, 3]);
});

test('client-side search selection prefers the restored photo, then the current photo, without a first-photo detour', () => {
  assert.equal(selectTrashUndoFile([photo(3), photo(1), photo(2)], 1, 2, 0), 1);
  assert.equal(selectTrashUndoFile([photo(3), photo(2)], 99, 2, 0), 1);
  assert.equal(selectTrashUndoFile([], 1, 2, 0), -1);
});

const content = await readFile(new URL('../src/components/Content.vue', import.meta.url), 'utf8');
const start = content.indexOf('async function refreshContentAfterTrashUndo(');
const contentCode = ts.transpile(content.slice(start, content.indexOf('async function updateContent(', start)), { target: ts.ScriptTarget.ES2022 });

function contentFixture(extra = {}) {
  const calls = [];
  const files = [photo(1), photo(2), photo(3)];
  const fileList = extra.fileList ?? ref([photo(2, { thumbnail: 'loaded-2' }), photo(3, { thumbnail: 'loaded-3' })]);
  const selectedItemIndex = extra.selectedItemIndex ?? ref(0);
  const contentReady = extra.contentReady ?? ref(true);
  const groupedRows = extra.groupedRows ?? ref([]);
  const groupedModeActive = extra.groupedModeActive ?? ref(false);
  const frames = [];
  const stop = watch([fileList, selectedItemIndex, contentReady, groupedRows], () => {
    frames.push({ ready: contentReady.value, ids: fileList.value.map(file => file?.id ?? null), selected: fileList.value[selectedItemIndex.value]?.id ?? null });
  }, { flush: 'post' });
  const deps = {
    fileList, selectedItemIndex, contentReady, groupedRows, groupedModeActive,
    isScanStreamingMode: ref(false), libConfig: { _libraryId: 'library-a' },
    updateContent: async () => { throw new Error('Undo must not clear the current content'); },
    invalidateThumbnailRequests: () => {}, currentQuerySource: ref('query'), tempViewMode: ref('none'),
    isGroupingSupportedForCurrentView: () => false, prepareTrashUndoRefresh,
    trashUndoCache: createTrashUndoCache(),
    getTrashUndoViewKey: () => deps.libConfig._libraryId + '/' + deps.currentQuerySource.value,
    isRealFileItem: file => typeof file?.id === 'number',
    selectionChunkSize: ref(200), visibleItemCount: ref(32),
    getCurrentQueryCountAndSum: async () => [3, 60],
    getCurrentQueryFilePosition: async fileId => files.findIndex(file => file.id === fileId),
    getCurrentQueryFiles: async (offset, limit) => files.slice(offset, offset + limit),
    createGroupHeaderRow: group => ({ type: 'group', group_id: group.groupId, count: group.count, size: group.size }),
    isItemRow: row => row?.type === 'item',
    getCachedThumbnailDataUrl: fileId => 'cached-' + fileId, config: { settings: { thumbnailSize: 256 } },
    getFileListThumb: async preparedFiles => { calls.push(['thumbnail', ...preparedFiles.map(file => file.id)]); },
    clearSelectionForFileListUpdate: () => calls.push(['clear-selection']),
    resetGroupingState: () => { groupedModeActive.value = false; groupedRows.value = []; },
    groupedTimelineGroups: ref([]), totalFileCount: ref(2), totalRowCount: ref(2), totalFileSize: ref(50),
    groupMetaMap: new Map(), fileIdToGroupId: new Map(), contentCountIsAuthoritative: ref(true), hasLoadedInitialResult: ref(true),
    markDedupSourceUpdated: () => {}, getCurrentQueryTimeLine: async () => [], timelineData: ref([]),
    nextTick, gridViewRef: ref({ refreshLayout: () => {}, scrollToItem: index => calls.push(['scroll', index]) }),
    syncSelectionToImageViewer: async index => calls.push(['viewer', index]),
    updateSelectedImage: async () => {}, fetchMissingVisibleThumbnails: async () => {},
    scrollToGroupedFile: async index => calls.push(['scroll-group', index]),
    console: { error: (...args) => calls.push(['error', ...args]) },
    ...extra,
  };
  const create = new Function(...Object.keys(deps),
    'let pendingFocusedFileId = null; let pendingInitialSelectedIndex = -1; let hasRestoredInitialSelection = false;'
    + 'let pendingRestoreScrollTop = { value: null }; let currentContentRequestId = 1; let contentUpdateSeq = 0;'
    + 'let pendingSelectionRestore = null; let lastVisibleRange = { start: 0, end: 2 }; let visibleRangeSeqId = 0;'
    + contentCode + '; return { run: refreshContentAfterTrashUndo, invalidate: () => { currentContentRequestId++; } };');
  const state = create(...Object.values(deps));
  return { ...state, deps, calls, frames, stop };
}

function rememberDeletion(fixture, files, deletedIds, groups = null) {
  fixture.deps.trashUndoCache.remember(captureTrashUndoSnapshot(fixture.deps.getTrashUndoViewKey(), files, groups), deletedIds);
}

test('cached undo switches the main photo and filmstrip before count, position or page queries finish', async () => {
  for (const waitingFor of ['count', 'position', 'page']) {
    const gate = deferred();
    const started = deferred();
    const files = [photo(1), photo(2), photo(3)];
    const wait = async result => { started.resolve(); await gate.promise; return result; };
    const fixture = contentFixture({
      getCurrentQueryCountAndSum: () => waitingFor === 'count' ? wait([3, 60]) : Promise.resolve([3, 60]),
      getCurrentQueryFilePosition: fileId => waitingFor === 'position' ? wait(fileId - 1) : Promise.resolve(fileId - 1),
      getCurrentQueryFiles: (offset, limit) => waitingFor === 'page' ? wait(files.slice(offset, offset + limit)) : Promise.resolve(files.slice(offset, offset + limit)),
      getFileListThumb: async () => { throw new Error('Cached undo must not wait for a thumbnail'); },
    });
    try {
      rememberDeletion(fixture, [photo(1, { thumbnail: 'deleted-1' }), photo(2), photo(3)], [1]);
      const refreshing = fixture.run(1, [1]);
      await started.promise;
      await nextTick();
      assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [1, 2, 3]);
      assert.equal(fixture.deps.selectedItemIndex.value, 0);
      assert.equal(fixture.deps.fileList.value[0].thumbnail, 'deleted-1');
      assert.equal(fixture.deps.fileList.value[0].trashUndoPreview, true);
      assert.equal(fixture.deps.totalFileCount.value, 3);
      assert.equal(fixture.deps.totalFileSize.value, 60);
      assert.ok(fixture.frames.every(frame => frame.ready && frame.selected === 1 && frame.ids.join(',') === '1,2,3'));
      assert.deepEqual(fixture.calls.filter(call => call[0] === 'scroll'), [['scroll', 0]]);
      gate.resolve();
      await refreshing;
      assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
      assert.deepEqual(fixture.calls.filter(call => call[0] === 'scroll'), [['scroll', 0]]);
    } finally { gate.resolve(); fixture.stop(); }
  }
});

test('deleting the first two photos then undoing twice instantly selects each restored photo, even at index zero', async () => {
  const gate = deferred();
  let files = [photo(2), photo(3)];
  const fixture = contentFixture({
    fileList: ref([photo(3)]),
    getCurrentQueryCountAndSum: async () => { await gate.promise; return [files.length, 60]; },
    getCurrentQueryFiles: async (offset, limit) => files.slice(offset, offset + limit),
    getCurrentQueryFilePosition: async fileId => files.findIndex(file => file.id === fileId),
  });
  try {
    rememberDeletion(fixture, [photo(1, { thumbnail: 'deleted-1' }), photo(2), photo(3)], [1]);
    rememberDeletion(fixture, [photo(2, { thumbnail: 'deleted-2' }), photo(3)], [2]);
    const first = fixture.run(2);
    await nextTick();
    assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [2, 3]);
    assert.equal(fixture.deps.fileList.value[0].thumbnail, 'deleted-2');
    files = [photo(1), photo(2), photo(3)];
    const second = fixture.run(1);
    await nextTick();
    assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [1, 2, 3]);
    assert.equal(fixture.deps.fileList.value[fixture.deps.selectedItemIndex.value].id, 1);
    gate.resolve();
    await Promise.all([first, second]);
    assert.ok(fixture.frames.every(frame => frame.selected === frame.ids[0] && frame.ready));
    assert.equal(fixture.deps.fileList.value[0].id, 1);
  } finally { gate.resolve(); fixture.stop(); }
});

test('background reconciliation neither steals a new selection nor clears the cached result on failure', async () => {
  for (const fails of [false, true]) {
    const gate = deferred();
    const started = deferred();
    const fixture = contentFixture({ getCurrentQueryFiles: async () => {
      started.resolve();
      await gate.promise;
      return fails ? null : [photo(1), photo(2), photo(3)];
    } });
    try {
      rememberDeletion(fixture, [photo(1), photo(2), photo(3)], [1]);
      const refreshing = fixture.run(1);
      await started.promise;
      fixture.deps.selectedItemIndex.value = 2;
      await nextTick();
      gate.resolve();
      await refreshing;
      assert.equal(fixture.deps.fileList.value[fixture.deps.selectedItemIndex.value].id, 3);
      assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [1, 2, 3]);
      assert.deepEqual(fixture.calls.filter(call => call[0] === 'scroll'), [['scroll', 0]]);
      assert.equal(fixture.calls.some(call => call[0] === 'error'), fails);
    } finally { gate.resolve(); fixture.stop(); }
  }
});

test('cached search results restore relevance groups without a slow re-search or a focus-stealing reload', async () => {
  const fixture = contentFixture({ currentQuerySource: ref('search'), currentSearchFileIds: ref([2, 3]) });
  try {
    rememberDeletion(fixture, [photo(3), photo(1), photo(2)], [1]);
    fixture.deps.fileList.value = [photo(3), photo(2)];
    let checkedSearchIds = false;
    fixture.deps.gridViewRef.value.refreshLayout = () => {
      assert.deepEqual(fixture.deps.currentSearchFileIds.value, [3, 1, 2]);
      checkedSearchIds = true;
    };
    await fixture.run(1);
    assert.equal(checkedSearchIds, true);
    assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [3, 1, 2]);
    assert.equal(fixture.deps.selectedItemIndex.value, 1);
    assert.deepEqual(fixture.deps.currentSearchFileIds.value, [3, 1, 2]);
    assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
  } finally { fixture.stop(); }
});

test('cached grouped queries, collections and smart albums expose restored headers and selection before querying any rows', async () => {
  for (const source of ['query', 'collection', 'smart']) {
    const gate = deferred();
    const started = deferred();
    const options = groupedOptions();
    const fixture = contentFixture({
      currentQuerySource: ref(source), currentCollectionId: ref(9), currentSmartQueryParams: ref({}),
      groupedModeActive: ref(true),
      groupedTimelineGroups: ref([
        { groupId: 'day-a', rowIndex: 0, count: 1, size: 20 },
        { groupId: 'day-b', rowIndex: 2, count: 1, size: 30 },
      ]),
      isGroupingSupportedForCurrentView: () => true,
      getGroupingQueryParams: () => ({ groupBy: 1 }),
      getGroupedFilePosition: async (_params, fileId) => fileId - 1,
      getCollectionGroupFileIds: async (_collectionId, _params, groupId) => groupId === 'day-a' ? [1, 2] : [3],
      getSmartGroupFileIds: async (_params, groupId) => groupId === 'day-a' ? [1, 2] : [3],
      getCurrentGroupedQueryRows: async (offset, limit) => {
        started.resolve();
        await gate.promise;
        return options.loadRows(offset, limit);
      },
      normalizeGroupedRowsResult: result => result,
      normalizeGridRow: row => row,
      refreshDedupSmartFileIds: async () => {},
    });
    try {
      rememberDeletion(fixture, [photo(1), photo(2), photo(3)], [1], [
        { groupId: 'day-a', rowIndex: 0, count: 2, size: 30 },
        { groupId: 'day-b', rowIndex: 3, count: 1, size: 30 },
      ]);
      const refreshing = fixture.run(1);
      await started.promise;
      assert.equal(fixture.deps.fileList.value[fixture.deps.selectedItemIndex.value].id, 1);
      assert.equal(fixture.deps.groupedRows.value[1].file, fixture.deps.fileList.value[0]);
      assert.equal(fixture.deps.groupedRows.value[0].count, 2);
      assert.equal(fixture.deps.totalRowCount.value, 5);
      gate.resolve();
      await refreshing;
      assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
      assert.ok(fixture.frames.every(frame => frame.ready && frame.selected === 1 && frame.ids.join(',') === '1,2,3'));
    } finally { gate.resolve(); fixture.stop(); }
  }
});

test('deleting again during cached reconciliation does not resurrect or reselect the deleted photo', async () => {
  const gate = deferred();
  const started = deferred();
  let files = [photo(1), photo(2), photo(3)];
  const fixture = contentFixture({
    getCurrentQueryCountAndSum: async () => [files.length, 50],
    getCurrentQueryFilePosition: async fileId => files.findIndex(file => file.id === fileId),
    getCurrentQueryFiles: async (offset, limit) => {
      const page = files.slice(offset, offset + limit);
      started.resolve();
      await gate.promise;
      return page;
    },
  });
  try {
    rememberDeletion(fixture, files, [1]);
    const refreshing = fixture.run(1);
    await started.promise;
    fixture.deps.fileList.value.splice(0, 1);
    files = files.slice(1);
    await nextTick();
    gate.resolve();
    await refreshing;
    assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [2, 3]);
    assert.equal(fixture.deps.selectedItemIndex.value, 0);
    assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
    assert.deepEqual(fixture.calls.filter(call => call[0] === 'scroll'), [['scroll', 0]]);
  } finally { gate.resolve(); fixture.stop(); }
});

test('a cached undo background result cannot overwrite another library or a newly opened view', async () => {
  const gate = deferred();
  const started = deferred();
  const fixture = contentFixture({ getCurrentQueryCountAndSum: async () => {
    started.resolve();
    await gate.promise;
    return [3, 60];
  } });
  try {
    rememberDeletion(fixture, [photo(1), photo(2), photo(3)], [1]);
    const refreshing = fixture.run(1);
    await started.promise;
    fixture.invalidate();
    fixture.deps.libConfig._libraryId = 'library-b';
    fixture.deps.fileList.value = [photo(90)];
    gate.resolve();
    await refreshing;
    assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [90]);
    assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
  } finally { gate.resolve(); fixture.stop(); }
});

test('the main image uses the restored cached thumbnail while the full-resolution image loads', async () => {
  const viewer = await readFile(new URL('../src/components/MediaViewer.vue', import.meta.url), 'utf8');
  assert.ok(viewer.includes(':showThumbnailPlaceholder="showThumbnailPlaceholder || !!file?.trashUndoPreview"'));
});

test('the actual undo consumer keeps the main photo and thumbnails mounted until metadata and the target thumbnail are ready', async () => {
  const gate = deferred();
  const started = deferred();
  const fixture = contentFixture({
    getCachedThumbnailDataUrl: () => null,
    getFileListThumb: async () => { started.resolve(); await gate.promise; },
  });
  try {
    const refreshing = fixture.run(1);
    await started.promise;
    await nextTick();
    assert.equal(fixture.deps.fileList.value[0].id, 2);
    assert.equal(fixture.deps.contentReady.value, true);
    assert.equal(fixture.frames.length, 0);
    gate.resolve();
    await refreshing;
    await nextTick();
    assert.ok(fixture.frames.length > 0);
    assert.ok(fixture.frames.every(frame => frame.ready && frame.ids.join(',') === '1,2,3' && frame.selected === 1));
    assert.equal(fixture.deps.fileList.value[1].thumbnail, 'loaded-2');
    assert.deepEqual(fixture.calls.filter(call => call[0] === 'scroll'), [['scroll', 0]]);
    assert.deepEqual(fixture.calls.filter(call => call[0] === 'viewer'), [['viewer', 0]]);
    assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
  } finally { fixture.stop(); }
});

test('failed metadata refresh leaves the existing photo and thumbnail frames untouched', async () => {
  const fixture = contentFixture({ getCurrentQueryFiles: async () => null });
  try {
    await fixture.run(1);
    assert.equal(fixture.frames.length, 0);
    assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [2, 3]);
    assert.equal(fixture.calls.some(call => call[0] === 'error'), true);
  } finally { fixture.stop(); }
});

test('a layout error after committing the restored photo does not restart the refresh', async () => {
  let layoutCalls = 0;
  let countCalls = 0;
  const fixture = contentFixture({
    getCurrentQueryCountAndSum: async () => { countCalls++; return [3, 60]; },
    gridViewRef: ref({ refreshLayout: () => {
      if (++layoutCalls === 1) throw new Error('Layout unavailable');
    } }),
  });
  try {
    await fixture.run(1);
    assert.equal(layoutCalls, 1);
    assert.equal(countCalls, 1);
    assert.equal(fixture.deps.fileList.value[fixture.deps.selectedItemIndex.value].id, 1);
    assert.ok(fixture.frames.every(frame => frame.ready && frame.selected === 1));
    assert.equal(fixture.calls.filter(call => call[0] === 'error').length, 1);
  } finally { fixture.stop(); }
});

test('a newer undo wins even when the previous background request finishes later', async () => {
  const gate = deferred();
  let countCalls = 0;
  const fixture = contentFixture({ getCurrentQueryCountAndSum: async () => {
    if (++countCalls === 1) await gate.promise;
    return [3, 60];
  } });
  try {
    const first = fixture.run(1);
    await fixture.run(3);
    gate.resolve();
    await first;
    assert.equal(fixture.deps.fileList.value[fixture.deps.selectedItemIndex.value].id, 3);
    assert.ok(fixture.frames.every(frame => frame.selected === 3));
  } finally { fixture.stop(); }
});

test('switching libraries during thumbnail preparation cannot apply the previous library result', async () => {
  const gate = deferred();
  const fixture = contentFixture({ getCachedThumbnailDataUrl: () => null, getFileListThumb: async () => gate.promise });
  try {
    const refreshing = fixture.run(1);
    await nextTick();
    fixture.deps.libConfig._libraryId = 'library-b';
    gate.resolve();
    await refreshing;
    assert.equal(fixture.frames.length, 0);
  } finally { fixture.stop(); }
});

test('a deletion completed during undo preparation is not resurrected by the stale draft', async () => {
  const gate = deferred();
  let files = [photo(1), photo(2), photo(3)];
  const fixture = contentFixture({
    getCachedThumbnailDataUrl: () => null,
    getFileListThumb: async () => gate.promise,
    getCurrentQueryCountAndSum: async () => [files.length, files.reduce((total, file) => total + file.size, 0)],
    getCurrentQueryFiles: async (offset, limit) => files.slice(offset, offset + limit),
  });
  try {
    const refreshing = fixture.run(1);
    await nextTick();
    fixture.deps.fileList.value.splice(1, 1);
    files = files.filter(file => file.id !== 3);
    gate.resolve();
    await refreshing;
    assert.deepEqual(fixture.deps.fileList.value.map(file => file?.id), [1, 2]);
    assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
  } finally { fixture.stop(); }
});

test('the actual grouped consumer commits restored group metadata and file focus together for queries, collections and smart albums', async () => {
  for (const source of ['query', 'collection', 'smart']) {
    const options = groupedOptions();
    const fixture = contentFixture({
      currentQuerySource: ref(source), currentCollectionId: ref(9), currentSmartQueryParams: ref({}),
      isGroupingSupportedForCurrentView: () => true,
      getGroupingQueryParams: () => ({ groupBy: 1 }),
      getGroupedFilePosition: async (_params, fileId) => fileId - 1,
      getCollectionGroupFileIds: async (_collectionId, _params, groupId) => groupId === 'day-a' ? [1, 2] : [3],
      getSmartGroupFileIds: async (_params, groupId) => groupId === 'day-a' ? [1, 2] : [3],
      getCurrentGroupedQueryRows: options.loadRows,
      normalizeGroupedRowsResult: result => result,
      normalizeGridRow: row => row,
      refreshDedupSmartFileIds: async () => {},
    });
    try {
      await fixture.run(3);
      assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
      assert.equal(fixture.deps.groupedModeActive.value, true);
      assert.equal(fixture.deps.fileList.value[fixture.deps.selectedItemIndex.value].id, 3);
      assert.deepEqual(fixture.deps.groupedTimelineGroups.value.map(group => group.count), [2, 1]);
      assert.ok(fixture.frames.every(frame => frame.ready && frame.selected === 3 && frame.ids.length === 3));
      assert.deepEqual(fixture.calls.filter(call => call[0] === 'scroll-group'), [['scroll-group', 2]]);
    } finally { fixture.stop(); }
  }
});
