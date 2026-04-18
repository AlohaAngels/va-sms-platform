// ============================================
// HubSpot Integration — Auto-sync leads to CRM
// ============================================
// When a lead qualifies, this creates or updates
// a contact in HubSpot with all the AI-captured data.

const HUBSPOT_API = "https://api.hubapi.com";

function getToken() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    console.warn("⚠️  No HUBSPOT_ACCESS_TOKEN set — skipping CRM sync");
    return null;
  }
  return token;
}

async function hubspotRequest(method, endpoint, body = null) {
  const token = getToken();
  if (!token) return null;

  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${HUBSPOT_API}${endpoint}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`HubSpot API error (${response.status}):`, errorText);
    return null;
  }

  return response.json();
}

// ─── Create or Update a Contact ───
export async function syncLeadToHubSpot(phone, leadData) {
  const token = getToken();
  if (!token) return;

  // Skip demo phone numbers
  if (phone.includes("DEMO")) {
    console.log("📋 HubSpot: Skipping demo lead");
    return;
  }

  try {
    const nameParts = (leadData.name || "").trim().split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Start with standard HubSpot properties only
    const standardProps = {
      firstname: firstName,
      lastname: lastName,
      phone: phone,
    };
    if (leadData.email) standardProps.email = leadData.email;

    // Custom properties (may or may not exist in HubSpot)
    const customProps = {
      care_type: leadData.care_type || "",
      care_recipient_name: leadData.care_recipient_name || "",
      relationship_to_client: leadData.relationship || "",
      urgency_level: leadData.urgency || "",
      insurance_type: leadData.insurance || "",
      referral_source: leadData.referral_source || "",
      in_service_area: leadData.in_service_area || "",
      lead_source: "AI SMS Platform",
      lead_status: "NEW",
    };

    // Clean empties
    Object.keys(customProps).forEach(k => { if (!customProps[k]) delete customProps[k]; });

    // Try with all properties first
    let allProps = { ...standardProps, ...customProps };

    const existing = await searchContactByPhone(phone);

    if (existing) {
      const contactId = existing.id;
      let result = await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`, { properties: allProps });
      if (!result) {
        // Retry with just standard props
        result = await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`, { properties: standardProps });
      }
      if (result) console.log(`📋 HubSpot: Updated contact ${contactId} (${leadData.name})`);
    } else {
      let result = await hubspotRequest("POST", "/crm/v3/objects/contacts", { properties: allProps });
      if (!result) {
        // Retry with just standard props (custom properties might not exist yet)
        console.log("📋 HubSpot: Retrying with standard properties only...");
        result = await hubspotRequest("POST", "/crm/v3/objects/contacts", { properties: standardProps });
      }
      if (result) console.log(`📋 HubSpot: Created contact ${result.id} (${leadData.name})`);
      else console.error("📋 HubSpot: Failed to create contact for " + leadData.name);
    }

    // Try to create a note (this can fail independently)
    try { await createEngagementNote(phone, leadData); } catch(e) {}

  } catch (error) {
    console.error("HubSpot sync error:", error.message);
  }
}

// ─── Search for Contact by Phone ───
async function searchContactByPhone(phone) {
  const result = await hubspotRequest("POST", "/crm/v3/objects/contacts/search", {
    filterGroups: [{
      filters: [{
        propertyName: "phone",
        operator: "EQ",
        value: phone,
      }],
    }],
  });

  if (result && result.results && result.results.length > 0) {
    return result.results[0];
  }
  return null;
}

// ─── Create a Note with Conversation Summary ───
async function createEngagementNote(phone, leadData) {
  const noteBody = [
    `📱 AI SMS Lead Qualification — Completed`,
    ``,
    `Contact: ${leadData.name || "Unknown"}`,
    `Phone: ${phone}`,
    `Email: ${leadData.email || "Not provided"}`,
    ``,
    `Care Recipient: ${leadData.care_recipient_name || "Same as contact"}`,
    `Relationship: ${leadData.relationship || "Not specified"}`,
    `Care Type: ${leadData.care_type || "General"}`,
    `Insurance: ${leadData.insurance || "Not discussed"}`,
    `Urgency: ${leadData.urgency || "Not specified"}`,
    `Service Area: ${leadData.in_service_area || "Not confirmed"}`,
    `Referral Source: ${leadData.referral_source || "Not specified"}`,
    ``,
    `Source: AI SMS Platform (Google Ads)`,
    `Action Needed: Schedule free in-home assessment`,
  ].join("\n");

  await hubspotRequest("POST", "/crm/v3/objects/notes", {
    properties: {
      hs_note_body: noteBody,
      hs_timestamp: new Date().toISOString(),
    },
  });
}

// ─── Sync Applicant to HubSpot ───
export async function syncApplicantToHubSpot(phone, data) {
  const token = getToken();
  if (!token) return;
  try {
    const nameParts = (data.name || "").trim().split(/\s+/);
    const props = { firstname: nameParts[0] || "", lastname: nameParts.slice(1).join(" ") || "", phone };
    if (data.email) props.email = data.email;
    props.hs_lead_status = "APPLICANT";
    const existing = await searchContactByPhone(phone);
    if (existing) {
      await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${existing.id}`, { properties: props });
      console.log("📋 HubSpot: Updated applicant " + (data.name || phone));
    } else {
      const result = await hubspotRequest("POST", "/crm/v3/objects/contacts", { properties: props });
      if (result) console.log("📋 HubSpot: Created applicant " + result.id);
    }
  } catch (e) { console.error("HubSpot applicant sync error:", e.message); }
}

// ─── Ensure Custom Properties Exist ───
// Call this once on startup to create custom properties if they don't exist
export async function ensureHubSpotProperties() {
  const token = getToken();
  if (!token) return;

  const customProperties = [
    { name: "care_type", label: "Care Type", type: "string", groupName: "contactinformation" },
    { name: "care_recipient_name", label: "Care Recipient Name", type: "string", groupName: "contactinformation" },
    { name: "relationship_to_client", label: "Relationship to Client", type: "string", groupName: "contactinformation" },
    { name: "urgency_level", label: "Urgency Level", type: "enumeration", groupName: "contactinformation",
      options: [
        { label: "Immediate", value: "immediate" },
        { label: "1-2 Weeks", value: "soon" },
        { label: "Exploring", value: "exploring" },
      ]
    },
    { name: "insurance_type", label: "Insurance Type", type: "enumeration", groupName: "contactinformation",
      options: [
        { label: "Private Pay", value: "private_pay" },
        { label: "VA Benefits", value: "va_benefits" },
        { label: "Long-Term Care Insurance", value: "ltc_insurance" },
        { label: "Medicare", value: "medicare" },
        { label: "Medicaid", value: "medicaid" },
      ]
    },
    { name: "referral_source", label: "Referral Source", type: "string", groupName: "contactinformation" },
    { name: "in_service_area", label: "In Service Area", type: "string", groupName: "contactinformation" },
  ];

  for (const prop of customProperties) {
    try {
      await hubspotRequest("POST", "/crm/v3/properties/contacts", {
        name: prop.name,
        label: prop.label,
        type: prop.type,
        fieldType: prop.type === "enumeration" ? "select" : "text",
        groupName: prop.groupName,
        ...(prop.options ? { options: prop.options } : {}),
      });
      console.log(`📋 HubSpot: Created property "${prop.label}"`);
    } catch (e) {
      // Property already exists — that's fine
    }
  }
}
