import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { reactive, ref, watch, nextTick } from 'vue';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = source => ts.transpile(source.replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), { target: ts.ScriptTarget.ES2022 });
const selectionSource = read('../src/composables/useAlbumSelection.ts');
const contentSource = read('../src/components/Content.vue');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const libConfig = reactive({ _libraryId: 'photos', activePane: 'main',
    album: { selected: false, folderPath: '/photos/source' } });
  let files = ['/photos/source/one.jpg', '/photos/source/two.jpg', '/photos/dest/three.jpg'];
  const queries = [];
  const options = { query: async params => [files.filter(path => params.searchFolder
    ? path.slice(0, path.lastIndexOf('/')) === params.searchFolder
    : path.startsWith(params.searchAllSubfolders + '/')).length, 0] };
  const deps = { reactive, libConfig, console: { error() {} },
    getQueryCountAndSum: async params => { queries.push(params); return options.query(params); } };
  const counts = new Function(...Object.keys(deps), compile(selectionSource) +
    '; return { setFolderFileCount, getFolderFileCount, clearFolderFileCounts, refreshFolderFileCounts };')(...Object.values(deps));
  const params = path => ({ searchFolder: path, searchAllSubfolders: '', searchFileType: 0 });
  return { ...counts, libConfig, options, queries, params, setFiles: next => { files = next; } };
}

function mountCountWatcher(f) {
  const start = contentSource.indexOf('watch(contentReady,');
  const updatedStart = contentSource.indexOf('watch([contentReady, isLoading],');
  const source = contentSource.slice(updatedStart >= 0 ? updatedStart : start, contentSource.indexOf('\nfunction updateCount('));
  const deps = { watch, contentReady: ref(false), isLoading: ref(false), contentQueryRefreshPending: true,
    contentCountIsAuthoritative: ref(true), tempViewMode: ref('none'), totalFileCount: ref(2),
    currentQuerySource: ref('query'), currentQueryParams: ref(f.params('/photos/source')),
    config: { main: { sidebarIndex: 1 } }, SIDEBAR: { ALBUM: 1 }, libConfig: f.libConfig,
    setFolderFileCount: f.setFolderFileCount, commitRequestedSidebarCount() {} };
  const stop = new Function(...Object.keys(deps), ts.transpile('const stop = ' + source, { target: ts.ScriptTarget.ES2022 }) + ';return stop;')(...Object.values(deps));
  return { ...deps, stop };
}

test('folder sync updates its badge after the one-time selection request was consumed', async () => {
  const f = fixture();
  f.setFolderFileCount('/photos/source', 2, f.params('/photos/source'));
  const view = mountCountWatcher(f);
  try {
    view.contentReady.value = true;
    await nextTick();
    assert.equal(f.getFolderFileCount('/photos/source'), 2);
    view.isLoading.value = true;
    await nextTick();
    view.totalFileCount.value = 1;
    view.isLoading.value = false;
    await nextTick();
    assert.equal(f.getFolderFileCount('/photos/source'), 1);
  } finally { view.stop(); }
});

test('content mutation events refresh cached badges even when a content reload is skipped', async () => {
  const f = fixture();
  f.setFolderFileCount('/photos/source', 2, f.params('/photos/source'));
  f.setFiles(['/photos/source/one.jpg']);
  let pending;
  let reloads = 0;
  const start = contentSource.indexOf('(event: any) => {', contentSource.indexOf("unlistenLibraryTotalRefreshed = await listen('library-total-refreshed'"));
  const source = contentSource.slice(start, contentSource.indexOf('\n  });', start));
  const deps = { refreshFolderFileCounts: () => { pending = f.refreshFolderFileCounts(); },
    isScanStreamingMode: ref(false), config: { main: { sidebarIndex: 1 } }, SIDEBAR: { ALBUM: 1 },
    pendingInitialSelectedIndex: 0, selectedItemIndex: ref(0), hasRestoredInitialSelection: false,
    updateContent: () => { reloads++; } };
  const handler = new Function(...Object.keys(deps), ts.transpile('const handler = ' + source,
    { target: ts.ScriptTarget.ES2022 }) + ';return handler;')(...Object.values(deps));
  handler({ payload: { source: 'content' } });
  await pending;
  assert.equal(f.getFolderFileCount('/photos/source'), 1);
  assert.equal(reloads, 0);
});

