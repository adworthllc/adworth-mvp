const API_BASE = 'https://adworth-ingestion-api.adworthllc.workers.dev';
const LEDGER_BASE = 'https://adworth-ledger.adworthllc.workers.dev';

document.addEventListener('DOMContentLoaded', async () => {
  await updateStatus();
  await loadMetadata();

  document.getElementById('setupBtn').addEventListener('click', handleSetup);
  document.getElementById('syncBtn').addEventListener('click', handleSync);
  document.getElementById('ledgerBtn').addEventListener('click', handleViewLedger);

  // Key-loss acknowledgment gates the Setup button
  const ack = document.getElementById('keylossAck');
  if (ack) {
    ack.addEventListener('change', () => {
      document.getElementById('setupBtn').disabled = !ack.checked;
    });
  }
});

async function updateStatus() {
  const data = await chrome.storage.local.get(['user_id', 'setup_complete']);
  const statusEl = document.getElementById('status');
  const statusValue = document.getElementById('statusValue');
  const setupBtn = document.getElementById('setupBtn');
  const syncBtn = document.getElementById('syncBtn');
  const ledgerBtn = document.getElementById('ledgerBtn');
  const keylossBox = document.getElementById('keylossBox');

  if (data.setup_complete) {
    statusEl.className = 'status ready';
    statusValue.textContent = '\u2713 Ready';
    setupBtn.style.display = 'none';
    keylossBox.style.display = 'none';
    syncBtn.disabled = false;
    ledgerBtn.disabled = false;
  } else {
    statusEl.className = 'status error';
    statusValue.textContent = '\u26a0 Not Setup';
    setupBtn.style.display = 'block';
    // Setup stays disabled until the key-loss box is acknowledged
    keylossBox.style.display = 'block';
    setupBtn.disabled = !document.getElementById('keylossAck').checked;
    syncBtn.disabled = true;
    ledgerBtn.disabled = true;
  }
}

async function loadMetadata() {
  const data = await chrome.storage.local.get(['device_fingerprint', 'ingestion_count']);
  document.getElementById('device').textContent =
    data.device_fingerprint ? data.device_fingerprint.substring(0, 12) + '...' : '\u2014';
  document.getElementById('ingestions').textContent = data.ingestion_count || 0;
}

async function handleSetup() {
  // Defense in depth — the button is disabled until acknowledged, but re-check.
  if (!document.getElementById('keylossAck').checked) {
    showMessage('Please acknowledge the key notice before setup.', 'error');
    return;
  }

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

    showMessage('\u2713 Setup complete! Ready to sync data.', 'success');

    await updateStatus();
    await loadMetadata();

  } catch (err) {
    console.error('Setup error:', err);
    showMessage('\u2717 Setup failed: ' + err.message, 'error');
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
    // executeScript with func: runs inline in page context and returns data
    // immediately. Limited by host_permissions to the three permitted domains.
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
            const rows = document.querySelectorAll('tr');
            rows.forEach(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 2) {
                const label = cells[0]?.textContent?.toLowerCase().trim() || '';
                const value = cells[1]?.textContent?.trim() || '';
                if (label.includes('campaign'))   metrics.campaign_name = value;
                if (label.includes('spend'))      metrics.spend = parseFloat(value.replace(/[$,]/g, '')) || 0;
                if (label.includes('conversion')) metrics.conversions = parseInt(value.replace(/[^0-9]/g, '')) || 0;
                if (label.includes('impression')) metrics.impressions = parseInt(value.replace(/[^0-9]/g, '')) || 0;
                if (label.includes('roas'))       metrics.roas = parseFloat(value) || 0;
              }
            });
            metrics.platform = 'adworth_demo'; metrics.advertiser_id = 'adworth-demo-advertiser';

          } else if (hostname.includes('adworth.app')) {
            const cards = document.querySelectorAll('[class*="metric"],[class*="stat"],[class*="result"],[class*="card"],[class*="val"]');
            cards.forEach(card => {
              const text = card.textContent?.toLowerCase() || '';
              const num = parseInt(card.textContent?.replace(/[^0-9]/g, '')) || 0;
              if (text.includes('ads found') || text.includes('ads_found')) metrics.ads_found = num;
              if (text.includes('risk')) metrics.privacy_risk = card.textContent?.trim();
              if (text.includes('flag')) metrics.reg_flags = num;
            });
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
          }
          // No else branch: host_permissions is restricted to ads.google.com,
          // business.facebook.com, and adworth.app. executeScript cannot run
          // on any other origin, so arbitrary-page extraction is impossible
          // by design. Page titles / browsing context of other sites are
          // never read. (v1.1.0 — privacy hardening.)

          return metrics;
        }
      });
    } catch (injectErr) {
      throw new Error('This page is not a supported ad platform. Open Google Ads, Meta Ads Manager, or adworth.app/demo, then sync.');
    }

    const data = results?.[0]?.result;
    if (!data) throw new Error('No data returned from page.');

    const stored = await chrome.storage.local.get(['user_id', 'device_fingerprint', 'ingestion_count']);
    const userId = stored.user_id;
    if (!userId) throw new Error('Not setup yet. Click Setup Extension first.');

    const timestamp = new Date().toISOString();
    const messageToSign = JSON.stringify({ ...data, timestamp });

    // ── Sign with private key via background service worker ──
    const signatureBase64 = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'signData',
        userId: userId,
        message: messageToSign
      }, (sig) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!sig) {
          reject(new Error('Session expired \u2014 please click Setup Extension again to regenerate your key.'));
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

    showMessage(`\u2713 Data synced! ID: ${result.ingestion_id.substring(0, 8)}...`, 'success');

    await loadMetadata();

  } catch (err) {
    console.error('Sync error:', err);
    showMessage('\u2717 Sync failed: ' + err.message, 'error');
  }
}

