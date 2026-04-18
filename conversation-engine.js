import Anthropic from "@anthropic-ai/sdk";
import { db } from "./database.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { syncLeadToHubSpot } from "./hubspot.js";
import { scheduleFollowUps, scheduleDayOfEmailReminder } from "./email-followups.js";
import { scheduleTextFollowUps, scheduleDayOfReminder } from "./text-followups.js";
import { findAvailableSlots, formatSlotsForSMS, bookAssessment, cancelAssessment, scoreSentiment } from "./google-calendar.js";

let anthropic = null;
function getClient() {
  if (!anthropic) { const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("ANTHROPIC_API_KEY not set"); anthropic = new Anthropic({ apiKey: key.replace(/[\s"']/g, "") }); }
  return anthropic;
}

export async function handleInboundMessage({ from, body, messageSid }) {
  const conversation = getOrCreateConversation(from);
  logMessage(from, "user", body, messageSid);
  if (isOptOut(body)) return handleOptOut(from);

  // Already booked
  if (conversation.stage === "assessment_booked") {
    if (isCancellationRequest(body)) return handleCancellation(from, body, conversation);
    return handlePostBooking(from, body, conversation);
  }

  // Selecting a slot
  if (conversation.stage === "selecting_slot") {
    if (isSlotSelection(body)) return handleSlotSelection(from, body, conversation);
    if (isDecline(body)) return handleBookingDecline(from, body, conversation);
    return handleGenericInStage(from, body, conversation, "selecting_slot");
  }

  // Nurturing — check if they want to book now
  if (conversation.stage === "nurturing") {
    if (wantsToBook(body)) return reenterBookingFlow(from, body, conversation);
    return handleNurturing(from, body, conversation);
  }

  // Normal qualification flow
  const messageHistory = buildMessageHistory(from);
  const allUserMsgs = db.prepare("SELECT content FROM messages WHERE phone = ? AND role = 'user' ORDER BY created_at ASC").all(from);
  const sentiment = scoreSentiment(allUserMsgs);
  const stateContext = buildStateContext(conversation, sentiment);
  const aiReply = await callClaude(messageHistory, stateContext);
  const parsed = parseAIResponse(aiReply, body, conversation);
  parsed.leadData.sentiment = sentiment.summary;
  if (sentiment.override && parsed.leadData.urgency !== "immediate") parsed.leadData.urgency = "immediate";
  updateConversation(from, parsed.stage, parsed.leadData);
  logMessage(from, "assistant", parsed.text, null);

  // Qualified with valid address? Offer calendar slots ONE TIME
  if (parsed.qualified && hasValidAddress(parsed.leadData.address) &&
      !["assessment_booked","selecting_slot","nurturing"].includes(parsed.stage)) {
    return await offerCalendarSlots(from, parsed);
  }

  // Qualified but address too vague?
  if (parsed.qualified && parsed.leadData.address && !hasValidAddress(parsed.leadData.address)) {
    const prompt = "To schedule Matthew's visit, I just need the full street address — house number, street name, and city. Something like '1234 Maple Street, Boise.' What's the address?";
    logMessage(from, "assistant", prompt, null);
    return { text: parsed.text + "\n\n" + prompt, stage: parsed.stage, qualified: true, leadData: parsed.leadData };
  }

  if (parsed.qualified) {
    saveLead(from, parsed.leadData);
    syncLeadToHubSpot(from, parsed.leadData).catch(console.error);
    try { scheduleFollowUps(from, parsed.leadData); scheduleTextFollowUps(from, parsed.leadData); } catch(e) {}
  }
  return { text: parsed.text, stage: parsed.stage, qualified: parsed.qualified, leadData: parsed.leadData };
}

// ADDRESS VALIDATION
function hasValidAddress(address) {
  if (!address) return false;
  const addr = address.trim();
  const hasNumber = /\d+/.test(addr);
  const streetWords = ["st","street","ave","avenue","rd","road","dr","drive","ln","lane","way","blvd","boulevard","ct","court","pl","place","cir","circle","pkwy"];
  const hasStreet = streetWords.some(w => addr.toLowerCase().includes(w));
  const cities = ["boise","meridian","eagle","nampa","caldwell","star","kuna","garden city","horseshoe bend","emmett","middleton","homedale","marsing"];
  const hasCity = cities.some(c => addr.toLowerCase().includes(c));
  return hasNumber && (hasStreet || hasCity);
}

function completeAddress(address) {
  if (!address) return address;
  let addr = address.trim();
  if (!addr.toLowerCase().includes("idaho") && !addr.toLowerCase().includes(", id") && !/,\s*id\b/i.test(addr)) {
    const cities = ["boise","meridian","eagle","nampa","caldwell","star","kuna","garden city","horseshoe bend","emmett","middleton","homedale","marsing"];
    for (const city of cities) { if (addr.toLowerCase().includes(city)) { addr += ", ID"; break; } }
  }
  return addr;
}

// OFFER CALENDAR SLOTS (ONE TIME)
async function offerCalendarSlots(from, parsed) {
  parsed.leadData.address = completeAddress(parsed.leadData.address);
  try {
    const slots = await findAvailableSlots(parsed.leadData.urgency || "soon", 3);
    if (slots && slots.length > 0) {
      parsed.leadData.available_slots = slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString() }));
      updateConversation(from, "selecting_slot", parsed.leadData);
      const r = parsed.text + "\n\nGreat news! Let's get your free assessment on the calendar. Our Executive Director, Matthew, will come to you personally:\n\n" + formatSlotsForSMS(slots) + "\n\nWhich works best? Reply with the number (1, 2, or 3), or let me know if you need a different day!";
      saveLead(from, parsed.leadData);
      syncLeadToHubSpot(from, parsed.leadData).catch(console.error);
      logMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_slot", qualified: true, leadData: parsed.leadData };
    }
  } catch (e) { console.error("Calendar error:", e.message); }
  saveLead(from, parsed.leadData); syncLeadToHubSpot(from, parsed.leadData).catch(console.error);
  try { scheduleFollowUps(from, parsed.leadData); scheduleTextFollowUps(from, parsed.leadData); } catch(e) {}
  return { text: parsed.text, stage: parsed.stage, qualified: parsed.qualified, leadData: parsed.leadData };
}

// SLOT SELECTION
async function handleSlotSelection(from, body, conversation) {
  const leadData = JSON.parse(conversation.lead_data || "{}");
  const slots = leadData.available_slots;
  if (!slots || !slots.length) return moveToNurturing(from, leadData, "Our team will reach out soon to find a time!");
  const t = body.trim().toLowerCase();
  let idx = -1;

  if (/^[1-3]$/.test(t) || (t.includes("1") && t.length < 15) || t.includes("first one")) idx = 0;
  else if ((t.includes("2") && t.length < 15) || t.includes("second")) idx = 1;
  else if ((t.includes("3") && t.length < 15) || t.includes("third")) idx = 2;
  else {
    const dayMap = { monday:1, tuesday:2, wednesday:3, thursday:4, friday:5 };
    let preferredDay = null;
    for (const [name, num] of Object.entries(dayMap)) { if (t.includes(name)) { preferredDay = num; break; } }
    const ns = await findAvailableSlots(leadData.urgency || "soon", 3, preferredDay);
    if (ns && ns.length) {
      leadData.available_slots = ns.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString() }));
      updateConversation(from, "selecting_slot", leadData);
      const dayName = preferredDay ? Object.keys(dayMap).find(k => dayMap[k] === preferredDay) : null;
      const r = dayName ? "Here are the " + dayName.charAt(0).toUpperCase() + dayName.slice(1) + " openings:\n\n" + formatSlotsForSMS(ns) + "\n\nWhich works best?" : "Here are some other openings:\n\n" + formatSlotsForSMS(ns) + "\n\nDo any of these work?";
      logMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_slot", qualified: true, leadData };
    } else {
      const dayName = preferredDay ? Object.keys(dayMap).find(k => dayMap[k] === preferredDay) : null;
      const r = dayName ? "Sorry, " + dayName.charAt(0).toUpperCase() + dayName.slice(1) + " is fully booked. Want me to check another day?" : "I'm not finding openings in that window. Want me to try a different day?";
      logMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_slot", qualified: true, leadData };
    }
  }

  if (idx >= 0 && idx < slots.length) {
    const recon = slots.map(s => ({ start: new Date(s.start), end: new Date(s.end), travelEnd: new Date(s.travelEnd) }));
    const result = await bookAssessment(leadData, idx, recon);
    if (result.success) {
      leadData.calendar_event_id = result.eventId; leadData.travel_event_id = result.travelEventId; leadData.assessment_time = result.startTime; delete leadData.available_slots;
      updateConversation(from, "assessment_booked", leadData); saveLead(from, leadData); syncLeadToHubSpot(from, leadData).catch(console.error);
      try { scheduleFollowUps(from, leadData); scheduleTextFollowUps(from, leadData); } catch(e) {}
      try { scheduleDayOfReminder(from, leadData, recon[idx].start.toISOString()); scheduleDayOfEmailReminder(from, leadData, recon[idx].start.toISOString()); } catch(e) {}
      const r = "You're all set!\n\nOur Executive Director, Matthew, will be there " + result.startTime + ".\n\nOur team will give you a quick call beforehand to confirm everything.\n\nIf you need anything before then, call 208-888-3611 or text here anytime. We look forward to meeting you!";
      logMessage(from, "assistant", r, null);
      return { text: r, stage: "assessment_booked", qualified: true, leadData };
    } else {
      const ns = await findAvailableSlots(leadData.urgency || "soon", 3);
      if (ns && ns.length) {
        leadData.available_slots = ns.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString() }));
        updateConversation(from, "selecting_slot", leadData);
        const r = "That time just got taken! Here are fresh openings:\n\n" + formatSlotsForSMS(ns) + "\n\nWhich works?";
        logMessage(from, "assistant", r, null);
        return { text: r, stage: "selecting_slot", qualified: true, leadData };
      }
      return moveToNurturing(from, leadData, "Our team will call you to schedule. Call 208-888-3611 anytime!");
    }
  }
  return handleGenericInStage(from, body, conversation, "selecting_slot");
}

