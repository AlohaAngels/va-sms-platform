// ============================================
// AI Email Follow-Ups — Personalized sequences
// ============================================
// Sends personalized follow-up emails to qualified leads
// using Claude to generate content based on their specific
// care needs, urgency, and conversation data.

import Anthropic from "@anthropic-ai/sdk";
import { db } from "./database.js";

const RESEND_API = "https://api.resend.com";

function getResendKey() {
  return process.env.RESEND_API_KEY || null;
}

function getFromEmail() {
  return process.env.EMAIL_FROM_ADDRESS || "care@boiseidahomecare.com";
}

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key.replace(/[\s"']/g, "") });
}

// ─── Send Email via Resend ───
async function sendEmail({ to, subject, html }) {
  const key = getResendKey();
  if (!key) {
    console.warn("⚠️  No RESEND_API_KEY — skipping email");
    return null;
  }

  try {
    const response = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Visiting Angels Boise <${getFromEmail()}>`,
        to: [to],
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Resend error:", err);
      return null;
    }

    const result = await response.json();
    console.log(`📧 Email sent to ${to}: "${subject}"`);
    return result;
  } catch (error) {
    console.error("Email send error:", error.message);
    return null;
  }
}

// ─── Generate Personalized Email with Claude ───
async function generateFollowUpEmail(leadData, emailType) {
  const client = getAnthropicClient();
  if (!client) return null;

  const prompts = {
    day1_thankyou: `Write a warm, personal thank-you email from Visiting Angels of Boise to a new lead. 
      Their name is ${leadData.name}. 
      They're looking for ${leadData.care_type || "in-home care"} for their ${leadData.relationship || "loved one"}${leadData.care_recipient_name ? ` (${leadData.care_recipient_name})` : ""}.
      ${leadData.urgency === "immediate" ? "They need care urgently." : leadData.urgency === "soon" ? "They're looking to start in the next 1-2 weeks." : "They're exploring their options."}
      ${leadData.insurance === "va_benefits" ? "They mentioned VA benefits — remind them we offer FREE VA Aid & Attendance benefit counseling." : ""}
      ${leadData.referral_source ? `They were referred by ${leadData.referral_source}.` : ""}
      
      The email should:
      - Thank them for reaching out
      - Briefly acknowledge their specific situation
      - Mention the FREE in-home assessment
      - Include our phone number: (208) 888-3611
      - Be warm but brief (under 200 words)
      - Sign off as "The Visiting Angels Team"
      - Do NOT include a subject line in the body`,

    day3_checkin: `Write a gentle check-in email from Visiting Angels of Boise to a lead we spoke with 3 days ago.
      Their name is ${leadData.name}.
      They need ${leadData.care_type || "in-home care"} for their ${leadData.relationship || "loved one"}.
      ${leadData.urgency === "immediate" ? "They mentioned urgency — check if they've found help yet." : ""}
      
      The email should:
      - Be warm and not pushy
      - Ask if they have any questions
      - Mention we're happy to schedule the free in-home assessment whenever they're ready
      - Include a specific benefit relevant to their care type
      - Be brief (under 150 words)
      - Sign off as "The Visiting Angels Team"`,

    day7_reminder: `Write a final gentle follow-up email from Visiting Angels of Boise. This is a week after initial contact.
      Their name is ${leadData.name}.
      They need ${leadData.care_type || "in-home care"}.
      
      The email should:
      - Be brief and respectful of their time
      - Mention one compelling fact about Visiting Angels (18 years in Treasure Valley, 90+ caregivers, best background checks in the business)
      - Offer the free in-home assessment one more time
      - Let them know they can reach us anytime at (208) 888-3611
      - Make it clear there's no pressure
      - Under 120 words
      - Sign off as "The Visiting Angels Team"`,
  };

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: "You are writing emails for Visiting Angels of Boise, a home care company in Meridian, Idaho. Write warm, professional emails. Output ONLY the email body in HTML format (use <p> tags, <br> for breaks). No subject line in the body. No markdown.",
      messages: [{ role: "user", content: prompts[emailType] }],
    });

    return response.content[0].text;
  } catch (error) {
    console.error("Email generation error:", error.message);
    return null;
  }
}

// ─── Generate Subject Line ───
async function generateSubjectLine(leadData, emailType) {
  const client = getAnthropicClient();
  if (!client) return getDefaultSubject(emailType, leadData);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 60,
      system: "Generate a short, warm email subject line. Output ONLY the subject line, nothing else. No quotes.",
      messages: [{
        role: "user",
        content: `Email subject for a ${emailType === "day1_thankyou" ? "thank you" : emailType === "day3_checkin" ? "3-day check-in" : "1-week gentle follow-up"} email to ${leadData.name} about ${leadData.care_type || "in-home care"} services from Visiting Angels. Keep it personal and warm, under 8 words.`
      }],
    });

    return response.content[0].text.trim();
  } catch {
    return getDefaultSubject(emailType, leadData);
  }
}

function getDefaultSubject(emailType, leadData) {
  const name = (leadData.name || "").split(" ")[0] || "there";
  switch (emailType) {
    case "day1_thankyou": return `Thanks for reaching out, ${name}!`;
    case "day3_checkin": return `Checking in, ${name}`;
    case "day7_reminder": return `We're here when you're ready, ${name}`;
    default: return `A message from Visiting Angels`;
  }
}

// ─── Email Template Wrapper ───
function wrapInTemplate(bodyHtml, leadName) {
  return `
<!DOCTYPE html>
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
    <hr style="border:none;border-top:1px solid #e8e4df;margin:24px 0;">
    <p style="font-size:13px;color:#888;line-height:1.5;">
      Visiting Angels of Boise<br>
      36 E. Pine Ave, Meridian, ID 83642<br>
      <a href="tel:2088883611" style="color:#1a2744;">(208) 888-3611</a> &bull; 
      <a href="https://www.visitingangels.com/boise/home" style="color:#1a2744;">visitingangels.com/boise</a>
    </p>
    <p style="font-size:11px;color:#aaa;margin-top:12px;">
      You received this email because you contacted Visiting Angels about in-home care services.
      If you'd like to stop receiving these emails, simply reply "unsubscribe."
    </p>
  </div>
</div>
</body>
</html>`;
}

// ─── Schedule Follow-Up Emails for a Lead ───
export function scheduleFollowUps(phone, leadData) {
  if (!leadData.email) {
    console.log(`📧 No email for ${leadData.name} — skipping follow-up emails`);
    return;
  }

  // Insert follow-up schedule into database
  const emails = [
    { type: "day1_thankyou", delay_hours: 1 },    // 1 hour after qualification
    { type: "day3_checkin", delay_hours: 72 },     // 3 days later
    { type: "day7_reminder", delay_hours: 168 },   // 7 days later
  ];

  for (const email of emails) {
    const sendAt = new Date(Date.now() + email.delay_hours * 60 * 60 * 1000).toISOString();

    try {
      db.prepare(`
        INSERT OR IGNORE INTO email_queue (phone, email_type, send_at, status, lead_data, created_at)
        VALUES (?, ?, ?, 'pending', ?, datetime('now'))
      `).run(phone, email.type, sendAt, JSON.stringify(leadData));
    } catch (e) {
      // Ignore duplicates
    }
  }

  console.log(`📧 Scheduled 3 follow-up emails for ${leadData.name} (${leadData.email})`);
}

// ─── Process Email Queue ───
// Called every 5 minutes by the scheduler in server.js
export async function processEmailQueue() {
  const key = getResendKey();
  if (!key) return;

  const now = new Date().toISOString();
  const pendingEmails = db.prepare(`
    SELECT * FROM email_queue 
    WHERE status = 'pending' AND send_at <= ?
    ORDER BY send_at ASC
    LIMIT 5
  `).all(now);

  for (const item of pendingEmails) {
    try {
      const leadData = JSON.parse(item.lead_data);

      // Check if lead has unsubscribed
      const lead = db.prepare("SELECT * FROM leads WHERE phone = ?").get(item.phone);
      if (lead && lead.email_unsubscribed) {
        db.prepare("UPDATE email_queue SET status = 'cancelled' WHERE id = ?").run(item.id);
        continue;
      }

      // Generate personalized email content
      const bodyHtml = await generateFollowUpEmail(leadData, item.email_type);
      if (!bodyHtml) {
        db.prepare("UPDATE email_queue SET status = 'failed', error = 'AI generation failed' WHERE id = ?").run(item.id);
        continue;
      }

      // Generate subject line
      const subject = await generateSubjectLine(leadData, item.email_type);

      // Wrap in template and send
      const fullHtml = wrapInTemplate(bodyHtml, leadData.name);
      const result = await sendEmail({
        to: leadData.email,
        subject,
        html: fullHtml,
      });

      if (result) {
        db.prepare("UPDATE email_queue SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(item.id);
      } else {
        db.prepare("UPDATE email_queue SET status = 'failed', error = 'Send failed' WHERE id = ?").run(item.id);
      }

      // Small delay between emails to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      console.error(`Email queue error for ${item.phone}:`, error.message);
      db.prepare("UPDATE email_queue SET status = 'failed', error = ? WHERE id = ?").run(error.message, item.id);
    }
  }

  if (pendingEmails.length > 0) {
    console.log(`📧 Processed ${pendingEmails.length} queued emails`);
  }
}

// ─── Cancel Follow-Ups (if lead becomes a client, etc.) ───
export function cancelFollowUps(phone) {
  db.prepare("UPDATE email_queue SET status = 'cancelled' WHERE phone = ? AND status = 'pending'").run(phone);
  console.log(`📧 Cancelled pending follow-ups for ${phone}`);
}
