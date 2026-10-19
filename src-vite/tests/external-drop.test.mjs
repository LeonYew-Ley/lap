import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/common/externalDrop.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const drop = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const transfer = (text, extras = {}) => ({ files: [], items: [], types: ['text/uri-list'], getData: type => type === 'text/uri-list' ? text : '', ...extras });

test('local file URLs decode spaces and non-ASCII names; comments and web URLs are excluded', () => {
  assert.deepEqual(drop.getExternalDropPaths(transfer('# comment\r\nfile:///Pictures/My%20Trip\r\nfile:///Pictures/%E6%97%85%E8%A1%8C\nhttps://example.com/photo')), ['/Pictures/My Trip', '/Pictures/旅行']);
});
test('Windows drive and UNC paths retain their absolute location', () => {
  assert.equal(drop.fileUrlToPath('file:///C:/Photos/My%20Trip'), 'C:/Photos/My Trip');
  assert.equal(drop.fileUrlToPath('file://server/share/Photos'), '//server/share/Photos');
  assert.equal(drop.fileUrlToPath('file://localhost/Pictures/Trip'), '/Pictures/Trip');
});
test('invalid URLs are rejected and duplicate sources are collapsed', () => {
  assert.equal(drop.fileUrlToPath('file:///bad%zz'), null);
  assert.equal(drop.fileUrlToPath('https://example.com/folder'), null);
  assert.deepEqual(drop.getExternalDropPaths(transfer('file:///Pictures/Trip\nfile:///Pictures/Trip', { files: [{ path: '/Pictures/Trip' }] })), ['/Pictures/Trip']);
});
test('file intent works while protected drag data is unavailable; ordinary text is ignored', () => {
  assert.equal(drop.hasExternalDropIntent(transfer('', { types: ['Files'] })), true);
  assert.equal(drop.hasExternalDropIntent(transfer('', { types: ['text/plain'] })), false);
  assert.equal(drop.hasExternalDropIntent(null), false);
});
test('directory entry names allow path confirmation without treating ordinary files as albums', () => {
  assert.deepEqual(drop.getDroppedDirectoryNames(transfer('', { items: [
    { webkitGetAsEntry: () => ({ isDirectory: true, name: 'Trip' }) },
    { webkitGetAsEntry: () => ({ isDirectory: false, name: 'photo.jpg' }) },
    { webkitGetAsEntry: () => null },
  ] })), ['Trip']);
});
test('HTTP drops remain available to the existing file-import handler', () => {
  const uris = drop.getExternalDropUris(transfer('https://example.com/a.jpg\nfile:///Pictures/Trip'));
  assert.deepEqual(drop.getExternalHttpDropUrls(uris), ['https://example.com/a.jpg']);
});

test('drag classification distinguishes files, directories, mixed and protected payloads', () => {
  const entry = type => ({ webkitGetAsEntry: () => ({ isDirectory: type === 'folder', isFile: type === 'file', name: 'sample' }) });
  assert.equal(drop.getExternalDropKind(transfer('', { items: [entry('folder')] })), 'folders');
  assert.equal(drop.getExternalDropKind(transfer('', { items: [entry('file')] })), 'files');
  assert.equal(drop.getExternalDropKind(transfer('', { items: [entry('folder'), entry('file')] })), 'mixed');
  assert.equal(drop.getExternalDropKind(transfer('', { types: ['Files'] })), 'unknown');
  assert.equal(drop.getExternalDropKind(transfer('https://example.com/a.jpg')), 'files');
});

test('protected drag MIME metadata identifies media files but never guesses an empty type is a folder', () => {
  assert.equal(drop.getExternalDropKind(transfer('', { items: [{ kind: 'file', type: 'image/jpeg' }] })), 'files');
  assert.equal(drop.getExternalDropKind(transfer('', { items: [{ kind: 'file', type: '' }] })), 'unknown');
  assert.equal(drop.getExternalDropKind(transfer('', { items: [{ kind: 'file', type: 'inode/directory' }] })), 'folders');
  assert.equal(drop.getExternalDropKind(transfer('', { items: [
    { kind: 'file', type: 'image/jpeg' }, { kind: 'file', type: '' },
  ] })), 'unknown');
});
test('all locales contain only the four used album-drop messages with matching placeholders', async () => {
  const folder = new URL('../src/locales/', import.meta.url);
  for (const name of await readdir(folder)) {
    if (!name.endsWith('.json')) continue;
    const locale = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    assert.deepEqual(Object.keys(locale.album.drop).sort(), ['add', 'confirm_folder', 'folders_only', 'separate'], name);
    assert(locale.album.drop.confirm_folder.includes('{name}'), name);
    for (const text of Object.values(locale.album.drop)) assert(text.trim().length > 0, name);
  }
});
