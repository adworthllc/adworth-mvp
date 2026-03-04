// Service Worker for Privacy Cockpit
// Manages Ed25519 private key (keeps it secure, non-extractable)

let userPrivateKeys = {}; // In-memory storage (per session)

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'storePrivateKey') {
    // Store private key reference (it's non-extractable, so we just keep the object)
    userPrivateKeys[request.userId] = request.privateKey;
    sendResponse({ success: true });
  }
  
  if (request.action === 'signData') {
    // Sign data with user's private key
    const userId = request.userId;
    const message = request.message;
    const privateKey = userPrivateKeys[userId];
    
    if (!privateKey) {
      sendResponse(null);
      return;
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
    
    // Return true to indicate we'll send response asynchronously
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Privacy Cockpit extension installed');
});
