import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';

class Element {
  constructor(editing = false) { this.editing = editing; }
  closest() { return this.editing ? this : null; }
}

const source = await readFile(new URL('../src/common/trashUndo.ts', import.meta.url), 'utf8');
const context = vm.createContext({ Element });
vm.runInContext(ts.transpile(source.replace('export ', ''), { target: ts.ScriptTarget.ES2022 }), context);
const matches = (overrides = {}, mac = false, inputActive = false) => context.isTrashUndoShortcut({
  key: 'z', code: 'KeyZ', ctrlKey: !mac, metaKey: mac, altKey: false, shiftKey: false,
  repeat: false, isComposing: false, target: new Element(), ...overrides,
}, mac, inputActive);

test('Ctrl+Z and Cmd+Z use the platform modifier', () => {
  assert.equal(matches(), true);
  assert.equal(matches({}, true), true);
  assert.equal(matches({ ctrlKey: false, metaKey: true }), false);
  assert.equal(matches({ ctrlKey: true, metaKey: false }, true), false);
});

test('typing, editable elements, dialogs, repeats and redo are not intercepted', () => {
  for (const override of [
    { target: new Element(true) }, { shiftKey: true }, { altKey: true },
    { repeat: true }, { isComposing: true }, { key: 'y', code: 'KeyY' },
  ]) assert.equal(matches(override), false);
  assert.equal(matches({}, false, true), false);
});

async function keydownFixture(inputStack = []) {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('const handleKeyDown ='), app.indexOf('async function undoLastTrash()'));
  const calls = [];
  const uiStore = { inputStack, isInputActive: name => inputStack.at(-1) === name };
  const handleKeyDown = new Function(
    'Element', 'uiStore', 'useUIStore', 'isMac', 'isTrashUndoShortcut',
    'handleMainWindowScaleShortcut', 'matchesShortcut', 'undoLastTrash', 'emit',
    code + '; return handleKeyDown;',
  )(
    Element, uiStore, () => uiStore, false, context.isTrashUndoShortcut,
    () => false, () => false, () => calls.push(['undo']),
    (...args) => calls.push(args),
  );
  const dispatch = (overrides = {}) => handleKeyDown({
    key: 'Delete', code: 'Delete', ctrlKey: false, metaKey: false,
    shiftKey: false, altKey: false, target: new Element(),
    preventDefault: () => calls.push(['preventDefault']),
    stopImmediatePropagation: () => calls.push(['stopImmediatePropagation']),
    ...overrides,
  });
  return { dispatch, calls };
}

test('the actual App capture handler forwards Delete without a store initialization error', async () => {
  const fixture = await keydownFixture();
  assert.doesNotThrow(() => fixture.dispatch());
  assert.deepEqual(fixture.calls, [['global-keydown', {
    key: 'Delete', code: 'Delete', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  }]]);
});

test('the actual App capture handler preserves navigation and copy shortcuts', async () => {
  for (const event of [
    { key: 'ArrowRight', code: 'ArrowRight' },
    { key: 'c', code: 'KeyC', ctrlKey: true },
  ]) {
    const fixture = await keydownFixture();
    fixture.dispatch(event);
    assert.equal(fixture.calls[0][0], 'global-keydown');
    assert.equal(fixture.calls[0][1].code, event.code);
    assert.equal(fixture.calls.length, 1);
  }
});

test('the actual App capture handler intercepts Ctrl+Z only, not Delete', async () => {
  const fixture = await keydownFixture();
  fixture.dispatch({ key: 'z', code: 'KeyZ', ctrlKey: true });
  assert.deepEqual(fixture.calls, [['preventDefault'], ['stopImmediatePropagation'], ['undo']]);
});

test('the actual App capture handler leaves dialog keys and text undo alone', async () => {
  const dialog = await keydownFixture(['MessageBox']);
  dialog.dispatch();
  dialog.dispatch({ key: 'z', code: 'KeyZ', ctrlKey: true });
  assert.deepEqual(dialog.calls, []);
  const editing = await keydownFixture();
  editing.dispatch({ key: 'z', code: 'KeyZ', ctrlKey: true, target: new Element(true) });
  assert.equal(editing.calls.some(call => call[0] === 'undo'), false);
});

