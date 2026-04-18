// ============================================
// Weekly Report — Monday morning email summary
// ============================================
// Runs every Monday at 7am MT and sends a formatted
// report to the management team showing the week's
// lead activity, conversion stats, and highlights.

import { db } from "./database.js";

const RESEND_API = "https://api.resend.com";

function getResendKey() {
  return process.env.RESEND_API_KEY || null;
}

function getFromEmail() {
  return process.env.EMAIL_FROM_ADDRESS || "care@boiseidahomecare.com";
}

function getReportRecipients() {
  const recipients = process.env.REPORT_EMAIL_TO || "";
  return recipients.split(",").map(e => e.trim()).filter(Boolean);
}

// ─── Gather Weekly Stats ───
function getWeeklyStats() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const totalLeads = db.prepare(
    "SELECT COUNT(*) as count FROM conversations WHERE created_at >= ?"
  ).get(weekAgo).count;

  const qualifiedLeads = db.prepare(
    "SELECT COUNT(*) as count FROM leads WHERE qualified = 1 AND created_at >= ?"
  ).get(weekAgo).count;

  const byUrgency = db.prepare(`
    SELECT urgency, COUNT(*) as count FROM leads 
    WHERE created_at >= ? AND qualified = 1
    GROUP BY urgency ORDER BY count DESC
  `).all(weekAgo);

  const byCareType = db.prepare(`
    SELECT care_type, COUNT(*) as count FROM leads 
    WHERE created_at >= ? AND qualified = 1
    GROUP BY care_type ORDER BY count DESC
  `).all(weekAgo);

  const byInsurance = db.prepare(`
    SELECT insurance_type as insurance, COUNT(*) as count FROM leads 
    WHERE created_at >= ? AND qualified = 1
    GROUP BY insurance_type ORDER BY count DESC
  `).all(weekAgo);

  const byReferral = db.prepare(`
    SELECT referral_source as source, COUNT(*) as count FROM leads 
    WHERE created_at >= ? AND qualified = 1 AND referral_source IS NOT NULL
    GROUP BY referral_source ORDER BY count DESC LIMIT 10
  `).all(weekAgo);

  const medicaidScreened = db.prepare(`
    SELECT COUNT(*) as count FROM conversations 
    WHERE stage = 'medicaid_screened' AND created_at >= ?
  `).get(weekAgo).count;

  const outOfArea = db.prepare(`
    SELECT COUNT(*) as count FROM conversations 
    WHERE stage = 'out_of_area' AND created_at >= ?
  `).get(weekAgo).count;

  const emailsSent = db.prepare(`
    SELECT COUNT(*) as count FROM email_queue 
    WHERE status = 'sent' AND sent_at >= ?
  `).get(weekAgo).count;

  // Recent qualified leads (for the detail section)
  const recentLeads = db.prepare(`
    SELECT * FROM leads 
    WHERE qualified = 1 AND created_at >= ?
    ORDER BY created_at DESC LIMIT 20
  `).all(weekAgo);

  return {
    totalLeads,
    qualifiedLeads,
    conversionRate: totalLeads > 0 ? Math.round((qualifiedLeads / totalLeads) * 100) : 0,
    byUrgency,
    byCareType,
    byInsurance,
    byReferral,
    medicaidScreened,
    outOfArea,
    emailsSent,
    recentLeads,
  };
}

