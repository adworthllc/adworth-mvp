// Service Worker for Privacy Cockpit
// Manages Ed25519 private key (keeps it secure, non-extractable)

let userPrivateKeys = {}; // In-memory storage (resets when service worker sleeps — handled below)

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'storePrivateKey') {
    // Store private key reference (it's non-extractable, so we just keep the CryptoKey object)
    userPrivateKeys[request.userId] = request.privateKey;
    sendResponse({ success: true });
    return true; // FIX: keep message port open for async
  }

  if (request.action === 'signData') {
    const userId = request.userId;
    const message = request.message;
    const privateKey = userPrivateKeys[userId];

    // FIX: If service worker restarted and lost key, tell popup to re-setup
    if (!privateKey) {
      sendResponse(null);
      return true;
    }

    crypto.subtle.sign(
      'Ed25519',
      privateKey,
      new TextEncoder().encode(message)
    ).then(signatureBuffer => {
      const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
      sendResponse(signatureBase64);
    }).catch(err => {
      console.error('Signing error:', err);
      sendResponse(null);
    });

    return true; // Keep message port open for async response
  }

});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Privacy Cockpit extension installed');
});
