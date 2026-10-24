export function isTrashUndoShortcut(event: KeyboardEvent, mac: boolean, inputActive: boolean) {
  const target = event.target;
  const editing = target instanceof Element && Boolean(target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  ));
  return !editing && !inputActive && !event.isComposing && !event.repeat
    && !event.altKey && !event.shiftKey
    && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    && (event.code === 'KeyZ' || event.key.toLowerCase() === 'z');
}
