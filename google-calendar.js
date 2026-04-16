// ============================================
// Google Calendar Integration
// OAuth2 + Smart Scheduling + INTAKE Booking
// ============================================

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPES = "https://www.googleapis.com/auth/calendar";

// ─── OAuth2 Token Management ───
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 300000) {
    return cachedAccessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn("⚠️  Google Calendar credentials not set — skipping calendar integration");
    return null;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Google OAuth token refresh failed:", err);
      return null;
    }

    const data = await response.json();
    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in * 1000);
    return cachedAccessToken;
  } catch (error) {
    console.error("Google OAuth error:", error.message);
    return null;
  }
}

// ─── Calendar API Helper ───
async function calendarRequest(method, endpoint, body = null) {
  const token = await getAccessToken();
  if (!token) return null;

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.warn("⚠️  No GOOGLE_CALENDAR_ID set");
    return null;
  }

  const url = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}${endpoint}`;
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);

  if (!response.ok) {
    const err = await response.text();
    console.error(`Google Calendar API error (${response.status}):`, err);
    return null;
  }

  if (response.status === 204) return {}; // No content (delete success)
  return response.json();
}

// ─── Get Busy Times ───
// Returns all busy periods in a date range
async function getBusyTimes(startDate, endDate) {
  const token = await getAccessToken();
  if (!token) return [];

  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  try {
    const response = await fetch(`${GOOGLE_CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        timeZone: "America/Boise",
        items: [{ id: calendarId }],
      }),
    });

    if (!response.ok) {
      console.error("FreeBusy error:", await response.text());
      return [];
    }

    const data = await response.json();
    const busy = data.calendars?.[calendarId]?.busy || [];
    return busy.map(b => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));
  } catch (error) {
    console.error("getBusyTimes error:", error.message);
    return [];
  }
}

// ─── Smart Slot Finder ───
// Finds available 2.5-hour blocks (2hr assessment + 30min travel)
// based on urgency tier and scheduling rules
export async function findAvailableSlots(urgency, count = 3) {
  const ASSESSMENT_DURATION_MIN = 120;  // 2 hours
  const TRAVEL_BUFFER_MIN = 30;         // 30 min travel
  const TOTAL_BLOCK_MIN = ASSESSMENT_DURATION_MIN + TRAVEL_BUFFER_MIN; // 2.5 hours
  const SLOT_START_HOUR = 9;            // 9 AM
  const SLOT_END_HOUR = 17;             // 5 PM (last assessment must end by 5)
  const TIMEZONE = "America/Boise";

  // Determine search window based on urgency
  const now = new Date();
  let searchStartDate = new Date(now);
  let searchEndDate = new Date(now);
  let preferMidweek = false;
  let keepMondayFridayLight = false;

  switch (urgency) {
    case "immediate":
      // Next 48 hours, any day M-F
      searchEndDate.setDate(searchEndDate.getDate() + 5); // Look ahead 5 days to ensure 48hrs of weekdays
      break;
    case "soon":
      // This week first (first in the door!), then up to 2 weeks out
      searchEndDate.setDate(searchEndDate.getDate() + 14);
      preferMidweek = true;
      keepMondayFridayLight = true;
      break;
    case "exploring":
    default:
      // 1-2 weeks out, mid-week preferred
      searchStartDate.setDate(searchStartDate.getDate() + 3); // Start looking 3 days out
      searchEndDate.setDate(searchEndDate.getDate() + 21);
      preferMidweek = true;
      keepMondayFridayLight = true;
      break;
  }

  // Get all busy times in the search window
  const busyTimes = await getBusyTimes(searchStartDate, searchEndDate);

  // Generate all possible slots
  const slots = [];
  const currentDate = new Date(searchStartDate);

  // Set to start of next business day if we're past business hours today
  const boiseNow = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  
  while (currentDate <= searchEndDate && slots.length < count * 3) {
    const dayOfWeek = currentDate.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      currentDate.setDate(currentDate.getDate() + 1);
      currentDate.setHours(SLOT_START_HOUR, 0, 0, 0);
      continue;
    }

    // For "soon" and "exploring" — deprioritize Monday (1) and Friday (5)
    const isMonFri = dayOfWeek === 1 || dayOfWeek === 5;

    // Generate time slots for this day (9am, 11:30am, 2pm)
    const possibleStarts = [
      { hour: 15, minute: 0 },
      { hour: 17, minute: 30 },
      { hour: 20, minute: 0 },
    ];

    for (const start of possibleStarts) {
      const slotStart = new Date(currentDate);
      slotStart.setHours(start.hour, start.minute, 0, 0);

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + TOTAL_BLOCK_MIN);

      // Skip if slot end is past business hours
      if (slotEnd.getHours() > 23 || (slotEnd.getHours() === 23 && slotEnd.getMinutes() > 30)) {
        continue;
      }

      // Skip if slot is in the past
      if (slotStart <= now) {
        continue;
      }

      // For immediate urgency, skip if more than 48 hours out
      if (urgency === "immediate") {
        const hoursFromNow = (slotStart - now) / (1000 * 60 * 60);
        if (hoursFromNow > 72) continue; // Allow 72 hours to get 3 good options
      }

      // Check if slot conflicts with any busy time
      const hasConflict = busyTimes.some(busy => {
        return slotStart < busy.end && slotEnd > busy.start;
      });

      if (!hasConflict) {
        slots.push({
          start: new Date(slotStart),
          end: new Date(slotStart.getTime() + ASSESSMENT_DURATION_MIN * 60000), // Assessment end (without travel)
          travelEnd: new Date(slotEnd), // Including travel buffer
          dayOfWeek,
          isMonFri,
          hoursFromNow: (slotStart - now) / (1000 * 60 * 60),
        });
      }
    }

    currentDate.setDate(currentDate.getDate() + 1);
    currentDate.setHours(SLOT_START_HOUR, 0, 0, 0);
  }

  // Sort and prioritize based on urgency
  if (urgency === "immediate") {
    // Earliest first
    slots.sort((a, b) => a.start - b.start);
  } else {
    // Prefer mid-week, but offer this week first ("first in the door")
    slots.sort((a, b) => {
      // First: prefer this week's openings
      const aThisWeek = a.hoursFromNow < 120; // Within 5 days
      const bThisWeek = b.hoursFromNow < 120;
      if (aThisWeek && !bThisWeek) return -1;
      if (!aThisWeek && bThisWeek) return 1;

      // Second: prefer Tue/Wed/Thu over Mon/Fri
      if (keepMondayFridayLight) {
        if (!a.isMonFri && b.isMonFri) return -1;
        if (a.isMonFri && !b.isMonFri) return 1;
      }

      // Third: earliest
      return a.start - b.start;
    });
  }

  // Return top slots
  return slots.slice(0, count);
}

