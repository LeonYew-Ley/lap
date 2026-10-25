import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { normalizeLineEndings, readSource } from './helpers/source.mjs';

const lines = ["import { ref } from 'vue';", 'export const value: number = 42;', ''];

for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
  test(`${name} source loads without retaining imports in the test fixture`, () => {
    const normalized = normalizeLineEndings(lines.join(newline));
    assert.equal(normalized, lines.join('\n'));
    const body = normalized.replace(/^import .*;\n/gm, '').replace(/export /g, '');
    const compiled = ts.transpile(body, { target: ts.ScriptTarget.ES2022 });
    assert.equal(new Function(compiled + '; return value;')(), 42);
  });
}

test('source loading preserves whitespace and normalizes checked-out files', () => {
  assert.equal(normalizeLineEndings('  a\r\n\r\n b  '), '  a\n\n b  ');
  const source = readSource(new URL('../src/common/availability.ts', import.meta.url));
  assert.equal(source.includes('\r'), false);
  assert.match(source, /^import /m);
});
