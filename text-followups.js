// ============================================
// Text Follow-Ups v3 — Matthew's Exact Cadence
// Booked: confirm (2-3min) + day-of reminder (2hr before)
// Not Booked: 10min, 2d, 5d, 9d, 21d, 30d
// SMS window: 9am-7pm MST
// ============================================
import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { db } from "./database.js";

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key.replace(/[\s"']/g, "") });
}

// ─── Time Window: Next valid SMS slot (9am-7pm MST) ───
function nextSMSWindow(baseDate) {
  const d = new Date(baseDate);
  const mstStr = d.toLocaleString("en-US", { timeZone: "America/Boise", hour12: false });
  const hour = parseInt(mstStr.split(", ")[1].split(":")[0]);

  if (hour >= 9 && hour < 19) return d; // In window
  if (hour >= 19) {
    // Past 7pm — push to next day 2pm MST
    d.setDate(d.getDate() + 1);
    const next = new Date(d.toLocaleDateString("en-US", { timeZone: "America/Boise" }) + " 14:00:00");
    return new Date(next.getTime() + 6 * 60 * 60 * 1000); // approx UTC offset
  }
  // Before 9am — push to 10am MST today
  const today = new Date(d.toLocaleDateString("en-US", { timeZone: "America/Boise" }) + " 10:00:00");
  return new Date(today.getTime() + 6 * 60 * 60 * 1000);
}

// ─── Generate Personalized Text with Claude ───
async function generateText(leadData, textType) {
  const client = getAnthropicClient();
  if (!client) return null;

  const name = (leadData.name || "").split(" ")[0] || "there";
  const careRecipient = leadData.care_recipient_name || "your loved one";
  const careType = leadData.care_type || "in-home care";
  const sentiment = leadData.sentiment || "";
  const referral = leadData.referral_source || "";
  const convoContext = sentiment ? `During the conversation, the following was noted: ${sentiment}.` : "";

  const systemMsg = `You write SMS texts for Visiting Angels of Boise (Meridian, Idaho). Rules:
- Write ONLY the text — no quotes, no labels, no preamble
- Natural, like a real person texting. 1 emoji max.
- ALWAYS reference something specific from their conversation ("Based on what you mentioned about...")
- ALWAYS end with: Reply STOP to unsubscribe
- Keep under the character limit specified
- Never say "just following up" without adding value
- Book link = "Reply here to schedule" or "Call 208-888-3611"
- No hashtags ever`;

  const prompts = {
    // ═══ BOOKED ═══
    booked_confirm: `Warm confirmation text to ${name}. They booked a free in-home assessment with Executive Director Matthew S. Croft for ${leadData.assessment_time}. Location: ${leadData.address || "on file"}. Care type: ${careType} for ${careRecipient}. ${convoContext} Include: booking details, that our team will call beforehand to confirm, and to reschedule just reply here or call 208-888-3611. Under 450 chars.`,

    booked_dayof: `Day-of reminder text to ${name}. Their assessment with Executive Director Matthew S. Croft is TODAY at ${leadData.assessment_time} at ${leadData.address || "the address on file"}. Care: ${careType} for ${careRecipient}. Thank them, express excitement about meeting them. Include: call 208-888-3611 for questions or to reschedule. Under 380 chars.`,

    // ═══ NOT BOOKED ═══
    nb_10min: `Thank-you text to ${name} who just asked about ${careType} for ${careRecipient}. ${convoContext} ${referral ? "They were referred by " + referral + "." : ""} Recap their key concern ("Based on what you mentioned about..."). Offer to schedule a free assessment — reply here to book or call 208-888-3611. Under 450 chars.`,

    nb_day2: `Day 2 follow-up to ${name} about ${careType} for ${careRecipient}. ${convoContext} Share ONE genuinely useful tip relevant to their care type. NOT sales — something they'd thank you for. Then softly offer scheduling. Under 380 chars. For memory care: mention sundowning tips or Alzheimer's Association. For post-surgery: fall prevention or that we start in 24hrs. For companion care: isolation prevention stats.`,

    nb_day5: `Day 5 deeper value text to ${name} about ${careType} for ${careRecipient}. ${convoContext} Share proof/FAQ: we've served Treasure Valley 18 years, 90+ caregivers, nationwide 7-year background checks (most Idaho companies only do 3), licensed/bonded/insured. Address a common concern related to their care type. Include booking offer. Under 420 chars.`,

    nb_day9: `Day 9 stronger check-in text to ${name}. They asked about ${careType} for ${careRecipient}. ${convoContext} Be direct but warm: "I want to make sure you're getting the help you need." Ask what's holding them back. Offer to answer ONE question. Include call 208-888-3611 or reply here. Under 320 chars.`,

    nb_day21: `Day 21 re-engagement text to ${name} from a FRESH ANGLE. They asked about ${careType} for ${careRecipient} weeks ago. ${convoContext} Try something different — mention a seasonal tip, free VA benefit counseling, or ask a question they haven't been asked. DON'T repeat earlier messaging. Under 320 chars.`,

    nb_day30: `Final graceful closing text to ${name}. Last follow-up about ${careType} for ${careRecipient}. ${convoContext} Ask warmly what we could have done better to help solve their situation. Door always open — text this number or call 208-888-3611 anytime. Under 380 chars.`,
  };

  const prompt = prompts[textType];
  if (!prompt) return null;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 250,
      system: systemMsg,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].text.trim();
  } catch (error) {
    console.error("Text generation error:", error.message);
    return null;
  }
}