test('undo refreshes folders, counts and content after the native operation', async () => {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  assert.ok(app.includes("invoke('undo_trash', { libraryId })"));
  assert.match(app, /refreshFolders: true, refreshCounts: true/);
  assert.ok(app.includes("emit('library-total-refreshed'"));
  assert.ok(app.includes("emit('refresh-content', {"));
  assert.match(app, /isUndoingTrash = false/);
});

async function contentUndoFixture() {
  const content = await readFile(new URL('../src/components/Content.vue', import.meta.url), 'utf8');
  const start = content.indexOf("unlistenRefreshContent = await listen('refresh-content'");
  const code = ts.transpile(content.slice(start, content.indexOf('unlistenTriggerNextAlbum =', start)), { target: ts.ScriptTarget.ES2022 });
  const calls = [];
  let handler;
  const create = new Function('listen', 'updateContent', 'refreshContentAfterTrashUndo', 'contentRootRef', 'pendingRestoreScrollTop', 'libConfig',
    'return (async () => { let unlistenRefreshContent; let pendingFocusedFileId = null; let pendingInitialSelectedIndex = 18; let hasRestoredInitialSelection = false; let lastSyncedAlbumFolder = "/photos";'
    + code + '; return () => ({ pendingFocusedFileId, pendingInitialSelectedIndex, hasRestoredInitialSelection, lastSyncedAlbumFolder }); })();');
  const scroll = { value: 400 };
  const state = await create(async (_name, callback) => { handler = callback; },
    (...args) => calls.push(['refresh', ...args]),
    (...args) => calls.push(['undo-refresh', ...args]),
    { value: { focus: args => calls.push(['focus', args]) } }, scroll, { _libraryId: 'library-a' });
  return { dispatch: payload => handler({ payload }), calls, state, scroll };
}

test('restored-file refresh uses the atomic refresh path without clearing the current view', async () => {
  const fixture = await contentUndoFixture();
  fixture.dispatch({ source: 'trash-undo', libraryId: 'library-a', focusFileId: 7 });
  assert.equal(fixture.state().lastSyncedAlbumFolder, '/photos');
  assert.deepEqual(fixture.calls, [['undo-refresh', 7, undefined], ['focus', { preventScroll: true }]]);
});

test('batch undo forwards all restored IDs to the immediate display cache', async () => {
  const fixture = await contentUndoFixture();
  fixture.dispatch({ source: 'trash-undo', libraryId: 'library-a', focusFileId: 7, fileIds: [7, 8] });
  assert.deepEqual(fixture.calls, [['undo-refresh', 7, [7, 8]], ['focus', { preventScroll: true }]]);
});

test('undo refreshes from another library are ignored and manual refresh keeps filesystem synchronization', async () => {
  const fixture = await contentUndoFixture();
  fixture.dispatch({ source: 'trash-undo', libraryId: 'library-b', focusFileId: 7 });
  assert.deepEqual(fixture.calls, []);
  fixture.dispatch({});
  assert.equal(fixture.state().lastSyncedAlbumFolder, '');
  assert.deepEqual(fixture.calls, [['refresh']]);
});

