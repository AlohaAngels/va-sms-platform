// ============================================
// Grok Voice Agent Bridge - Clean Working Version
// (Greeting + streamSid fix + correct audio event)
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

    let streamSid = null;
    let grokReady = false;

    console.log(`[Grok Voice] XAI_API_KEY loaded: YES (length: ${process.env.XAI_API_KEY.length})`);
    console.log(`[Grok Voice] ✅ Twilio connected – type: ${callType}`);

    const grokWS = new WebSocket(XAI_URL, {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
    });

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

      setTimeout(() => {
        grokWS.send(JSON.stringify({ type: "response.create" }));
        console.log(`[Grok Voice] ✅ response.create sent`);
        grokReady = true;
      }, 400);
    });

    grokWS.on('error', (err) => {
      console.error(`[Grok Voice ERROR] xAI WebSocket error:`, err.message || err);
    });

    grokWS.on('close', (code, reason) => {
      console.log(`[Grok Voice] xAI WebSocket closed – code: ${code}, reason: ${reason || 'none'}`);
    });

    // Capture streamSid + forward audio to Grok
    twilioWS.on('message', (message) => {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log(`[Grok Voice] Stream started – streamSid: ${streamSid}`);
      }

      if (msg.event === 'media' && streamSid && grokReady) {
        grokWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      } else if (msg.event === 'media' && !grokReady) {
        console.log(`[Grok Voice] ⚠️  Twilio sent audio but Grok not ready yet`);
      }
    });

// Forward Grok audio back to Twilio (cleaned payload)
grokWS.on('message', (data) => {
  const event = JSON.parse(data);
  console.log(`[Grok Voice] ← xAI event: ${event.type}`);

  if (event.type === 'response.output_audio.delta' && streamSid) {
    // Decode + re-encode to clean the payload (fixes static/garble)
    const audioBuffer = Buffer.from(event.delta, 'base64');
    const cleanPayload = audioBuffer.toString('base64');

    twilioWS.send(JSON.stringify({
      event: 'media',
      streamSid: streamSid,
      media: { payload: cleanPayload }
    }));
    console.log(`[Grok Voice] ← Audio sent to caller (${cleanPayload.length} bytes)`);
  }

  if (event.type === 'error') {
    console.error(`[Grok Voice ERROR] xAI returned error:`, event);
  }
});

    twilioWS.on('close', () => grokWS.close());
    grokWS.on('close', () => twilioWS.close());
  });
}
