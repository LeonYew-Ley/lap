// Browser integration against the real AlbumList component with fixture IPC.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.goto(process.env.LAP_DEMO_URL || 'http://127.0.0.1:4179/demos/lap/index.html');
    const panel = page.locator('[data-album-drop-zone]').first();
    await panel.waitFor();
    await panel.getByText('Sample-Wikimedia', { exact: true }).click();
    const target = page.locator('[data-album-drop-new]');
    const drag = async (event, uri = 'file:///Pictures/Dropped%20Trip', placeholder = false) => {
      await (placeholder ? target : panel).evaluate((el, { event, uri }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/uri-list', uri);
        el.dispatchEvent(new DragEvent(event, { bubbles: true, cancelable: true, dataTransfer }));
      }, { event, uri });
    };
    // Ordinary file drops must be canceled throughout the Albums pane; stopping
    // propagation alone still lets the WebView navigate to a PDF/image URL.
    for (const location of ['[data-album-list-root]', '.sidebar-panel-header', '[data-album-id]']) {
      const result = await panel.locator(location).first().evaluate(el => {
        const dt = new DataTransfer();
        dt.items.add(new File(['%PDF-1.4'], 'document.pdf', { type: 'application/pdf' }));
        dt.setData('text/uri-list', 'file:///Pictures/document.pdf');
        const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        const allowed = el.dispatchEvent(event);
        return { prevented: event.defaultPrevented, allowed };
      });
      assert.equal(result.prevented, true);
      assert.equal(result.allowed, false);
    }
    assert.equal(await page.evaluate(() => window.__lapDemoBackend.state.albums.length), 1);
    assert(!await page.evaluate(() => window.__lapDemoBackend.commands.some(c => ['add_album', 'import_file', 'import_file_bytes'].includes(c.command))));
    // Enter the main content, not the Albums pane: only the matching target appears.
    const typedDrag = async (kind, event = 'dragenter') => {
      await page.locator('[data-thumbnail-container]').first().evaluate((el, { kind, event }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([], kind === 'folders' ? 'Trip' : 'photo.jpg'));
        const kinds = kind === 'mixed' ? ['folders', 'files'] : [kind];
        Object.defineProperty(dt, 'items', { value: kinds.map(k => ({ webkitGetAsEntry: () => ({ isDirectory: k === 'folders', isFile: k === 'files', name: 'sample' }) })) });
        el.dispatchEvent(new DragEvent(event, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, { kind, event });
    };
    await typedDrag('folders');
    await target.waitFor();
    assert.equal(await page.locator('.drop-overlay').count(), 0);
    await page.keyboard.press('Escape');
    await typedDrag('files');
    await page.locator('.drop-overlay').waitFor();
    assert.equal(await target.count(), 0);
    await page.keyboard.press('Escape');
    await typedDrag('mixed');
    assert.equal(await target.count(), 0);
    await typedDrag('mixed', 'drop');
    await page.getByText('Drag files and folders separately.', { exact: true }).waitFor();
    await drag('dragenter');
    await target.waitFor();
    await page.keyboard.press('Escape');
    await target.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__lapDemoBackend.state.albums.length), 1);
    await drag('dragenter');
    await drag('drop', 'file:///Pictures/Dropped%20Trip', true);
    await page.waitForFunction(() => window.__lapDemoBackend.state.albums.length === 2);
    assert.equal(await page.evaluate(() => window.__lapDemoBackend.state.albums[1].name), 'Dropped Trip');
    assert.equal(await page.evaluate(() => window.__lapDemoBackend.state.albums[1].path), '/Pictures/Dropped Trip');
    await page.waitForFunction(() => window.__lapDemoBackend.commands.some(c => c.command === 'index_album' && c.args.albumId === 2));
    await drag('dragenter');
    await drag('drop', 'file:///Pictures/Dropped%20Trip', true);
    await page.getByText('This album already exists', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__lapDemoBackend.state.albums.length), 2);
    await drag('dragenter');
    await drag('drop', 'file:///Pictures/Dropped%20Trip/Child', true);
    await page.getByText('This folder overlaps another album', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__lapDemoBackend.state.albums.length), 2);
    await drag('dragenter');
    await drag('drop', 'file:///Pictures/Second\nfile:///Pictures/Third', true);
    await page.waitForFunction(() => window.__lapDemoBackend.state.albums.length === 4);
    // Simulate a WebView that exposes a directory entry without its absolute path.
    await drag('dragenter');
    await target.evaluate(el => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([], 'Browser Album'));
      Object.defineProperty(dataTransfer, 'items', { value: [{ webkitGetAsEntry: () => ({ isDirectory: true, name: 'Browser Album' }) }] });
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    await page.waitForFunction(() => window.__lapDemoBackend.state.albums.length === 5);
    // Directory metadata is protected while hovering, then exposed at drop.
    await panel.evaluate(el => {
      const dt = new DataTransfer();
      dt.items.add(new File([], 'Delayed Folder'));
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    assert.equal(await target.count(), 0);
    await panel.evaluate(el => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'file:///Pictures/Delayed%20Folder');
      Object.defineProperty(dt, 'items', { value: [{ kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true, name: 'Delayed Folder' }) }] });
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForFunction(() => window.__lapDemoBackend.state.albums.length === 6);
    assert(!await page.evaluate(() => window.__lapDemoBackend.commands.some(c => ['import_file', 'import_file_bytes', 'copy_file', 'move_file'].includes(c.command))));
    assert.deepEqual(errors, []);
    if (process.env.LAP_SCREENSHOT_DIR) {
      await drag('dragenter');
      await drag('dragover', 'file:///Pictures/Next', true);
      await panel.screenshot({ path: process.env.LAP_SCREENSHOT_DIR + '/album-drop-placeholder.png' });
    }
    console.log('PASS: placeholder cancellation, original paths, indexing, duplicate/nested rejection, batch folders, no file copies');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
