// Service Worker for Privacy Cockpit
// Manages Ed25519 private key with persistent storage fallback
// Private key stored as JWK in chrome.storage.local so it survives service worker termination

let userPrivateKeys = {}; // In-memory cache — fast path

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'storePrivateKey') {
    const userId = request.userId;
    const privateKey = request.privateKey;

    // Cache in memory
    userPrivateKeys[userId] = privateKey;

    // Also persist as JWK so it survives service worker termination
    crypto.subtle.exportKey('jwk', privateKey)
      .then(jwk => {
        const storageKey = 'private_key_jwk_' + userId;
        return chrome.storage.local.set({ [storageKey]: jwk });
      })
      .then(() => sendResponse({ success: true }))
      .catch(err => {
        console.error('Key storage error:', err);
        // Still succeed — in-memory key is available for this session
        sendResponse({ success: true });
      });

    return true; // Keep message port open for async
  }

  if (request.action === 'signData') {
    const userId = request.userId;
    const message = request.message;

    const doSign = (privateKey) => {
      return crypto.subtle.sign(
        'Ed25519',
        privateKey,
        new TextEncoder().encode(message)
      ).then(signatureBuffer => {
        return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
      });
    };

    // Fast path — key already in memory
    if (userPrivateKeys[userId]) {
      doSign(userPrivateKeys[userId])
        .then(sig => sendResponse(sig))
        .catch(err => {
          console.error('Signing error:', err);
          sendResponse(null);
        });
      return true;
    }

    // Slow path — service worker was killed, reload key from storage
    const storageKey = 'private_key_jwk_' + userId;
    chrome.storage.local.get([storageKey])
      .then(result => {
        const jwk = result[storageKey];
        if (!jwk) {
          // No persisted key — user must run Setup again
          sendResponse(null);
          return;
        }
        // Re-import the JWK back into a CryptoKey
        return crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'Ed25519' },
          false, // non-extractable after re-import
          ['sign']
        ).then(privateKey => {
          // Restore to memory cache for subsequent calls
          userPrivateKeys[userId] = privateKey;
          return doSign(privateKey);
        }).then(sig => sendResponse(sig));
      })
      .catch(err => {
        console.error('Key reload error:', err);
        sendResponse(null);
      });

    return true; // Keep message port open for async
  }

});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Privacy Cockpit installed');
});
