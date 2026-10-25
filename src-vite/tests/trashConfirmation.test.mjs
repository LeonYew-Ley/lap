import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp, computed, nextTick, ref, watch } from 'vue';
import { createPinia, defineStore } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import ts from 'typescript';
import vm from 'node:vm';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const [content, folder, store, main, settings] = await Promise.all([
  read('../src/components/Content.vue'), read('../src/components/AlbumFolder.vue'),
  read('../src/stores/configStore.js'), read('../src/main.js'), read('../src/views/Settings.vue'),
]);
const undoHelpers = {};
new Function('exports', ts.transpile(await read('../src/common/trashUndoRefresh.ts'), {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}))(undoHelpers);

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return ts.transpile(source.slice(from, to), { target: ts.ScriptTarget.ES2022 });
}

const context = vm.createContext({ console });
const storeModule = new vm.SourceTextModule(store, { context });
await storeModule.link(specifier => {
  const exports = specifier === 'pinia' ? { defineStore }
    : specifier === '@/common/i18n' ? { i18n: { global: { locale: ref('en') } }, loadLanguage: async () => {} }
    : { SIDEBAR: { ALBUM: 1 }, MAP_MARKER_SIZES: [64] };
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await storeModule.evaluate();

function storageFixture(initial) {
  const data = new Map(initial ? [['configStore', JSON.stringify(initial)]] : []);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

function configFixture(storage = storageFixture()) {
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage }));
  createApp({}).use(pinia);
  return storeModule.namespace.useConfigStore(pinia);
}