// ── View My Consent Ledger ──────────────────────────────────────────────────
// Proves identity by signing "{userId}:{timestamp}" with the device private
// key, then calls POST /user/ledger. No password, no API key — the key is the
// identity. Returned data is rendered with createTextNode (no innerHTML of
// server data) to keep rendering XSS-safe.
async function handleViewLedger() {
  const messageEl = document.getElementById('message');
  messageEl.className = '';
  messageEl.textContent = 'Retrieving your ledger...';

  try {
    const stored = await chrome.storage.local.get(['user_id']);
    const userId = stored.user_id;
    if (!userId) throw new Error('Not setup yet. Click Setup Extension first.');

    // The challenge: a numeric timestamp. The Worker enforces a 5-min window.
    const timestamp = String(Date.now());
    const challenge = `${userId}:${timestamp}`;

    const signature = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'signData',
        userId: userId,
        message: challenge
      }, (sig) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!sig) {
          reject(new Error('Session expired \u2014 please click Setup Extension again to regenerate your key.'));
        } else {
          resolve(sig);
        }
      });
    });

    const res = await fetch(`${LEDGER_BASE}/user/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, timestamp, signature })
    });

    if (res.status === 401) throw new Error('Could not verify your key. Try again, or re-run Setup.');
    if (!res.ok) throw new Error('Ledger retrieval failed: ' + res.statusText);

    const data = await res.json();
    renderLedger(data);
    messageEl.className = '';
    messageEl.textContent = '';

  } catch (err) {
    console.error('Ledger error:', err);
    showMessage('\u2717 ' + err.message, 'error');
  }
}

function renderLedger(data) {
  const section = document.getElementById('ledgerSection');
  const content = document.getElementById('ledgerContent');
  content.textContent = ''; // clear
  section.style.display = 'block';

  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  if (tokens.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ledger-empty';
    empty.textContent = 'No consent tokens yet. Use "Generate Consent Token" to create one.';
    content.appendChild(empty);
    return;
  }

  tokens.forEach((token) => {
    const card = document.createElement('div');
    card.className = 'token-card';

    // Token ID
    const idEl = document.createElement('div');
    idEl.className = 'tc-id';
    idEl.textContent = token.token_id || 'unknown';
    card.appendChild(idEl);

    // Derive status + dates from the token's events
    const events = Array.isArray(token.events) ? token.events : [];
    let status = 'active';
    let issued = null;
    let expires = null;
    let scope = null;
    for (const ev of events) {
      if (ev.event === 'CONSENT_REVOKED') status = 'revoked';
      if (ev.event === 'CONSENT_EXPIRED') status = 'expired';
      if (ev.event === 'CONSENT_ISSUED') {
        issued = ev.timestamp || null;
        if (ev.details && ev.details.expiresAt) expires = ev.details.expiresAt;
      }
      if (ev.scope) scope = ev.scope;
    }

    card.appendChild(makeRow('Status', null, status));
    if (issued)  card.appendChild(makeRow('Issued', formatDate(issued)));
    if (expires) card.appendChild(makeRow('Expires', formatDate(expires)));

    // Scope — present but may be unspecified until consent categories ship.
    // 'running-data-shoe-ads' is a hardcoded demo default in the current
    // ingestion-api build (not a real user choice); tag it so the dashboard
    // does not present a placeholder as a genuine consent decision.
    const scopeRow = document.createElement('div');
    scopeRow.className = 'tc-row';
    const scopeLabel = document.createElement('span');
    scopeLabel.className = 'tc-label';
    scopeLabel.textContent = 'Scope';
    scopeRow.appendChild(scopeLabel);
    const scopeVal = document.createElement('span');
    if (scope === 'running-data-shoe-ads') {
      scopeVal.textContent = scope + ' ';
      const tag = document.createElement('span');
      tag.className = 'tc-scope-pending';
      tag.textContent = '(demo default)';
      scopeVal.appendChild(tag);
    } else if (scope) {
      scopeVal.textContent = scope;
    } else {
      scopeVal.className = 'tc-scope-pending';
      scopeVal.textContent = 'not yet specified';
    }
    scopeRow.appendChild(scopeVal);
    card.appendChild(scopeRow);

    content.appendChild(card);
  });
}

// Build a label/value row. If statusValue is provided, render it as a pill.
function makeRow(label, value, statusValue) {
  const row = document.createElement('div');
  row.className = 'tc-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'tc-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  if (statusValue) {
    const pill = document.createElement('span');
    pill.className = 'tc-status ' + statusValue;
    pill.textContent = statusValue;
    row.appendChild(pill);
  } else {
    const valEl = document.createElement('span');
    valEl.textContent = value || '\u2014';
    row.appendChild(valEl);
  }
  return row;
}

function formatDate(ts) {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(ts);
  }
}

function showMessage(text, type) {
  const el = document.getElementById('message');
  el.className = 'message ' + type;
  el.textContent = text;
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
