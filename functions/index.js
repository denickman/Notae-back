const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');
const axios = require('axios');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { importX509, importJWK, jwtVerify } = require('jose');

// Initialize Firebase Admin
admin.initializeApp();

// Define secrets
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const openaiApiKey = defineSecret('OPENAI_API_KEY');
const appleIssuerId = defineSecret('APPLE_ISSUER_ID');
const appleKeyId = defineSecret('APPLE_KEY_ID');
const applePrivateKey = defineSecret('APPLE_PRIVATE_KEY');

const FREE_VOICE_LIMIT = 7;
const FREE_PHOTO_LIMIT = 3;

const getMonthKey = () => new Date().toISOString().slice(0, 7); // UTC YYYY-MM

async function ensureMonthlyVoiceReset(userRef, userData) {
  const monthKey = getMonthKey();
  const tier = userData.subscriptionTier || 'free';
  const needsLimitFix = tier !== 'pro' && (userData.voiceActionsLimit || FREE_VOICE_LIMIT) !== FREE_VOICE_LIMIT;
  const needsReset = tier !== 'pro' && userData.voiceActionsDayKey !== monthKey;

  if (needsReset || needsLimitFix) {
    await userRef.update({
      voiceActionsUsed: needsReset ? 0 : (userData.voiceActionsUsed || 0),
      voiceActionsDayKey: monthKey,
      ...(needsLimitFix ? { voiceActionsLimit: FREE_VOICE_LIMIT } : {}),
    });
    userData.voiceActionsUsed = needsReset ? 0 : (userData.voiceActionsUsed || 0);
    userData.voiceActionsDayKey = monthKey;
    if (needsLimitFix) {
      userData.voiceActionsLimit = FREE_VOICE_LIMIT;
    }
  }

  return userData;
}

async function ensureMonthlyPhotoReset(userRef, userData) {
  const monthKey = getMonthKey();
  const tier = userData.subscriptionTier || 'free';
  const needsLimitFix = tier !== 'pro' && (userData.photoScansLimit || FREE_PHOTO_LIMIT) !== FREE_PHOTO_LIMIT;
  const needsReset = tier !== 'pro' && userData.photoScansDayKey !== monthKey;

  if (needsReset || needsLimitFix) {
    await userRef.update({
      photoScansUsed: needsReset ? 0 : (userData.photoScansUsed || 0),
      photoScansDayKey: monthKey,
      ...(needsLimitFix ? { photoScansLimit: FREE_PHOTO_LIMIT } : {}),
    });
    userData.photoScansUsed = needsReset ? 0 : (userData.photoScansUsed || 0);
    userData.photoScansDayKey = monthKey;
    if (needsLimitFix) {
      userData.photoScansLimit = FREE_PHOTO_LIMIT;
    }
  }

  return userData;
}

