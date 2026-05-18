/**
 * consent-taxonomy.js — Adworth Privacy Cockpit
 * Two-layer consent categorization model.
 *
 * ============================================================
 * STATUS: PROVISIONAL — NOT YET WIRED INTO PRODUCTION
 * ============================================================
 * This module is a standalone artifact. As of v1.1.0 it is NOT imported
 * by popup.js, background.js, or any Worker. It exists to be reviewed —
 * including by patent/regulatory counsel (OPEN-4) — before the consent
 * token schema is changed fleet-wide (the "Phase 3" rollout).
 *
 * Do not import this into the live extension or Workers until:
 *   1. Counsel has reviewed the TCF v2.2 mapping (see PROVISIONAL note below)
 *   2. The token schema change is coordinated across adworth-ingestion-api,
 *      adworth-bouncer, and the ADWORTH_TOKENS / ADWORTH_LEDGER namespaces
 *   3. terms.html, privacy.html, and services.html are updated to describe
 *      the taxonomy (Standing Rule 1)
 *
 * ------------------------------------------------------------
 * THE TWO LAYERS
 * ------------------------------------------------------------
 * Layer 1 — PURPOSE: what the data is used for.
 *   Mapped to IAB TCF v2.2 standard Purpose IDs. This is the vocabulary
 *   the advertising buy-side already speaks, so an Adworth consent token
 *   carrying these IDs is legible to advertisers without translation.
 *
 * Layer 2 — LAWFUL BASIS: the legal grounding for processing.
 *   Mapped to GDPR Article 6(1) lawful bases. This is the actual law
 *   underneath the purpose. Carrying it makes a token auditable by a
 *   regulator, not just actionable by an advertiser.
 *
 * A single consent grant carries BOTH: { purposeId, basis, granted }.
 *
 * ------------------------------------------------------------
 * PROVISIONAL — TCF v2.2 MAPPING (attorney review required)
 * ------------------------------------------------------------
 * The Purpose IDs below mirror the IAB Europe Transparency & Consent
 * Framework v2.2 Global Vendor List purpose definitions. IMPORTANT:
 *   - TCF is governed by IAB Europe. Mapping to purpose IDs does NOT make
 *     Adworth a registered TCF Consent Management Platform (CMP), and this
 *     module does NOT emit a TCF "TC String."
 *   - The TCF framework has been the subject of regulatory challenge
 *     (Belgian DPA, 2022). Adworth must NOT claim "TCF compliance" or
 *     "IAB-approved" anywhere in product, marketing, or legal text until
 *     counsel confirms what may accurately be claimed.
 *   - This mapping is provisional and may change after FTO review, given
 *     consent-mechanism prior art is dense (cf. existing FTO concern re:
 *     Brave patents 12,314,982 / 12,093,977).
 * Treat the GDPR Article 6 layer as stable; treat the TCF layer as a
 * working assumption pending sign-off.
 * ------------------------------------------------------------
 */

'use strict';

/**
 * TCF v2.2 standard purposes (Layer 1).
 * id    — the IAB TCF v2.2 Purpose ID (integer, stable).
 * key   — Adworth internal slug.
 * label — short user-facing label for the Cockpit UI.
 * desc  — plain-language description shown to the user before they grant.
 *
 * PROVISIONAL: labels/descriptions are Adworth plain-language renderings,
 * not verbatim IAB text. Verbatim IAB text has its own usage terms —
 * counsel to advise before any verbatim use.
 */
const TCF_PURPOSES = Object.freeze([
  {
    id: 1,
    key: 'store_access_device',
    label: 'Store or access information on your device',
    desc: 'Allow cookies, device identifiers, or similar to be stored or read on your device.'
  },
  {
    id: 2,
    key: 'basic_ads',
    label: 'Use limited data to select basic ads',
    desc: 'Show ads based on limited data such as the content you are viewing and your approximate location.'
  },
  {
    id: 3,
    key: 'personalised_ads_profile',
    label: 'Create a profile for personalised advertising',
    desc: 'Build a profile about you using your activity to make advertising more relevant to you.'
  },
  {
    id: 4,
    key: 'personalised_ads',
    label: 'Use profiles to select personalised ads',
    desc: 'Select and show you ads based on a personalised advertising profile.'
  },
  {
    id: 5,
    key: 'personalised_content_profile',
    label: 'Create a profile for personalised content',
    desc: 'Build a profile about you to personalise the content (not ads) you are shown.'
  },
  {
    id: 6,
    key: 'personalised_content',
    label: 'Use profiles to select personalised content',
    desc: 'Select and show you content based on a personalised content profile.'
  },
  {
    id: 7,
    key: 'measure_ad_performance',
    label: 'Measure advertising performance',
    desc: 'Measure whether and how ads were shown to you and how they performed.'
  },
  {
    id: 8,
    key: 'measure_content_performance',
    label: 'Measure content performance',
    desc: 'Measure whether and how content was shown to you and how it performed.'
  },
  {
    id: 9,
    key: 'market_research',
    label: 'Understand audiences through research',
    desc: 'Use aggregated research to learn about audiences who saw ads or content.'
  },
  {
    id: 10,
    key: 'develop_improve_services',
    label: 'Develop and improve services',
    desc: 'Use your data to develop new products and improve existing ones.'
  }
]);

/**
 * GDPR Article 6(1) lawful bases (Layer 2).
 * For an advertising-consent product only two are realistically in play
 * (consent and legitimate interests), but all six are defined for
 * completeness and so the enumeration is jurisdiction-accurate.
 */
