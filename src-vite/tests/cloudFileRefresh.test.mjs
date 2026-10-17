import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { ref } from 'vue';

const source = fs.readFileSync(new URL('../src/components/RefreshFileInfoDialog.vue', import.meta.url), 'utf8');
const body = ts.transpile(source.split('<script setup lang="ts">')[1].split('</script>')[0]
  .replace(/^import .*;\n/gm, ''), { target: ts.ScriptTarget.ES2022 });
function fixture(responses) {
  let mounted;
  const refreshed = [];
  const calls = [];
  const props = { fileIds: responses.map((_, i) => i + 1), libraryId: 'test', freeSpace: true,
    finishRefresh: async results => refreshed.push(...results) };
  const deps = {
    ref, defineProps: () => props, defineEmits: () => () => {},
    onMounted: callback => { mounted = callback; }, onBeforeUnmount: () => {}, watch: () => {},
    invoke: async (command, args) => {
      calls.push({ command, args });
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return response;
    },
    config: { settings: { thumbnailSize: 512 } }, libConfig: { _libraryId: 'test' },
    getRawDisplayOptions: () => ({}),
    useUIStore: () => ({ pushInputHandler() {}, removeInputHandler() {} }),
    window: { addEventListener() {}, removeEventListener() {} }, console: { error() {} },
  };
  const state = new Function(...Object.keys(deps), body +
    '; return { processed, succeeded, failed, releaseRequested, keptLocal, lastError, running };')(...Object.values(deps));
  return { state, refreshed, calls, run: () => mounted() };
}
const result = (id, extra = {}) => ({ file: { id, cloud_only: false, metadata_pending: false },
  size_delta: 10, skipped: false, release_requested: false, error: null, ...extra });

test('accepted asynchronous release requests are reported without claiming the file is already cloud-only', async () => {
  const updated = result(1, { release_requested: true });
  const f = fixture([updated]);
  await f.run();
  assert.equal(f.state.releaseRequested.value, 1);
  assert.equal(f.state.keptLocal.value, 0);
  assert.equal(f.state.succeeded.value, 1);
  assert.equal(f.refreshed[0].file.cloud_only, false);
});

test('thumbnail failure still refreshes the downloaded file, metadata and size delta', async () => {
  const updated = result(1, { error: 'Thumbnail could not be cached' });
  const f = fixture([updated]);
  await f.run();
  assert.deepEqual(f.refreshed, [updated]);
  assert.equal(f.state.failed.value, 1);
  assert.equal(f.state.succeeded.value, 0);
  assert.equal(f.state.keptLocal.value, 1);
  assert.equal(f.state.lastError.value, updated.error);
});

test('a mixed batch retains partial updates and continues after command and release failures', async () => {
  const partial = result(2, { error: 'Release refused' });
  const complete = result(3, { release_requested: true, file: { id: 3, cloud_only: true } });
  const f = fixture([new Error('Download failed'), partial, complete]);
  await f.run();
  assert.deepEqual(f.refreshed, [partial, complete]);
  assert.equal(f.state.processed.value, 3);
  assert.equal(f.state.failed.value, 2);
  assert.equal(f.state.succeeded.value, 1);
  assert.equal(f.state.running.value, false);
  assert.ok(f.calls.every(call => call.command === 'index_cloud_file'));
});