// ═══════════════════════════════════════════════════════
// 🆕 NEW FUNCTION: Claude Vision (Photo Scan)
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
    console.log('✅ User authenticated:', userId);
    
    const { imageBase64, imageType, prompt } = request.data;

    if (!imageBase64) {
      console.error('❌ No image data');
      throw new HttpsError('invalid-argument', 'imageBase64 is required');
    }

    // Validate image type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mediaType = imageType || 'image/jpeg';
    
    if (!validTypes.includes(mediaType)) {
      throw new HttpsError('invalid-argument', `Invalid image type: ${mediaType}`);
    }

    // Estimate image size (base64 is ~33% larger than binary)
    const estimatedSizeMB = (imageBase64.length * 0.75) / 1024 / 1024;
    console.log('📊 Image size (estimated):', estimatedSizeMB.toFixed(2), 'MB');

    if (estimatedSizeMB > 5) {
      throw new HttpsError(
        'invalid-argument',
        `Image too large: ${estimatedSizeMB.toFixed(1)}MB (max 5MB). Please resize on device.`
      );
    }

    try {
      const deviceID = request.data.deviceID || 'unknown';
      console.log('📱 Device ID:', deviceID.substring(0, 8) + '...');
      
      // Rate limiting
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.log('📝 Creating new user document');
        const monthKey = getMonthKey();
        await userRef.set({
          deviceID: deviceID,
          photoScansUsed: 0,
          photoScansLimit: FREE_PHOTO_LIMIT,
          photoScansDayKey: monthKey,
          voiceActionsUsed: 0,
          voiceActionsLimit: FREE_VOICE_LIMIT,
          voiceActionsDayKey: monthKey,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      let userData = userDoc.data() || {
        photoScansUsed: 0,
        photoScansLimit: FREE_PHOTO_LIMIT,
        photoScansDayKey: getMonthKey(),
        voiceActionsUsed: 0,
        voiceActionsLimit: FREE_VOICE_LIMIT,
        voiceActionsDayKey: getMonthKey(),
        subscriptionTier: 'free'
      };

      userData = await ensureMonthlyPhotoReset(userRef, userData);
      
      const photoScansLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.photoScansLimit || 3);
      const photoScansUsed = userData.photoScansUsed || 0;

      console.log('📊 User data:', {
        subscriptionTier: userData.subscriptionTier,
        photoScansUsed,
        photoScansLimit,
        remainingScans: photoScansLimit - photoScansUsed,
      });

      // Check limit
      if (photoScansUsed >= photoScansLimit && userData.subscriptionTier === 'free') {
        console.error('❌ Photo scans limit exceeded');
        throw new HttpsError(
          'resource-exhausted',
          `PHOTO_SCANS_LIMIT_REACHED:${photoScansLimit}:${userData.subscriptionTier}`,
          {
            limit: photoScansLimit,
            used: photoScansUsed,
            tier: userData.subscriptionTier,
          }
        );
      }

      // Detect photo type and select template
      const photoType = request.data.photoType || 'note'; // 'recipe', 'receipt', 'note', 'custom'
      const systemPrompt = getPhotoScanPrompt(photoType, prompt);

      console.log('📝 Using template:', photoType);
      console.log('🔑 Getting API key...');
      const apiKey = anthropicApiKey.value();
      
      if (!apiKey) {
        throw new HttpsError('failed-precondition', 'API key not configured');
      }

      const apiStartTime = Date.now();
      const modelFallbacks = [
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5-20251001',
        'claude-3-5-haiku-20241022',
        'claude-3-haiku-20240307',
      ];
      let result;
      let modelUsed;
      let lastErrorText;

      for (const model of modelFallbacks) {
        console.log(`🌐 Calling Claude Vision API (${model})...`);
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              messages: [{
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: imageBase64
                    }
                  },
                  {
                    type: 'text',
                    text: systemPrompt
                  }
                ]
              }]
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            lastErrorText = errorText;
            console.error(`❌ Claude Vision API error (${model}):`, errorText);

            if (response.status === 404 || errorText.includes('not_found')) {
              continue;
            }

            throw new HttpsError('internal', `Claude API error: ${response.statusText}`);
          }

          result = await response.json();
          modelUsed = model;
          break;
        } catch (error) {
          if (error instanceof HttpsError) {
            throw error;
          }
          lastErrorText = error.message;
          if (model === modelFallbacks[modelFallbacks.length - 1]) {
            throw new HttpsError('internal', error.message);
          }
        }
      }

      if (!result) {
        throw new HttpsError('internal', `Claude API error: ${lastErrorText || 'Unknown error'}`);
      }

      const apiDuration = Date.now() - apiStartTime;
      
      // Extract text from response
      const textContent = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n\n');

      const estimatedCost = (
        result.usage.input_tokens * 3.0 +  // Vision tokens more expensive
        result.usage.output_tokens * 15.0
      ) / 1000000;
      
      console.log('✅ Claude Vision response:', {
        model: modelUsed,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        estimatedCost: `$${estimatedCost.toFixed(6)}`,
        textLength: textContent.length,
      });

      // ✅ Update usage
      console.log('💾 Updating photo scan usage...');
      await userRef.update({
        photoScansUsed: admin.firestore.FieldValue.increment(1),
        lifetimeAPIRequests: admin.firestore.FieldValue.increment(1),
        monthlyTokens: admin.firestore.FieldValue.increment(
          result.usage.input_tokens + result.usage.output_tokens
        ),
        lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Enhanced logging
      await db.collection('usage_logs').add({
        userId: userId,
        deviceID: deviceID,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        service: 'claude-vision',
        model: modelUsed,
        photoType: photoType,
        imageSizeMB: parseFloat(estimatedSizeMB.toFixed(2)),
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
        cost: estimatedCost,
        durationMs: apiDuration,
        subscriptionTier: userData.subscriptionTier,
      });

      console.log('✅ Photo scan completed successfully');

      return {
        markdown: textContent,
        usage: result.usage,
        photoType: photoType,
        remainingScans: Math.max(0, photoScansLimit - (photoScansUsed + 1)),
      };

    } catch (error) {
      console.error('💥 CLAUDE VISION ERROR:', {
        name: error.name,
        message: error.message,
      });
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', error.message);
    }
  }
);