// BOOKING DECLINE → NURTURING
async function handleBookingDecline(from, body, conversation) {
  const leadData = JSON.parse(conversation.lead_data || "{}");
  delete leadData.available_slots;
  const mh = buildMessageHistory(from);
  const ctx = buildStateContext(conversation, {}) + "\nThe lead just DECLINED booking. They said: \"" + body + "\"\nDO NOT offer time slots. Instead: 1) Acknowledge warmly 2) Share ONE thing that makes VA special (18 years, 90+ caregivers, best background checks) 3) End with: 'Whenever you are ready, just text this number and we will get it set up. Our office will also follow up within 24 hours. Do you have any questions about how our process works or what sets us apart?' Keep under 400 chars.";
  const aiReply = await callClaude(mh, ctx);
  const cleanReply = aiReply.replace(/\[\[LEAD_DATA:[^\]]+\]\]/g, "").replace(/\[\[QUALIFIED\]\]/g, "").trim();
  updateConversation(from, "nurturing", leadData); saveLead(from, leadData); syncLeadToHubSpot(from, leadData).catch(console.error);
  try { scheduleFollowUps(from, leadData); scheduleTextFollowUps(from, leadData); } catch(e) {}
  logMessage(from, "assistant", cleanReply, null);
  return { text: cleanReply, stage: "nurturing", qualified: true, leadData };
}

