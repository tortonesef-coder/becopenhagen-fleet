const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

// POST /api/voice/transcribe
// Receives base64 audio, sends to Whisper, parses with Claude, returns bike IDs
router.post('/transcribe', async (req, res) => {
  const { audio_base64, audio_type, action_type, context } = req.body;
  if (!audio_base64) return res.status(400).json({ error: 'No audio provided' });

  // Debug: confirm keys are loaded
  console.log('Voice request received, action:', action_type);
  console.log('OpenAI key set:', !!process.env.OPENAI_API_KEY);
  console.log('Anthropic key set:', !!process.env.ANTHROPIC_API_KEY);

  try {
    // Step 1: Transcribe with Whisper
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    const mimeType = audio_type || 'audio/webm';
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, `recording.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      console.error('Whisper error:', err);
      return res.status(500).json({ error: 'Transcription failed', detail: err });
    }

    const whisperData = await whisperRes.json();
    const transcript = whisperData.text || '';
    console.log('Transcript:', transcript);

    if (!transcript.trim()) return res.json({ transcript: '', bike_ids: [], raw: '' });

    // Step 2: Get all valid bike IDs from DB for context
    const db = getDb();
    const allBikes = db.prepare('SELECT id, type_id, name FROM bikes WHERE active=1').all();
    const bikeIds = allBikes.map(b => b.id).join(', ');

    // Step 3: Parse with Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: `You extract bike IDs from speech transcripts for a bike rental company.
Valid bike IDs follow these patterns: A1-A37, SA1-SA7, AC1-AC5, AT1-AT5, B1-B5, BM1-BM4, TB1-TB18, M3-M7, CC1-CC5, E2-E11.
The full list of active bikes is: ${bikeIds}.
Return ONLY a JSON object like: {"bike_ids": ["A3", "CC2", "TB5"], "confidence": "high"}
If no bike IDs are found, return: {"bike_ids": [], "confidence": "low"}
People may say bike IDs in various ways: "A three", "alpha 3", "CC two", "cargo two", "touring five", etc.
Common speech patterns — map these to bike IDs:
- "A three" or "alpha 3" or "adult 3" → A3
- "A seven" → A7, "A eight" → A8
- "CC two" or "cargo two" or "cargo bike 2" → CC2
- "TB five" or "touring five" or "touring bike 5" or "touring bike number 5" → TB5
- "electric two" or "E two" → E2
- "small adult one" or "SA one" → SA1
- "AC one" or "child seat one" → AC1
- "AT one" or "toddler one" → AT1
- "mountain bike three" or "M three" → M3
- Numbers can be spoken as words: "seven" → 7, "five" → 5, "twelve" → 12
- People often say "and" between IDs: "A7, A8, and TB5" → [A7, A8, TB5]
- Ignore filler words like "and", "also", "plus", "then"
Extract ALL bike IDs mentioned. Do not add bikes not mentioned. Do not guess.`,
        messages: [{ role: 'user', content: `Action type: ${action_type || 'unknown'}\nTranscript: "${transcript}"\n\nExtract all bike IDs mentioned.` }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude error:', err);
      // Return transcript even if Claude fails — better than nothing
      return res.json({ transcript, bike_ids: [], raw: transcript, error: 'Parsing failed' });
    }

    const claudeData = await claudeRes.json();
    const claudeText = claudeData.content?.[0]?.text || '{}';

    let parsed = { bike_ids: [] };
    try {
      parsed = JSON.parse(claudeText.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('Claude parse error:', claudeText);
    }

    // Validate IDs against actual DB
    const validIds = new Set(allBikes.map(b => b.id));
    const confirmedIds = (parsed.bike_ids || []).filter(id => validIds.has(id.toUpperCase())).map(id => id.toUpperCase());

    res.json({
      transcript,
      bike_ids: confirmedIds,
      confidence: parsed.confidence || 'medium',
      raw: claudeText,
    });

  } catch (e) {
    console.error('Voice error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