// ─── Default Texts (fallback) ───
function getDefaultText(textType, ld) {
  const name = (ld.name || "").split(" ")[0] || "there";
  const cr = ld.care_recipient_name || "your loved one";
  const ct = ld.care_type || "in-home care";
  const defaults = {
    booked_confirm: `Hi ${name}! You're confirmed — Matthew S. Croft will be at ${ld.address || "your home"} on ${ld.assessment_time} for your free assessment. Our team will call beforehand to confirm. Need to reschedule? Reply here or call 208-888-3611. We look forward to meeting you! 😊\n\nReply STOP to unsubscribe`,
    booked_dayof: `Hi ${name}! Reminder: Matthew S. Croft will be at ${ld.address || "your home"} today at ${ld.assessment_time}. We're excited to meet you and talk about the best care for ${cr}. Questions? Call 208-888-3611. See you soon! 😊\n\nReply STOP to unsubscribe`,
    nb_10min: `Hi ${name}! Thanks for reaching out about ${ct} for ${cr}. Based on what you shared, I think we can really help. Want to schedule a free in-home assessment? Reply here to find a time or call 208-888-3611!\n\nReply STOP to unsubscribe`,
    nb_day2: `Hi ${name}, quick tip for ${ct}: always ask any Idaho home care company about their background check process. We do nationwide 7-year checks — most only go back 3. Happy to answer any questions! Reply here or call 208-888-3611.\n\nReply STOP to unsubscribe`,
    nb_day5: `Hi ${name}, Visiting Angels has served the Treasure Valley for 18 years with 90+ caregivers. We're licensed, bonded, and insured with the best background checks in Idaho. A free assessment could answer all your questions about ${ct}. Reply to schedule!\n\nReply STOP to unsubscribe`,
    nb_day9: `Hi ${name}, I want to make sure you're getting the help you need for ${cr}. Is anything holding you back? I'm happy to answer any question — just reply here or call 208-888-3611.\n\nReply STOP to unsubscribe`,
    nb_day21: `Hi ${name}, did you know we offer free VA benefit counseling for veterans and their families? If that's helpful for ${cr}'s situation, we'd love to assist. Either way, we're here. Reply anytime or call 208-888-3611. 💛\n\nReply STOP to unsubscribe`,
    nb_day30: `Hi ${name}, this is our last check-in about care for ${cr}. We'd love to know — was there anything we could have done better? Your feedback truly helps. If your needs ever change, text this number or call 208-888-3611 anytime. Wishing you all the best. 💛\n\nReply STOP to unsubscribe`,
  };
  return defaults[textType] || `Hi ${name}, reaching out from Visiting Angels. Call 208-888-3611 anytime!\n\nReply STOP to unsubscribe`;
}

// ─── Send Text ───
async function sendText(to, body) {
  const client = getTwilioClient();
  if (!client) return null;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) return null;
  try {
    const msg = await client.messages.create({ body, from, to });
    console.log(`💬 Text sent to ${to}: ${msg.sid}`);
    return msg;
  } catch (e) { console.error(`Text error ${to}:`, e.message); return null; }
}

