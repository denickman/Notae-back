const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const {defineSecret} = require('firebase-functions/params');
const axios = require('axios');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const {importX509, importJWK, jwtVerify} = require('jose');

// Initialize Firebase Admin
admin.initializeApp();

// Define secrets
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const openaiApiKey = defineSecret('OPENAI_API_KEY');
const appleIssuerId = defineSecret('APPLE_ISSUER_ID');
const appleKeyId = defineSecret('APPLE_KEY_ID');
const applePrivateKey = defineSecret('APPLE_PRIVATE_KEY');

// Photo scan prompt templates
function getPhotoScanPrompt(photoType, customPrompt) {
  if (customPrompt) return customPrompt;

  const templates = {
    note: [
      'Extract all visible text and format as clean Markdown.',
      'Use headings (#, ##, ###), bullet lists, and **bold/italic** where appropriate.',
      'Preserve the original structure and order. Do not invent content.'
    ].join(' '),
    recipe: [
      'Extract recipe and format as Markdown with:',
      '# Title, **Prep time**, **Cook time**, **Servings**.',
      'Then ## Ingredients (grouped if needed), then ## Steps as a numbered list.',
      'Add ## Tips/Notes if present. Do not invent content.'
    ].join(' '),
    receipt: [
      'Extract receipt items and format as a Markdown table with columns:',
      'Item | Qty | Price | Total.',
      'Include Subtotal, Tax, Total at the end. Preserve currency symbols.'
    ].join(' '),
    whiteboard: [
      'Extract whiteboard content and organize into sections with headings.',
      'Use TODO checkboxes (- [ ]) for action items and bullet lists where helpful.'
    ].join(' '),
    business_card: [
      'Extract contact information and format as Markdown with emoji labels:',
      '👤 Name, 🏢 Company, 💼 Title, 📧 Email, 📞 Phone, 🌐 Website, 📍 Address.',
      'Include only fields that are present.'
    ].join(' ')
  };

  return templates[photoType] || templates.note;
}

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 1: Claude Proxy (LIFETIME LIMITS)
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
      // ✅ ПОЛУЧАЕМ DEVICE ID ИЗ ЗАПРОСА
      const deviceID = request.data.deviceID || 'unknown';
      console.log('📱 Device ID:', deviceID.substring(0, 8) + '...');
      
      // Rate limiting with Firestore
      console.log('🔍 Checking rate limits...');
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.log('📝 Creating new user document');
        await userRef.set({
          deviceID: deviceID,                // ← СОХРАНЯЕМ DEVICE ID
          lifetimeRequests: 0,               // ← LIFETIME вместо daily
          lifetimeLimit: 3,                  // ← ЛИМИТ НАВСЕГДА
          monthlyTokens: 0,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      let userData = userDoc.data() || {
        lifetimeRequests: 0,
        lifetimeLimit: 3,
        subscriptionTier: 'free',
        monthlyTokens: 0
      };
      
      const lifetimeLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.lifetimeLimit || 3);

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        lifetimeRequests: userData.lifetimeRequests || 0,
        lifetimeLimit,
        remainingRequests: lifetimeLimit - (userData.lifetimeRequests || 0),
        deviceID: deviceID.substring(0, 8) + '...',
      });

      // ✅ ПРОВЕРЯЕМ DEVICE ID (защита от лайфхака)
      if (userData.deviceID && userData.deviceID !== deviceID) {
        console.warn('⚠️ Device ID mismatch - updating to new device', {
          stored: userData.deviceID.substring(0, 8),
          received: deviceID.substring(0, 8),
          userId: userId
        });
        // Обновляем на новый deviceID (юзер мог сменить устройство)
        await userRef.update({ deviceID: deviceID });
      }

      // ✅ ПРОВЕРЯЕМ LIFETIME ЛИМИТ
      if ((userData.lifetimeRequests || 0) >= lifetimeLimit && userData.subscriptionTier === 'free') {
        console.error('❌ Lifetime limit exceeded');
        throw new HttpsError(
          'resource-exhausted',
          `LIFETIME_LIMIT_REACHED:${lifetimeLimit}:${userData.subscriptionTier}`,
          {
            limit: lifetimeLimit,
            tier: userData.subscriptionTier,
            message: `LIFETIME_LIMIT_REACHED:${lifetimeLimit}:${userData.subscriptionTier}`
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

      // ✅ UPDATE LIFETIME REQUESTS (statistics only)
      console.log('💾 Updating usage stats...');
      await userRef.update({
        lifetimeAPIRequests: admin.firestore.FieldValue.increment(1),
        monthlyTokens: admin.firestore.FieldValue.increment(
          result.usage.input_tokens + result.usage.output_tokens
        ),
        lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Enhanced usage logging
      await db.collection('usage_logs').add({
        userId: userId,
        deviceID: deviceID,
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

      const voiceActionsLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.voiceActionsLimit || 3);
      const voiceActionsUsed = userData.voiceActionsUsed || 0;
      return {
        content: result.content,
        stopReason: result.stop_reason,
        usage: result.usage,
        remainingRequests: voiceActionsLimit - voiceActionsUsed,
      };
    } catch (error) {
      console.error('💥 CLAUDE PROXY ERROR:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', error.message);
    }
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 2: Claude Vision (PHOTO SCAN)
// ═══════════════════════════════════════════════════════

exports.callClaudeVision = onCall(
  {
    secrets: [anthropicApiKey],
    region: 'us-central1',
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (request) => {
    console.log('📸 === CLAUDE VISION CALLED ===');

    if (!request.auth) {
      console.error('❌ No authentication');
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = request.auth.uid;
    const {
      imageBase64,
      imageType,
      photoType,
      deviceID,
      customPrompt,
      prompt,
    } = request.data || {};

    if (!imageBase64 || !imageType || !photoType || !deviceID) {
      console.error('❌ Missing required parameters');
      throw new HttpsError(
        'invalid-argument',
        'imageBase64, imageType, photoType, deviceID are required'
      );
    }

    let normalizedImageType = String(imageType).toLowerCase();
    if (normalizedImageType === 'image/jpg') {
      normalizedImageType = 'image/jpeg';
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(normalizedImageType)) {
      console.error('❌ Unsupported image type:', normalizedImageType);
      throw new HttpsError(
        'invalid-argument',
        `Unsupported image type: ${normalizedImageType}`
      );
    }

    const estimatedSizeMB = (imageBase64.length * 0.75) / 1024 / 1024;
    if (estimatedSizeMB > 5) {
      console.error('❌ Image too large:', estimatedSizeMB.toFixed(2), 'MB');
      throw new HttpsError(
        'invalid-argument',
        `Image too large: ${estimatedSizeMB.toFixed(2)}MB (max 5MB)`
      );
    }

    try {
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.log('📝 Creating new user document');
        await userRef.set({
          deviceID: deviceID,
          photoScansUsed: 0,
          photoScansLimit: 3,
          lifetimeAPIRequests: 0,
          monthlyTokens: 0,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      const userData = userDoc.data() || {
        photoScansUsed: 0,
        photoScansLimit: 3,
        subscriptionTier: 'free',
        monthlyTokens: 0,
      };

      const subscriptionTier = userData.subscriptionTier || 'free';
      const photoScansLimit = subscriptionTier === 'pro'
        ? 999999
        : (userData.photoScansLimit || 3);
      const photoScansUsed = userData.photoScansUsed || 0;

      console.log('📊 User data:', {
        subscriptionTier,
        photoScansUsed,
        photoScansLimit,
        remainingScans: photoScansLimit - photoScansUsed,
        deviceID: deviceID.substring(0, 8) + '...',
      });

      if (userData.deviceID && userData.deviceID !== deviceID) {
        console.warn('⚠️ Device ID mismatch - updating to new device', {
          stored: userData.deviceID.substring(0, 8),
          received: deviceID.substring(0, 8),
          userId: userId
        });
        await userRef.update({ deviceID: deviceID });
      }

      if (photoScansUsed >= photoScansLimit && subscriptionTier === 'free') {
        console.error('❌ Photo scans limit exceeded');
        throw new HttpsError(
          'resource-exhausted',
          `PHOTO_SCANS_LIMIT_REACHED:${photoScansLimit}:${subscriptionTier}`,
          {
            limit: photoScansLimit,
            tier: subscriptionTier,
            message: `PHOTO_SCANS_LIMIT_REACHED:${photoScansLimit}:${subscriptionTier}`
          }
        );
      }

      const systemPrompt = getPhotoScanPrompt(photoType, customPrompt || prompt);

      console.log('🌐 Calling Claude Vision API...');
      const apiStartTime = Date.now();
      const apiKey = anthropicApiKey.value();

      if (!apiKey) {
        console.error('❌ ANTHROPIC_API_KEY is not set!');
        throw new HttpsError('failed-precondition', 'API key not configured');
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: normalizedImageType,
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: systemPrompt
              }
            ]
          }]
        })
      });

      const apiDuration = Date.now() - apiStartTime;

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Claude Vision API error:', errorText);
        throw new HttpsError('internal', `Claude Vision API error: ${response.statusText}`);
      }

      const result = await response.json();
      const contentBlocks = result.content || [];
      const textBlock = contentBlocks.find(block => block.type === 'text');
      const extractedText = textBlock?.text?.trim() || '';

      if (!extractedText) {
        console.error('❌ Claude Vision returned empty text');
        throw new HttpsError('internal', 'Claude Vision returned empty response');
      }

      const inputTokens = result.usage?.input_tokens || 0;
      const outputTokens = result.usage?.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      const estimatedCost = ((inputTokens * 3) + (outputTokens * 15)) / 1000000;

      await userRef.update({
        photoScansUsed: admin.firestore.FieldValue.increment(1),
        lifetimeAPIRequests: admin.firestore.FieldValue.increment(1),
        monthlyTokens: admin.firestore.FieldValue.increment(totalTokens),
        lastRequestAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await db.collection('usage_logs').add({
        userId: userId,
        deviceID: deviceID,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        service: 'claude-vision',
        model: 'claude-3-5-sonnet-20241022',
        photoType: photoType,
        imageSizeMB: parseFloat(estimatedSizeMB.toFixed(2)),
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens,
        cost: parseFloat(estimatedCost.toFixed(6)),
        durationMs: apiDuration,
        subscriptionTier: subscriptionTier
      });

      console.log('✅ Claude Vision completed successfully');

      return {
        markdown: extractedText,
        photoType: photoType,
        remainingScans: Math.max(0, photoScansLimit - (photoScansUsed + 1))
      };
    } catch (error) {
      console.error('💥 CLAUDE VISION ERROR:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError('internal', error.message);
    }
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 3: Whisper Proxy (LIFETIME LIMITS)
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
      // ✅ ПОЛУЧАЕМ DEVICE ID ИЗ ЗАПРОСА
      const deviceID = request.data.deviceID || 'unknown';
      console.log('📱 Device ID:', deviceID.substring(0, 8) + '...');
      
      // Rate limiting with Firestore
      console.log('🔍 Checking rate limits...');
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) {
        console.log('📝 Creating new user document');
        await userRef.set({
          deviceID: deviceID,
          voiceActionsUsed: 0,
          voiceActionsLimit: 3,
          lifetimeAPIRequests: 0,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      
      let userData = userDoc.data() || {
        voiceActionsUsed: 0,
        voiceActionsLimit: 3,
        lifetimeAPIRequests: 0,
        subscriptionTier: 'free'
      };
      
      const voiceActionsLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.voiceActionsLimit || 3);
      const voiceActionsUsed = userData.voiceActionsUsed || 0;

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        voiceActionsUsed,
        voiceActionsLimit,
        remainingRequests: voiceActionsLimit - voiceActionsUsed,
        deviceID: deviceID.substring(0, 8) + '...',
      });

      // ✅ ПРОВЕРЯЕМ DEVICE ID (защита от лайфхака)
      if (userData.deviceID && userData.deviceID !== deviceID) {
        console.warn('⚠️ Device ID mismatch - updating to new device', {
          stored: userData.deviceID.substring(0, 8),
          received: deviceID.substring(0, 8),
          userId: userId
        });
        // Обновляем на новый deviceID (юзер мог сменить устройство)
        await userRef.update({ deviceID: deviceID });
      }

      // ✅ ПРОВЕРЯЕМ ЛИМИТ НА VOICE ACTIONS
      if (voiceActionsUsed >= voiceActionsLimit && userData.subscriptionTier === 'free') {
        console.error('❌ Voice actions limit exceeded');
        throw new HttpsError(
          'resource-exhausted',
          `VOICE_ACTIONS_LIMIT_REACHED:${voiceActionsLimit}:${userData.subscriptionTier}`,
          {
            limit: voiceActionsLimit,
            tier: userData.subscriptionTier,
            message: `VOICE_ACTIONS_LIMIT_REACHED:${voiceActionsLimit}:${userData.subscriptionTier}`
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
      
      const estimatedDurationMinutes = audioSizeMB / 2;
      const estimatedCost = estimatedDurationMinutes * 0.006;
      
      console.log('✅ Transcription successful:', {
        textLength: result.text?.length,
        textPreview: result.text?.substring(0, 50),
        estimatedDurationMin: estimatedDurationMinutes.toFixed(2),
        estimatedCost: `$${estimatedCost.toFixed(6)}`,
      });

      // ✅ UPDATE LIFETIME REQUESTS
      console.log('💾 Updating usage stats...');
      await userRef.update({
        voiceActionsUsed: admin.firestore.FieldValue.increment(1),
        lifetimeAPIRequests: admin.firestore.FieldValue.increment(1),
        lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('usage_logs').add({
        userId: userId,
        deviceID: deviceID,
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
        remainingRequests: voiceActionsLimit - (voiceActionsUsed + 1),
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      
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
// ФУНКЦИЯ 4: Get User Usage (LIFETIME)
// ═══════════════════════════════════════════════════════

exports.getUserUsage = onCall({region: 'us-central1'}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const userId = request.auth.uid;
  const deviceID = request.data?.deviceID || 'unknown';
  
  const db = admin.firestore();
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  let userData = userDoc.data();

  if (!userData) {
    await userRef.set({
      deviceID: deviceID,
      voiceActionsUsed: 0,
      voiceActionsLimit: 3,
      lifetimeAPIRequests: 0,
      monthlyTokens: 0,
      subscriptionTier: 'free',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    userData = {
      voiceActionsUsed: 0,
      voiceActionsLimit: 3,
      lifetimeAPIRequests: 0,
      monthlyTokens: 0,
      subscriptionTier: 'free',
    };
  }

  const voiceActionsLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.voiceActionsLimit || 3);
  const monthlyLimit = userData.subscriptionTier === 'pro' ? 10000000 : 100000;
  
  const voiceActionsUsed = userData.voiceActionsUsed || 0;
  const remaining = Math.max(0, voiceActionsLimit - voiceActionsUsed);

  return {
    voiceActionsUsed: voiceActionsUsed,
    voiceActionsLimit: voiceActionsLimit,
    remainingVoiceActions: remaining,
    
    // ✅ OLD FIELDS (daily) - backwards compatibility aliases:
    dailyRequests: voiceActionsUsed,
    dailyLimit: voiceActionsLimit,
    remainingDaily: remaining,
    
    // Other fields:
    lifetimeAPIRequests: userData.lifetimeAPIRequests || 0,
    monthlyTokens: userData.monthlyTokens || 0,
    monthlyLimit: monthlyLimit,
    remainingMonthly: Math.max(0, monthlyLimit - (userData.monthlyTokens || 0)),
    subscriptionTier: userData.subscriptionTier || 'free',
    lastRequestAt: userData.lastRequestAt,
    deviceID: userData.deviceID,
  };
});

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 5: Verify Subscription (App Store)
// ═══════════════════════════════════════════════════════

exports.verifySubscription = onCall(
  {
    secrets: [appleIssuerId, appleKeyId, applePrivateKey],
    region: 'us-central1',
    timeoutSeconds: 30,
  },
  async (request) => {
    console.log('💳 === VERIFY SUBSCRIPTION CALLED ===');

    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = request.auth.uid;
    const jwsToken = request.data.jwsToken;

    if (!jwsToken) {
      throw new HttpsError('invalid-argument', 'jwsToken is required');
    }

    try {
      const decoded = jwt.decode(jwsToken, {complete: true});
      if (!decoded?.header) {
        throw new Error('Invalid JWS token');
      }

      const {kid, x5c} = decoded.header;
      let publicKey;

      if (kid === 'Apple_Xcode_Key') {
        if (!x5c?.[0]) {
          throw new Error('Missing x5c certificate');
        }
        const cert = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`;
        publicKey = await importX509(cert, 'ES256');
      } else {
        const appleKeys = await getApplePublicKeys();
        const matchingKey = appleKeys.find((key) => key.kid === kid);
        if (!matchingKey) {
          throw new Error('No matching Apple public key found');
        }
        publicKey = await importJWK(matchingKey, 'ES256');
      }

      const {payload} = await jwtVerify(jwsToken, publicKey, {
        algorithms: ['ES256'],
      });

      const expiresDate = new Date(payload.expiresDate);
      const isActive = expiresDate > new Date();

      const db = admin.firestore();
      await db.collection('users').doc(userId).update({
        subscriptionTier: isActive ? 'pro' : 'free',
        subscriptionExpiresAt: admin.firestore.Timestamp.fromDate(expiresDate),
        subscriptionProductId: payload.productId,
        subscriptionVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        isActive,
        expiresAt: expiresDate.toISOString(),
        subscriptionTier: isActive ? 'pro' : 'free',
      };
    } catch (err) {
      console.error('💥 VERIFY ERROR:', err.message);
      throw new HttpsError('internal', err.message);
    }
  }
);

function generateAppleServerJWT() {
  const issuer = appleIssuerId.value();
  const keyId = appleKeyId.value();
  const privateKey = applePrivateKey.value();

  if (!issuer || !keyId || !privateKey) {
    throw new Error('Missing Apple secrets');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    iat: now,
    exp: now + 300,
    aud: 'appstoreconnect-v1'
  };

  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header: {alg: 'ES256', kid: keyId, typ: 'JWT'}
  });
}

async function getApplePublicKeys() {
  const urls = [
    'https://api.storekit.itunes.apple.com/in-app-purchase/v1/jwsPublicKeys',
    'https://api.storekit-sandbox.itunes.apple.com/in-app-purchase/v1/jwsPublicKeys'
  ];

  const token = generateAppleServerJWT();
  const allKeys = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {Authorization: `Bearer ${token}`}
      });
      if (response.ok) {
        const data = await response.json();
        allKeys.push(...data.keys);
      }
    } catch (err) {
      console.warn(`⚠️ Error fetching ${url}:`, err.message);
    }
  }

  if (allKeys.length === 0) {
    throw new Error('Failed to fetch App Store public keys');
  }

  return allKeys;
}
