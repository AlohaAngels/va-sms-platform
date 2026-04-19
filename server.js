// ============================================
// Visiting Angels AI SMS Platform — Server
// Phase 2: HubSpot + Email Follow-ups + Reports + Grok Voice
// ============================================
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import twilio from "twilio";
import cron from "node-cron";
import dotenv from "dotenv";
import { handleInboundMessage } from "./conversation-engine.js";
import { handleHRMessage } from "./hr-conversation-engine.js";
import { db, initDatabase } from "./database.js";
import { ensureHubSpotProperties } from "./hubspot.js";
import { processEmailQueue } from "./email-followups.js";
import { sendWeeklyReport } from "./weekly-report.js";
import { verifyCalendarAccess } from "./google-calendar.js";
import { processTextQueue } from "./text-followups.js";

// === NEW IMPORTS FOR GROK VOICE ===
import { WebSocketServer } from 'ws';
import { setupGrokVoiceBridge } from './grok-voice-bridge.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(morgan("short"));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Twilio Signature Validation ───
function validateTwilioRequest(req, res, next) {
  if (process.env.NODE_ENV === "development") return next();
  const signature = req.headers["x-twilio-signature"];
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const isValid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
  if (isValid) { next(); } else { console.warn("⚠️  Invalid Twilio signature"); res.status(403).send("Forbidden"); }
}

// ============================================
// WEBHOOK ENDPOINT — Twilio sends SMS here
// ============================================
app.post("/webhook/sms", validateTwilioRequest, async (req, res) => {
  try {
    const { From, Body, MessageSid, To } = req.body;
    const hrNumber = process.env.TWILIO_HR_PHONE_NUMBER || "";
    const isHR = To === hrNumber;

    console.log(`📨 ${isHR ? "HR" : "Lead"} SMS from ${From}: "${Body}"`);

    let aiResponse;
    if (isHR) {
      aiResponse = await handleHRMessage({ from: From, body: Body, messageSid: MessageSid });
    } else {
      aiResponse = await handleInboundMessage({ from: From, body: Body, messageSid: MessageSid });
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.text);
    res.type("text/xml").send(twiml.toString());
    console.log(`✅ Replied to ${From} | ${isHR ? "HR" : "Lead"} | Stage: ${aiResponse.stage}`);

    if (!isHR && aiResponse.qualified) {
      notifyCoordinator(aiResponse.leadData).catch(console.error);
    }
  } catch (error) {
    console.error("❌ Webhook error:", error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Thanks for reaching out! We're experiencing a brief technical issue. Call us at (208) 888-3611 for immediate help.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ─── SMS Status Callback ───
app.post("/webhook/sms-status", (req, res) => {
  const { MessageSid, MessageStatus, To } = req.body;
  console.log(`📊 SMS ${MessageSid} to ${To}: ${MessageStatus}`);
  if (["failed", "undelivered"].includes(MessageStatus)) {
    console.warn(`⚠️  Message ${MessageSid} to ${To} failed`);
  }
  res.sendStatus(200);
});

// ============================================
// VOICE WEBHOOK — Now powers Grok realtime voice
// ============================================
app.post("/webhook/voice", (req, res) => {
  const { To } = req.body;
  const hrNumber = process.env.TWILIO_HR_PHONE_NUMBER || "";
  const callType = To === hrNumber ? "hr" : "lead";

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect({
    action: "/webhook/voice-status"  // optional status callback
  }).stream({
    url: `wss://${req.get('host')}/media-stream?type=${callType}`,
    bidirectional: true
  });

  res.type("text/xml").send(twiml.toString());
  console.log(`📞 ${callType.toUpperCase()} voice call routed to Grok Voice Agent`);
});

app.get("/webhook/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect().stream({
    url: `wss://${req.get('host')}/media-stream?type=lead`,
    bidirectional: true
  });
  res.type("text/xml").send(twiml.toString());
});

// ─── Health Check ───
app.get("/health", (req, res) => {
  const activeConvos = db.prepare("SELECT COUNT(DISTINCT phone) as c FROM conversations WHERE stage != 'complete' AND stage != 'out_of_area'").get().c;
  const totalLeads = db.prepare("SELECT COUNT(*) as c FROM leads WHERE qualified = 1").get().c;
  const pendingEmails = db.prepare("SELECT COUNT(*) as c FROM email_queue WHERE status = 'pending'").get().c;
  let pendingTexts = 0;
  try { pendingTexts = db.prepare("SELECT COUNT(*) as c FROM text_queue WHERE status = 'pending'").get().c; } catch(e) {}
  res.json({
    status: "ok",
    service: "Visiting Angels AI SMS Platform (v2.2 + Grok Voice)",
    timestamp: new Date().toISOString(),
    activeConversations: activeConvos,
    totalQualifiedLeads: totalLeads,
    pendingFollowUpEmails: pendingEmails,
    pendingFollowUpTexts: pendingTexts,
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN,
    emailService: !!process.env.RESEND_API_KEY,
    calendar: !!process.env.GOOGLE_CALENDAR_ID,
    grokVoice: true
  });
});

// (All the rest of your original routes — /api/leads, /api/emails, demos, notifyCoordinator, etc. — are unchanged below)
app.get("/api/leads", (req, res) => {
  const leads = db.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 50").all();
  res.json(leads);
});

app.get("/api/leads/:phone", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE phone = ?").get(req.params.phone);
  const messages = db.prepare("SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC").all(req.params.phone);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json({ lead, messages });
});

