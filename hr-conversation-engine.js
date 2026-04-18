// ============================================
// HR Conversation Engine — Lily
// Applicant Screening + Interview Booking
// ============================================
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./database.js";
import { HR_SYSTEM_PROMPT } from "./hr-system-prompt.js";
import { syncApplicantToHubSpot } from "./hubspot.js";
import { findAvailableSlots, formatSlotsForSMS, bookAssessment } from "./google-calendar.js";

let anthropic = null;
function getClient() {
  if (!anthropic) { const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("ANTHROPIC_API_KEY not set"); anthropic = new Anthropic({ apiKey: key.replace(/[\s"']/g, "") }); }
  return anthropic;
}

// ─── Main Handler ───
export async function handleHRMessage({ from, body, messageSid }) {
  const conversation = getOrCreateHRConversation(from);
  logHRMessage(from, "user", body, messageSid);

  if (isOptOut(body)) return handleOptOut(from);

  // Already booked interview
  if (conversation.stage === "interview_booked") {
    return handlePostBooking(from, body, conversation);
  }

  // Selecting interview slot
  if (conversation.stage === "selecting_interview") {
    if (isSlotSelection(body)) return handleSlotSelection(from, body, conversation);
    if (isDecline(body)) return handleInterviewDecline(from, body, conversation);
    return handleGeneric(from, body, conversation, "selecting_interview");
  }

  // Disqualified — just answer questions kindly
  if (conversation.stage === "disqualified") {
    return handleGeneric(from, body, conversation, "disqualified");
  }

  // Normal screening flow
  const messageHistory = buildHRHistory(from);
  const stateContext = buildHRContext(conversation);
  const aiReply = await callClaude(messageHistory, stateContext);
  const parsed = parseHRResponse(aiReply, body, conversation);

  updateHRConversation(from, parsed.stage, parsed.applicantData);
  logHRMessage(from, "assistant", parsed.text, null);

  // Qualified? Offer interview slots
  if (parsed.qualified && !["interview_booked", "selecting_interview"].includes(parsed.stage)) {
    return await offerInterviewSlots(from, parsed);
  }

  // Disqualified? Save and notify
  if (parsed.disqualified) {
    saveApplicant(from, parsed.applicantData, false);
    notifyHRTeam(from, parsed.applicantData, "disqualified").catch(console.error);
  }

  return { text: parsed.text, stage: parsed.stage, qualified: parsed.qualified, applicantData: parsed.applicantData };
}

// ─── Offer Interview Slots ───
async function offerInterviewSlots(from, parsed) {
  const calendarId = process.env.MEGAN_CALENDAR_ID;
  if (!calendarId) {
    const r = parsed.text + "\n\nYou sound like a great fit! Please call our office at (208) 984-2425 to schedule an interview with Megan, our Office Manager.";
    logHRMessage(from, "assistant", r, null);
    saveApplicant(from, parsed.applicantData, true);
    return { text: r, stage: "complete", qualified: true, applicantData: parsed.applicantData };
  }

  try {
    // Use Megan's calendar for interview slots
    const origCalendar = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ID = calendarId;
    const slots = await findAvailableSlots("soon", 3);
    process.env.GOOGLE_CALENDAR_ID = origCalendar;

    if (slots && slots.length > 0) {
      parsed.applicantData.available_slots = slots.map(s => ({
        start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString()
      }));
      updateHRConversation(from, "selecting_interview", parsed.applicantData);
      const slotsText = formatSlotsForSMS(slots);
      const r = parsed.text + "\n\nYou sound like a great fit! Let's get you in for an interview with Megan, our Office Manager. Here are the available times:\n\n" + slotsText + "\n\nWhich works best? Reply with the number, or let me know if you need a different day!";
      saveApplicant(from, parsed.applicantData, true);
      syncApplicantToHubSpot(from, parsed.applicantData).catch(console.error);
      logHRMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_interview", qualified: true, applicantData: parsed.applicantData };
    }
  } catch (e) { console.error("HR Calendar error:", e.message); }

  const r = parsed.text + "\n\nYou sound great! Please call (208) 984-2425 to schedule an interview with Megan.";
  saveApplicant(from, parsed.applicantData, true);
  syncApplicantToHubSpot(from, parsed.applicantData).catch(console.error);
  logHRMessage(from, "assistant", r, null);
  return { text: r, stage: "complete", qualified: true, applicantData: parsed.applicantData };
}

// ─── Slot Selection ───
async function handleSlotSelection(from, body, conversation) {
  const data = JSON.parse(conversation.lead_data || "{}");
  const slots = data.available_slots;
  if (!slots || !slots.length) return { text: "Please call (208) 984-2425 to schedule with Megan!", stage: "complete", qualified: true, applicantData: data };

  const t = body.trim().toLowerCase();
  let idx = -1;

  if (/^[1-3]$/.test(t) || (t.includes("1") && t.length < 15) || t.includes("first")) idx = 0;
  else if ((t.includes("2") && t.length < 15) || t.includes("second")) idx = 1;
  else if ((t.includes("3") && t.length < 15) || t.includes("third")) idx = 2;
  else {
    // Day-specific request
    const dayMap = { monday:1, tuesday:2, wednesday:3, thursday:4, friday:5 };
    let preferredDay = null;
    for (const [name, num] of Object.entries(dayMap)) { if (t.includes(name)) { preferredDay = num; break; } }

    const calendarId = process.env.MEGAN_CALENDAR_ID;
    const origCalendar = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ID = calendarId;
    const ns = await findAvailableSlots("soon", 3, preferredDay);
    process.env.GOOGLE_CALENDAR_ID = origCalendar;

    if (ns && ns.length) {
      data.available_slots = ns.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString() }));
      updateHRConversation(from, "selecting_interview", data);
      const dayName = preferredDay ? Object.keys(dayMap).find(k => dayMap[k] === preferredDay) : null;
      const r = dayName ? "Here are " + dayName.charAt(0).toUpperCase() + dayName.slice(1) + " openings:\n\n" + formatSlotsForSMS(ns) + "\n\nWhich works?"
        : "Here are some other times:\n\n" + formatSlotsForSMS(ns) + "\n\nDo any work?";
      logHRMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_interview", qualified: true, applicantData: data };
    } else {
      const dayName = preferredDay ? Object.keys(dayMap).find(k => dayMap[k] === preferredDay) : null;
      const r = dayName ? dayName.charAt(0).toUpperCase() + dayName.slice(1) + " is full. Want me to check another day?" : "I'm not finding openings there. Try a different day?";
      logHRMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_interview", qualified: true, applicantData: data };
    }
  }

  if (idx >= 0 && idx < slots.length) {
    const recon = slots.map(s => ({ start: new Date(s.start), end: new Date(s.end), travelEnd: new Date(s.travelEnd) }));

    // Book on Megan's calendar
    const calendarId = process.env.MEGAN_CALENDAR_ID;
    const origCalendar = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ID = calendarId;

    // Override lead data for interview format
    const interviewData = {
      ...data,
      care_recipient_name: data.name || "Applicant",
      address: "36 E. Pine Ave, Meridian, ID 83642",
    };

    const result = await bookAssessment(interviewData, idx, recon);
    process.env.GOOGLE_CALENDAR_ID = origCalendar;

    if (result.success) {
      data.interview_event_id = result.eventId;
      data.interview_time = result.startTime;
      delete data.available_slots;
      updateHRConversation(from, "interview_booked", data);
      saveApplicant(from, data, true);
      syncApplicantToHubSpot(from, data).catch(console.error);
      notifyHRTeam(from, data, "interview_booked").catch(console.error);

      const r = "You're all set! 🎉\n\nYour interview with Megan Dickson is " + result.startTime +
        " at our office: 36 E. Pine Ave, Meridian, ID 83642.\n\nPlease bring a valid ID and proof of insurance." +
        (data.resume_sent !== "yes" ? "\n\nIf you have a resume, please email it to mdickson@boiseidahohomecare.com before your interview." : "") +
        "\n\nIf you need to reschedule, just text here or call (208) 984-2425. We look forward to meeting you!";
      logHRMessage(from, "assistant", r, null);
      return { text: r, stage: "interview_booked", qualified: true, applicantData: data };
    }
  }

  return handleGeneric(from, body, conversation, "selecting_interview");
}

// ─── Interview Decline ───
async function handleInterviewDecline(from, body, conversation) {
  const data = JSON.parse(conversation.lead_data || "{}");
  delete data.available_slots;
  const r = "No problem at all! When you're ready to schedule, just text this number or call (208) 984-2425. We'd love to have you on the team!";
  updateHRConversation(from, "nurturing_applicant", data);
  logHRMessage(from, "assistant", r, null);
  return { text: r, stage: "nurturing_applicant", qualified: true, applicantData: data };
}

// ─── Post Booking ───
async function handlePostBooking(from, body, conversation) {
  const mh = buildHRHistory(from);
  const sc = buildHRContext(conversation);
  const aiReply = await callClaude(mh, sc);
  const clean = aiReply.replace(/\[\[HR_DATA:[^\]]+\]\]/g, "").replace(/\[\[HR_QUALIFIED\]\]/g, "").replace(/\[\[HR_DISQUALIFIED:[^\]]+\]\]/g, "").trim();
  logHRMessage(from, "assistant", clean, null);
  return { text: clean, stage: "interview_booked", qualified: true, applicantData: JSON.parse(conversation.lead_data || "{}") };
}