// ─── Build HTML Report ───
function buildReportHtml(stats) {
  const weekEnd = new Date();
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const formatDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const urgencyEmoji = { immediate: "🔴", soon: "🟡", exploring: "🟢" };
  const urgencyLabel = { immediate: "Immediate", soon: "1-2 Weeks", exploring: "Exploring" };

  function tableRows(items, labelKey, countKey) {
    if (!items || items.length === 0) return `<tr><td colspan="2" style="padding:8px 12px;color:#999;">None this week</td></tr>`;
    return items.map(item => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;">${item[labelKey] || "Not specified"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;text-align:right;font-weight:600;color:#1a2744;">${item[countKey]}</td>
      </tr>
    `).join("");
  }

  const leadRows = stats.recentLeads.map(lead => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;">${lead.name || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;">${lead.care_type || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;">${urgencyEmoji[lead.urgency] || "⚪"} ${urgencyLabel[lead.urgency] || lead.urgency || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;">${lead.referral_source || "—"}</td>
    </tr>
  `).join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  
  <!-- Header -->
  <div style="background:#1a2744;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;font-family:Georgia,serif;font-size:22px;margin:0;">Weekly Lead Report</h1>
    <p style="color:#c5a45a;font-size:14px;margin:6px 0 0;">
      ${formatDate(weekStart)} – ${formatDate(weekEnd)}
    </p>
  </div>

  <div style="background:#fff;padding:28px 24px;border-radius:0 0 12px 12px;">
    
    <!-- Quick Stats -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="text-align:center;padding:16px;background:#f5f0e8;border-radius:8px;">
          <div style="font-size:32px;font-weight:700;color:#1a2744;">${stats.totalLeads}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">Total Conversations</div>
        </td>
        <td width="12"></td>
        <td style="text-align:center;padding:16px;background:#e8f5e9;border-radius:8px;">
          <div style="font-size:32px;font-weight:700;color:#2d8a5e;">${stats.qualifiedLeads}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">Qualified Leads</div>
        </td>
        <td width="12"></td>
        <td style="text-align:center;padding:16px;background:#f5f0e8;border-radius:8px;">
          <div style="font-size:32px;font-weight:700;color:#c5a45a;">${stats.conversionRate}%</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">Conversion Rate</div>
        </td>
      </tr>
    </table>

    <!-- Screened Out -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="text-align:center;padding:12px;background:#fef3cd;border-radius:8px;">
          <span style="font-weight:600;color:#856404;">${stats.medicaidScreened} Medicaid Screened</span>
          <span style="margin:0 12px;color:#ddd;">|</span>
          <span style="font-weight:600;color:#856404;">${stats.outOfArea} Out of Area</span>
          <span style="margin:0 12px;color:#ddd;">|</span>
          <span style="font-weight:600;color:#856404;">${stats.emailsSent} Follow-up Emails Sent</span>
        </td>
      </tr>
    </table>

    <!-- By Urgency -->
    <h3 style="font-family:Georgia,serif;color:#1a2744;font-size:16px;margin:20px 0 8px;">By Urgency</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ece4;border-radius:8px;overflow:hidden;">
      ${stats.byUrgency.map(u => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;">${urgencyEmoji[u.urgency] || "⚪"} ${urgencyLabel[u.urgency] || u.urgency || "Not specified"}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0ece4;text-align:right;font-weight:600;color:#1a2744;">${u.count}</td>
        </tr>
      `).join("") || `<tr><td style="padding:8px 12px;color:#999;">None this week</td></tr>`}
    </table>

    <!-- By Care Type -->
    <h3 style="font-family:Georgia,serif;color:#1a2744;font-size:16px;margin:20px 0 8px;">By Care Type</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ece4;border-radius:8px;overflow:hidden;">
      ${tableRows(stats.byCareType, "care_type", "count")}
    </table>

    <!-- By Referral Source -->
    <h3 style="font-family:Georgia,serif;color:#1a2744;font-size:16px;margin:20px 0 8px;">Top Referral Sources</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ece4;border-radius:8px;overflow:hidden;">
      ${tableRows(stats.byReferral, "source", "count")}
    </table>

    <!-- Recent Leads -->
    ${stats.recentLeads.length > 0 ? `
    <h3 style="font-family:Georgia,serif;color:#1a2744;font-size:16px;margin:24px 0 8px;">This Week's Qualified Leads</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0ece4;border-radius:8px;overflow:hidden;font-size:13px;">
      <tr style="background:#1a2744;">
        <td style="padding:8px 12px;color:#fff;font-weight:600;">Name</td>
        <td style="padding:8px 12px;color:#fff;font-weight:600;">Care Type</td>
        <td style="padding:8px 12px;color:#fff;font-weight:600;">Urgency</td>
        <td style="padding:8px 12px;color:#fff;font-weight:600;">Referral</td>
      </tr>
      ${leadRows}
    </table>
    ` : ""}

    <!-- Footer -->
    <hr style="border:none;border-top:1px solid #e8e4df;margin:24px 0;">
    <p style="font-size:12px;color:#999;text-align:center;">
      Generated by Visiting Angels AI SMS Platform<br>
      View all leads: <a href="${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''}/api/leads" style="color:#1a2744;">/api/leads</a>
    </p>
  </div>
</div>
</body>
</html>`;
}

// ─── Send Weekly Report ───
export async function sendWeeklyReport() {
  const key = getResendKey();
  if (!key) {
    console.warn("⚠️  No RESEND_API_KEY — skipping weekly report");
    return;
  }

  const recipients = getReportRecipients();
  if (recipients.length === 0) {
    console.warn("⚠️  No REPORT_EMAIL_TO set — skipping weekly report");
    return;
  }

  const stats = getWeeklyStats();
  const html = buildReportHtml(stats);

  const weekEnd = new Date();
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const formatDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  try {
    const response = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Visiting Angels Reports <${getFromEmail()}>`,
        to: recipients,
        subject: `📊 Weekly Lead Report — ${formatDate(weekStart)} to ${formatDate(weekEnd)} (${stats.qualifiedLeads} qualified leads)`,
        html,
      }),
    });

    if (response.ok) {
      console.log(`📊 Weekly report sent to ${recipients.join(", ")} (${stats.qualifiedLeads} leads this week)`);
    } else {
      const err = await response.text();
      console.error("Weekly report send error:", err);
    }
  } catch (error) {
    console.error("Weekly report error:", error.message);
  }
}
