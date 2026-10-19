// Shared DOM payload parsing for external file/folder drops.
export function getExternalDropUris(dt: DataTransfer | null) {
  const value = dt?.getData('text/uri-list')
    || dt?.getData('text/x-moz-url')
    || dt?.getData('text/plain')
    || '';
  return value
    .split(/\r?\n/)
    .map(uri => uri.trim())
    .filter(uri => uri.length > 0 && !uri.startsWith('#'));
}

export function getExternalHttpDropUrls(uris: string[]) {
  return uris
    .filter(uri => uri.startsWith('http://') || uri.startsWith('https://'));
}

export function fileUrlToPath(uri: string) {
  if (!uri.startsWith('file://')) return null;
  try {
    const url = new URL(uri);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    } else if (url.hostname && url.hostname !== 'localhost') {
      path = `//${url.hostname}${path}`;
    }
    return path || null;
  } catch {
    return null;
  }
}

export function getExternalFileDropPaths(uris: string[]) {
  return uris
    .map(fileUrlToPath)
    .filter((path): path is string => !!path);
}

export function hasExternalDropIntent(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return dt.files.length > 0 || types.includes('Files')
    || types.includes('text/uri-list') || types.includes('text/x-moz-url');
}

// Snapshot before awaiting IPC: drag data is protected once the drop handler returns.
export function getExternalDropPaths(dt: DataTransfer | null): string[] {
  const paths = getExternalFileDropPaths(getExternalDropUris(dt));
  for (const file of Array.from(dt?.files || [])) {
    const path = (file as File & { path?: string }).path;
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

export function getDroppedDirectoryNames(dt: DataTransfer | null): string[] {
  return Array.from(dt?.items || []).flatMap(item => {
    const entry = item.webkitGetAsEntry?.();
    return entry?.isDirectory ? [entry.name] : [];
  });
}

export type ExternalDropKind = 'unknown' | 'files' | 'folders' | 'mixed';

export function getExternalDropKind(dt: DataTransfer | null): ExternalDropKind {
  let files = false, folders = false, unknown = false;
  for (const item of Array.from(dt?.items || [])) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) folders = true;
    else if (entry?.isFile) files = true;
    else if (item.kind === 'file') {
      // MIME metadata may remain readable while entry/path data is protected.
      if (['inode/directory', 'application/x-directory'].includes(item.type)) folders = true;
      else if (item.type) files = true;
      else unknown = true;
    }
  }
  if (files && folders) return 'mixed';
  if (unknown) return 'unknown';
  if (files || folders) return folders ? 'folders' : 'files';
  if (getExternalHttpDropUrls(getExternalDropUris(dt)).length) return 'files';
  return 'unknown';
}