function moveToNurturing(from, leadData, message) {
  delete leadData.available_slots;
  updateConversation(from, "nurturing", leadData); saveLead(from, leadData); syncLeadToHubSpot(from, leadData).catch(console.error);
  try { scheduleFollowUps(from, leadData); scheduleTextFollowUps(from, leadData); } catch(e) {}
  logMessage(from, "assistant", message, null);
  return { text: message, stage: "nurturing", qualified: true, leadData };
}

// NURTURING — helpful, informative, no pushing
async function handleNurturing(from, body, conversation) {
  const leadData = JSON.parse(conversation.lead_data || "{}");
  const mh = buildMessageHistory(from);
  const sc = buildStateContext(conversation, {});
  const aiReply = await callClaude(mh, sc);
  const cleanReply = aiReply.replace(/\[\[LEAD_DATA:[^\]]+\]\]/g, "").replace(/\[\[QUALIFIED\]\]/g, "").trim();
  if (cleanReply.includes("I'm not sure") || cleanReply.includes("I don't have") || cleanReply.includes("would need to check") || cleanReply.includes("I'll have someone")) {
    flagUnknownQuestion(from, body, leadData);
  }
  logMessage(from, "assistant", cleanReply, null);
  return { text: cleanReply, stage: "nurturing", qualified: true, leadData };
}

