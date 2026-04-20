// ============================================
// Grok Voice Agent Bridge - Minimal Clean Version
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

    const grokWS = new WebSocket(XAI_URL, {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
    });

    grokWS.on('open', () => {
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

      setTimeout(() => {
        grokWS.send(JSON.stringify({ type: "response.create" }));
        grokReady = true;
      }, 500);
    });

    twilioWS.on('message', (message) => {
      const msg = JSON.parse(message);
      if (msg.event === 'start') streamSid = msg.start.streamSid;
      if (msg.event === 'media' && streamSid && grokReady) {
        grokWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }
    });

    grokWS.on('message', (data) => {
      const event = JSON.parse(data);
      if (event.type === 'response.output_audio.delta' && streamSid) {
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: event.delta }
        }));
      }
    });

    twilioWS.on('close', () => grokWS.close());
    grokWS.on('close', () => twilioWS.close());
  });
}
