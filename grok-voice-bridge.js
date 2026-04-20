// ============================================
// Grok Voice Agent Bridge - Final Version with response.create + full logging
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

    console.log(`[Grok Voice] XAI_API_KEY loaded: ${process.env.XAI_API_KEY ? 'YES (length: ' + process.env.XAI_API_KEY.length + ')' : 'NO'}`);
    console.log(`[Grok Voice] ✅ Twilio connected – type: ${callType}`);

    const grokWS = new WebSocket(XAI_URL, {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
    });

    let grokReady = false;

    grokWS.on('open', () => {
      console.log(`[Grok Voice] ✅ Connected to xAI realtime API`);
      
      grokWS.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: "You are a warm, friendly, professional AI assistant for Visiting Angels of Boise. Help the caller with in-home care questions. Be natural, concise, and speak like a real person on the phone. Ask one question at a time and listen carefully.",
          voice: "ara",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" }
        }
      }));
      console.log(`[Grok Voice] ✅ session.update sent`);

      // Explicitly start the response (this often fixes silent sessions)
      setTimeout(() => {
        grokWS.send(JSON.stringify({ type: "response.create" }));
        console.log(`[Grok Voice] ✅ response.create sent`);
      }, 300);

      grokReady = true;
    });

    grokWS.on('error', (err) => {
      console.error(`[Grok Voice ERROR] xAI WebSocket error:`, err.message || err);
    });

    grokWS.on('close', (code, reason) => {
      console.log(`[Grok Voice] xAI WebSocket closed – code: ${code}, reason: ${reason || 'none'}`);
    });

    // Twilio audio → Grok
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

    // FULL logging of everything xAI sends back
    grokWS.on('message', (data) => {
      const event = JSON.parse(data);
      console.log(`[Grok Voice] ← xAI event: ${event.type}`);
      
    if (event.type === 'response.output_audio.delta') {
        twilioWS.send(JSON.stringify({
          event: 'media',
          media: { payload: event.delta }
        }));
        console.log(`[Grok Voice] ← Audio received from xAI (${event.delta.length} bytes)`);
      }
      
      if (event.type === 'error') {
        console.error(`[Grok Voice ERROR] xAI returned error:`, event);
      }
    });

    twilioWS.on('close', () => grokWS.close());
    grokWS.on('close', () => twilioWS.close());
  });
}
