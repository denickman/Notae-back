const {onCall} = require('firebase-functions/v2/https');
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
// ФУНКЦИЯ 1: Claude Proxy (PRODUCTION READY)
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
      throw new Error('User must be authenticated');
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
        });
      }

      const userData = userDoc.data() || {dailyRequests: 0, subscriptionTier: 'free'};
      const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 10;

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        dailyRequests: userData.dailyRequests,
        dailyLimit,
      });

      if (userData.dailyRequests >= dailyLimit) {
        console.error('❌ Rate limit exceeded');
        throw new Error(
          `Daily limit of ${dailyLimit} requests reached. ${
            userData.subscriptionTier === 'free' ? 'Upgrade to Pro for 1000 requests/day.' : ''
          }`
        );
      }

      // Call Claude API
      console.log('🔑 Getting API key...');
      const apiKey = anthropicApiKey.value();
      
      if (!apiKey) {
        console.error('❌ ANTHROPIC_API_KEY is not set!');
        throw new Error('API key not configured');
      }
      
      console.log('✅ API key retrieved (length:', apiKey.length, ')');

      console.log('🌐 Calling Claude API...');
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

      console.log('📡 API response received:', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Claude API error:', errorText);
        throw new Error(`Claude API error: ${response.statusText}`);
      }

      const result = await response.json();
      
      console.log('✅ Claude response successful:', {
        stopReason: result.stop_reason,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
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

      console.log('✅ Usage stats updated');
      console.log('🎉 Claude proxy completed successfully');

      return {
        content: result.content,
        stopReason: result.stop_reason,
        usage: result.usage,
      };
    } catch (error) {
      console.error('💥 CLAUDE PROXY ERROR:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
);

// ═══════════════════════════════════════════════════════
// ФУНКЦИЯ 2: Whisper Proxy (PRODUCTION READY с axios)
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
      throw new Error('User must be authenticated');
    }

    const userId = request.auth.uid;
    console.log('✅ User authenticated:', userId);
    
    const audioDataBase64 = request.data.audioData;

    if (!audioDataBase64) {
      console.error('❌ No audioData in request');
      throw new Error('audioData is required');
    }

    console.log('📊 Audio data received:', {
      userId,
      base64Length: audioDataBase64.length,
      estimatedSizeMB: (audioDataBase64.length * 0.75 / 1024 / 1024).toFixed(2),
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
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      
      const userData = userDoc.data() || {dailyRequests: 0, subscriptionTier: 'free'};
      const dailyLimit = userData.subscriptionTier === 'pro' ? 1000 : 10;

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        dailyRequests: userData.dailyRequests,
        dailyLimit,
      });

      if (userData.dailyRequests >= dailyLimit) {
        console.error('❌ Rate limit exceeded');
        throw new Error(`Daily limit of ${dailyLimit} requests reached`);
      }

      // Call Whisper API
      console.log('🔑 Getting API key...');
      const apiKey = openaiApiKey.value();
      
      if (!apiKey) {
        console.error('❌ OPENAI_API_KEY is not set!');
        throw new Error('API key not configured');
      }
      
      console.log('✅ API key retrieved (length:', apiKey.length, ')');

      console.log('📦 Preparing audio buffer...');
      const audioBuffer = Buffer.from(audioDataBase64, 'base64');
      console.log('✅ Audio buffer created:', {
        bufferSize: audioBuffer.length,
        sizeMB: (audioBuffer.length / 1024 / 1024).toFixed(2),
      });

      console.log('📝 Creating FormData with axios...');
      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.m4a',
        contentType: 'audio/mp4',
      });
      form.append('model', 'whisper-1');
      console.log('✅ FormData created');

      console.log('🌐 Calling OpenAI Whisper API via axios...');
      
      // Используем axios для правильной отправки FormData
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

      console.log('📡 API response received:', {
        status: response.status,
        statusText: response.statusText,
      });

      const result = response.data;
      console.log('✅ Transcription successful:', {
        textLength: result.text?.length,
        textPreview: result.text?.substring(0, 50),
      });

      // Update usage
      console.log('💾 Updating usage stats...');
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

      console.log('✅ Usage stats updated');
      console.log('🎉 Whisper proxy completed successfully');

      return {text: result.text};
    } catch (error) {
      // Axios errors have different structure
      if (error.response) {
        console.error('💥 WHISPER API ERROR:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        });
        throw new Error(`Whisper API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      
      console.error('💥 WHISPER PROXY ERROR:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
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
