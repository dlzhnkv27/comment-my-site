// Service worker: injects the UI, captures viewport frames, saves the final image.
//
// Saving has two routes:
//   1. Native helper (native-host/install.sh) — writes the PNG straight to ~/Desktop.
//   2. Fallback — chrome.downloads with a "Save as" dialog (Chrome remembers the last folder).

const NATIVE_HOST = 'com.comment_my_site.saver';
// chrome.tabs.captureVisibleTab is limited to 2 calls per second.
const CAPTURE_INTERVAL_MS = 550;
const DOWNLOAD_WAIT_MS = 4 * 60 * 1000;

// ---------------------------------------------------------------------------
// Toolbar button / shortcut: inject (or re-activate) the content script.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    // chrome://, Chrome Web Store, PDF viewer and other protected pages.
    await flashBadge(tab.id, '✕', '#e03e3e');
    console.warn('Comment My Site: cannot run on this page', err);
  }
});

async function flashBadge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}

// ---------------------------------------------------------------------------
// Messages from the content script.

const handlers = {
  capture: handleCapture,
  'capture-done': async (msg, sender) => {
    await chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' });
    return { ok: true };
  },
  'save-begin': handleSaveBegin,
  'save-chunk': handleSaveChunk,
  'save-end': handleSaveEnd,
  reveal: handleReveal,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not ours.
  if (!msg || msg.target === 'offscreen') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Capture

let lastCaptureAt = 0;

async function handleCapture(msg, sender) {
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.active) throw new Error('tab-inactive');

  if (msg.progress) {
    const pct = Math.min(99, Math.round((msg.progress.index / msg.progress.total) * 100));
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#0d99ff' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: `${pct}%` });
  }

  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      lastCaptureAt = Date.now();
      return { dataUrl };
    } catch (err) {
      lastCaptureAt = Date.now();
      if (attempt < 3 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(err?.message)) continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Save: the content script streams the PNG as base64 chunks
// (a single extension message is limited to 64 MiB).

const sessions = new Map();

async function handleSaveBegin(msg) {
  const filename = sanitizeFilename(msg.filename);

  const native = await openNativeHost();
  if (native) {
    try {
      // Long timeout: on first use macOS may hold the call while asking for Desktop access.
      const res = await native.call({ type: 'begin', filename }, 90000);
      if (!res?.ok) throw new Error(res?.error || 'begin failed');
      sessions.set(msg.id, { mode: 'native', native });
      return { ok: true, mode: 'native' };
    } catch (err) {
      console.warn('Comment My Site: native helper failed, falling back to downloads', err);
      native.close();
    }
  }

  await ensureOffscreen();
  await sendToOffscreen({ type: 'blob-begin', id: msg.id });
  sessions.set(msg.id, { mode: 'download', filename, mime: msg.mime || 'image/png' });
  return { ok: true, mode: 'download' };
}

async function handleSaveChunk(msg) {
  const session = sessions.get(msg.id);
  if (!session) throw new Error('unknown save session');
  if (session.mode === 'native') {
    const res = await session.native.call({ type: 'chunk', data: msg.data });
    if (!res?.ok) throw new Error(res?.error || 'chunk failed');
  } else {
    await sendToOffscreen({ type: 'blob-chunk', id: msg.id, data: msg.data });
  }
  return { ok: true };
}

async function handleSaveEnd(msg) {
  const session = sessions.get(msg.id);
  if (!session) throw new Error('unknown save session');
  sessions.delete(msg.id);

  if (session.mode === 'native') {
    try {
      const res = await session.native.call({ type: 'end' }, 60000);
      if (!res?.ok) throw new Error(res?.error || 'save failed');
      return { ok: true, mode: 'native', path: res.path };
    } finally {
      session.native.close();
    }
  }

  const { url } = await sendToOffscreen({ type: 'blob-end', id: msg.id, mime: session.mime });
  const downloadId = await chrome.downloads.download({
    url,
    filename: session.filename,
    saveAs: true,
    conflictAction: 'uniquify',
  });
  const item = await waitForDownload(downloadId);
  sendToOffscreen({ type: 'revoke', url }).catch(() => {});
  if (item.state === 'complete') return { ok: true, mode: 'download', path: item.filename, downloadId };
  if (item.error === 'USER_CANCELED') return { ok: false, canceled: true };
  throw new Error(item.error || 'download failed');
}

async function handleReveal(msg) {
  if (msg.downloadId != null) {
    chrome.downloads.show(msg.downloadId);
    return { ok: true };
  }
  const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'reveal', path: msg.path });
  return res || { ok: false };
}

function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const finish = async () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      const [item] = await chrome.downloads.search({ id: downloadId });
      resolve(item || { state: 'interrupted', error: 'not found' });
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') finish();
    };
    const timer = setTimeout(finish, DOWNLOAD_WAIT_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    // The download may already be finished before the listener was attached.
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item && item.state !== 'in_progress') finish();
    });
  });
}

function sanitizeFilename(name) {
  const clean = String(name || 'comments.png').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return clean.endsWith('.png') ? clean : `${clean}.png`;
}

// ---------------------------------------------------------------------------
// Native messaging helper (optional).

function openNativeHost() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch {
      resolve(null);
      return;
    }

    const pending = [];
    let alive = true;

    port.onMessage.addListener((reply) => pending.shift()?.resolve(reply));
    port.onDisconnect.addListener(() => {
      alive = false;
      const reason = chrome.runtime.lastError?.message || 'native host disconnected';
      for (const p of pending.splice(0)) p.reject(new Error(reason));
    });

    const close = () => {
      if (!alive) return;
      alive = false;
      try { port.disconnect(); } catch {}
    };

    // Replies come back in request order, so a FIFO queue is enough.
    const call = (message, timeoutMs = 15000) =>
      new Promise((res, rej) => {
        if (!alive) return rej(new Error('native host disconnected'));
        const timer = setTimeout(() => {
          close();
          rej(new Error('native host timeout'));
        }, timeoutMs);
        pending.push({
          resolve: (v) => { clearTimeout(timer); res(v); },
          reject: (e) => { clearTimeout(timer); rej(e); },
        });
        port.postMessage(message);
      });

    call({ type: 'ping' }, 3000).then(
      (reply) => {
        if (reply?.ok) resolve({ call, close });
        else { close(); resolve(null); }
      },
      () => { close(); resolve(null); },
    );
  });
}

// ---------------------------------------------------------------------------
// Offscreen document: the service worker cannot create blob: URLs, and data: URLs
// over 2 MB are rejected by chrome.downloads.

let offscreenCreating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Assemble the exported PNG into a blob: URL for chrome.downloads',
      })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function sendToOffscreen(message) {
  const res = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  if (res?.error) throw new Error(res.error);
  return res;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