async function reenterBookingFlow(from, body, conversation) {
  const leadData = JSON.parse(conversation.lead_data || "{}");
  try {
    const slots = await findAvailableSlots(leadData.urgency || "soon", 3);
    if (slots && slots.length > 0) {
      leadData.available_slots = slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString() }));
      updateConversation(from, "selecting_slot", leadData);
      const r = "Great! Let's get that set up. Here are the available times:\n\n" + formatSlotsForSMS(slots) + "\n\nWhich works best? Or name a day and I'll check!";
      logMessage(from, "assistant", r, null);
      return { text: r, stage: "selecting_slot", qualified: true, leadData };
    }
  } catch(e) {}
  const r = "I'd love to get that scheduled! Call our office at 208-888-3611 and they'll find a perfect time.";
  logMessage(from, "assistant", r, null);
  return { text: r, stage: "nurturing", qualified: true, leadData };
}

// POST-BOOKING — just answer questions
async function handlePostBooking(from, body, conversation) {
  const mh = buildMessageHistory(from);
  const sc = buildStateContext(conversation, {});
  const aiReply = await callClaude(mh, sc);
  const cleanReply = aiReply.replace(/\[\[LEAD_DATA:[^\]]+\]\]/g, "").replace(/\[\[QUALIFIED\]\]/g, "").trim();
  logMessage(from, "assistant", cleanReply, null);
  return { text: cleanReply, stage: "assessment_booked", qualified: true, leadData: JSON.parse(conversation.lead_data || "{}") };
}

async function handleGenericInStage(from, body, conversation, stage) {
  const leadData = JSON.parse(conversation.lead_data || "{}");
  const mh = buildMessageHistory(from);
  const sc = buildStateContext(conversation, {});
  const aiReply = await callClaude(mh, sc);
  const cleanReply = aiReply.replace(/\[\[LEAD_DATA:[^\]]+\]\]/g, "").replace(/\[\[QUALIFIED\]\]/g, "").trim();
  logMessage(from, "assistant", cleanReply, null);
  return { text: cleanReply, stage, qualified: true, leadData };
}

// CANCELLATION
async function handleCancellation(from, body, conversation) {
  const ld = JSON.parse(conversation.lead_data || "{}");
  if (ld.calendar_event_id) await cancelAssessment(ld.calendar_event_id, ld.travel_event_id);
  const r = "No problem at all! I've cancelled your assessment" + (ld.assessment_time ? " for " + ld.assessment_time : "") + ".\n\nWould you mind sharing what changed? It helps us improve. And if you'd like to reschedule, just text here anytime.\n\nYou can also call 208-888-3611 whenever you're ready.";
  delete ld.calendar_event_id; delete ld.travel_event_id; delete ld.assessment_time;
  updateConversation(from, "nurturing", ld);
  try { scheduleFollowUps(from, ld); scheduleTextFollowUps(from, ld); } catch(e) {}
  logMessage(from, "assistant", r, null);
  return { text: r, stage: "nurturing", qualified: true, leadData: ld };
}

