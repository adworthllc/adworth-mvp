const API_BASE = 'https://adworth-ingestion-api.adworthllc.workers.dev';

document.addEventListener('DOMContentLoaded', async () => {
  await updateStatus();
  await loadMetadata();

  document.getElementById('setupBtn').addEventListener('click', handleSetup);
  document.getElementById('syncBtn').addEventListener('click', handleSync);
});

async function updateStatus() {
  const data = await chrome.storage.local.get(['user_id', 'setup_complete']);
  const statusEl = document.getElementById('status');
  const statusValue = document.getElementById('statusValue');
  const setupBtn = document.getElementById('setupBtn');
  const syncBtn = document.getElementById('syncBtn');

  if (data.setup_complete) {
    statusEl.className = 'status ready';
    statusValue.textContent = '✓ Ready';
    setupBtn.style.display = 'none';
    syncBtn.disabled = false;
  } else {
    statusEl.className = 'status error';
    statusValue.textContent = '⚠ Not Setup';
    setupBtn.style.display = 'block';
    syncBtn.disabled = true;
  }
}

async function loadMetadata() {
  const data = await chrome.storage.local.get(['device_fingerprint', 'ingestion_count']);
  document.getElementById('device').textContent =
    data.device_fingerprint ? data.device_fingerprint.substring(0, 12) + '...' : '—';
  document.getElementById('ingestions').textContent = data.ingestion_count || 0;
}

async function handleSetup() {
  const messageEl = document.getElementById('message');
  messageEl.className = '';
  messageEl.textContent = 'Setting up...';

  try {
    const userId = 'user_' + Math.random().toString(36).substring(7);
    const registerRes = await fetch(`${API_BASE}/extension/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, action: 'generate_keypair' })
    });

    if (!registerRes.ok) throw new Error('Registration failed: ' + registerRes.statusText);
    const { setup_token } = await registerRes.json();

    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      false,
      ['sign', 'verify']
    );

    const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer)));
    const deviceFingerprint = generateDeviceFingerprint();

    const uploadRes = await fetch(`${API_BASE}/extension/upload-pubkey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        setup_token: setup_token,
        public_key: publicKeyBase64,
        device_fingerprint: deviceFingerprint
      })
    });

    if (!uploadRes.ok) throw new Error('Public key upload failed: ' + uploadRes.statusText);

    await chrome.storage.local.set({
      user_id: userId,
      setup_complete: true,
      public_key: publicKeyBase64,
      device_fingerprint: deviceFingerprint,
      setup_timestamp: new Date().toISOString(),
      ingestion_count: 0,
      private_key_ref: 'stored_in_crypto_api'
    });

    chrome.runtime.sendMessage({
      action: 'storePrivateKey',
      userId: userId,
      privateKey: keyPair.privateKey
    });

    messageEl.className = 'message success';
    messageEl.textContent = '✓ Setup complete! Ready to sync data.';

    await updateStatus();
    await loadMetadata();

  } catch (err) {
    console.error('Setup error:', err);
    messageEl.className = 'message error';
    messageEl.textContent = '✗ Setup failed: ' + err.message;
  }
}

async function handleSync() {
  const messageEl = document.getElementById('message');
  messageEl.className = '';
  messageEl.textContent = 'Syncing data...';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) throw new Error('No active tab found');

    // FIX: Programmatically inject content script into the tab
    // This is more reliable than manifest declaration for MV3
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-script.js']
      });
    } catch (injectErr) {
      // Script may already be injected — that is fine, continue
      console.log('Script injection note:', injectErr.message);
    }

    // Small delay to ensure script is registered and listening
    await new Promise(resolve => setTimeout(resolve, 200));

    // Now send message to content script
    let response;
    try {
      response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'extractMetrics' }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });
    } catch (err) {
      throw new Error('Could not reach content script: ' + err.message);
    }

    if (!response || !response.data) {
      throw new Error('No data found on this page. Navigate to adworth.app first.');
    }

    const stored = await chrome.storage.local.get(['user_id', 'device_fingerprint', 'ingestion_count']);
    const userId = stored.user_id;

    if (!userId) throw new Error('Not setup yet. Click Setup Extension first.');

    const timestamp = new Date().toISOString();
    const messageToSign = JSON.stringify({
      ...response.data,
      timestamp: timestamp
    });

    const signatureBase64 = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'signData',
        userId: userId,
        message: messageToSign
      }, (sig) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!sig) {
          reject(new Error('Session expired — please click Setup Extension again.'));
        } else {
          resolve(sig);
        }
      });
    });

    const ingestRes = await fetch(`${API_BASE}/extension/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        timestamp: timestamp,
        data: response.data,
        signature: signatureBase64
      })
    });

    if (!ingestRes.ok) throw new Error('Data ingest failed: ' + ingestRes.statusText);

    const result = await ingestRes.json();

    const newCount = (stored.ingestion_count || 0) + 1;
    await chrome.storage.local.set({ ingestion_count: newCount });

    messageEl.className = 'message success';
    messageEl.textContent = `✓ Data synced! ID: ${result.ingestion_id.substring(0, 8)}...`;

    await loadMetadata();

  } catch (err) {
    console.error('Sync error:', err);
    messageEl.className = 'message error';
    messageEl.textContent = '✗ Sync failed: ' + err.message;
  }
}

function generateDeviceFingerprint() {
  const data = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language
  };

  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'device_' + Math.abs(hash).toString(16);
}