test('restored files are selected and scrolled into view in flat lists and grouped filmstrips', async () => {
  const content = await readFile(new URL('../src/components/Content.vue', import.meta.url), 'utf8');
  const start = content.indexOf('async function restoreFocusedFileAfterListRefresh()');
  const code = ts.transpile(content.slice(start, content.indexOf('async function waitForGroupedGridLayout()', start)), { target: ts.ScriptTarget.ES2022 });
  for (const grouped of [false, true]) {
    const calls = [];
    const selectedItemIndex = { value: 0 };
    const deps = {
      fileList: { value: [{}] }, groupedModeActive: { value: grouped }, selectedItemIndex,
      totalFileCount: { value: 30 }, currentContentRequestId: 1,
      getCurrentQueryFilePosition: async fileId => { calls.push(['resolve', fileId]); return 12; },
      resolveGroupedFileIndex: async fileId => { calls.push(['resolve-group', fileId]); return 12; },
      nextTick: async () => {}, scrollToGroupedFile: async index => calls.push(['scroll-group', index]),
      gridViewRef: { value: { scrollToItem: index => calls.push(['scroll', index]) } },
    };
    const restore = new Function(...Object.keys(deps), 'let pendingFocusedFileId = 7; let isRestoringFocusedFile = false;' + code + '; return restoreFocusedFileAfterListRefresh;')(...Object.values(deps));
    await restore();
    assert.equal(selectedItemIndex.value, 12);
    assert.deepEqual(calls, [[grouped ? 'resolve-group' : 'resolve', 7], [grouped ? 'scroll-group' : 'scroll', 12]]);
  }
});

test('single-file recycling runs on a blocking worker instead of the UI thread', async () => {
  const commands = await readFile(new URL('../../src-tauri/src/t_cmds.rs', import.meta.url), 'utf8');
  const start = commands.indexOf('pub async fn delete_file(');
  assert.ok(start >= 0);
  const command = commands.slice(start, commands.indexOf('#[tauri::command]', start));
  assert.match(command, /spawn_blocking/);
  assert.match(command, /delete_files_grouped/);
});

async function undoFixture(result = { restored: true, fileIds: [7], albumIds: [1, 2] }, recountError = false, recountGate = Promise.resolve()) {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('async function undoLastTrash()'), app.indexOf('function normalizeScale('));
  const calls = [];
  const libConfig = { _libraryId: 'library-a' };
  const toast = Object.fromEntries(['info', 'success', 'error'].map(type => [type, (...args) => calls.push([type, ...args])]));
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'undo_trash') return typeof result === 'function' ? result() : result;
    if (command === 'recount_album' && recountError) throw new Error('count refresh failed');
    if (command === 'recount_album') await recountGate;
    if (command === 'get_all_albums') return [{ id: 1 }, { id: 2 }];
    return { id: args.albumId };
  };
  const undo = new Function('libConfig', 'invoke', 'emit', 'toast', 't', 'console',
    'let isUndoingTrash = false; let trashUndoRefreshSeq = 0; ' + code + '; return undoLastTrash;')(
    libConfig, invoke, async (...args) => calls.push(['emit', ...args]), toast, key => key, { error() {} },
  );
  return { undo, calls, libConfig, flushCounts: () => new Promise(resolve => setImmediate(resolve)) };
}

test('successful undo focuses the restored file before recounting only affected albums', async () => {
  const fixture = await undoFixture();
  await fixture.undo();
  await fixture.flushCounts();
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'recount_album').map(call => call[1].albumId), [1, 2]);
  assert.equal(fixture.calls.some(call => call[0] === 'get_all_albums'), false);
  const refresh = fixture.calls.find(call => call[0] === 'emit' && call[1] === 'refresh-content');
  assert.deepEqual(refresh[2], { source: 'trash-undo', libraryId: 'library-a', focusFileId: 7, fileIds: [7] });
  const albumRefresh = fixture.calls.find(call => call[0] === 'emit' && call[1] === 'albums-refreshed');
  assert.equal(albumRefresh[2].source, 'trash-undo');
  assert.ok(fixture.calls.indexOf(refresh) < fixture.calls.findIndex(call => call[0] === 'recount_album'));
  assert.equal(fixture.calls.filter(call => call[0] === 'emit').length, 3);
});

