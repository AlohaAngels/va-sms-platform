// ============================================
// Grok Voice Agent Bridge - Key Check Version
// ============================================
import WebSocket from 'ws';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { HR_SYSTEM_PROMPT } from './hr-system-prompt.js';

const XAI_URL = 'wss://api.x.ai/v1/realtime';

export function setupGrokVoiceBridge(wss) {
  wss.on('connection', (twilioWS, req) => {
    const url = new URL(req.url, 'https://dummy');
    const callType = url.searchParams.get('type') || 'lead';
    const systemPrompt = callType === 'hr' ? HR_SYSTEM_PROMPT : SYSTEM_PROMPT;

    // === NEW: Confirm key is loaded ===
    const keyLoaded = process.env.XAI_API_KEY ? `YES (length: ${process.env.XAI_API_KEY.length})` : 'NO';
    console.log(`[Grok Voice] XAI_API_KEY loaded: ${keyLoaded}`);

    console.log(`[Grok Voice] ✅ Twilio connected – type: ${callType}`);

    const grokWS = new WebSocket(XAI_URL, {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
    });

    let grokReady = false;

    grokWS.on('open', () => {
      console.log(`[Grok Voice] ✅ Connected to xAI realtime API`);
      // ... rest of the code (same as before)
      grokWS.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: systemPrompt + "\n\nYou are now speaking live on the phone. Be warm, natural, and concise. Use friendly tone and natural pauses.",
          voice: "ara",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" }
        }
      }));
      grokReady = true;
      console.log(`[Grok Voice] ✅ session.update sent`);
    });

    grokWS.on('error', (err) => {
      console.error(`[Grok Voice ERROR] xAI WebSocket error:`, err.message || err);
    });

    grokWS.on('close', (code, reason) => {
      console.log(`[Grok Voice] xAI WebSocket closed – code: ${code}, reason: ${reason || 'none'}`);
    });

    // ... (rest of the audio forwarding code is the same as the verbose version I gave you earlier)
    twilioWS.on('message', (message) => {
      if (!grokReady) {
        console.log(`[Grok Voice] ⚠️  Twilio sent audio but Grok not ready yet`);
        return;
      }
      const msg = JSON.parse(message);
      if (msg.event === 'media') {
        grokWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
        console.log(`[Grok Voice] → Audio sent to xAI (${msg.media.payload.length} bytes)`);
      }
    });

    grokWS.on('message', (data) => {
      const event = JSON.parse(data);
      if (event.type === 'response.audio.delta') {
        twilioWS.send(JSON.stringify({
          event: 'media',
          media: { payload: event.delta }
        }));
        console.log(`[Grok Voice] ← Audio received from xAI (${event.delta.length} bytes)`);
      }
    });

    twilioWS.on('close', () => grokWS.close());
    grokWS.on('close', () => twilioWS.close());
  });
}
