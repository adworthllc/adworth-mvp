const API_BASE = 'https://adworth-ingestion-api.adworthllc.workers.dev';

document.addEventListener('DOMContentLoaded', async () => {
  await updateStatus();
  await loadMetadata();
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
    // Step 1: Register with Adworth
    const userId = 'user_' + Math.random().toString(36).substring(7);
    const registerRes = await fetch(`${API_BASE}/extension/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        action: 'generate_keypair'
      })
    });
    
    if (!registerRes.ok) throw new Error('Registration failed: ' + registerRes.statusText);
    const { setup_token } = await registerRes.json();
    
    // Step 2: Generate Ed25519 keypair locally
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      false,
      ['sign', 'verify']
    );
    
    // Step 3: Export public key
    const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer)));
    
    // Step 4: Generate device fingerprint
    const deviceFingerprint = generateDeviceFingerprint();
    
    // Step 5: Upload public key
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
    
    // Step 6: Store setup data locally
    // Private key is stored by browser automatically (non-extractable)
    await chrome.storage.local.set({
      user_id: userId,
      setup_complete: true,
      public_key: publicKeyBase64,
      device_fingerprint: deviceFingerprint,
      setup_timestamp: new Date().toISOString(),
      ingestion_count: 0,
      private_key_ref: 'stored_in_crypto_api'
    });
    
    // Store reference to private key
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
    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    
    if (!tab) throw new Error('No active tab found');
    
    // Send message to content script to extract data
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractMetrics'
    });
    
    if (!response || !response.data) {
      throw new Error('No data found on dashboard');
    }
    
    // Get stored data
    const stored = await chrome.storage.local.get(['user_id', 'device_fingerprint', 'ingestion_count']);
    const userId = stored.user_id;
    
    if (!userId) throw new Error('Not setup yet. Click Setup Extension first.');
    
    // Prepare data
    const timestamp = new Date().toISOString();
    const messageToSign = JSON.stringify({
      ...response.data,
      timestamp: timestamp
    });
    
    // Get private key from background
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'signData',
        userId: userId,
        message: messageToSign
      }, async (signatureBase64) => {
        if (!signatureBase64) {
          reject(new Error('Failed to sign data'));
          return;
        }
        
        // Send to Adworth
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
        
        if (!ingestRes.ok) {
          throw new Error('Data ingest failed: ' + ingestRes.statusText);
        }
        
        const result = await ingestRes.json();
        
        // Update counter
        const newCount = (stored.ingestion_count || 0) + 1;
        await chrome.storage.local.set({ ingestion_count: newCount });
        
        messageEl.className = 'message success';
        messageEl.textContent = `✓ Data synced! ID: ${result.ingestion_id.substring(0, 8)}...`;
        
        await loadMetadata();
        resolve();
      });
    });
    
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