test('slow background counts do not block the next undo, and older counts cannot overwrite the latest undo', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let fileId = 2;
  const fixture = await undoFixture(() => ({ restored: true, fileIds: [fileId--], albumIds: [1] }), false, gate);
  await fixture.undo();
  await fixture.undo();
  assert.equal(fixture.calls.filter(call => call[0] === 'undo_trash').length, 2);
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'emit' && call[1] === 'refresh-content').map(call => call[2].fileIds), [[2], [1]]);
  assert.equal(fixture.calls.some(call => call[0] === 'emit' && call[1] === 'albums-refreshed'), false);
  finish();
  await fixture.flushCounts();
  assert.equal(fixture.calls.filter(call => call[0] === 'emit' && call[1] === 'albums-refreshed').length, 1);
  assert.equal(fixture.calls.filter(call => call[0] === 'emit' && call[1] === 'library-total-refreshed').length, 1);
});

test('undo refreshes the folder tree without reselecting it and stealing content keyboard focus', async () => {
  const album = await readFile(new URL('../src/components/AlbumList.vue', import.meta.url), 'utf8');
  const start = album.indexOf("unlistenAlbumsRefreshed = await listen('albums-refreshed',");
  const end = album.indexOf('\n  });', start) + '\n  });'.length;
  const code = ts.transpile(album.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  for (const source of ['trash-undo', undefined]) {
    const calls = [];
    let handler;
    const currentAlbum = { id: 1, path: '/photos', is_expanded: true };
    const deps = {
      listen: async (_name, callback) => { handler = callback; },
      libConfig: { _libraryId: 'library-a' },
      selection: { albumId: { value: 1 }, folderPath: { value: '/photos/folder' }, selected: { value: false } },
      getAlbumById: () => currentAlbum,
      clickFinalSubFolder: async (...args) => calls.push(['select', ...args]),
      expandAlbum: async (...args) => calls.push(['expand', ...args]),
      refreshAlbumVisibleCounts: async () => calls.push(['counts']),
      refreshFolderSearchFolders: () => calls.push(['search']),
    };
    const create = new Function(...Object.keys(deps), 'return (async () => { let unlistenAlbumsRefreshed;' + code + '})();');
    await create(...Object.values(deps));
    await handler({ payload: { source, libraryId: 'library-a', albums: [{ id: 1 }], refreshCounts: true } });
    assert.equal(calls.some(call => call[0] === 'select'), source !== 'trash-undo');
    assert.equal(calls.some(call => call[0] === 'expand'), source === 'trash-undo');
    assert.deepEqual(calls.slice(-2), [['counts'], ['search']]);
  }
});

test('an album count refresh failure cannot turn an already successful restore into an undo failure', async () => {
  const fixture = await undoFixture(undefined, true);
  await fixture.undo();
  assert.equal(fixture.calls.some(call => call[0] === 'emit' && call[1] === 'refresh-content'), true);
  assert.equal(fixture.calls.some(call => call[0] === 'success'), true);
  assert.equal(fixture.calls.some(call => call[0] === 'error'), false);
  await fixture.undo();
  assert.equal(fixture.calls.filter(call => call[0] === 'undo_trash').length, 2);
});

test('empty history and native failures do not emit misleading refresh events', async () => {
  for (const result of [false, () => { throw new Error('collision'); }]) {
    const fixture = await undoFixture(result);
    await fixture.undo();
    assert.equal(fixture.calls.some(call => call[0] === 'emit'), false);
    assert.equal(fixture.calls.some(call => call[0] === (result === false ? 'info' : 'error')), true);
    await fixture.undo();
    assert.equal(fixture.calls.filter(call => call[0] === 'undo_trash').length, 2);
  }
});

test('pending undo suppresses duplicate requests and a changed library is not refreshed', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const fixture = await undoFixture(() => pending);
  const first = fixture.undo();
  await fixture.undo();
  assert.equal(fixture.calls.filter(call => call[0] === 'undo_trash').length, 1);
  fixture.libConfig._libraryId = 'library-b';
  finish({ restored: true, fileIds: [7], albumIds: [1] });
  await first;
  assert.equal(fixture.calls.some(call => call[0] === 'get_all_albums'), false);
});