// ═══════════════════════════════════════════════════════
// 📝 Helper: Photo Scan Prompts
// ═══════════════════════════════════════════════════════

function getPhotoScanPrompt(photoType, customPrompt) {
  if (customPrompt) {
    return customPrompt;
  }

  const templates = {
    recipe: `Extract this recipe and format as beautiful Markdown:

# [Recipe Title]

**Prep time:** X min  
**Cook time:** Y min  
**Servings:** Z  

## Ingredients

### [Category 1]
- ingredient 1 (quantity + unit)
- ingredient 2 (quantity + unit)

### [Category 2]
- ingredient 3

## Instructions

1. First step with details
2. Second step
3. Third step

## Tips
- Any helpful tips from the image

Use emojis where appropriate (🥘 🍳 ⏱️ 🔥). Keep formatting clean and readable.`,

    receipt: `Extract receipt data and format as Markdown:

# 🧾 Receipt - [Store Name]

**Date:** YYYY-MM-DD  
**Time:** HH:MM  
**Location:** [Store address if visible]  

## Items

| Item | Qty | Price |
|------|-----|-------|
| Item 1 | 1 | $X.XX |
| Item 2 | 2 | $Y.YY |

## Summary

- **Subtotal:** $XX.XX
- **Tax:** $X.XX
- **Total:** $XX.XX

**Payment:** [Card/Cash]  
**Receipt #:** [number if visible]`,

    note: `Extract ALL text from this image and format as clean, well-structured Markdown:

- Use # ## ### for headers (detect hierarchy from font size/position)
- Use bullet lists (-) for lists
- Use numbered lists (1. 2. 3.) for sequences
- Use **bold** for emphasis
- Use tables if structured data is present
- Add emojis where contextually appropriate
- Preserve the logical structure and flow

Make it readable and beautiful. Don't add content that's not in the image.`,

    whiteboard: `Extract content from this whiteboard/notes and structure as Markdown:

# [Main Topic - if visible]

## Key Points

- Point 1
- Point 2
- Point 3

## Details

[Organize content logically]

## Action Items

- [ ] Task 1
- [ ] Task 2

Use checkboxes for TODO items. Add section headers based on content grouping.`,

    business_card: `Extract contact information from this business card:

# 👤 [Full Name]

**Title:** [Job Title]  
**Company:** [Company Name]  

## Contact

- 📧 Email: [email]
- 📱 Phone: [phone]
- 🌐 Website: [website]
- 📍 Address: [address]

## Social

- LinkedIn: [if visible]
- Other: [if visible]

Keep formatting clean and professional.`
  };

  return templates[photoType] || templates.note;
}

// ═══════════════════════════════════════════════════════
// Function: Whisper Proxy (UNCHANGED from your current)
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
    const audioDataBase64 = request.data.audioData;
    const language = request.data.language || 'auto';

    if (!audioDataBase64) {
      throw new HttpsError('invalid-argument', 'audioData is required');
    }

    const audioBuffer = Buffer.from(audioDataBase64, 'base64');
    const audioSizeMB = audioBuffer.length / 1024 / 1024;

    if (audioSizeMB > 25) {
      throw new HttpsError(
        'invalid-argument',
        `Audio file too large: ${audioSizeMB.toFixed(1)}MB (max 25MB)`
      );
    }

    try {
      const deviceID = request.data.deviceID || 'unknown';
      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) {
        const monthKey = getMonthKey();
        await userRef.set({
          deviceID: deviceID,
          voiceActionsUsed: 0,
          voiceActionsLimit: FREE_VOICE_LIMIT,
          voiceActionsDayKey: monthKey,
          photoScansUsed: 0,
          photoScansLimit: FREE_PHOTO_LIMIT,
          photoScansDayKey: monthKey,
          subscriptionTier: 'free',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      
      let userData = userDoc.data() || {
        voiceActionsUsed: 0,
        voiceActionsLimit: FREE_VOICE_LIMIT,
        voiceActionsDayKey: getMonthKey(),
        subscriptionTier: 'free'
      };

      userData = await ensureMonthlyVoiceReset(userRef, userData);

      const voiceActionsLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.voiceActionsLimit || FREE_VOICE_LIMIT);
      const voiceActionsUsed = userData.voiceActionsUsed || 0;

      const apiKey = openaiApiKey.value();
      if (!apiKey) {
        throw new HttpsError('failed-precondition', 'API key not configured');
      }

      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.m4a',
        contentType: 'audio/mp4',
      });
      form.append('model', 'whisper-1');
      
      if (language && language !== 'auto') {
        form.append('language', language);
      }

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
      const result = response.data;
      
      const estimatedDurationMinutes = audioSizeMB / 2;
      const estimatedCost = estimatedDurationMinutes * 0.006;

      // ✅ Update usage for Whisper
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
        audioSizeMB: parseFloat(audioSizeMB.toFixed(2)),
        cost: parseFloat(estimatedCost.toFixed(6)),
        textLength: result.text?.length,
        durationMs: apiDuration,
        subscriptionTier: userData.subscriptionTier,
      });

      return {
        text: result.text,
        remainingTranscriptions: Math.max(0, voiceActionsLimit - (voiceActionsUsed + 1)),
        remainingRequests: Math.max(0, voiceActionsLimit - (voiceActionsUsed + 1)),
      };

    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      
      if (error.response) {
        throw new HttpsError(
          'internal',
          `Whisper API error: ${error.response.status}`
        );
      }
      
      throw new HttpsError('internal', error.message);
    }
  }
);

