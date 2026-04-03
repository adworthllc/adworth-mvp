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

    // Key generation happens in background.js service worker — CryptoKey objects
    // cannot survive chrome.runtime.sendMessage serialization so we never pass them
    const keyGenResult = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'generateKey', userId: userId },
        (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!response?.success) reject(new Error(response?.error || 'Key generation failed'));
          else resolve(response);
        }
      );
    });

    const publicKeyBase64 = keyGenResult.publicKey;
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

    // Private key already stored inside background.js generateKey handler — nothing to pass here

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

    // ── Direct extraction — no message passing, no race condition ──
    // executeScript with func: runs inline in page context and returns data immediately.
    // No listener registration needed, no timing dependency.
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const hostname = window.location.hostname;
          const href = window.location.href;
          const metrics = {
            page_url: hostname + window.location.pathname,
            extracted_at: new Date().toISOString()
          };

          if (hostname.includes('adworth.app') && href.includes('/demo')) {
            // demo.html — reads <tr><td> table structure
            const rows = document.querySelectorAll('tr');
            rows.forEach(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 2) {
                const label = cells[0]?.textContent?.toLowerCase().trim() || '';
                const value = cells[1]?.textContent?.trim() || '';
                if (label.includes('campaign')) metrics.campaign_name = value;
                if (label.includes('spend'))      metrics.spend = parseFloat(value.replace(/[$,]/g, '')) || 0;
                if (label.includes('conversion')) metrics.conversions = parseInt(value.replace(/[^0-9]/g, '')) || 0;
                if (label.includes('impression')) metrics.impressions = parseInt(value.replace(/[^0-9]/g, '')) || 0;
                if (label.includes('roas'))       metrics.roas = parseFloat(value) || 0;
              }
            });
            metrics.platform = 'adworth_demo';

          } else if (hostname.includes('adworth.app')) {
            // dashboard.html or any other adworth page — extract visible metric cards
            const cards = document.querySelectorAll('[class*="metric"],[class*="stat"],[class*="result"],[class*="card"],[class*="val"]');
            cards.forEach(card => {
              const text = card.textContent?.toLowerCase() || '';
              const num = parseInt(card.textContent?.replace(/[^0-9]/g, '')) || 0;
              if (text.includes('ads found') || text.includes('ads_found')) metrics.ads_found = num;
              if (text.includes('risk')) metrics.privacy_risk = card.textContent?.trim();
              if (text.includes('flag'))  metrics.reg_flags = num;
            });
            // Also grab any domain that was analysed
            const domainInput = document.querySelector('input[type="text"],input[placeholder*="domain"]');
            if (domainInput?.value) metrics.analysed_domain = domainInput.value;
            metrics.platform = 'adworth_dashboard';

          } else if (hostname.includes('ads.google.com')) {
            const rows = document.querySelectorAll('[role="row"]');
            rows.forEach(row => {
              const cells = row.querySelectorAll('[role="gridcell"]');
              if (cells.length > 0) {
                const text = cells[0]?.textContent?.toLowerCase() || '';
                if (text.includes('spend') || text.includes('cost'))
                  metrics.spend = parseFloat(cells[1]?.textContent?.replace(/[$,]/g, '')) || 0;
                if (text.includes('impression'))
                  metrics.impressions = parseInt(cells[1]?.textContent?.replace(/[^0-9]/g, '')) || 0;
                if (text.includes('click') && !text.includes('rate'))
                  metrics.clicks = parseInt(cells[1]?.textContent?.replace(/[^0-9]/g, '')) || 0;
              }
            });
            metrics.platform = 'google_ads';

          } else if (hostname.includes('business.facebook.com')) {
            const cells = document.querySelectorAll('[data-testid*="metric"],[aria-label*="metric"]');
            cells.forEach(cell => {
              const label = (cell?.getAttribute('aria-label') || cell?.textContent || '').toLowerCase();
              const value = cell?.nextElementSibling?.textContent || '';
              if (label.includes('spend'))      metrics.spend = parseFloat(value.replace(/[$,]/g, '')) || 0;
              if (label.includes('conversion')) metrics.conversions = parseInt(value.replace(/[^0-9]/g, '')) || 0;
            });
            metrics.platform = 'facebook';

          } else {
            // Any other page — capture basic page signal so demo still flows end-to-end
            metrics.platform = 'web_page';
            metrics.page_title = document.title?.substring(0, 80) || '';
            metrics.ad_elements = document.querySelectorAll('[id*="ad"],[class*="ad"],[class*="sponsor"]').length;
          }

          return metrics;
        }
      });
    } catch (injectErr) {
      throw new Error('Could not access this page: ' + injectErr.message + '. Try adworth.app/demo.');
    }

    const data = results?.[0]?.result;
    if (!data) throw new Error('No data returned from page.');

    const stored = await chrome.storage.local.get(['user_id', 'device_fingerprint', 'ingestion_count']);
    const userId = stored.user_id;
    if (!userId) throw new Error('Not setup yet. Click Setup Extension first.');

    const timestamp = new Date().toISOString();
    const messageToSign = JSON.stringify({ ...data, timestamp });

    // ── Sign with private key via background service worker ──
    // If SW was terminated by Chrome, sendMessage will wake it back up.
    const signatureBase64 = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'signData',
        userId: userId,
        message: messageToSign
      }, (sig) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!sig) {
          reject(new Error('Session expired — please click Setup Extension again to regenerate your key.'));
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
        timestamp,
        data,
        signature: signatureBase64
      })
    });

    if (!ingestRes.ok) throw new Error('Ingest failed: ' + ingestRes.statusText);
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
