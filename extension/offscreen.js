// Offscreen document: reassembles base64 chunks into a Blob and hands out a blob: URL
// that chrome.downloads can fetch (used only when the native helper is not installed).

const parts = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'blob-begin':
      parts.set(msg.id, []);
      return { ok: true };
    case 'blob-chunk': {
      const list = parts.get(msg.id);
      if (!list) throw new Error('unknown blob');
      const res = await fetch(`data:application/octet-stream;base64,${msg.data}`);
      list.push(await res.arrayBuffer());
      return { ok: true };
    }
    case 'blob-end': {
      const list = parts.get(msg.id);
      if (!list) throw new Error('unknown blob');
      parts.delete(msg.id);
      const url = URL.createObjectURL(new Blob(list, { type: msg.mime || 'image/png' }));
      // Safety net in case the service worker never asks to revoke it.
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      return { url };
    }
    case 'revoke':
      URL.revokeObjectURL(msg.url);
      return { ok: true };
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}
