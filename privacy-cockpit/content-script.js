// Content script runs on dashboard pages
// Extracts marketing metrics without PII

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractMetrics') {
    const metrics = extractDashboardMetrics();
    sendResponse({ data: metrics });
  }
});

function extractDashboardMetrics() {
  const hostname = window.location.hostname;
  
  if (hostname.includes('ads.google.com')) {
    return extractGoogleAdsMetrics();
  } else if (hostname.includes('business.facebook.com')) {
    return extractFacebookMetrics();
  } else if (hostname.includes('adworth.app/demo')) {
    return extractDemoMetrics();
  }
  
  return null;
}

function extractGoogleAdsMetrics() {
  const metrics = {};
  
  try {
    const rows = document.querySelectorAll('[role="row"]');
    rows.forEach(row => {
      const cells = row.querySelectorAll('[role="gridcell"]');
      if (cells.length > 0) {
        const text = cells[0]?.textContent?.toLowerCase() || '';
        
        if (text.includes('campaign') || text.includes('name')) {
          metrics.campaign_name = cells[1]?.textContent;
        }
        if (text.includes('spend') || text.includes('cost')) {
          const val = cells[1]?.textContent?.replace(/[$,]/g, '');
          metrics.spend = parseFloat(val);
        }
        if (text.includes('conversion') && !text.includes('rate')) {
          const val = cells[1]?.textContent?.replace(/[^0-9]/g, '');
          metrics.conversions = parseInt(val);
        }
        if (text.includes('impression')) {
          const val = cells[1]?.textContent?.replace(/[^0-9]/g, '');
          metrics.impressions = parseInt(val);
        }
        if (text.includes('click') && !text.includes('rate')) {
          const val = cells[1]?.textContent?.replace(/[^0-9]/g, '');
          metrics.clicks = parseInt(val);
        }
      }
    });
  } catch (err) {
    console.error('Google Ads extraction error:', err);
  }
  
  metrics.platform = 'google_ads';
  metrics.extracted_at = new Date().toISOString();
  
  return Object.keys(metrics).length > 1 ? metrics : null;
}

function extractFacebookMetrics() {
  const metrics = {};
  
  try {
    const cells = document.querySelectorAll('[data-testid*="metric"], [aria-label*="metric"]');
    cells.forEach(cell => {
      const label = cell?.getAttribute('aria-label') || cell?.textContent;
      const value = cell?.nextElementSibling?.textContent;
      
      if (label && value) {
        if (label.toLowerCase().includes('spend')) {
          metrics.spend = parseFloat(value.replace(/[$,]/g, ''));
        }
        if (label.toLowerCase().includes('conversion')) {
          metrics.conversions = parseInt(value.replace(/[^0-9]/g, ''));
        }
      }
    });
  } catch (err) {
    console.error('Facebook extraction error:', err);
  }
  
  metrics.platform = 'facebook';
  metrics.extracted_at = new Date().toISOString();
  
  return Object.keys(metrics).length > 1 ? metrics : null;
}

function extractDemoMetrics() {
  // For adworth.app/demo dashboard
  const metrics = {};
  
  try {
    const rows = document.querySelectorAll('tr');
    let i = 0;
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const label = cells[0]?.textContent?.toLowerCase() || '';
        const value = cells[1]?.textContent || '';
        
        if (label.includes('campaign')) {
          metrics.campaign_name = value;
        }
        if (label.includes('spend')) {
          metrics.spend = parseFloat(value.replace(/[$,]/g, ''));
        }
        if (label.includes('conversion')) {
          metrics.conversions = parseInt(value.replace(/[^0-9]/g, ''));
        }
        if (label.includes('impression')) {
          metrics.impressions = parseInt(value.replace(/[^0-9]/g, ''));
        }
        if (label.includes('roas')) {
          metrics.roas = parseFloat(value);
        }
      }
    });
  } catch (err) {
    console.error('Demo extraction error:', err);
  }
  
  metrics.platform = 'demo';
  metrics.extracted_at = new Date().toISOString();
  
  return Object.keys(metrics).length > 1 ? metrics : null;
}
