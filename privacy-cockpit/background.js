// background.js — Privacy Cockpit Service Worker
// Ed25519 key generation happens HERE — keys are never passed via message
// (CryptoKey objects do not survive chrome.runtime.sendMessage serialization)
// Private key stored as JWK in chrome.storage.local — survives service worker termination

let userPrivateKeys = {}; // In-memory cache — fast path

// ─────────────────────────────────────────────
// HELPER: Sign a message with a CryptoKey
// ─────────────────────────────────────────────
const doSign = (privateKey, message) => {
  return crypto.subtle.sign(
    'Ed25519',
    privateKey,
    new TextEncoder().encode(message)
  ).then(signatureBuffer => {
    return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  });
};

// ─────────────────────────────────────────────
// HELPER: Load key from JWK storage (slow path)
// ─────────────────────────────────────────────
const loadKeyFromStorage = (userId) => {
  const storageKey = 'private_key_jwk_' + userId;
  return chrome.storage.local.get([storageKey]).then(result => {
    const jwk = result[storageKey];
    if (!jwk) return null;
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'Ed25519' },
      false,       // non-extractable after re-import
      ['sign']
    ).then(privateKey => {
      userPrivateKeys[userId] = privateKey; // restore to memory cache
      return privateKey;
    });
  });
};

// ─────────────────────────────────────────────
// MESSAGE HANDLERS
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── generateKey ──────────────────────────────
  // Called by popup.js during Setup — generates keypair HERE in the service
  // worker, stores private key as JWK, returns public key as base64
  if (request.action === 'generateKey') {
    const userId = request.userId;

    crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,            // extractable so we can export JWK
      ['sign', 'verify']
    )
    .then(async (keyPair) => {
      // Export private key as JWK and persist
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      const storageKey = 'private_key_jwk_' + userId;
      await chrome.storage.local.set({ [storageKey]: jwk });

      // Cache private key in memory for this session
      userPrivateKeys[userId] = keyPair.privateKey;

      // Export public key as base64 to return to popup
      const pubKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
      const pubKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(pubKeyBuffer)));

      sendResponse({ success: true, publicKey: pubKeyBase64 });
    })
    .catch(err => {
      console.error('Key generation error:', err);
      sendResponse({ success: false, error: err.message });
    });

    return true; // Keep message port open for async
  }

  // ── signData ─────────────────────────────────
  // Called by popup.js during Sync — signs the payload using stored private key
  if (request.action === 'signData') {
    const userId = request.userId;
    const message = request.message;

    // Fast path — key already in memory
    if (userPrivateKeys[userId]) {
      doSign(userPrivateKeys[userId], message)
        .then(sig => sendResponse(sig))
        .catch(err => {
          console.error('Signing error (memory path):', err);
          sendResponse(null);
        });
      return true;
    }

    // Slow path — service worker was terminated, reload from storage
    loadKeyFromStorage(userId)
      .then(privateKey => {
        if (!privateKey) {
          // No persisted key found — user must run Setup again
          console.warn('No key found for userId:', userId);
          sendResponse(null);
          return;
        }
        return doSign(privateKey, message);
      })
      .then(sig => { if (sig) sendResponse(sig); })
      .catch(err => {
        console.error('Signing error (storage path):', err);
        sendResponse(null);
      });

    return true; // Keep message port open for async
  }

  // ── clearKeys ────────────────────────────────
  // Called if popup needs to force a full reset
  if (request.action === 'clearKeys') {
    const userId = request.userId;
    delete userPrivateKeys[userId];
    const storageKey = 'private_key_jwk_' + userId;
    chrome.storage.local.remove([storageKey])
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Privacy Cockpit installed');
});
