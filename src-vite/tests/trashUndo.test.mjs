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
  assert.ok(app.includes("emit('refresh-content')"));
  assert.match(app, /isUndoingTrash = false/);
});

async function undoFixture(result = true) {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('async function undoLastTrash()'), app.indexOf('function normalizeScale('));
  const calls = [];
  const libConfig = { _libraryId: 'library-a' };
  const toast = Object.fromEntries(['info', 'success', 'error'].map(type => [type, (...args) => calls.push([type, ...args])]));
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'undo_trash') return typeof result === 'function' ? result() : result;
    if (command === 'get_all_albums') return [{ id: 1 }, { id: 2 }];
    return { id: args.albumId };
  };
  const undo = new Function('libConfig', 'invoke', 'emit', 'toast', 't',
    'let isUndoingTrash = false; ' + code + '; return undoLastTrash;')(
    libConfig, invoke, async (...args) => calls.push(['emit', ...args]), toast, key => key,
  );
  return { undo, calls, libConfig };
}

test('successful undo refreshes all album and library counts once', async () => {
  const fixture = await undoFixture();
  await fixture.undo();
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'recount_album').map(call => call[1].albumId), [1, 2]);
  assert.equal(fixture.calls.filter(call => call[0] === 'emit').length, 3);
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
  finish(true);
  await first;
  assert.equal(fixture.calls.some(call => call[0] === 'get_all_albums'), false);
});