// ─── Generic Handler ───
async function handleGeneric(from, body, conversation, stage) {
  const mh = buildHRHistory(from);
  const sc = buildHRContext(conversation);
  const aiReply = await callClaude(mh, sc);
  const clean = aiReply.replace(/\[\[HR_DATA:[^\]]+\]\]/g, "").replace(/\[\[HR_QUALIFIED\]\]/g, "").replace(/\[\[HR_DISQUALIFIED:[^\]]+\]\]/g, "").trim();
  logHRMessage(from, "assistant", clean, null);
  return { text: clean, stage, qualified: false, applicantData: JSON.parse(conversation.lead_data || "{}") };
}

// ─── Notify HR Team ───
async function notifyHRTeam(from, data, type) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_EMAIL_TO;
  if (!key || !to) return;

  const subject = type === "interview_booked"
    ? `✅ Interview Booked: ${data.name || "Applicant"}`
    : `❌ Applicant Disqualified: ${data.name || "Unknown"}`;

  const html = `<h2>${type === "interview_booked" ? "Interview Booked" : "Applicant Disqualified"}</h2>
<table style="border-collapse:collapse;width:100%;">
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Name</td><td style="padding:8px;border:1px solid #ddd;">${data.name || "N/A"}</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Phone</td><td style="padding:8px;border:1px solid #ddd;">${from}</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Email</td><td style="padding:8px;border:1px solid #ddd;">${data.email || "N/A"}</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Experience</td><td style="padding:8px;border:1px solid #ddd;">${data.experience_years || "N/A"} years</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Certifications</td><td style="padding:8px;border:1px solid #ddd;">${data.certifications || "N/A"}</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Pay Expectation</td><td style="padding:8px;border:1px solid #ddd;">${data.pay_expectation || "N/A"}</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Availability</td><td style="padding:8px;border:1px solid #ddd;">${data.availability || "N/A"}</td></tr>
${data.interview_time ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Interview</td><td style="padding:8px;border:1px solid #ddd;">${data.interview_time}</td></tr>` : ""}
${data.red_flags ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;color:#C0392B;">Red Flags</td><td style="padding:8px;border:1px solid #ddd;color:#C0392B;">${data.red_flags}</td></tr>` : ""}
${data.disqualify_reason ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Reason</td><td style="padding:8px;border:1px solid #ddd;">${data.disqualify_reason}</td></tr>` : ""}
</table>
<p><b>Source:</b> AI HR Screening (Lily) via ${from}</p>`;

  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Lily - VA HR <${process.env.EMAIL_FROM_ADDRESS || "care@boiseidahohomecare.com"}>`,
      to: to.split(",").map(e => e.trim()),
      subject, html
    }),
  }).catch(e => console.error("HR notify error:", e.message));
}

// ─── Detection Helpers ───
function isDecline(t) {
  const l = t.trim().toLowerCase();
  const patterns = ["no ","no,","no.","not now","not yet","not ready","need to think","think about","hold off","let me think","maybe later","not sure","can't right now"];
  return l === "no" || patterns.some(p => l.includes(p));
}

function isSlotSelection(t) {
  const l = t.trim().toLowerCase();
  if (isDecline(l)) return false;
  return /^[1-3]$/.test(l) || l.includes("first") || l.includes("second") || l.includes("third") ||
    (l.includes("1") && l.length < 15) || (l.includes("2") && l.length < 15) || (l.includes("3") && l.length < 15) ||
    l.includes("monday") || l.includes("tuesday") || l.includes("wednesday") || l.includes("thursday") || l.includes("friday") ||
    l.includes("next week") || l.includes("what about") || l.includes("do you have") ||
    l.includes("none") || l.includes("different") || l.includes("other day") || l.includes("another");
}

function isOptOut(m) { return ["stop","unsubscribe","quit","opt out","optout"].includes(m.trim().toLowerCase()); }

function handleOptOut(p) {
  db.prepare("UPDATE hr_conversations SET stage='opted_out',updated_at=datetime('now') WHERE phone=?").run(p);
  return { text: "You've been unsubscribed. If you change your mind, text again or call (208) 984-2425. Take care!", stage: "opted_out", qualified: false, applicantData: {} };
}

// ─── Claude API ───
async function callClaude(mh, sc) {
  try {
    const c = getClient();
    const r = await c.messages.create({ model: "claude-sonnet-4-6", max_tokens: 500, system: HR_SYSTEM_PROMPT + "\n\n" + sc, messages: mh });
    return r.content[0].text;
  } catch(e) { console.error("Claude HR error:", e.message); return "Thanks for your interest! Call (208) 984-2425 for help."; }
}

function buildHRHistory(phone) {
  const rows = db.prepare("SELECT role,content FROM hr_messages WHERE phone=? ORDER BY created_at ASC LIMIT 30").all(phone);
  const m = [];
  for (const r of rows) { const l = m[m.length - 1]; if (l && l.role === r.role) l.content += "\n" + r.content; else m.push({ role: r.role, content: r.content }); }
  if (m.length > 0 && m[0].role === "assistant") m.shift();
  return m;
}

function buildHRContext(conv) {
  const d = conv.lead_data ? JSON.parse(conv.lead_data) : {};
  return `
CURRENT STATE: Stage=${conv.stage || "new_applicant"} Data=${JSON.stringify(d)} Messages=${conv.message_count || 0}
STAGE INSTRUCTIONS: ${getHRStageInstructions(conv.stage, d)}
FORMAT: Keep under 350 chars. Tag data at END: [[HR_DATA:field=value]]. When qualified: [[HR_QUALIFIED]]. When disqualified: [[HR_DISQUALIFIED:reason=X]]`;
}

function getHRStageInstructions(s, d) {
  const i = {
    new_applicant: "Greet warmly as Lily. Ask if they're interested in a caregiver position. Start screening.",
    greeting: "Continue greeting. Ask about their caregiving experience (years + personal care skills).",
    screening: "Continue screening. Follow the flow: experience → certifications → transportation → background → availability → pay. Data so far: " + JSON.stringify(d),
    arpo: "Run ARPO framework: Activity, Rank, Process, Offers. Data: " + JSON.stringify(d),
    selecting_interview: "Interview times offered. Answer questions. Do NOT re-offer slots.",
    interview_booked: "Interview booked: " + (d.interview_time || "soon") + ". Answer questions. Remind: bring ID + insurance proof. Resume to mdickson@boiseidahohomecare.com. NEVER offer new times.",
    nurturing_applicant: "They declined to schedule now. Be warm. Remind they can text anytime or call (208) 984-2425.",
    disqualified: "Not qualified. Be kind. Explain why. Suggest what they could do to be a stronger candidate. Answer questions.",
    complete: "Screening done. Answer questions. (208) 984-2425.",
    opted_out: "Opted out.",
  };
  return i[s] || "Screen the applicant. Follow the screening flow.";
}

// ─── Parse HR Response ───
function parseHRResponse(ai, body, conv) {
  const ed = conv.lead_data ? JSON.parse(conv.lead_data) : {};
  const nd = { ...ed };
  let st = conv.stage || "greeting";
  let qualified = false;
  let disqualified = false;

  // Parse HR data tags
  const dp = /\[\[HR_DATA:(\w+)=([^\]]+)\]\]/g;
  let m;
  while ((m = dp.exec(ai)) !== null) {
    nd[m[1]] = m[2].trim();
    if (st === "greeting" || st === "new_applicant") st = "screening";
  }

  if (ai.includes("[[HR_QUALIFIED]]")) { qualified = true; st = "complete"; }
  if (ai.includes("[[HR_DISQUALIFIED")) {
    disqualified = true; st = "disqualified";
    const reasonMatch = ai.match(/\[\[HR_DISQUALIFIED:reason=([^\]]+)\]\]/);
    if (reasonMatch) nd.disqualify_reason = reasonMatch[1];
  }

  // Auto-qualify check
  if (nd.experience_years && parseInt(nd.experience_years) >= 1 &&
      nd.has_personal_care_exp === "yes" && nd.has_transportation === "yes" &&
      nd.background_clear === "yes" && nd.name && !qualified && !disqualified) {
    if (nd.pay_expectation) {
      const pay = parseInt(nd.pay_expectation.replace(/[^0-9]/g, ""));
      if (pay <= 23) { qualified = true; st = "complete"; }
    }
  }

  return {
    text: ai.replace(/\[\[HR_DATA:[^\]]+\]\]/g, "").replace(/\[\[HR_QUALIFIED\]\]/g, "").replace(/\[\[HR_DISQUALIFIED:[^\]]+\]\]/g, "").trim(),
    stage: st, qualified, disqualified, applicantData: nd
  };
}

// ─── Database ───
function getOrCreateHRConversation(p) {
  let c = db.prepare("SELECT * FROM hr_conversations WHERE phone=?").get(p);
  if (!c) { db.prepare("INSERT INTO hr_conversations(phone,stage,lead_data,message_count,created_at,updated_at) VALUES(?,'greeting','{}',0,datetime('now'),datetime('now'))").run(p); c = db.prepare("SELECT * FROM hr_conversations WHERE phone=?").get(p); }
  if (c.stage === "opted_out") { db.prepare("UPDATE hr_conversations SET stage='greeting',lead_data='{}',message_count=0,updated_at=datetime('now') WHERE phone=?").run(p); c = db.prepare("SELECT * FROM hr_conversations WHERE phone=?").get(p); }
  return c;
}
function updateHRConversation(p, s, d) { db.prepare("UPDATE hr_conversations SET stage=?,lead_data=?,message_count=message_count+2,updated_at=datetime('now') WHERE phone=?").run(s, JSON.stringify(d), p); }
function logHRMessage(p, r, c, sid) { db.prepare("INSERT INTO hr_messages(phone,role,content,message_sid,created_at) VALUES(?,?,?,?,datetime('now'))").run(p, r, c, sid); }

function saveApplicant(p, d, qualified) {
  const existing = db.prepare("SELECT * FROM applicants WHERE phone=?").get(p);
  if (existing) {
    db.prepare("UPDATE applicants SET name=?,email=?,experience_years=?,certifications=?,has_transportation=?,availability=?,pay_expectation=?,qualified=?,updated_at=datetime('now') WHERE phone=?")
      .run(d.name, d.email, d.experience_years, d.certifications, d.has_transportation, d.availability, d.pay_expectation, qualified ? 1 : 0, p);
  } else {
    db.prepare("INSERT INTO applicants(phone,name,email,experience_years,certifications,has_transportation,availability,pay_expectation,qualified,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
      .run(p, d.name, d.email, d.experience_years, d.certifications, d.has_transportation, d.availability, d.pay_expectation, qualified ? 1 : 0);
  }
  console.log("👤 Applicant saved: " + (d.name || "Unknown") + " (" + p + ") [" + (qualified ? "QUALIFIED" : "NOT QUALIFIED") + "]");
}
