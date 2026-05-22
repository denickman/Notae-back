'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Pure helpers mirrored from index.js for unit tests (keep in sync manually).
const SUBSCRIPTION_TIER_ORDER = { free: 0, plus: 1, pro: 2 };

function isSubscriptionTierUpgrade(fromTier, toTier) {
  const from = String(fromTier || 'free');
  const to = String(toTier || 'free');
  return (SUBSCRIPTION_TIER_ORDER[to] ?? 0) > (SUBSCRIPTION_TIER_ORDER[from] ?? 0);
}

function highestSubscriptionTier(tierA, tierB) {
  const a = SUBSCRIPTION_TIER_ORDER[tierA] ?? 0;
  const b = SUBSCRIPTION_TIER_ORDER[tierB] ?? 0;
  return a >= b ? (tierA || 'free') : (tierB || 'free');
}

function sumUsageFieldAcrossDocs(docs, field) {
  let total = 0;
  docs.forEach((doc) => {
    total += doc.data()[field] || 0;
  });
  return total;
}

function resolveEffectiveTierFromDocs(docs, fallbackTier = 'free') {
  let best = fallbackTier || 'free';
  docs.forEach((doc) => {
    const t = doc.data().subscriptionTier || 'free';
    best = highestSubscriptionTier(best, t);
  });
  return best;
}

test('highestSubscriptionTier prefers pro over plus over free', () => {
  assert.equal(highestSubscriptionTier('free', 'plus'), 'plus');
  assert.equal(highestSubscriptionTier('plus', 'pro'), 'pro');
  assert.equal(highestSubscriptionTier('pro', 'free'), 'pro');
});

test('sumUsageFieldAcrossDocs totals voiceActionsUsed', () => {
  const docs = [
    { data: () => ({ voiceActionsUsed: 3 }) },
    { data: () => ({ voiceActionsUsed: 7 }) },
    { data: () => ({ photoScansUsed: 99 }) },
  ];
  assert.equal(sumUsageFieldAcrossDocs(docs, 'voiceActionsUsed'), 10);
});

test('resolveEffectiveTierFromDocs picks highest tier among peers', () => {
  const docs = [
    { data: () => ({ subscriptionTier: 'free' }) },
    { data: () => ({ subscriptionTier: 'pro' }) },
    { data: () => ({ subscriptionTier: 'plus' }) },
  ];
  assert.equal(resolveEffectiveTierFromDocs(docs, 'free'), 'pro');
});

test('isSubscriptionTierUpgrade true only for paid tier increases', () => {
  assert.equal(isSubscriptionTierUpgrade('free', 'plus'), true);
  assert.equal(isSubscriptionTierUpgrade('plus', 'pro'), true);
  assert.equal(isSubscriptionTierUpgrade('free', 'pro'), true);
  assert.equal(isSubscriptionTierUpgrade('pro', 'plus'), false);
  assert.equal(isSubscriptionTierUpgrade('plus', 'free'), false);
  assert.equal(isSubscriptionTierUpgrade('pro', 'free'), false);
  assert.equal(isSubscriptionTierUpgrade('plus', 'plus'), false);
});