const GDPR_LAWFUL_BASES = Object.freeze([
  {
    id: 'consent',
    article: '6(1)(a)',
    label: 'Consent',
    desc: 'You have given clear, specific, informed, and freely given permission.'
  },
  {
    id: 'contract',
    article: '6(1)(b)',
    label: 'Contract',
    desc: 'Processing is necessary to perform a contract with you.'
  },
  {
    id: 'legal_obligation',
    article: '6(1)(c)',
    label: 'Legal obligation',
    desc: 'Processing is necessary to comply with the law.'
  },
  {
    id: 'vital_interests',
    article: '6(1)(d)',
    label: 'Vital interests',
    desc: 'Processing is necessary to protect someone\u2019s life.'
  },
  {
    id: 'public_task',
    article: '6(1)(e)',
    label: 'Public task',
    desc: 'Processing is necessary for a task carried out in the public interest.'
  },
  {
    id: 'legitimate_interests',
    article: '6(1)(f)',
    label: 'Legitimate interests',
    desc: 'Processing is necessary for legitimate interests, balanced against your rights.'
  }
]);

/**
 * The bases an Adworth consent token may legitimately carry.
 * Advertising consent in the Adworth model is grounded in EITHER explicit
 * consent OR legitimate interests — the two TCF itself permits. Any token
 * presenting a basis outside this set is rejected by isValidGrant().
 *
 * PROVISIONAL: whether legitimate_interests is acceptable for a given
 * purpose is a legal question. Counsel to confirm per-purpose.
 */
const ADWORTH_PERMITTED_BASES = Object.freeze(['consent', 'legitimate_interests']);

// ── Lookup helpers ──────────────────────────────────────────

const _purposeById = Object.freeze(
  Object.fromEntries(TCF_PURPOSES.map(p => [p.id, p]))
);
const _purposeByKey = Object.freeze(
  Object.fromEntries(TCF_PURPOSES.map(p => [p.key, p]))
);
const _basisById = Object.freeze(
  Object.fromEntries(GDPR_LAWFUL_BASES.map(b => [b.id, b]))
);

/** Look up a TCF purpose by its integer ID. Returns the object or null. */
function getPurposeById(id) {
  return _purposeById[id] || null;
}

/** Look up a TCF purpose by its Adworth slug. Returns the object or null. */
function getPurposeByKey(key) {
  return _purposeByKey[key] || null;
}

/** Look up a GDPR lawful basis by its id. Returns the object or null. */
function getBasisById(id) {
  return _basisById[id] || null;
}

/**
 * Validate a single consent grant.
 * A grant is { purposeId: int, basis: string, granted: bool }.
 * Returns true only if the purpose ID is a known TCF purpose, the basis
 * is one Adworth permits, and granted is a boolean.
 */
function isValidGrant(grant) {
  if (!grant || typeof grant !== 'object') return false;
  if (!Number.isInteger(grant.purposeId)) return false;
  if (!_purposeById[grant.purposeId]) return false;
  if (typeof grant.basis !== 'string') return false;
  if (!ADWORTH_PERMITTED_BASES.includes(grant.basis)) return false;
  if (typeof grant.granted !== 'boolean') return false;
  return true;
}

/**
 * Validate a full consent grant set — an array of grants.
 * Returns { valid: bool, errors: string[] }.
 * Does not require all 10 purposes to be present; a token may grant a
 * subset. Does reject duplicate purpose IDs and malformed entries.
 */
function validateGrantSet(grants) {
  const errors = [];
  if (!Array.isArray(grants)) {
    return { valid: false, errors: ['Grant set must be an array.'] };
  }
  if (grants.length === 0) {
    return { valid: false, errors: ['Grant set is empty.'] };
  }
  const seen = new Set();
  grants.forEach((g, i) => {
    if (!isValidGrant(g)) {
      errors.push(`Grant at index ${i} is invalid.`);
      return;
    }
    if (seen.has(g.purposeId)) {
      errors.push(`Duplicate purpose ID ${g.purposeId} at index ${i}.`);
    }
    seen.add(g.purposeId);
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Build a default grant set with every TCF purpose present and DENIED,
 * grounded in explicit consent. This is the privacy-respecting default:
 * the user must affirmatively turn each purpose ON. Nothing is granted
 * until the user acts.
 */
function buildDefaultGrantSet() {
  return TCF_PURPOSES.map(p => ({
    purposeId: p.id,
    basis: 'consent',
    granted: false
  }));
}

/**
 * Schema descriptor for the consent token payload this taxonomy implies.
 * Phase 3 (ingestion-api + bouncer) must agree with this shape.
 * Kept here as the single source of truth for the token contract.
 */
const CONSENT_TOKEN_SCHEMA = Object.freeze({
  taxonomy_version: 'adworth-consent-taxonomy-1.0-PROVISIONAL',
  purpose_standard: 'IAB-TCF-v2.2',
  basis_standard: 'GDPR-Article-6',
  grant_shape: { purposeId: 'integer', basis: 'string', granted: 'boolean' }
});

// ── Exports ─────────────────────────────────────────────────
// ES module export. When Phase 3 wires this in, popup.js / Workers
// import from here. No side effects on import.

export {
  TCF_PURPOSES,
  GDPR_LAWFUL_BASES,
  ADWORTH_PERMITTED_BASES,
  CONSENT_TOKEN_SCHEMA,
  getPurposeById,
  getPurposeByKey,
  getBasisById,
  isValidGrant,
  validateGrantSet,
  buildDefaultGrantSet
};
