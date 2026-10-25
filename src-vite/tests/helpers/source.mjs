import fs from 'node:fs';

export function normalizeLineEndings(source) {
  return source.replace(/\r\n?/g, '\n');
}

export function readSource(path) {
  return normalizeLineEndings(fs.readFileSync(path, 'utf8'));
}