// FLAG UNKNOWN QUESTIONS
function flagUnknownQuestion(from, question, leadData) {
  console.log("FLAG: Unknown question from " + leadData.name + ": " + question);
  const key = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_EMAIL_TO;
  if (!key || !to) return;
  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "VA SMS Alert <" + (process.env.EMAIL_FROM_ADDRESS || "care@boiseidahohomecare.com") + ">",
      to: to.split(",").map(e => e.trim()),
      subject: "HIGH PRIORITY: Unknown Question from " + (leadData.name || "Lead"),
      html: "<h2 style='color:#C0392B;'>Unknown Question Flagged</h2><p>A lead asked a question the AI could not answer confidently.</p><table style='border-collapse:collapse;width:100%;'><tr><td style='padding:8px;border:1px solid #ddd;font-weight:bold;'>Lead Name</td><td style='padding:8px;border:1px solid #ddd;'>" + (leadData.name || "Unknown") + "</td></tr><tr><td style='padding:8px;border:1px solid #ddd;font-weight:bold;'>Phone</td><td style='padding:8px;border:1px solid #ddd;'>" + from + "</td></tr><tr><td style='padding:8px;border:1px solid #ddd;font-weight:bold;'>Question</td><td style='padding:8px;border:1px solid #ddd;'>" + question + "</td></tr><tr><td style='padding:8px;border:1px solid #ddd;font-weight:bold;'>Care Type</td><td style='padding:8px;border:1px solid #ddd;'>" + (leadData.care_type || "N/A") + "</td></tr></table><p style='margin-top:16px;'><strong>Action:</strong> Consider adding this answer to the system prompt.</p>",
    }),
  }).catch(e => console.error("Flag email error:", e.message));
}

// DETECTION HELPERS
function isDecline(t) {
  const l = t.trim().toLowerCase();
  const patterns = ["no ","no,","no.","not now","not yet","not right now","not ready","need to talk","need to think","talk to","think about","hold off","let me think","i'll pass","maybe later","not interested","not sure","i don't know","gathering info","just looking","exploring","researching","not at this time","can't right now","family first","check with"];
  return l === "no" || patterns.some(p => l.includes(p));
}

function isSlotSelection(t) {
  const l = t.trim().toLowerCase();
  if (isDecline(l)) return false;
  return /^[1-3]$/.test(l) || l.includes("first one") || l.includes("second") || l.includes("third") ||
    (l.includes("1") && l.length < 15) || (l.includes("2") && l.length < 15) || (l.includes("3") && l.length < 15) ||
    l.includes("monday") || l.includes("tuesday") || l.includes("wednesday") || l.includes("thursday") || l.includes("friday") ||
    l.includes("next week") || l.includes("what about") || l.includes("do you have") || l.includes("any openings") ||
    l.includes("none") || l.includes("different") || l.includes("other day") || l.includes("another") ||
    l.includes("later in the week") || l.includes("later this week");
}

function wantsToBook(t) {
  const l = t.trim().toLowerCase();
  return l.includes("book") || l.includes("schedule") || l.includes("set up") || l.includes("ready to") || l.includes("let's do it") || l.includes("sign me up") || l.includes("available times") || l.includes("when can") || l.includes("what times") || l.includes("make an appointment");
}

function isCancellationRequest(t) { const l = t.toLowerCase(); return l.includes("cancel") || l.includes("can't make it") || l.includes("cant make it") || l.includes("need to reschedule") || l.includes("won't be able"); }
function isOptOut(m) { return ["stop","unsubscribe","quit","opt out","optout"].includes(m.trim().toLowerCase()); }
function handleOptOut(p) { db.prepare("UPDATE conversations SET stage='opted_out',updated_at=datetime('now') WHERE phone=?").run(p); return { text: "You've been unsubscribed. Text again or call (208) 888-3611 anytime. Take care!", stage: "opted_out", qualified: false, leadData: {} }; }

