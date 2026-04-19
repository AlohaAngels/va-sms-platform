// ============================================
// Grok Voice Agent Bridge for Twilio Media Streams
// (xAI realtime API — works with your existing prompts)
// ============================================
import { WebSocket } from 'ws';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { HR_SYSTEM_PROMPT } from './hr-system-prompt.js';

const XAI_URL = 'wss://api.x.ai/v1/realtime';

export function setupGrokVoiceBridge(wss) {
  wss.on('connection', (twilioWS, req) => {
    const url = new URL(req.url, 'https://dummy');
    const callType = url.searchParams.get('type') || 'lead'; // 'lead' or 'hr'
    const systemPrompt = callType === 'hr' ? HR_SYSTEM_PROMPT : SYSTEM_PROMPT;

    console.log(`[Grok Voice] New call connected — type: ${callType}`);

    const grokWS = new WebSocket(XAI_URL, {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
    });

    let grokReady = false;

    grokWS.on('open', () => {
      grokWS.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: systemPrompt + "\n\nYou are now speaking live on the phone. Be warm, natural, and concise. Use friendly tone and natural pauses.",
          voice: "alloy",           // Change to "echo", "fable", "onyx", "nova", or "shimmer" if you want a different voice
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" }
        }
      }));
      grokReady = true;
      console.log(`[Grok Voice] Grok session started for ${callType}`);
    });

    // Twilio audio → Grok
    twilioWS.on('message', (message) => {
      if (!grokReady) return;
      const msg = JSON.parse(message);
      if (msg.event === 'media') {
        grokWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }
    });

    // Grok audio → Twilio
    grokWS.on('message', (data) => {
      const event = JSON.parse(data);
      if (event.type === 'response.audio.delta') {
        twilioWS.send(JSON.stringify({
          event: 'media',
          media: { payload: event.delta }
        }));
      }
    });

    // Cleanup when call ends
    twilioWS.on('close', () => grokWS.close());
    grokWS.on('close', () => twilioWS.close());
  });
}