// ═══════════════════════════════════════════════════════
// Function: Get User Usage (UPDATED with photo scans)
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
    const monthKey = getMonthKey();
    await userRef.set({
      deviceID: deviceID,
      voiceActionsUsed: 0,
      voiceActionsLimit: FREE_VOICE_LIMIT,
      voiceActionsDayKey: monthKey,
      photoScansUsed: 0,
      photoScansLimit: FREE_PHOTO_LIMIT,
      photoScansDayKey: monthKey,
      lifetimeAPIRequests: 0,
      monthlyTokens: 0,
      subscriptionTier: 'free',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    userData = {
      voiceActionsUsed: 0,
      voiceActionsLimit: FREE_VOICE_LIMIT,
      voiceActionsDayKey: monthKey,
      photoScansUsed: 0,
      photoScansLimit: FREE_PHOTO_LIMIT,
      photoScansDayKey: monthKey,
      subscriptionTier: 'free',
    };
  }

  userData = await ensureMonthlyVoiceReset(userRef, userData);
  userData = await ensureMonthlyPhotoReset(userRef, userData);

  const voiceActionsLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.voiceActionsLimit || FREE_VOICE_LIMIT);
  const photoScansLimit = userData.subscriptionTier === 'pro' ? 999999 : (userData.photoScansLimit || FREE_PHOTO_LIMIT);
  
  const voiceActionsUsed = userData.voiceActionsUsed || 0;
  const photoScansUsed = userData.photoScansUsed || 0;

  return {
    // Voice transcriptions
    voiceActionsUsed: voiceActionsUsed,
    voiceActionsLimit: voiceActionsLimit,
    remainingVoiceActions: Math.max(0, voiceActionsLimit - voiceActionsUsed),
    
    // Photo scans
    photoScansUsed: photoScansUsed,
    photoScansLimit: photoScansLimit,
    remainingPhotoScans: Math.max(0, photoScansLimit - photoScansUsed),
    
    // General
    subscriptionTier: userData.subscriptionTier || 'free',
    lifetimeAPIRequests: userData.lifetimeAPIRequests || 0,
    monthlyTokens: userData.monthlyTokens || 0,
    lastRequestAt: userData.lastRequestAt,
    deviceID: userData.deviceID,
  };
});

// ═══════════════════════════════════════════════════════
// Other functions (Subscription, etc.) - UNCHANGED
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
      const decoded = jwt.decode(jwsToken, { complete: true });
      if (!decoded?.header) {
        throw new Error('Invalid JWS token');
      }

      const { kid, x5c } = decoded.header;
      let publicKey;

      if (kid === 'Apple_Xcode_Key') {
        if (!x5c?.[0]) {
          throw new Error('Missing x5c certificate');
        }
        const cert = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`;
        publicKey = await importX509(cert, 'ES256');
      } else {
        const appleKeys = await getApplePublicKeys();
        const matchingKey = appleKeys.find(k => k.kid === kid);
        if (!matchingKey) {
          throw new Error(`No matching Apple public key found`);
        }
        publicKey = await importJWK(matchingKey, 'ES256');
      }

      const { payload } = await jwtVerify(jwsToken, publicKey, {
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
    header: { alg: 'ES256', kid: keyId, typ: 'JWT' }
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
        headers: { 'Authorization': `Bearer ${token}` }
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