// CLAUDE API
async function callClaude(mh, sc) {
  try { const c = getClient(); const r = await c.messages.create({ model: "claude-sonnet-4-6", max_tokens: 500, system: SYSTEM_PROMPT + "\n\n" + sc, messages: mh }); return r.content[0].text; }
  catch(e) { console.error("Claude API error:", e.message); return "Thanks for your message! Call (208) 888-3611 for help."; }
}

function buildMessageHistory(phone) {
  const rows = db.prepare("SELECT role,content FROM messages WHERE phone=? ORDER BY created_at ASC LIMIT 30").all(phone);
  const m = []; for (const r of rows) { const l = m[m.length - 1]; if (l && l.role === r.role) l.content += "\n" + r.content; else m.push({ role: r.role, content: r.content }); }
  if (m.length > 0 && m[0].role === "assistant") m.shift(); return m;
}

function buildStateContext(conv, sentiment = {}) {
  const d = conv.lead_data ? JSON.parse(conv.lead_data) : {};
  return "\nCURRENT STATE: Stage=" + (conv.stage || "new_contact") + " Data=" + JSON.stringify(d) + " Messages=" + (conv.message_count || 0) + " Sentiment=" + (sentiment.summary || "N/A") +
    (sentiment.override ? "\nSENTIMENT OVERRIDE: Treat as IMMEDIATE urgency." : "") +
    "\nSTAGE INSTRUCTIONS: " + getStageInstructions(conv.stage, d) +
    "\nADDRESS REQUIREMENT: Must have house number + street name + city before scheduling. Accept partial — auto-add Idaho." +
    "\nFULL NAMES REQUIRED: Always get FIRST and LAST name for both contact and care recipient." +
    "\nFORMAT: Keep under 320 chars. Tag data at END: [[LEAD_DATA:field=value]]. Fields: relationship,contact_name,care_recipient_name,care_type,in_service_area,urgency,name,phone,email,insurance,referral_source,address. When qualified (full name+phone+valid address+NOT Medicaid+adult): [[QUALIFIED]]";
}

function getStageInstructions(s, d) {
  const i = {
    new_contact: "Greet warmly. Ask if care is for them or a loved one.",
    greeting: "Greet warmly. Ask if care is for them or a loved one.",
    needs: "Get BOTH FULL names (first AND last) for contact + recipient. Ask care type. For: " + (d.relationship || "someone"),
    location: "Care: " + (d.care_type || "TBD") + ". Ask Treasure Valley area. Confirm service area. Ask referral.",
    referral: "Ask referral source + insurance.",
    insurance: "Screen insurance. Medicaid=at capacity(2-1-1). Medicare=no coverage. VA/LTC/private=continue.",
    urgency: "Ask timeline. Get FULL street address (house# + street + city) for assessment.",
    capture_info: "Get remaining: FULL name, phone, email(optional), FULL ADDRESS (house# + street + city). Have: " + JSON.stringify(d),
    selecting_slot: "Slots offered. If they pick a number or ask for a day, system handles it. Answer questions. Do NOT re-offer time slots.",
    assessment_booked: "Booked: " + (d.assessment_time || "soon") + ". Answer questions. Coordinator will call. NEVER offer new times.",
    nurturing: "NURTURING MODE. Qualified but declined booking. Be helpful and informative, NOT pushy. Share what makes VA special (18 years, 90+ caregivers, 7-year background checks, licensed/bonded/insured). Ask if they have questions about: their care situation, how our process works, what sets us apart. End with 'text this number anytime to schedule.' NEVER offer time slots. Office follows up by phone within 24 hours.",
    cancelled: "Cancelled. Be warm. Ask feedback. Text anytime to reschedule.",
    complete: "Captured. Coordinator in touch. 208-888-3611.",
    out_of_area: "Outside area. visitingangels.com/office-locator.",
    medicaid_screened: "Medicaid at capacity. 2-1-1.",
    under_18: "Adults 18+ only.",
    job_inquiry: "visitingangels.com/boise/employment.",
  };
  return i[s] || "Guide toward qualification. Be warm.";
}

