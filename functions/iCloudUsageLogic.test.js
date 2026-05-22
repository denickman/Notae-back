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

function evaluateAggregatedUsageLimitSync({ docs, usageField, userData, limitForTier }) {
  const currentTier = userData.subscriptionTier || 'free';
  const effectiveTier = docs.length > 0
    ? resolveEffectiveTierFromDocs(docs, currentTier)
    : currentTier;

  if (effectiveTier === 'free') {
    const limit = limitForTier('free');
    const used = userData[usageField] || 0;
    return { canProceed: used < limit, totalUsed: used, limit, tier: 'free' };
  }

  const limit = limitForTier(effectiveTier);
  const totalUsed = docs.length > 0
    ? sumUsageFieldAcrossDocs(docs, usageField)
    : (userData[usageField] || 0);

  return {
    canProceed: totalUsed < limit,
    totalUsed,
    limit,
    tier: effectiveTier,
  };
}

function resolveUsageCountsForDisplay({ effectiveTier, userData, iCloudDocs }) {
  if (effectiveTier === 'free') {
    return {
      voiceActionsUsed: userData.voiceActionsUsed || 0,
      photoScansUsed: userData.photoScansUsed || 0,
    };
  }
  return {
    voiceActionsUsed: iCloudDocs.length > 0
      ? sumUsageFieldAcrossDocs(iCloudDocs, 'voiceActionsUsed')
      : (userData.voiceActionsUsed || 0),
    photoScansUsed: iCloudDocs.length > 0
      ? sumUsageFieldAcrossDocs(iCloudDocs, 'photoScansUsed')
      : (userData.photoScansUsed || 0),
  };
}

function migrationUsageKeysForDonorTier(donorTier) {
  const baseKeys = [
    'subscriptionTier',
    'subscriptionProductId',
    'lifetimeAPIRequests',
    'monthlyTokens',
  ];
  if (donorTier !== 'free') {
    baseKeys.push('voiceActionsUsed', 'photoScansUsed');
  }
  return baseKeys;
}

const voiceLimitForTier = (tier) => (tier === 'pro' ? 150 : tier === 'plus' ? 50 : 10);

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

test('evaluateAggregatedUsageLimitSync free tier uses per-device usage only', () => {
  const docs = [
    { data: () => ({ subscriptionTier: 'free', voiceActionsUsed: 5 }) },
    { data: () => ({ subscriptionTier: 'free', voiceActionsUsed: 3 }) },
  ];
  const result = evaluateAggregatedUsageLimitSync({
    docs,
    usageField: 'voiceActionsUsed',
    userData: { subscriptionTier: 'free', voiceActionsUsed: 3 },
    limitForTier: voiceLimitForTier,
  });
  assert.equal(result.tier, 'free');
  assert.equal(result.totalUsed, 3);
  assert.equal(result.limit, 10);
  assert.equal(result.canProceed, true);
});

test('evaluateAggregatedUsageLimitSync paid tier aggregates across iCloud peers', () => {
  const docs = [
    { data: () => ({ subscriptionTier: 'pro', voiceActionsUsed: 5 }) },
    { data: () => ({ subscriptionTier: 'free', voiceActionsUsed: 3 }) },
  ];
  const result = evaluateAggregatedUsageLimitSync({
    docs,
    usageField: 'voiceActionsUsed',
    userData: { subscriptionTier: 'free', voiceActionsUsed: 3 },
    limitForTier: voiceLimitForTier,
  });
  assert.equal(result.tier, 'pro');
  assert.equal(result.totalUsed, 8);
  assert.equal(result.limit, 150);
  assert.equal(result.canProceed, true);
});

test('resolveUsageCountsForDisplay free tier ignores peer counters', () => {
  const docs = [
    { data: () => ({ voiceActionsUsed: 5, photoScansUsed: 2 }) },
    { data: () => ({ voiceActionsUsed: 0, photoScansUsed: 0 }) },
  ];
  const counts = resolveUsageCountsForDisplay({
    effectiveTier: 'free',
    userData: { voiceActionsUsed: 3, photoScansUsed: 1 },
    iCloudDocs: docs,
  });
  assert.deepEqual(counts, { voiceActionsUsed: 3, photoScansUsed: 1 });
});

test('resolveUsageCountsForDisplay paid tier sums peer counters', () => {
  const docs = [
    { data: () => ({ voiceActionsUsed: 5, photoScansUsed: 2 }) },
    { data: () => ({ voiceActionsUsed: 2, photoScansUsed: 1 }) },
  ];
  const counts = resolveUsageCountsForDisplay({
    effectiveTier: 'plus',
    userData: { voiceActionsUsed: 2, photoScansUsed: 1 },
    iCloudDocs: docs,
  });
  assert.deepEqual(counts, { voiceActionsUsed: 7, photoScansUsed: 3 });
});

test('migrationUsageKeysForDonorTier skips usage keys for free donor', () => {
  const freeKeys = migrationUsageKeysForDonorTier('free');
  assert.ok(!freeKeys.includes('voiceActionsUsed'));
  assert.ok(!freeKeys.includes('photoScansUsed'));

  const plusKeys = migrationUsageKeysForDonorTier('plus');
  assert.ok(plusKeys.includes('voiceActionsUsed'));
  assert.ok(plusKeys.includes('photoScansUsed'));
});