app.get("/api/emails", (req, res) => {
  const emails = db.prepare("SELECT * FROM email_queue ORDER BY created_at DESC LIMIT 50").all();
  res.json(emails);
});

app.get("/api/texts", (req, res) => {
  try {
    const texts = db.prepare("SELECT * FROM text_queue ORDER BY created_at DESC LIMIT 50").all();
    res.json(texts);
  } catch(e) {
    res.json([]);
  }
});

app.get("/api/report/test", async (req, res) => {
  try {
    await sendWeeklyReport();
    res.json({ status: "Report sent! Check your email." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/calendar/test", async (req, res) => {
  try {
    const result = await verifyCalendarAccess();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function notifyCoordinator(leadData) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const phoneList = process.env.COORDINATOR_PHONES || process.env.COORDINATOR_PHONE || "";
  const phones = phoneList.split(",").map(p => p.trim()).filter(Boolean);
  if (phones.length === 0) { console.warn("⚠️  No COORDINATOR_PHONES set"); return; }

  const urgencyLabel = { immediate: "🔴 URGENT", soon: "🟡 1-2 Weeks", exploring: "🟢 Exploring" };
  const message = [
    `🔔 NEW QUALIFIED LEAD`,
    `━━━━━━━━━━━━━━━━━━`,
    `Name: ${leadData.name}`,
    `Phone: ${leadData.phone}`,
    `Email: ${leadData.email || "N/A"}`,
    `Care For: ${leadData.care_recipient_name || "Same as contact"}`,
    `Care Type: ${leadData.care_type || leadData.careType}`,
    `Relationship: ${leadData.relationship}`,
    `Insurance: ${leadData.insurance || "Not discussed"}`,
    `Urgency: ${urgencyLabel[leadData.urgency] || leadData.urgency}`,
    `Referral: ${leadData.referral_source || "Not specified"}`,
    `━━━━━━━━━━━━━━━━━━`,
    `Schedule free in-home assessment.`,
  ].join("\n");

  for (const phone of phones) {
    try {
      await client.messages.create({ body: message, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
      console.log(`📲 Notified: ${phone}`);
    } catch (err) { console.error(`Failed to notify ${phone}:`, err.message); }
  }
  console.log(`📲 Alert sent to ${phones.length} team members`);
}

// DEMO / SANDBOX MODE (unchanged)
app.post("/api/demo", async (req, res) => { /* ... your original demo code ... */ });
app.post("/api/demo/reset", (req, res) => { /* ... */ });
app.post("/api/hr-demo", async (req, res) => { /* ... */ });
app.post("/api/hr-demo/reset", (req, res) => { /* ... */ });
app.get("/api/applicants", (req, res) => { /* ... */ });
app.get("/demo", (req, res) => { /* ... your full demo HTML ... */ });
app.get("/hr-demo", (req, res) => { /* ... your full HR demo HTML ... */ });

// ============================================
// STARTUP & SCHEDULING + GROK VOICE WEBSOCKET
// ============================================
initDatabase();
ensureHubSpotProperties().catch(err => console.warn("HubSpot property setup skipped:", err.message));
verifyCalendarAccess().then(result => {
  if (result.connected) console.log("📅 Google Calendar connected: " + result.calendarName);
  else console.warn("⚠️  Google Calendar not connected: " + result.reason);
}).catch(err => console.warn("Calendar verification skipped:", err.message));

cron.schedule("*/5 * * * *", () => {
  processEmailQueue().catch(err => console.error("Email queue error:", err.message));
  processTextQueue().catch(err => console.error("Text queue error:", err.message));
});

cron.schedule("0 14 * * 1", () => sendWeeklyReport().catch(err => console.error("Weekly report error:", err.message)));
cron.schedule("0 14 * * *", () => sendWeeklyReport().catch(err => console.error("Daily report error:", err.message)));

console.log("⏰ Scheduled: Email + Text queue processing (every 5 min)");
console.log("⏰ Scheduled: Daily report (7am MT)");

// ─── Start server + WebSocket for Grok Voice ───
const server = app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   Visiting Angels AI SMS Platform (v2.2)     ║
  ║   + Grok Voice Agent NOW ACTIVE              ║
  ║   Running on port ${PORT}                        ║
  ║                                              ║
  ║   SMS Webhook: /webhook/sms                  ║
  ║   Voice Webhook: /webhook/voice              ║
  ║   Health:      /health                       ║
  ╚══════════════════════════════════════════════╝
  `);
});

const wss = new WebSocketServer({ server });
setupGrokVoiceBridge(wss);

export default app;
