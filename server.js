// ============================================
// Visiting Angels AI SMS Platform — Server
// Phase 2: HubSpot + Email Follow-ups + Reports
// ============================================
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import twilio from "twilio";
import cron from "node-cron";
import dotenv from "dotenv";
import { handleInboundMessage } from "./conversation-engine.js";
import { db, initDatabase } from "./database.js";
import { ensureHubSpotProperties } from "./hubspot.js";
import { processEmailQueue } from "./email-followups.js";
import { sendWeeklyReport } from "./weekly-report.js";
import { verifyCalendarAccess } from "./google-calendar.js";
import { processTextQueue } from "./text-followups.js";

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
    const { From, Body, MessageSid } = req.body;
    console.log(`📨 Inbound SMS from ${From}: "${Body}"`);
    const aiResponse = await handleInboundMessage({ from: From, body: Body, messageSid: MessageSid });
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.text);
    res.type("text/xml").send(twiml.toString());
    console.log(`✅ Replied to ${From} | Stage: ${aiResponse.stage}`);
    if (aiResponse.qualified) {
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

// ─── Voice Call Handler ───
// If someone calls the SMS number, play a message and redirect to office
app.post("/webhook/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Thank you for calling Visiting Angels of Boise. " +
    "This number is set up for text messaging. " +
    "Let me connect you with our office right now."
  );
  twiml.dial("+12088883611");
  res.type("text/xml").send(twiml.toString());
  console.log(`📞 Voice call from ${req.body.From} — redirected to office`);
});
app.get("/webhook/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Thank you for calling Visiting Angels of Boise. " +
    "This number is set up for text messaging. " +
    "Let me connect you with our office right now."
  );
  twiml.dial("+12088883611");
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
    service: "Visiting Angels AI SMS Platform (v2.2)",
    timestamp: new Date().toISOString(),
    activeConversations: activeConvos,
    totalQualifiedLeads: totalLeads,
    pendingFollowUpEmails: pendingEmails,
    pendingFollowUpTexts: pendingTexts,
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN,
    emailService: !!process.env.RESEND_API_KEY,
    calendar: !!process.env.GOOGLE_CALENDAR_ID,
  });
});

// ─── Leads API ───
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

// ─── Email Queue Status ───
app.get("/api/emails", (req, res) => {
  const emails = db.prepare("SELECT * FROM email_queue ORDER BY created_at DESC LIMIT 50").all();
  res.json(emails);
});

// ─── Text Queue Status ───
app.get("/api/texts", (req, res) => {
  try {
    const texts = db.prepare("SELECT * FROM text_queue ORDER BY created_at DESC LIMIT 50").all();
    res.json(texts);
  } catch(e) {
    res.json([]);
  }
});