function contentFixture(config = configFixture(), resultOverride) {
  const files = [1, 2].map(id => ({ id, album_id: 1, name: `${id}.jpg`, file_path: `/photos/${id}.jpg`, size: 10, isSelected: true }));
  const calls = { trash: [], batch: [], dedup: [], errors: [], events: [] };
  const success = ids => ({ deletedFileIds: ids, deletedCount: ids.length, failedCount: 0 });
  const deps = {
    config, computed, currentOriginalsUnavailable: () => false, selectMode: ref(false), selectedCount: ref(2),
    dedupReclaimBytes: ref(0), dedupTrashGroupKey: ref(''), dedupDeleteFileIds: ref([]), dedupBulkFileCount: ref(0),
    doNotAskAgain: ref(false), showTrashMsgbox: ref(false), isTrashDeleting: ref(false),
    fileList: ref(files), selectedItemIndex: ref(0), totalFileCount: ref(2), totalFileSize: ref(20),
    captureTrashUndoView: () => undoHelpers.captureTrashUndoSnapshot('view', deps.fileList.value, null),
    trashUndoCache: undoHelpers.createTrashUndoCache(),
    isDedupPanelOpen: ref(false), dedupPaneRef: ref({ refreshGroups: async () => {} }),
    localeMsg: ref({ msgbox: { move_to_trash: {
      file_success: 'Trashed {file}', files_success: 'Trashed {count}', file_error: 'Trash failed', files_error: 'Batch trash failed',
    } }, info_panel: { dedup: { no_removable_files: 'No removable files' } } }),
    deleteFile: async (...args) => { calls.trash.push(args); return resultOverride ?? success([args[0]]); },
    batchDeleteFiles: async (items, permanently) => { calls.batch.push([items, permanently]); return resultOverride ?? success(items.map(item => item.fileId)); },
    dedupDelete: async request => { calls.dedup.push(request); return resultOverride ?? success(request.fileIds ?? [1, 2]); },
    getFileInfo: async id => files.find(file => file.id === id),
    getActionableSelectedItemsForAction: async () => deps.fileList.value.filter(file => file.isSelected),
    rebuildSelectionAfterListMutation: ids => {
      deps.selectedCount.value = ids.size;
      deps.fileList.value.forEach(file => { file.isSelected = ids.has(file.id); });
    },
    refreshGroupedRowsAfterDelete: async () => {}, refreshAffectedAlbums: async () => {}, refreshLibraryTotalCount: async () => {},
    isSearchLikeView: ref(false), tempViewMode: ref('none'), timelineData: ref([]), getCurrentQueryTimeLine: async () => [],
    removeDeletedFilesFromImageViewerSession: () => 0, tauriEmit: (...args) => calls.events.push(args),
    updateSelectedImage: () => {}, t: key => key, console: { error() {}, log() {} },
    toast: { success() {}, warning() {}, error: message => calls.errors.push(message) },
  };
  const code = section(content, 'const openTrashMsgbox =', 'const rawJpegCompanionDeleteCount')
    + section(content, 'const getDeleteFileSuccessMessage =', 'async function refreshGroupedRowsAfterDelete');
  const actions = new Function(...Object.keys(deps), code + 'return { openTrashMsgbox, openAllDuplicatesTrashMsgbox, closeTrashMsgbox, handleTrashMsgboxOk };')(...Object.values(deps));
  return { ...actions, deps, calls };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('new and existing installations confirm by default; only an explicit false disables confirmation', () => {
  assert.equal(configFixture().settings.confirmBeforeTrash, true);
  for (const value of [undefined, null, 'false', true, false]) {
    const config = configFixture(storageFixture({ settings: { language: 'en', confirmBeforeTrash: value } }));
    assert.equal(config.settings.confirmBeforeTrash, value !== false);
  }
});

test('quick undo defaults to five entries, validates limits and persists setting changes', async () => {
  assert.equal(configFixture().settings.trashUndoLimit, 5);
  for (const [value, expected] of [[undefined, 5], [null, 5], [0, 5], [-1, 5], ['bad', 5], [2.9, 2], [200, 100]]) {
    assert.equal(configFixture(storageFixture({ settings: { trashUndoLimit: value } })).settings.trashUndoLimit, expected);
  }
  const storage = storageFixture();
  const config = configFixture(storage);
  config.setTrashUndoLimit(12);
  await nextTick();
  assert.equal(configFixture(storage).settings.trashUndoLimit, 12);
  config.setTrashUndoLimit(0);
  assert.equal(config.settings.trashUndoLimit, 5);
});

test('checking Do not ask again then canceling neither deletes nor persists the opt-out', () => {
  const fixture = contentFixture();
  fixture.openTrashMsgbox();
  assert.equal(fixture.deps.showTrashMsgbox.value, true);
  fixture.deps.doNotAskAgain.value = true;
  fixture.closeTrashMsgbox();
  fixture.openTrashMsgbox();
  assert.equal(fixture.deps.doNotAskAgain.value, false);
  assert.equal(fixture.deps.config.settings.confirmBeforeTrash, true);
  assert.deepEqual(fixture.calls.trash, []);
});

test('confirmed opt-out persists across restarts and Settings can restore confirmation', async () => {
  const storage = storageFixture();
  const first = contentFixture(configFixture(storage));
  first.openTrashMsgbox();
  first.deps.doNotAskAgain.value = true;
  await first.handleTrashMsgboxOk();
  await nextTick();
  const reopened = contentFixture(configFixture(storage));
  assert.equal(reopened.deps.config.settings.confirmBeforeTrash, false);
  reopened.openTrashMsgbox();
  await settle();
  assert.equal(reopened.deps.showTrashMsgbox.value, false);
  assert.deepEqual(reopened.calls.trash, [[1, '/photos/1.jpg']]);
  reopened.deps.config.setConfirmBeforeTrash(true);
  reopened.openTrashMsgbox();
  assert.equal(reopened.deps.showTrashMsgbox.value, true);
  assert.equal(reopened.calls.trash.length, 1);
});

test('confirming without the checkbox keeps the next confirmation enabled', async () => {
  const fixture = contentFixture();
  fixture.openTrashMsgbox();
  await fixture.handleTrashMsgboxOk();
  fixture.openTrashMsgbox();
  assert.equal(fixture.deps.showTrashMsgbox.value, true);
});

test('multi-select partial failures keep failed files selected without permanent-delete fallback', async () => {
  const fixture = contentFixture(undefined, { deletedFileIds: [1], failedCount: 1, trashFailedFileIds: [2] });
  fixture.deps.config.setConfirmBeforeTrash(false);
  fixture.deps.selectMode.value = true;
  fixture.openTrashMsgbox();
  await settle();
  assert.equal(fixture.calls.batch.length, 1);
  assert.equal(fixture.calls.batch[0][1], false);
  assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [2]);
  assert.equal(fixture.deps.fileList.value[0].isSelected, true);
  assert.equal(fixture.deps.selectedCount.value, 1);
  assert.deepEqual(fixture.calls.errors, ['Batch trash failed']);
  assert.equal(fixture.deps.showTrashMsgbox.value, false);
});

test('a failed trash leaves the file visible and releases the deletion lock', async () => {
  const fixture = contentFixture(undefined, { deletedFileIds: [], failedCount: 1, trashFailedFileIds: [1] });
  fixture.openTrashMsgbox();
  await fixture.handleTrashMsgboxOk();
  assert.equal(fixture.deps.fileList.value.length, 2);
  assert.deepEqual(fixture.calls.errors, ['Trash failed']);
  assert.deepEqual(fixture.calls.events, []);
  assert.equal(fixture.deps.isTrashDeleting.value, false);
  assert.equal(fixture.deps.showTrashMsgbox.value, false);
});