// ─── Format Slots for SMS Display ───
export function formatSlotsForSMS(slots) {
  if (!slots || slots.length === 0) {
    return "I'm having trouble checking the calendar right now. Our team can help you schedule directly — just call 208-888-3611.";
  }

  const options = { 
    weekday: "long", 
    month: "long", 
    day: "numeric", 
    hour: "numeric", 
    minute: "2-digit",
    timeZone: "America/Boise",
  };

  const lines = slots.map((slot, i) => {
    const dateStr = slot.start.toLocaleString("en-US", options);
    return `${i + 1}. ${dateStr}`;
  });

  return lines.join("\n");
}

// ─── Book an Appointment ───
// Creates the INTAKE event + travel buffer on the calendar
export async function bookAssessment(leadData, slotIndex, availableSlots) {
  if (!availableSlots || slotIndex < 0 || slotIndex >= availableSlots.length) {
    return { success: false, error: "Invalid slot selection" };
  }

  const slot = availableSlots[slotIndex];

  // Determine city from address
  const city = extractCity(leadData.address || leadData.care_address || "Treasure Valley");
  const careRecipient = leadData.care_recipient_name || leadData.name || "Client";

  // Event title in the preferred format: INTAKE - (City) Client Name
  const eventTitle = `* INTAKE - (${city}) ${careRecipient}`;

  // Build the description with all captured data
  const contactName = leadData.contact_name || leadData.name || "Unknown";
  const description = [
    `Contact: ${contactName}${leadData.relationship ? ` (${leadData.relationship})` : ""}`,
    `Phone: ${leadData.phone || "See SMS thread"}`,
    `Email: ${leadData.email || "Not provided"}`,
    ``,
    `Care Recipient: ${careRecipient}`,
    `Care Type: ${leadData.care_type || "To be discussed"}`,
    `Insurance: ${leadData.insurance || "Not discussed"}`,
    `Urgency: ${leadData.urgency || "Not specified"}`,
    `Referral Source: ${leadData.referral_source || "Not specified"}`,
    ``,
    leadData.sentiment ? `Sentiment: ${leadData.sentiment}` : null,
    ``,
    `--- AI Conversation Summary ---`,
    leadData.conversation_summary || "See full conversation in HubSpot.",
    ``,
    `Source: AI SMS Platform`,
    `Booked automatically by AI on ${new Date().toLocaleString("en-US", { timeZone: "America/Boise" })}`,
  ].filter(Boolean).join("\n");

  try {
    // 1. Create the INTAKE event (2 hours)
    const intakeEvent = await calendarRequest("POST", "/events", {
      summary: eventTitle,
      location: leadData.address || leadData.care_address || "",
      description,
      start: {
        dateTime: slot.start.toISOString(),
        timeZone: "America/Boise",
      },
      end: {
        dateTime: slot.end.toISOString(),
        timeZone: "America/Boise",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 60 },   // 1 hour before
          { method: "popup", minutes: 1440 },  // Day before
        ],
      },
      colorId: "9", // Blueberry — stands out on calendar
    });

    if (!intakeEvent || !intakeEvent.id) {
      return { success: false, error: "Failed to create calendar event" };
    }

    // 2. Create travel buffer event (30 min after)
    const travelEvent = await calendarRequest("POST", "/events", {
      summary: `🚗 Travel Buffer — after ${careRecipient} INTAKE`,
      start: {
        dateTime: slot.end.toISOString(),
        timeZone: "America/Boise",
      },
      end: {
        dateTime: slot.travelEnd.toISOString(),
        timeZone: "America/Boise",
      },
      colorId: "8", // Graphite — subtle
      transparency: "opaque",
    });

    console.log(`📅 Booked: ${eventTitle} on ${slot.start.toLocaleString("en-US", { timeZone: "America/Boise" })}`);

    return {
      success: true,
      eventId: intakeEvent.id,
      travelEventId: travelEvent?.id || null,
      eventTitle,
      startTime: slot.start.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Boise",
      }),
      endTime: slot.end.toLocaleString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Boise",
      }),
    };
  } catch (error) {
    console.error("Calendar booking error:", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Cancel an Appointment ───
export async function cancelAssessment(eventId, travelEventId = null) {
  try {
    // Delete the INTAKE event
    await calendarRequest("DELETE", `/events/${eventId}`);
    console.log(`📅 Cancelled event: ${eventId}`);

    // Delete the travel buffer if we have its ID
    if (travelEventId) {
      await calendarRequest("DELETE", `/events/${travelEventId}`);
      console.log(`📅 Cancelled travel buffer: ${travelEventId}`);
    }

    return { success: true };
  } catch (error) {
    console.error("Calendar cancellation error:", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Verify Calendar Connection ───
export async function verifyCalendarAccess() {
  const token = await getAccessToken();
  if (!token) return { connected: false, reason: "No credentials" };

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return { connected: false, reason: "No calendar ID" };

  try {
    const response = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`,
      {
        headers: { "Authorization": `Bearer ${token}` },
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log(`📅 Calendar connected: ${data.summary}`);
      return { connected: true, calendarName: data.summary };
    } else {
      const err = await response.text();
      return { connected: false, reason: err };
    }
  } catch (error) {
    return { connected: false, reason: error.message };
  }
}

// ─── Helper: Extract City from Address ───
function extractCity(address) {
  if (!address) return "Treasure Valley";

  // Common Treasure Valley cities
  const cities = [
    "Boise", "Meridian", "Eagle", "Nampa", "Caldwell", 
    "Star", "Kuna", "Garden City", "Horseshoe Bend", 
    "Idaho City", "Marsing", "Homedale", "Fruitland",
    "Emmett", "Middleton",
  ];

  const upperAddr = address.toUpperCase();
  for (const city of cities) {
    if (upperAddr.includes(city.toUpperCase())) {
      return city;
    }
  }

  // Try to extract city from a standard address format (123 Main St, City, ID 83642)
  const parts = address.split(",");
  if (parts.length >= 2) {
    return parts[parts.length - 2].trim().split(" ")[0] || "Treasure Valley";
  }

  return "Treasure Valley";
}

// ─── Sentiment Scorer ───
// Analyzes conversation text for emotional urgency
export function scoreSentiment(messages) {
  if (!messages || messages.length === 0) return { score: "neutral", override: false, summary: "" };

  const allText = messages.map(m => m.content || m).join(" ").toLowerCase();

  // High anxiety indicators
  const urgentWords = [
    "fell", "fall", "fallen", "hospital", "emergency", "scared", "afraid",
    "can't cope", "desperate", "immediately", "asap", "right away", "urgent",
    "discharged", "released from", "broke", "broken", "injury", "injured",
    "wandering", "lost", "confused", "dangerous", "unsafe", "alone",
    "can't leave", "no one", "nobody", "help me", "please help",
    "crying", "overwhelmed", "don't know what to do", "at my wit's end",
  ];

  // Calm/exploring indicators
  const calmWords = [
    "just looking", "exploring", "information", "thinking about",
    "down the road", "eventually", "no rush", "whenever", "planning ahead",
    "researching", "comparing", "options",
  ];

  let urgentCount = 0;
  let calmCount = 0;
  const urgentMatches = [];

  for (const word of urgentWords) {
    if (allText.includes(word)) {
      urgentCount++;
      urgentMatches.push(word);
    }
  }

  for (const word of calmWords) {
    if (allText.includes(word)) {
      calmCount++;
    }
  }

  // Message frequency can indicate anxiety (lots of short messages)
  const messageCount = messages.length;
  const avgLength = allText.length / Math.max(messageCount, 1);
  const highFrequency = messageCount > 8 && avgLength < 50;

  // Score
  if (urgentCount >= 3 || (urgentCount >= 2 && highFrequency)) {
    return {
      score: "high_anxiety",
      override: true, // Override stated urgency to "immediate"
      summary: `High anxiety detected — mentions: ${urgentMatches.slice(0, 3).join(", ")}`,
    };
  } else if (urgentCount >= 1) {
    return {
      score: "moderate_concern",
      override: false,
      summary: `Moderate concern — mentioned: ${urgentMatches.join(", ")}`,
    };
  } else if (calmCount >= 2) {
    return {
      score: "calm_exploring",
      override: false,
      summary: "Calm tone — appears to be researching options",
    };
  }

  return {
    score: "neutral",
    override: false,
    summary: "Neutral tone",
  };
}