// ─── Schedule Text Follow-Ups ───
export function scheduleTextFollowUps(phone, leadData) {
  if (!phone) return;
  const isBooked = !!leadData.assessment_time;
  const now = Date.now();
  let texts;

  if (isBooked) {
    texts = [
      { type: "booked_confirm", delay_min: 3 },  // 2-3 min after booking
    ];
    // Day-of reminder scheduled separately via scheduleDayOfReminder()
  } else {
    texts = [
      { type: "nb_10min", delay_min: 10 },           // 10 minutes
      { type: "nb_day2", delay_hours: 48 },            // Day 2
      { type: "nb_day5", delay_hours: 120 },           // Day 5
      { type: "nb_day9", delay_hours: 216 },           // Day 9
      { type: "nb_day21", delay_hours: 504 },          // Day 21
      { type: "nb_day30", delay_hours: 720 },          // Day 30
    ];
  }

  for (const t of texts) {
    const delayMs = t.delay_min ? t.delay_min * 60000 : t.delay_hours * 3600000;
    let sendAt = new Date(now + delayMs);
    // Apply SMS window (9am-7pm MST) except for immediate confirmations (<15 min)
    if (!t.delay_min || t.delay_min > 15) sendAt = nextSMSWindow(sendAt);
    try {
      db.prepare("INSERT OR IGNORE INTO text_queue (phone,text_type,send_at,status,lead_data,created_at) VALUES (?,?,?,'pending',?,datetime('now'))")
        .run(phone, t.type, sendAt.toISOString(), JSON.stringify(leadData));
    } catch (e) { /* ignore dupes */ }
  }
  console.log(`💬 Scheduled ${texts.length} texts for ${leadData.name} [${isBooked ? "BOOKED" : "NOT BOOKED"}]`);
}

// ─── Schedule Day-Of Reminder (2 hours before assessment) ───
export function scheduleDayOfReminder(phone, leadData, assessmentStartISO) {
  if (!phone || !assessmentStartISO) return;
  const reminderTime = new Date(new Date(assessmentStartISO).getTime() - 2 * 3600000);
  if (reminderTime <= new Date()) return;
  try {
    db.prepare("INSERT OR IGNORE INTO text_queue (phone,text_type,send_at,status,lead_data,created_at) VALUES (?,'booked_dayof',?,'pending',?,datetime('now'))")
      .run(phone, reminderTime.toISOString(), JSON.stringify(leadData));
    console.log(`💬 Day-of text reminder scheduled for ${leadData.name} at ${reminderTime.toISOString()}`);
  } catch (e) { /* ignore dupes */ }
}

// ─── Process Text Queue ───
export async function processTextQueue() {
  const client = getTwilioClient();
  if (!client) return;
  const now = new Date().toISOString();
  const pending = db.prepare("SELECT * FROM text_queue WHERE status='pending' AND send_at<=? ORDER BY send_at ASC LIMIT 5").all(now);

  for (const item of pending) {
    try {
      const leadData = JSON.parse(item.lead_data);
      const conv = db.prepare("SELECT * FROM conversations WHERE phone=?").get(item.phone);

      // Skip if opted out
      if (conv && conv.stage === "opted_out") { db.prepare("UPDATE text_queue SET status='cancelled' WHERE id=?").run(item.id); continue; }

      // Skip nudges if they booked
      if (conv && conv.stage === "assessment_booked" && ["nb_day2", "nb_day5", "nb_day9", "nb_day21"].includes(item.text_type)) {
        db.prepare("UPDATE text_queue SET status='cancelled' WHERE id=?").run(item.id); continue;
      }

      // Skip if they replied recently (24hr) for nudge texts
      if (["nb_day2", "nb_day5", "nb_day9", "nb_day21"].includes(item.text_type)) {
        const recent = db.prepare("SELECT * FROM messages WHERE phone=? AND role='user' AND created_at>datetime('now','-24 hours') LIMIT 1").get(item.phone);
        if (recent) { db.prepare("UPDATE text_queue SET status='skipped' WHERE id=?").run(item.id); continue; }
      }

      let body = await generateText(leadData, item.text_type);
      if (!body) body = getDefaultText(item.text_type, leadData);
      if (!body.includes("STOP")) body += "\n\nReply STOP to unsubscribe";

      const result = await sendText(item.phone, body);
      if (result) db.prepare("UPDATE text_queue SET status='sent',sent_at=datetime('now') WHERE id=?").run(item.id);
      else db.prepare("UPDATE text_queue SET status='failed',error='Send failed' WHERE id=?").run(item.id);

      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`Text queue error ${item.phone}:`, e.message);
      db.prepare("UPDATE text_queue SET status='failed',error=? WHERE id=?").run(e.message, item.id);
    }
  }
  if (pending.length > 0) console.log(`💬 Processed ${pending.length} queued texts`);
}

// ─── Cancel Pending Texts ───
export function cancelTextFollowUps(phone) {
  db.prepare("UPDATE text_queue SET status='cancelled' WHERE phone=? AND status='pending'").run(phone);
}