test('repeated Delete while an operation is pending cannot trash the next photo', async () => {
  const fixture = contentFixture();
  fixture.deps.config.setConfirmBeforeTrash(false);
  fixture.openTrashMsgbox();
  fixture.openTrashMsgbox();
  await fixture.handleTrashMsgboxOk();
  await settle();
  assert.equal(fixture.calls.trash.length, 1);
  assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [2]);
});

test('browsing to another photo during trash does not remove that photo from the list', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const fixture = contentFixture(undefined, pending);
  fixture.deps.config.setConfirmBeforeTrash(false);
  fixture.openTrashMsgbox();
  fixture.deps.selectedItemIndex.value = 1;
  complete({ deletedFileIds: [1], failedCount: 0 });
  await settle();
  assert.deepEqual(fixture.deps.fileList.value.map(file => file.id), [2]);
  assert.equal(fixture.deps.selectedItemIndex.value, 0);
});

test('Delete still works after an atomic undo refresh leaves unloaded virtual slots before the current photo', async () => {
  const fixture = contentFixture();
  fixture.deps.fileList.value.unshift(null);
  fixture.deps.selectedItemIndex.value = 1;
  fixture.openTrashMsgbox();
  await fixture.handleTrashMsgboxOk();
  assert.deepEqual(fixture.calls.trash, [[1, '/photos/1.jpg']]);
  assert.deepEqual(fixture.deps.fileList.value.map(file => file?.id ?? null), [null, 2]);
  assert.equal(fixture.deps.selectedItemIndex.value, 1);
  assert.deepEqual(fixture.calls.errors, []);
});

test('the actual deletion path caches metadata only for successfully recycled photos', async () => {
  for (const batch of [false, true]) {
    const fixture = contentFixture(undefined, { deletedFileIds: [1], deletedCount: 1, failedCount: batch ? 1 : 0 });
    fixture.deps.selectMode.value = batch;
    fixture.openTrashMsgbox();
    await fixture.handleTrashMsgboxOk();
    const draft = fixture.deps.trashUndoCache.restore('view', [1], fixture.deps.fileList.value, null, 1);
    assert.deepEqual(draft.files.map(file => file.id), [1, 2]);
    assert.equal(draft.selectedIndex, 0);
    assert.equal(draft.files[0].file_path, '/photos/1.jpg');
    assert.equal(fixture.deps.trashUndoCache.restore('view', [2], [], null, 2), null);
  }
  const failed = contentFixture(undefined, { deletedFileIds: [], deletedCount: 0, failedCount: 1 });
  failed.openTrashMsgbox();
  await failed.handleTrashMsgboxOk();
  assert.equal(failed.deps.trashUndoCache.restore('view', [1], [failed.deps.fileList.value[1]], null, 1), null);
});

test('selected duplicates, similar photos and delete-all obey the preference and use trash only', async () => {
  for (const group of ['12', 'similar:12', 'all']) {
    const fixture = contentFixture();
    fixture.deps.config.setConfirmBeforeTrash(false);
    if (group === 'all') fixture.openAllDuplicatesTrashMsgbox(2, 20);
    else fixture.openTrashMsgbox(20, group, [1, 2]);
    await settle();
    assert.equal(fixture.deps.showTrashMsgbox.value, false);
    if (group === 'similar:12') assert.equal(fixture.calls.batch[0][1], false);
    else assert.equal(fixture.calls.dedup[0].permanently, undefined);
  }
});

function folderFixture(config = configFixture(), result = 1) {
  const target = { id: 1, name: 'folder', path: '/photos/folder' };
  const calls = { trash: [], errors: [] };
  const deps = {
    config, isTrashDeleting: ref(false), isRenamingFolder: ref(false), isCreatingFolder: ref(false), disposed: false,
    props: { unavailable: false, rootPath: '/photos', albumId: 1, children: [target], showFolderActions: false },
    isDirectoryAccessible: async () => true, selectedFolder: ref(target),
    selection: { folderPath: ref(target.path), folderId: ref(1) }, clickFolder: async () => {},
    doNotAskAgain: ref(false), showTrashFolderMsgbox: ref(false),
    deleteFolder: async path => { calls.trash.push(path); return result; },
    t: key => key, getFolderByPath: () => undefined, console: { error() {} },
    toast: { success() {}, error: message => calls.errors.push(message) },
  };
  const code = section(folder, 'async function startDeleteFolder(', '// more menuitems')
    + section(folder, 'const clickTrashFolder =', '/// toggle whether folder');
  const actions = new Function(...Object.keys(deps), code + 'return { startDeleteFolder, clickTrashFolder };')(...Object.values(deps));
  return { ...actions, deps, calls, target };
}