function parseAIResponse(ai, body, conv) {
  const ed = conv.lead_data ? JSON.parse(conv.lead_data) : {}; const nd = { ...ed }; let st = conv.stage || "greeting"; let q = false;
  const dp = /\[\[LEAD_DATA:(\w+)=([^\]]+)\]\]/g; let m;
  while ((m = dp.exec(ai)) !== null) { const [, f, v] = m; nd[f] = v.trim();
    if (f === "relationship" && st === "greeting") st = "needs";
    if (f === "care_type" && ["needs","greeting"].includes(st)) st = "location";
    if (f === "in_service_area") st = v.toLowerCase().includes("no") ? "out_of_area" : "referral";
    if (f === "referral_source" && st === "referral") st = "insurance";
    if (f === "insurance") st = v.toLowerCase().includes("medicaid") ? "medicaid_screened" : "urgency";
    if (f === "urgency" && st === "urgency") st = "capture_info";
    if (["name","contact_name","phone","email","address"].includes(f)) st = "capture_info";
  }
  if (ai.includes("[[QUALIFIED]]")) { q = true; st = "complete"; }
  if (nd.name && (nd.phone || nd.email) && nd.address && hasValidAddress(nd.address) && !q && !(nd.insurance || "").toLowerCase().includes("medicaid")) { q = true; st = "complete"; }
  return { text: ai.replace(/\[\[LEAD_DATA:[^\]]+\]\]/g, "").replace(/\[\[QUALIFIED\]\]/g, "").trim(), stage: st, qualified: q, leadData: nd };
}

// DATABASE
function getOrCreateConversation(p) { let c = db.prepare("SELECT * FROM conversations WHERE phone=?").get(p); if (!c) { db.prepare("INSERT INTO conversations(phone,stage,lead_data,message_count,created_at,updated_at) VALUES(?,'greeting','{}',0,datetime('now'),datetime('now'))").run(p); c = db.prepare("SELECT * FROM conversations WHERE phone=?").get(p); } if (c.stage === "opted_out") { db.prepare("UPDATE conversations SET stage='greeting',lead_data='{}',message_count=0,updated_at=datetime('now') WHERE phone=?").run(p); c = db.prepare("SELECT * FROM conversations WHERE phone=?").get(p); } return c; }
function updateConversation(p, s, ld) { db.prepare("UPDATE conversations SET stage=?,lead_data=?,message_count=message_count+2,updated_at=datetime('now') WHERE phone=?").run(s, JSON.stringify(ld), p); }
function logMessage(p, r, c, sid) { db.prepare("INSERT INTO messages(phone,role,content,message_sid,created_at) VALUES(?,?,?,?,datetime('now'))").run(p, r, c, sid); }
function saveLead(p, ld) { const e = db.prepare("SELECT * FROM leads WHERE phone=?").get(p); if (e) { db.prepare("UPDATE leads SET name=?,email=?,care_type=?,care_recipient_name=?,relationship=?,urgency=?,insurance_type=?,referral_source=?,in_service_area=?,qualified=1,updated_at=datetime('now') WHERE phone=?").run(ld.name,ld.email,ld.care_type,ld.care_recipient_name,ld.relationship,ld.urgency,ld.insurance,ld.referral_source,ld.in_service_area,p); } else { db.prepare("INSERT INTO leads(phone,name,email,care_type,care_recipient_name,relationship,urgency,insurance_type,referral_source,in_service_area,qualified,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))").run(p,ld.name,ld.email,ld.care_type,ld.care_recipient_name,ld.relationship,ld.urgency,ld.insurance,ld.referral_source,ld.in_service_area); } console.log("Lead saved: " + ld.name + " (" + p + ")"); }