// ─── Manual Report Trigger (for testing) ───
app.get("/api/report/test", async (req, res) => {
  try {
    await sendWeeklyReport();
    res.json({ status: "Report sent! Check your email." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Calendar Verification (for testing) ───
app.get("/api/calendar/test", async (req, res) => {
  try {
    const result = await verifyCalendarAccess();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Notify Team ───
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

// ============================================
// DEMO / SANDBOX MODE
// ============================================
app.post("/api/demo", async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const fakePhone = "+1DEMO" + (sessionId || "000000").replace(/[^0-9]/g, "").slice(0, 7).padEnd(7, "0");
    const aiResponse = await handleInboundMessage({ from: fakePhone, body: message, messageSid: "DEMO_" + Date.now() });
    res.json({ reply: aiResponse.text, stage: aiResponse.stage, qualified: aiResponse.qualified, leadData: aiResponse.leadData || {} });
  } catch (error) {
    console.error("Demo error:", error);
    res.status(500).json({ reply: "Something went wrong. Try again!", error: error.message });
  }
});

app.post("/api/demo/reset", (req, res) => {
  const { sessionId } = req.body;
  const fakePhone = "+1DEMO" + (sessionId || "000000").replace(/[^0-9]/g, "").slice(0, 7).padEnd(7, "0");
  db.prepare("DELETE FROM messages WHERE phone = ?").run(fakePhone);
  db.prepare("DELETE FROM conversations WHERE phone = ?").run(fakePhone);
  db.prepare("DELETE FROM leads WHERE phone = ?").run(fakePhone);
  try { db.prepare("DELETE FROM email_queue WHERE phone = ?").run(fakePhone); } catch(e) {}
  try { db.prepare("DELETE FROM text_queue WHERE phone = ?").run(fakePhone); } catch(e) {}
  res.json({ status: "reset" });
});

app.get("/demo", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Visiting Angels SMS Demo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0ece4; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
  .container { width: 100%; max-width: 420px; }
  .header { background: #1a2744; border-radius: 16px 16px 0 0; padding: 20px; text-align: center; }
  .header h1 { color: #fff; font-family: Georgia, serif; font-size: 18px; margin-bottom: 4px; }
  .header p { color: #c5a45a; font-size: 13px; }
  .badge { display: inline-block; background: #c5a45a; color: #1a2744; padding: 3px 12px; border-radius: 12px; font-size: 11px; font-weight: 700; margin-top: 8px; }
  .chat { background: #fff; height: 420px; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 82%; padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.45; white-space: pre-line; animation: fadeIn 0.3s ease; }
  .msg.ai { align-self: flex-start; background: #f5f0e8; color: #1a2744; border-bottom-left-radius: 4px; }
  .msg.user { align-self: flex-end; background: #1a2744; color: #fff; border-bottom-right-radius: 4px; }
  .msg.system { align-self: center; background: transparent; color: #999; font-size: 12px; font-style: italic; text-align: center; }
  .typing { align-self: flex-start; background: #f5f0e8; padding: 12px 20px; border-radius: 16px; border-bottom-left-radius: 4px; display: none; }
  .typing span { display: inline-block; width: 8px; height: 8px; background: #ccc; border-radius: 50%; margin: 0 2px; animation: pulse 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  .input-area { background: #fff; padding: 12px; display: flex; gap: 8px; border-top: 1px solid #e8e4df; border-radius: 0 0 16px 16px; }
  .input-area input { flex: 1; padding: 10px 16px; border-radius: 24px; border: 1px solid #e8e4df; font-size: 14px; outline: none; background: #f9f7f4; }
  .input-area input:focus { border-color: #c5a45a; }
  .input-area button { width: 40px; height: 40px; border-radius: 50%; background: #1a2744; border: none; cursor: pointer; color: #fff; font-size: 16px; }
  .input-area button:disabled { background: #ddd; cursor: default; }
  .suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 0; }
  .suggestions button { padding: 6px 14px; border-radius: 16px; font-size: 12px; background: #f5eed9; color: #1a2744; border: 1px solid #c5a45a; cursor: pointer; font-family: Georgia, serif; }
  .suggestions button:hover { background: #c5a45a; color: #fff; }
  .controls { display: flex; gap: 8px; margin-top: 10px; justify-content: center; }
  .controls button { padding: 8px 16px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #ddd; background: #fff; color: #666; }
  .controls button:hover { background: #f5f0e8; }
  .lead-panel { background: #fff; border-radius: 12px; margin-top: 16px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .lead-panel h3 { font-family: Georgia, serif; color: #1a2744; font-size: 14px; margin-bottom: 10px; }
  .lead-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid #f5f0e8; }
  .lead-row:last-child { border: none; }
  .lead-label { color: #999; }
  .lead-value { color: #1a2744; font-weight: 600; }
  .lead-value.empty { color: #ddd; font-weight: 400; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Visiting Angels SMS Demo</h1>
    <p>Practice the AI conversation — no real texts sent</p>
    <div class="badge">SANDBOX MODE</div>
  </div>
  <div class="chat" id="chat">
    <div class="msg system">Send a message to start — try "Hi, I need help with care for my mom"</div>
  </div>
  <div class="typing" id="typing"><span></span><span></span><span></span></div>
  <div class="input-area">
    <input type="text" id="input" placeholder="Type a message..." autocomplete="off">
    <button id="sendBtn" onclick="send()">&#9654;</button>
  </div>
  <div class="suggestions">
    <button onclick="useSuggestion(this)">Hi, I need care for my mom</button>
    <button onclick="useSuggestion(this)">How much does it cost?</button>
    <button onclick="useSuggestion(this)">Are you hiring?</button>
    <button onclick="useSuggestion(this)">Do you accept Medicaid?</button>
  </div>
  <div class="controls">
    <button onclick="resetChat()">Reset Conversation</button>
  </div>
  <div class="lead-panel">
    <h3>Lead Qualification Status</h3>
    <div id="leadInfo">
      <div class="lead-row"><span class="lead-label">Stage</span><span class="lead-value empty" id="ls">Waiting...</span></div>
      <div class="lead-row"><span class="lead-label">Contact Name</span><span class="lead-value empty" id="ln">—</span></div>
      <div class="lead-row"><span class="lead-label">Care Recipient</span><span class="lead-value empty" id="lcr">—</span></div>
      <div class="lead-row"><span class="lead-label">Relationship</span><span class="lead-value empty" id="lr">—</span></div>
      <div class="lead-row"><span class="lead-label">Care Type</span><span class="lead-value empty" id="lc">—</span></div>
      <div class="lead-row"><span class="lead-label">Insurance</span><span class="lead-value empty" id="li">—</span></div>
      <div class="lead-row"><span class="lead-label">Urgency</span><span class="lead-value empty" id="lu">—</span></div>
      <div class="lead-row"><span class="lead-label">Referral Source</span><span class="lead-value empty" id="lref">—</span></div>
      <div class="lead-row"><span class="lead-label">Phone</span><span class="lead-value empty" id="lp">—</span></div>
      <div class="lead-row"><span class="lead-label">Email</span><span class="lead-value empty" id="le">—</span></div>
      <div class="lead-row"><span class="lead-label">Address</span><span class="lead-value empty" id="la">—</span></div>
      <div class="lead-row"><span class="lead-label">Assessment</span><span class="lead-value empty" id="lat">—</span></div>
    </div>
  </div>
</div>
<script>
const sessionId = "DEMO" + Math.random().toString(36).slice(2, 9);
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const typing = document.getElementById("typing");
input.addEventListener("keydown", e => { if (e.key === "Enter" && input.value.trim()) send(); });
function addMsg(text, cls) { const div = document.createElement("div"); div.className = "msg " + cls; div.textContent = text; chat.appendChild(div); chat.scrollTop = chat.scrollHeight; }
function useSuggestion(btn) { input.value = btn.textContent; send(); }
async function send() {
  const text = input.value.trim(); if (!text) return; input.value = "";
  addMsg(text, "user"); typing.style.display = "block"; chat.scrollTop = chat.scrollHeight;
  document.getElementById("sendBtn").disabled = true;
  try {
    const res = await fetch("/api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, sessionId }) });
    const data = await res.json(); typing.style.display = "none"; addMsg(data.reply, "ai"); updateLead(data);
    if (data.qualified) addMsg("Lead qualified! In live mode: SMS alert sent, HubSpot contact created, calendar slots offered, follow-up texts scheduled.", "system");
  } catch (err) { typing.style.display = "none"; addMsg("Error connecting. Try again.", "system"); }
  document.getElementById("sendBtn").disabled = false; input.focus();
}
function updateLead(data) {
  const d = data.leadData || {};
  const stageNames = { greeting:"Initial Contact", needs:"Identifying Needs", location:"Service Area", referral:"Referral Source", insurance:"Insurance Check", urgency:"Timeline", capture_info:"Capturing Info", selecting_slot:"Choosing Time Slot", assessment_booked:"Assessment Booked ✅", cancelled:"Cancelled — Nurturing", complete:"Lead Captured!", out_of_area:"Outside Area", medicaid_screened:"Medicaid (At Capacity)", under_18:"Under 18", job_inquiry:"Job Inquiry" };
  setField("ls", stageNames[data.stage] || data.stage, data.stage === "complete" ? "#2d8a5e" : data.stage === "assessment_booked" ? "#2d8a5e" : data.stage === "medicaid_screened" ? "#c0392b" : data.stage === "cancelled" ? "#e67e22" : "#c5a45a");
  setField("ln", d.name || d.contact_name);
  setField("lcr", d.care_recipient_name);
  setField("lr", d.relationship);
  setField("lc", d.care_type);
  setField("li", d.insurance);
  setField("lu", d.urgency);
  setField("lref", d.referral_source);
  setField("lp", d.phone);
  setField("le", d.email);
  setField("la", d.address);
  setField("lat", d.assessment_time);
}
function setField(id, val, color) { const el = document.getElementById(id); if (val) { el.textContent = val; el.className = "lead-value"; if (color) el.style.color = color; } }
async function resetChat() {
  await fetch("/api/demo/reset", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ sessionId }) });
  chat.innerHTML = '<div class="msg system">Conversation reset — send a message to start again</div>';
  ["ls","ln","lcr","lr","lc","li","lu","lref","lp","le","la","lat"].forEach(id => { const el = document.getElementById(id); el.textContent = id === "ls" ? "Waiting..." : "\\u2014"; el.className = "lead-value empty"; el.style.color = ""; });
}
</script>
</body>
</html>`);
});

// ============================================
// STARTUP & SCHEDULING
// ============================================
initDatabase();

// Set up HubSpot custom properties (runs once on startup)
ensureHubSpotProperties().catch(err => {
  console.warn("HubSpot property setup skipped:", err.message);
});

// Verify Google Calendar connection on startup
verifyCalendarAccess().then(result => {
  if (result.connected) console.log("📅 Google Calendar connected: " + result.calendarName);
  else console.warn("⚠️  Google Calendar not connected: " + result.reason);
}).catch(err => {
  console.warn("Calendar verification skipped:", err.message);
});

// Process email queue every 5 minutes
cron.schedule("*/5 * * * *", () => {
  processEmailQueue().catch(err => {
    console.error("Email queue processing error:", err.message);
  });
  processTextQueue().catch(err => {
    console.error("Text queue processing error:", err.message);
  });
});

// Weekly report — Monday at 7:00 AM Mountain Time (14:00 UTC)
cron.schedule("0 14 * * 1", () => {
  console.log("📊 Running weekly report...");
  sendWeeklyReport().catch(err => {
    console.error("Weekly report error:", err.message);
  });
});

// Daily report — Every day at 7:00 AM Mountain Time (14:00 UTC)
cron.schedule("0 14 * * *", () => {
  console.log("📊 Running daily report...");
  sendWeeklyReport().catch(err => {
    console.error("Daily report error:", err.message);
  });
});

console.log("⏰ Scheduled: Email + Text queue processing (every 5 min)");
console.log("⏰ Scheduled: Daily report (7am MT)");

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   Visiting Angels AI SMS Platform (v2.1)     ║
  ║   Running on port ${PORT}                        ║
  ║                                              ║
  ║   Webhook:     /webhook/sms                  ║
  ║   Health:      /health                       ║
  ║   Leads API:   /api/leads                    ║
  ║   Email Queue: /api/emails                   ║
  ║   Test Report: /api/report/test              ║
  ║   Test Calendar:/api/calendar/test           ║
  ║   Demo:        /demo                         ║
  ╚══════════════════════════════════════════════╝
  `);
});

export default app;
