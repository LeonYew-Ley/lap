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