test('moving files refreshes source, destination and recursive parent without querying unseen folders', async () => {
  const f = fixture();
  f.setFolderFileCount('/photos/source', 2, f.params('/photos/source'));
  f.setFolderFileCount('/photos/dest', 1, f.params('/photos/dest'));
  f.setFolderFileCount('/photos', 3, { searchFolder: '', searchAllSubfolders: '/photos', searchFileType: 0 });
  f.setFiles(['/photos/source/one.jpg', '/photos/dest/two.jpg', '/photos/dest/three.jpg']);
  await f.refreshFolderFileCounts();
  assert.equal(f.getFolderFileCount('/photos/source'), 1);
  assert.equal(f.getFolderFileCount('/photos/dest'), 2);
  assert.equal(f.getFolderFileCount('/photos'), 3);
  assert.equal(f.queries.length, 3);
  f.setFiles([]);
  await f.refreshFolderFileCounts();
  assert.equal(f.getFolderFileCount('/photos/source'), 0);
  assert.equal(f.getFolderFileCount('/photos/dest'), 0);
  assert.equal(f.getFolderFileCount('/photos'), 0);
});

test('a slow old refresh cannot overwrite a newer refresh or content count', async () => {
  const f = fixture();
  f.setFolderFileCount('/photos/source', 2, f.params('/photos/source'));
  const old = deferred();
  f.options.query = () => old.promise;
  const pending = f.refreshFolderFileCounts();
  f.options.query = async () => [1, 0];
  await f.refreshFolderFileCounts();
  old.resolve([2, 0]);
  await pending;
  assert.equal(f.getFolderFileCount('/photos/source'), 1);

  const slower = deferred();
  f.options.query = () => slower.promise;
  const next = f.refreshFolderFileCounts();
  f.setFolderFileCount('/photos/source', 0, f.params('/photos/source'));
  slower.resolve([1, 0]);
  await next;
  assert.equal(f.getFolderFileCount('/photos/source'), 0);
});

test('library switches and clearing counts discard pending results, even for the same path', async () => {
  const f = fixture();
  f.setFolderFileCount('/photos/source', 2, f.params('/photos/source'));
  const old = deferred();
  f.options.query = () => old.promise;
  const pending = f.refreshFolderFileCounts();
  f.libConfig._libraryId = 'other';
  old.resolve([99, 0]);
  await pending;
  assert.equal(f.getFolderFileCount('/photos/source'), 2);
  const cleared = deferred();
  f.options.query = () => cleared.promise;
  const next = f.refreshFolderFileCounts();
  f.clearFolderFileCounts();
  f.setFolderFileCount('/photos/source', 7, f.params('/photos/source'));
  cleared.resolve([99, 0]);
  await next;
  assert.equal(f.getFolderFileCount('/photos/source'), 7);
});

test('failed counts retain their last value while other folders refresh, preserving query filters', async () => {
  const f = fixture();
  const filtered = { ...f.params('/photos/source'), searchFileType: 1 };
  f.setFolderFileCount('/photos/source', 2, filtered);
  f.setFolderFileCount('/photos/dest', 1, f.params('/photos/dest'));
  f.options.query = async params => {
    if (params.searchFolder === '/photos/source') {
      assert.equal(params.searchFileType, 1);
      throw new Error('temporary database failure');
    }
    return [4, 0];
  };
  await f.refreshFolderFileCounts();
  assert.equal(f.getFolderFileCount('/photos/source'), 2);
  assert.equal(f.getFolderFileCount('/photos/dest'), 4);
});

test('temporary views and mismatched folder queries cannot replace a folder badge', async () => {
  const f = fixture();
  const view = mountCountWatcher(f);
  try {
    view.tempViewMode.value = 'dedup';
    view.contentReady.value = true;
    await nextTick();
    assert.equal(f.getFolderFileCount('/photos/source'), 0);
    view.contentReady.value = false;
    await nextTick();
    view.tempViewMode.value = 'none';
    view.currentQueryParams.value = f.params('/photos/different');
    view.contentReady.value = true;
    await nextTick();
    assert.equal(f.getFolderFileCount('/photos/source'), 0);
  } finally { view.stop(); }
});
