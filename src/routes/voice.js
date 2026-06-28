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
        system: `You extract bike IDs from speech transcripts for a bike rental company in Copenhagen.

BIKE TYPE PREFIXES:
- A = adult bike (also called "adult", "city bike", just a number alone like "twelve")
- SA = small adult bike (also "small adult", "small bike")
- CC = cargo bike / Christiania bike (also "cargo", "cargo bike", "Christiania")
- TB = touring bike (also "touring", "touring bike")
- E = electric bike (also "electric", "e-bike")
- AC = adult with child seat (also "child seat", "AC")
- AT = adult with toddler seat (also "toddler", "toddler seat", "AT")
- B = kids bike small (also "kids bike", "child bike", "children's bike")
- BM = kids bike medium
- M or MB = mountain bike (also "mountain", "mountain bike")

EXAMPLES — always follow this pattern:
- "A12" or "A twelve" or "adult twelve" or "twelve" → A12
- "A7" or "A seven" or "adult seven" → A7
- "TB4" or "TB four" or "touring bike 4" or "touring four" or "touring bike four" → TB4
- "TB5" or "touring bike 5" or "touring five" → TB5
- "CC2" or "cargo bike 2" or "cargo two" or "cargo bike two" or "Christiania two" → CC2
- "CC1" or "cargo one" or "cargo bike one" → CC1
- "E2" or "electric two" or "electric bike 2" → E2
- "SA1" or "small adult one" or "small one" → SA1
- "AC1" or "child seat one" → AC1
- "AT1" or "toddler one" → AT1
- "M3" or "mountain three" or "mountain bike 3" → M3

RULES:
- Numbers can be words: "four" → 4, "twelve" → 12, "two" → 2
- Ignore: "and", "also", "plus", "then", "with", "the"
- Extract ALL bike IDs mentioned in the transcript
- Return ONLY valid JSON: {"bike_ids": ["A12", "TB4", "CC2"], "confidence": "high"}
- If nothing found: {"bike_ids": [], "confidence": "low"}
- Do NOT invent bikes. Do NOT skip any mentioned bike.`,
        messages: [{ role: 'user', content: `Extract all bike IDs from this transcript. Return JSON only.\n\nTranscript: \"${transcript}\"` }],
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

    // Validate IDs against actual DB — split into found and not found
    const validIds = new Set(allBikes.map(b => b.id));
    const parsedIds = (parsed.bike_ids || []).map(id => id.toUpperCase());
    const confirmedIds = parsedIds.filter(id => validIds.has(id));
    const notFoundIds = parsedIds.filter(id => !validIds.has(id));

    res.json({
      transcript,
      bike_ids: confirmedIds,
      not_found: notFoundIds,
      confidence: parsed.confidence || 'medium',
      raw: claudeText,
    });

  } catch (e) {
    console.error('Voice error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
