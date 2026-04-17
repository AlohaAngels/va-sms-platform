// ============================================
// Email Follow-Ups v3 — Matthew's Exact Cadence
// Booked: confirm (2-3min) + day-of (2hr before)
// Not Booked: 10min, 2d, 5d, 15d, 21d, 30d
// Email window: 8:30-11am MST (except immediate)
// ============================================
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./database.js";

const RESEND_API = "https://api.resend.com";
function getResendKey() { return process.env.RESEND_API_KEY || null; }
function getFromEmail() { return process.env.EMAIL_FROM_ADDRESS || "care@boiseidahohomecare.com"; }
function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key.replace(/[\s"']/g, "") });
}

// ─── Time Window: Next valid email slot (8:30-11am MST) ───
function nextEmailWindow(baseDate) {
  const d = new Date(baseDate);
  const mstStr = d.toLocaleString("en-US", { timeZone: "America/Boise", hour12: false });
  const parts = mstStr.split(", ")[1].split(":");
  const hour = parseInt(parts[0]);
  const min = parseInt(parts[1]);

  if (hour >= 8 && (hour < 11 || (hour === 8 && min >= 30))) return d; // In window
  // Outside window — push to next morning 9am MST
  if (hour >= 11) d.setDate(d.getDate() + 1); // Already past 11am, go to tomorrow
  // Set to ~9am MST (15:00 UTC during MDT, 16:00 UTC during MST)
  const target = new Date(d.toLocaleDateString("en-US") + " 15:00:00 UTC");
  return target;
}

// ─── Send Email via Resend ───
async function sendEmail({ to, subject, html }) {
  const key = getResendKey();
  if (!key) { console.warn("No RESEND_API_KEY — skipping email"); return null; }
  try {
    const response = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `Visiting Angels Boise <${getFromEmail()}>`, to: [to], subject, html }),
    });
    if (!response.ok) { console.error("Resend error:", await response.text()); return null; }
    const result = await response.json();
    console.log(`📧 Email sent to ${to}: "${subject}"`);
    return result;
  } catch (e) { console.error("Email error:", e.message); return null; }
}

// ─── Generate Email Body with Claude ───
async function generateEmailBody(leadData, emailType) {
  const client = getAnthropicClient();
  if (!client) return null;

  const name = leadData.name || "there";
  const firstName = name.split(" ")[0];
  const cr = leadData.care_recipient_name || "your loved one";
  const ct = leadData.care_type || "in-home care";
  const rel = leadData.relationship || "loved one";
  const sentiment = leadData.sentiment || "";
  const referral = leadData.referral_source || "";
  const urgency = leadData.urgency || "soon";
  const convo = sentiment ? `Conversation context: ${sentiment}.` : "";
  const refNote = referral ? `Referred by: ${referral}.` : "";

  const systemMsg = `You write emails for Visiting Angels of Boise (Meridian, Idaho). Rules:
- Output ONLY the email body in HTML (<p>, <br>, <strong>, <em> tags)
- No subject line in the body. No markdown. No DOCTYPE.
- ALWAYS reference something specific from their conversation ("Based on what you mentioned about...")
- ALWAYS add genuine value — a tip, fact, or answer
- Warm, personal, professional. Under the word count specified.
- Sign off as "The Visiting Angels Team"
- Never say "just following up" without value`;

  const prompts = {
    // ═══ BOOKED ═══
    booked_confirm: `Warm confirmation email to ${name}. They booked a free in-home assessment with Executive Director Matthew S. Croft for ${leadData.assessment_time} at ${leadData.address || "their home"}. Care: ${ct} for ${rel} ${cr}. ${convo} ${refNote}
Include: booking details (time, location), that our team will call beforehand to confirm, reschedule by replying to this email or calling (208) 888-3611, and something warm about their specific care needs. Under 200 words.`,

    booked_dayof: `Day-of reminder email to ${name}. Assessment with Matthew S. Croft is TODAY at ${leadData.assessment_time} at ${leadData.address || "their home"}. Care: ${ct} for ${cr}. ${convo}
Express excitement about meeting them. Include: time, location, call (208) 888-3611 for questions or reschedule. Mention what to expect during the assessment (about 2 hours, no obligation, Matthew will learn about their needs and create a custom care plan). Under 180 words.`,

    // ═══ NOT BOOKED ═══
    nb_10min: `Thank-you email to ${name} who just asked about ${ct} for ${rel} ${cr}. ${convo} ${refNote} Urgency: ${urgency}.
Recap their key concern from the conversation ("Based on what you shared about..."). Thank them, acknowledge their situation, mention the FREE in-home assessment. Include (208) 888-3611. Under 200 words.`,

    nb_day2: `Day 2 follow-up to ${name} about ${ct} for ${cr}. ${convo} ${refNote}
Share ONE genuinely useful tip or answer a common question for their specific care type. NOT a sales pitch — real value. Then softly offer the free assessment. Under 180 words.
Ideas by care type: memory care → sundowning tips, caregiver burnout stats. Post-surgery → fall prevention, medication management. Companion care → isolation health risks. Personal care → dignity-preserving techniques.`,

    nb_day5: `Day 5 deeper-value email to ${name} about ${ct} for ${cr}. ${convo}
Share compelling proof: 18 years in Treasure Valley, 90+ caregivers, nationwide 7-year background checks (most companies do 3), licensed/bonded/insured, part of America's largest home care network. Address a common FAQ or objection related to ${ct}. Include assessment offer. Under 220 words.`,

    nb_day15: `Day 15 social proof email to ${name}. They asked about ${ct} for ${cr}. ${convo}
Share a brief, anonymous case study relevant to their situation (don't use real names). Example: "A family in Eagle reached out about memory care for their mother. Within 48 hours, we matched them with a caregiver who had 5 years of Alzheimer's experience. Six months later, the family says it was the best decision they made." Adapt the story to match ${ct}. Under 200 words.`,

    nb_day21: `Day 21 re-engagement email to ${name} from a FRESH ANGLE. ${ct} for ${cr}. ${convo}
Try something different: seasonal relevance, mention free VA benefit counseling, a new perspective on their situation, or address an objection they might have. DON'T repeat earlier emails. Under 180 words.`,

    nb_day30: `Final graceful closing email to ${name}. Last follow-up about ${ct} for ${cr}. ${convo}
Ask warmly what we could have done better to help solve their situation. Genuinely ask for feedback — it helps us improve. Door always open: (208) 888-3611 or reply anytime. Wish them well. Under 180 words.`,
  };

  const prompt = prompts[emailType];
  if (!prompt) return null;
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 600, system: systemMsg,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].text.trim();
  } catch (e) { console.error("Email gen error:", e.message); return null; }
}