test('folder deletion shares the persistent confirmation preference', async () => {
  const fixture = folderFixture();
  await fixture.startDeleteFolder(fixture.target);
  assert.equal(fixture.deps.showTrashFolderMsgbox.value, true);
  assert.deepEqual(fixture.calls.trash, []);
  fixture.deps.doNotAskAgain.value = true;
  await fixture.clickTrashFolder();
  assert.equal(fixture.deps.config.settings.confirmBeforeTrash, false);
  assert.deepEqual(fixture.calls.trash, [fixture.target.path]);
  const next = folderFixture(fixture.deps.config);
  await next.startDeleteFolder(next.target);
  assert.equal(next.deps.showTrashFolderMsgbox.value, false);
  assert.equal(next.calls.trash.length, 1);
});

test('folder trash failure keeps the folder and never offers permanent deletion', async () => {
  const fixture = folderFixture(undefined, 0);
  fixture.deps.config.setConfirmBeforeTrash(false);
  await fixture.startDeleteFolder(fixture.target);
  assert.equal(fixture.deps.props.children.length, 1);
  assert.deepEqual(fixture.calls.errors, ['msgbox.move_to_trash.folder_error']);
  assert.equal(fixture.deps.isTrashDeleting.value, false);
});

test('an already-open Settings window receives the opt-out and re-enables it in the main window', async () => {
  const mainConfig = configFixture();
  const settingsConfig = configFixture();
  const listeners = new Map();
  const listen = (name, callback) => listeners.set(name, callback);
  const emit = async (name, payload) => listeners.get(name)?.({ payload });
  const sync = section(main, 'if (isMainWindow) {', '// Load only');
  for (const [isMainWindow, config] of [[true, mainConfig], [false, settingsConfig]]) {
    new Function('isMainWindow', 'isSettingsWindow', 'config', 'listen', 'emit', 'let settingsSyncRequest = 0;' + sync)(isMainWindow, !isMainWindow, config, listen, emit);
  }
  const mainListener = section(main, "  listen('settings-confirmBeforeTrash-changed'", "  listen('settings-autoCheckUpdates-changed'");
  new Function('config', 'listen', mainListener)(mainConfig, listen);
  const watcher = section(settings, 'watch(() => config.settings.confirmBeforeTrash,', 'watch(() => config.settings.autoCheckUpdates,');
  const stops = [];
  vm.runInNewContext(watcher, { config: settingsConfig, watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; }, emit });
  try {
    mainConfig.setConfirmBeforeTrash(false);
    await nextTick();
    assert.equal(settingsConfig.settings.confirmBeforeTrash, false);
    settingsConfig.setConfirmBeforeTrash(true);
    await nextTick();
    assert.equal(mainConfig.settings.confirmBeforeTrash, true);
  } finally {
    stops.forEach(stop => stop());
  }
});

test('undo cache limits synchronize in both directions between main and Settings windows', async () => {
  const mainConfig = configFixture();
  const settingsConfig = configFixture();
  const listeners = new Map();
  const listen = (name, callback) => listeners.set(name, callback);
  const emit = async (name, payload) => listeners.get(name)?.({ payload });
  const sync = section(main, 'if (isMainWindow) {', '// Load only');
  for (const [isMainWindow, config] of [[true, mainConfig], [false, settingsConfig]]) {
    new Function('isMainWindow', 'isSettingsWindow', 'config', 'listen', 'emit', 'let settingsSyncRequest = 0;' + sync)(isMainWindow, !isMainWindow, config, listen, emit);
  }
  const mainListener = section(main, "  listen('settings-trashUndoLimit-changed'", "  listen('settings-autoCheckUpdates-changed'");
  new Function('config', 'listen', mainListener)(mainConfig, listen);
  const watcher = section(settings, 'watch(() => config.settings.trashUndoLimit,', 'watch(() => config.settings.autoCheckUpdates,');
  const stop = vm.runInNewContext(watcher, { config: settingsConfig, watch, emit });
  try {
    mainConfig.setTrashUndoLimit(9);
    await nextTick();
    assert.equal(settingsConfig.settings.trashUndoLimit, 9);
    settingsConfig.setTrashUndoLimit(3);
    await nextTick();
    assert.equal(mainConfig.settings.trashUndoLimit, 3);
  } finally {
    stop();
  }
});
