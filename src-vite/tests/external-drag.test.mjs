import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/common/externalDrag.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(check = async () => true) {
  let inspections = 0;
  const context = vm.createContext({ console, queueMicrotask });
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
  const module = new vm.SourceTextModule(outputText, { context });
  await module.link(name => {
    if (name === 'vue') return synthetic({ ref: value => ({ value }) });
    if (name === '@/common/api') return synthetic({ getDragPayload: async () => ({}), isDirectoryAccessible: check });
    if (name === '@/common/utils') return synthetic({ isMac: false });
    return synthetic({
      getExternalDropKind: dt => { inspections++; return dt.kind; },
      getExternalDropPaths: dt => dt.paths || [],
    });
  });
  await module.evaluate();
  const event = (kind, type = 'dragover', paths = []) => ({ type, dataTransfer: { kind, paths } });
  return { ...module.namespace, event, inspections: () => inspections };
}

test('capture/bubble inspect once, known hover is cached, and drop revalidates', async () => {
  const f = await fixture(), event = f.event('folders');
  f.updateExternalDrag(event);
  f.updateExternalDrag(event);
  for (let i = 0; i < 100; i++) f.updateExternalDrag(f.event('unknown'));
  assert.equal(f.inspections(), 1);
  f.updateExternalDrag(f.event('mixed', 'drop'));
  assert.equal(f.inspections(), 2);
  assert.equal(f.externalDragKind.value, 'mixed');
});
test('directory checks use at most four concurrent IPC calls', async () => {
  let active = 0, peak = 0, calls = 0;
  const f = await fixture(async () => {
    calls++; active++; peak = Math.max(peak, active);
    await tick(); active--;
    return true;
  });
  f.updateExternalDrag(f.event('unknown', 'dragenter', Array.from({ length: 25 }, (_, i) => '/folder/' + i)));
  for (let i = 0; i < 20 && f.externalDragKind.value === 'unknown'; i++) await tick();
  assert.equal(f.externalDragKind.value, 'folders');
  assert.equal(calls, 25);
  assert.equal(peak, 4);
});
test('mixed sources stop probing after the first decisive batch', async () => {
  let calls = 0;
  const f = await fixture(async path => { calls++; return path !== '/file'; });
  f.updateExternalDrag(f.event('unknown', 'dragenter', ['/file', ...Array.from({ length: 100 }, (_, i) => '/folder/' + i)]));
  await tick();
  assert.equal(f.externalDragKind.value, 'mixed');
  assert.equal(calls, 4);
});
test('cancel invalidates pending work and prevents remaining probes or stale writes', async () => {
  const releases = [];
  const f = await fixture(() => new Promise(resolve => releases.push(resolve)));
  f.updateExternalDrag(f.event('unknown', 'dragenter', Array.from({ length: 20 }, (_, i) => '/folder/' + i)));
  await tick();
  assert.equal(releases.length, 4);
  f.resetExternalDrag();
  f.resetExternalDrag();
  releases.forEach(resolve => resolve(true));
  await tick();
  assert.equal(releases.length, 4);
  assert.equal(f.externalDragKind.value, 'unknown');
});
test('both drop listeners share deferred cleanup, keeping the type readable during dispatch', async () => {
  const f = await fixture();
  f.updateExternalDrag(f.event('folders'));
  f.finishExternalDrag();
  f.finishExternalDrag();
  assert.equal(f.externalDragKind.value, 'folders');
  await tick();
  assert.equal(f.externalDragKind.value, 'unknown');
});
