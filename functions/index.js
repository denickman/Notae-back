const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const {defineSecret} = require('firebase-functions/params');
const axios = require('axios');
const FormData = require('form-data');

// Initialize Firebase Admin
admin.initializeApp();

// Define secrets
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const openaiApiKey = defineSecret('OPENAI_API_KEY');

// ═══════════════════════════════════════════════════════
// HELPER: Check and Reset Daily Limits
// ═══════════════════════════════════════════════════════

async function checkAndResetDailyLimit(userRef, userData) {
  const now = new Date();
  const lastReset = userData.lastResetAt?.toDate();
  
  // Проверяем нужен ли сброс (новый день)
  if (!lastReset || lastReset.toDateString() !== now.toDateString()) {
    console.log('🔄 Resetting daily limits for new day');
    await userRef.update({
      dailyRequests: 0,
      lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return 0;
  }
  
  return userData.dailyRequests || 0;
}

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 1: Claude Proxy (С ПРАВИЛЬНЫМ HttpsError)
// ═══════════════════════════════════════════════════════

exports.callClaudeProxy = onCall(
  {
    secrets: [anthropicApiKey],
    region: 'us-central1',
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (request) => {
    console.log('🤖 === CLAUDE PROXY CALLED ===');
    
    if (!request.auth) {
      console.error('❌ No authentication');
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = request.auth.uid;
    console.log('✅ User authenticated:', userId);
    
    const {messages, tools, system} = request.data;

    console.log('📊 Request data:', {
      userId,
      messageCount: messages?.length,
      hasTools: !!tools,
      hasSystem: !!system,
    });

    try {
      // Rate limiting with Firestore
      console.log('🔍 Checking rate limits...');
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.log('📝 Creating new user document');
        await userRef.set({
          dailyRequests: 0,
          monthlyTokens: 0,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      let userData = userDoc.data() || {
        dailyRequests: 0,
        subscriptionTier: 'free',
        monthlyTokens: 0
      };
      
      // ✅ АВТОСБРОС ЛИМИТА
      const currentRequests = await checkAndResetDailyLimit(userRef, userData);
      userData.dailyRequests = currentRequests;
      
      const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 5;

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        dailyRequests: userData.dailyRequests,
        dailyLimit,
        remainingRequests: dailyLimit - userData.dailyRequests,
      });

      // ✅ ПРАВИЛЬНЫЙ СПОСОБ ВЫБРОСИТЬ ОШИБКУ ЛИМИТА
      if (userData.dailyRequests >= dailyLimit) {
        console.error('❌ Rate limit exceeded');
        throw new HttpsError(
          'resource-exhausted',
          `DAILY_LIMIT_REACHED:${dailyLimit}:${userData.subscriptionTier}`,
          {
            limit: dailyLimit,
            tier: userData.subscriptionTier,
            message: `DAILY_LIMIT_REACHED:${dailyLimit}:${userData.subscriptionTier}`
          }
        );
      }

      // Call Claude API
      console.log('🔑 Getting API key...');
      const apiKey = anthropicApiKey.value();
      
      if (!apiKey) {
        console.error('❌ ANTHROPIC_API_KEY is not set!');
        throw new HttpsError('failed-precondition', 'API key not configured');
      }
      
      console.log('✅ API key retrieved (length:', apiKey.length, ')');

      console.log('🌐 Calling Claude API...');
      const apiStartTime = Date.now();
      
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

      const apiDuration = Date.now() - apiStartTime;

      console.log('📡 API response received:', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        durationMs: apiDuration,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Claude API error:', errorText);
        throw new HttpsError('internal', `Claude API error: ${response.statusText}`);
      }

      const result = await response.json();
      
      const estimatedCost = (
        result.usage.input_tokens * 0.25 +
        result.usage.output_tokens * 1.25
      ) / 1000000;
      
      console.log('✅ Claude response successful:', {
        stopReason: result.stop_reason,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
        estimatedCost: `$${estimatedCost.toFixed(6)}`,
      });

      // Update usage
      console.log('💾 Updating usage stats...');
      await userRef.update({
        dailyRequests: admin.firestore.FieldValue.increment(1),
        monthlyTokens: admin.firestore.FieldValue.increment(
          result.usage.input_tokens + result.usage.output_tokens
        ),
        lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Enhanced usage logging
      await db.collection('usage_logs').add({
        userId: userId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        service: 'claude',
        model: 'claude-3-5-haiku-20241022',
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
        cost: estimatedCost,
        hasTools: !!tools,
        stopReason: result.stop_reason,
        durationMs: apiDuration,
        subscriptionTier: userData.subscriptionTier,
      });

      console.log('✅ Usage stats updated');
      console.log('🎉 Claude proxy completed successfully');

      return {
        content: result.content,
        stopReason: result.stop_reason,
        usage: result.usage,
        remainingRequests: dailyLimit - (userData.dailyRequests + 1),
      };
    } catch (error) {
      console.error('💥 CLAUDE PROXY ERROR:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      
      // ✅ Если это уже HttpsError - пробросить как есть
      if (error instanceof HttpsError) {
        throw error;
      }
      
      // Иначе обернуть в internal
      throw new HttpsError('internal', error.message);
    }
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 2: Whisper Proxy (С ПРАВИЛЬНЫМ HttpsError)
// ═══════════════════════════════════════════════════════

exports.callWhisperProxy = onCall(
  {
    secrets: [openaiApiKey],
    region: 'us-central1',
    timeoutSeconds: 300,
    memory: '1GiB',
  },
  async (request) => {
    console.log('🎙️ === WHISPER PROXY CALLED ===');
    
    if (!request.auth) {
      console.error('❌ No authentication');
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = request.auth.uid;
    console.log('✅ User authenticated:', userId);
    
    const audioDataBase64 = request.data.audioData;
    const language = request.data.language || 'auto';

    if (!audioDataBase64) {
      console.error('❌ No audioData in request');
      throw new HttpsError('invalid-argument', 'audioData is required');
    }

    const audioBuffer = Buffer.from(audioDataBase64, 'base64');
    const audioSizeMB = audioBuffer.length / 1024 / 1024;

    console.log('📊 Audio data received:', {
      userId,
      base64Length: audioDataBase64.length,
      audioSizeMB: audioSizeMB.toFixed(2),
      language: language,
    });

    // ✅ ПРОВЕРКА РАЗМЕРА
    if (audioSizeMB > 25) {
      console.error('❌ Audio file too large:', audioSizeMB, 'MB');
      throw new HttpsError(
        'invalid-argument',
        `Audio file too large: ${audioSizeMB.toFixed(1)}MB (max 25MB)`
      );
    }

    try {
      // Rate limiting with Firestore
      console.log('🔍 Checking rate limits...');
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) {
        console.log('📝 Creating new user document');
        await userRef.set({
          dailyRequests: 0,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      
      let userData = userDoc.data() || {
        dailyRequests: 0,
        subscriptionTier: 'free'
      };
      
      // ✅ АВТОСБРОС ЛИМИТА
      const currentRequests = await checkAndResetDailyLimit(userRef, userData);
      userData.dailyRequests = currentRequests;
      
      const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 5;

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        dailyRequests: userData.dailyRequests,
        dailyLimit,
        remainingRequests: dailyLimit - userData.dailyRequests,
      });

      // ✅ ПРАВИЛЬНЫЙ СПОСОБ ВЫБРОСИТЬ ОШИБКУ ЛИМИТА
      if (userData.dailyRequests >= dailyLimit) {
        console.error('❌ Rate limit exceeded');
        throw new HttpsError(
          'resource-exhausted',
          `DAILY_LIMIT_REACHED:${dailyLimit}:${userData.subscriptionTier}`,
          {
            limit: dailyLimit,
            tier: userData.subscriptionTier,
            message: `DAILY_LIMIT_REACHED:${dailyLimit}:${userData.subscriptionTier}`
          }
        );
      }

      // Call Whisper API
      console.log('🔑 Getting API key...');
      const apiKey = openaiApiKey.value();
      
      if (!apiKey) {
        console.error('❌ OPENAI_API_KEY is not set!');
        throw new HttpsError('failed-precondition', 'API key not configured');
      }
      
      console.log('✅ API key retrieved (length:', apiKey.length, ')');

      console.log('📝 Creating FormData with axios...');
      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.m4a',
        contentType: 'audio/mp4',
      });
      form.append('model', 'whisper-1');
      
      // ✅ ДОБАВЛЯЕМ ЯЗЫК
      if (language && language !== 'auto') {
        form.append('language', language);
        console.log('🌍 Language specified:', language);
      }
      
      console.log('✅ FormData created');

      console.log('🌐 Calling OpenAI Whisper API via axios...');
      const apiStartTime = Date.now();
      
      const response = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...form.getHeaders(),
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      const apiDuration = Date.now() - apiStartTime;

      console.log('📡 API response received:', {
        status: response.status,
        statusText: response.statusText,
        durationMs: apiDuration,
      });

      const result = response.data;
      
      // ✅ РАСЧЁТ ДЛИТЕЛЬНОСТИ И СТОИМОСТИ
      const estimatedDurationMinutes = audioSizeMB / 2;
      const estimatedCost = estimatedDurationMinutes * 0.006;
      
      console.log('✅ Transcription successful:', {
        textLength: result.text?.length,
        textPreview: result.text?.substring(0, 50),
        estimatedDurationMin: estimatedDurationMinutes.toFixed(2),
        estimatedCost: `$${estimatedCost.toFixed(6)}`,
      });

      // Update usage
      console.log('💾 Updating usage stats...');
      await userRef.update({
        dailyRequests: admin.firestore.FieldValue.increment(1),
        lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ✅ РАСШИРЕННОЕ ЛОГИРОВАНИЕ
      await db.collection('usage_logs').add({
        userId: userId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        service: 'whisper',
        audioSize: audioBuffer.length,
        audioSizeMB: parseFloat(audioSizeMB.toFixed(2)),
        estimatedDurationMinutes: parseFloat(estimatedDurationMinutes.toFixed(2)),
        cost: parseFloat(estimatedCost.toFixed(6)),
        language: language,
        textLength: result.text?.length,
        durationMs: apiDuration,
        subscriptionTier: userData.subscriptionTier,
      });

      console.log('✅ Usage stats updated');
      console.log('🎉 Whisper proxy completed successfully');

      return {
        text: result.text,
        remainingRequests: dailyLimit - (userData.dailyRequests + 1),
      };
    } catch (error) {
      // ✅ Если это уже HttpsError - пробросить как есть
      if (error instanceof HttpsError) {
        throw error;
      }
      
      // Axios errors
      if (error.response) {
        console.error('💥 WHISPER API ERROR:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        });
        throw new HttpsError(
          'internal',
          `Whisper API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`
        );
      }
      
      console.error('💥 WHISPER PROXY ERROR:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      
      throw new HttpsError('internal', error.message);
    }
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 3: Get User Usage
// ═══════════════════════════════════════════════════════

exports.getUserUsage = onCall({region: 'us-central1'}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const userId = request.auth.uid;
  const db = admin.firestore();
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  let userData = userDoc.data();

  if (!userData) {
    await userRef.set({
      dailyRequests: 0,
      monthlyTokens: 0,
      subscriptionTier: 'free',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    userData = {
      dailyRequests: 0,
      monthlyTokens: 0,
      subscriptionTier: 'free',
    };
  }

  // ✅ АВТОСБРОС ЛИМИТА
  const currentRequests = await checkAndResetDailyLimit(userRef, userData);
  userData.dailyRequests = currentRequests;

  const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 5;
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
    lastResetAt: userData.lastResetAt,
  };
});

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 4: Reset Daily Limits (SCHEDULED)
// ═══════════════════════════════════════════════════════

exports.resetDailyLimits = onSchedule(
  {
    schedule: '0 0 * * *',
    timeZone: 'UTC',
    region: 'us-central1',
  },
  async (event) => {
    console.log('🌙 === DAILY LIMITS RESET SCHEDULED ===');
    
    const db = admin.firestore();
    const usersSnapshot = await db.collection('users')
      .where('subscriptionTier', '==', 'free')
      .get();
    
    let resetCount = 0;
    const batch = db.batch();
    
    usersSnapshot.docs.forEach(doc => {
      batch.update(doc.ref, {
        dailyRequests: 0,
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      resetCount++;
    });
    
    await batch.commit();
    
    console.log(`✅ Reset daily limits for ${resetCount} users`);
    return {resetCount};
  }
);