// ─── Generate Subject Line ───
async function generateSubjectLine(leadData, emailType) {
  const client = getAnthropicClient();
  if (!client) return getDefaultSubject(emailType, leadData);
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 60,
      system: "Write ONLY an email subject line. Under 8 words. Personal, warm. No quotes.",
      messages: [{ role: "user", content: `Subject for a ${emailType.replace(/_/g, " ")} email to ${leadData.name} about ${leadData.care_type || "in-home care"} from Visiting Angels.` }],
    });
    return response.content[0].text.trim();
  } catch (e) { return getDefaultSubject(emailType, leadData); }
}

function getDefaultSubject(emailType, ld) {
  const name = (ld.name || "").split(" ")[0];
  const subjects = {
    booked_confirm: `You're confirmed, ${name}!`,
    booked_dayof: `See you today, ${name}!`,
    nb_10min: `Thanks for reaching out, ${name}`,
    nb_day2: `A quick tip for you, ${name}`,
    nb_day5: `Why families trust us, ${name}`,
    nb_day15: `A story we thought you'd appreciate`,
    nb_day21: `Something new for you, ${name}`,
    nb_day30: `One last note, ${name}`,
  };
  return subjects[emailType] || `A message from Visiting Angels`;
}

// ─── Email Template Wrapper ───
function wrapInTemplate(bodyHtml) {
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER || "+12084605111";
  const displaySms = twilioNumber.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:20px;">
  <div style="background:#1a2744;padding:20px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;font-family:Georgia,serif;font-size:20px;margin:0;">Visiting Angels</h1>
    <p style="color:#c5a45a;font-size:13px;margin:4px 0 0;">of Boise &bull; In-Home Care</p>
  </div>
  <div style="background:#ffffff;padding:28px 24px;border-radius:0 0 12px 12px;">
    ${bodyHtml}

    <div style="background:#f5eed9;border-radius:8px;padding:20px;margin:24px 0;text-align:center;">
      <p style="font-size:15px;color:#1a2744;font-weight:bold;margin:0 0 12px;">Ready to schedule your free assessment?</p>
      <p style="font-size:13px;color:#4a4a4a;margin:0 0 8px;">
        <strong>Text us:</strong> <a href="sms:${twilioNumber}" style="color:#1a2744;text-decoration:underline;">${displaySms}</a> — we'll find times that work for you
      </p>
      <p style="font-size:13px;color:#4a4a4a;margin:0;">
        <strong>Call us:</strong> <a href="tel:2088883611" style="color:#1a2744;text-decoration:underline;font-size:15px;font-weight:bold;">(208) 888-3611</a> — talk to our team directly
      </p>
      <p style="font-size:11px;color:#888;margin:10px 0 0;">We can answer any questions and get your free in-home assessment set up.</p>
    </div>

    <hr style="border:none;border-top:1px solid #e8e4df;margin:24px 0;">
    <p style="font-size:13px;color:#888;line-height:1.5;">
      Visiting Angels of Boise<br>
      36 E. Pine Ave, Meridian, ID 83642<br>
      <a href="tel:2088883611" style="color:#1a2744;">(208) 888-3611</a> &bull;
      <a href="https://www.visitingangels.com/boise/home" style="color:#1a2744;">visitingangels.com/boise</a>
    </p>
    <p style="font-size:11px;color:#aaa;margin-top:12px;">
      You received this email because you contacted Visiting Angels about in-home care services.
      To stop receiving these emails, simply reply "unsubscribe."
    </p>
  </div>
</div>
</body>
</html>`;
}

// ─── Schedule Follow-Up Emails ───
export function scheduleFollowUps(phone, leadData) {
  if (!leadData.email) {
    console.log(`📧 No email for ${leadData.name} — skipping email follow-ups`);
    return;
  }

  const isBooked = !!leadData.assessment_time;
  const now = Date.now();
  let emails;

  if (isBooked) {
    // ═══ BOOKED SEQUENCE ═══
    emails = [
      { type: "booked_confirm", delay_min: 3 },    // 2-3 min after booking
    ];
    // Day-of email reminder scheduled separately via scheduleDayOfEmailReminder()
  } else {
    // ═══ NOT BOOKED SEQUENCE ═══
    emails = [
      { type: "nb_10min", delay_min: 10 },             // 10 minutes
      { type: "nb_day2", delay_hours: 48 },              // Day 2
      { type: "nb_day5", delay_hours: 120 },             // Day 5
      { type: "nb_day15", delay_hours: 360 },            // Day 15 (email only)
      { type: "nb_day21", delay_hours: 504 },            // Day 21
      { type: "nb_day30", delay_hours: 720 },            // Day 30
    ];
  }

  for (const email of emails) {
    const delayMs = email.delay_min ? email.delay_min * 60000 : email.delay_hours * 3600000;
    let sendAt = new Date(now + delayMs);
    // Apply email window (8:30-11am MST) except for immediate confirmations
    if (!email.delay_min || email.delay_min > 15) sendAt = nextEmailWindow(sendAt);
    try {
      db.prepare("INSERT OR IGNORE INTO email_queue (phone,email_type,send_at,status,lead_data,created_at) VALUES (?,?,?,'pending',?,datetime('now'))")
        .run(phone, email.type, sendAt.toISOString(), JSON.stringify(leadData));
    } catch (e) { /* ignore dupes */ }
  }
  console.log(`📧 Scheduled ${emails.length} emails for ${leadData.name} [${isBooked ? "BOOKED" : "NOT BOOKED"}]`);
}

// ─── Schedule Day-Of Email Reminder (2 hours before) ───
export function scheduleDayOfEmailReminder(phone, leadData, assessmentStartISO) {
  if (!phone || !assessmentStartISO || !leadData.email) return;
  const reminderTime = new Date(new Date(assessmentStartISO).getTime() - 2 * 3600000);
  if (reminderTime <= new Date()) return;
  try {
    db.prepare("INSERT OR IGNORE INTO email_queue (phone,email_type,send_at,status,lead_data,created_at) VALUES (?,'booked_dayof',?,'pending',?,datetime('now'))")
      .run(phone, reminderTime.toISOString(), JSON.stringify(leadData));
    console.log(`📧 Day-of email reminder scheduled for ${leadData.name}`);
  } catch (e) { /* ignore dupes */ }
}

// ─── Process Email Queue ───
export async function processEmailQueue() {
  const key = getResendKey();
  if (!key) return;
  const now = new Date().toISOString();
  const pending = db.prepare("SELECT * FROM email_queue WHERE status='pending' AND send_at<=? ORDER BY send_at ASC LIMIT 5").all(now);

  for (const item of pending) {
    try {
      const leadData = JSON.parse(item.lead_data);

      // Check unsubscribe
      const lead = db.prepare("SELECT * FROM leads WHERE phone=?").get(item.phone);
      if (lead && lead.email_unsubscribed) { db.prepare("UPDATE email_queue SET status='cancelled' WHERE id=?").run(item.id); continue; }

      // Check if booked (skip not-booked nudges)
      const conv = db.prepare("SELECT * FROM conversations WHERE phone=?").get(item.phone);
      if (conv && conv.stage === "assessment_booked" && ["nb_day2", "nb_day5", "nb_day15", "nb_day21"].includes(item.email_type)) {
        db.prepare("UPDATE email_queue SET status='cancelled' WHERE id=?").run(item.id); continue;
      }

      // Generate content
      const bodyHtml = await generateEmailBody(leadData, item.email_type);
      if (!bodyHtml) { db.prepare("UPDATE email_queue SET status='failed',error='AI gen failed' WHERE id=?").run(item.id); continue; }

      const subject = await generateSubjectLine(leadData, item.email_type);
      const fullHtml = wrapInTemplate(bodyHtml);
      const result = await sendEmail({ to: leadData.email, subject, html: fullHtml });

      if (result) db.prepare("UPDATE email_queue SET status='sent',sent_at=datetime('now') WHERE id=?").run(item.id);
      else db.prepare("UPDATE email_queue SET status='failed',error='Send failed' WHERE id=?").run(item.id);

      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`Email queue error ${item.phone}:`, e.message);
      db.prepare("UPDATE email_queue SET status='failed',error=? WHERE id=?").run(e.message, item.id);
    }
  }
  if (pending.length > 0) console.log(`📧 Processed ${pending.length} queued emails`);
}

// ─── Cancel Pending Emails ───
export function cancelFollowUps(phone) {
  db.prepare("UPDATE email_queue SET status='cancelled' WHERE phone=? AND status='pending'").run(phone);
}
