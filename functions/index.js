const {onCall} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const {defineSecret} = require('firebase-functions/params');

// Initialize Firebase Admin
admin.initializeApp();

// Define secrets
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const openaiApiKey = defineSecret('OPENAI_API_KEY');

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 1: Claude Proxy
// ═══════════════════════════════════════════════════════

exports.callClaudeProxy = onCall(
  {
    secrets: [anthropicApiKey],
    region: 'us-central1',
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (request) => {
    if (!request.auth) {
      throw new Error('User must be authenticated');
    }

    const userId = request.auth.uid;
    const {messages, tools, system} = request.data;

    console.log('Claude proxy called', {
      userId,
      messageCount: messages?.length,
      hasTools: !!tools,
    });

    // Rate limiting
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({
        dailyRequests: 0,
        monthlyTokens: 0,
        subscriptionTier: 'free',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const userData = userDoc.data() || {dailyRequests: 0, subscriptionTier: 'free'};
    const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 10;

    if (userData.dailyRequests >= dailyLimit) {
      throw new Error(
        `Daily limit of ${dailyLimit} requests reached. ${
          userData.subscriptionTier === 'free' ? 'Upgrade to Pro for 1000 requests/day.' : ''
        }`
      );
    }

    // Call Claude API
    const apiKey = anthropicApiKey.value();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 4096,
        messages: messages,
        tools: tools || undefined,
        system: system || undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', errorText);
      throw new Error(`Claude API error: ${response.statusText}`);
    }

    const result = await response.json();

    // Update usage
    await userRef.update({
      dailyRequests: admin.firestore.FieldValue.increment(1),
      monthlyTokens: admin.firestore.FieldValue.increment(
        result.usage.input_tokens + result.usage.output_tokens
      ),
      lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Log usage
    await db.collection('usage_logs').add({
      userId: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      model: 'claude-3-5-haiku-20241022',
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cost: (result.usage.input_tokens * 0.25 + result.usage.output_tokens * 1.25) / 1000000,
      hasTools: !!tools,
      stopReason: result.stop_reason,
    });

    console.log('Claude response', {
      userId,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    });

    return {
      content: result.content,
      stopReason: result.stop_reason,
      usage: result.usage,
    };
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 2: Whisper Proxy
// ═══════════════════════════════════════════════════════

exports.callWhisperProxy = onCall(
  {
    secrets: [openaiApiKey],
    region: 'us-central1',
    timeoutSeconds: 300,
    memory: '1GiB',
  },
  async (request) => {
    if (!request.auth) {
      throw new Error('User must be authenticated');
    }

    const userId = request.auth.uid;
    const audioDataBase64 = request.data.audioData;

    if (!audioDataBase64) {
      throw new Error('audioData is required');
    }

    console.log('Whisper proxy called', {userId, audioSize: audioDataBase64.length});

    // Rate limiting
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data() || {dailyRequests: 0, subscriptionTier: 'free'};
    const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 10;

    if (userData.dailyRequests >= dailyLimit) {
      throw new Error(`Daily limit of ${dailyLimit} requests reached`);
    }

    // Call Whisper API
    const apiKey = openaiApiKey.value();
    const audioBuffer = Buffer.from(audioDataBase64, 'base64');

    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, {filename: 'audio.m4a', contentType: 'audio/mp4'});
    form.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Whisper API error:', errorText);
      throw new Error(`Whisper API error: ${response.statusText}`);
    }

    const result = await response.json();

    // Update usage
    await userRef.update({
      dailyRequests: admin.firestore.FieldValue.increment(1),
      lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('usage_logs').add({
      userId: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      service: 'whisper',
      audioSize: audioBuffer.length,
    });

    console.log('Whisper response', {userId, textLength: result.text?.length});

    return {text: result.text};
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 3: Get User Usage
// ═══════════════════════════════════════════════════════

exports.getUserUsage = onCall({region: 'us-central1'}, async (request) => {
  if (!request.auth) {
    throw new Error('User must be authenticated');
  }

  const userId = request.auth.uid;
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.data();

  if (!userData) {
    return {
      dailyRequests: 0,
      monthlyTokens: 0,
      subscriptionTier: 'free',
      dailyLimit: 10,
      monthlyLimit: 100000,
      remainingDaily: 10,
      remainingMonthly: 100000,
    };
  }

  const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 10;
  const monthlyLimit = userData.subscriptionTier === 'pro' ? 10000000 : 100000;

  return {
    dailyRequests: userData.dailyRequests || 0,
    monthlyTokens: userData.monthlyTokens || 0,
    subscriptionTier: userData.subscriptionTier || 'free',
    dailyLimit: dailyLimit,
    monthlyLimit: monthlyLimit,
    remainingDaily: Math.max(0, dailyLimit - (userData.dailyRequests || 0)),
    remainingMonthly: Math.max(0, monthlyLimit - (userData.monthlyTokens || 0)),
    lastRequestAt: userData.lastRequestAt,
  };
});
