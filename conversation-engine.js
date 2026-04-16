import Anthropic from "@anthropic-ai/sdk";
import { db } from "./database.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { syncLeadToHubSpot } from "./hubspot.js";
import { scheduleFollowUps } from "./email-followups.js";
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
  if (conversation.stage === "assessment_booked" && isCancellationRequest(body)) return handleCancellation(from, body, conversation);
  if (conversation.stage === "selecting_slot" && isSlotSelection(body)) return handleSlotSelection(from, body, conversation);

  const messageHistory = buildMessageHistory(from);
  const allUserMsgs = db.prepare("SELECT content FROM messages WHERE phone = ? AND role = 'user' ORDER BY created_at ASC").all(from);
  const sentiment = scoreSentiment(allUserMsgs);
  const stateContext = buildStateContext(conversation, sentiment);
  const aiReply = await callClaude(messageHistory, stateContext);
  const parsed = parseAIResponse(aiReply, body, conversation);
  parsed.leadData.sentiment = sentiment.summary;
  if (sentiment.override && parsed.leadData.urgency !== "immediate") { parsed.leadData.urgency = "immediate"; console.log("Sentiment override: immediate for " + from); }
  updateConversation(from, parsed.stage, parsed.leadData);
  logMessage(from, "assistant", parsed.text, null);

  if (parsed.qualified && parsed.leadData.address) return await offerCalendarSlots(from, parsed);
  if (parsed.qualified) { saveLead(from, parsed.leadData); syncLeadToHubSpot(from, parsed.leadData).catch(console.error); try { scheduleFollowUps(from, parsed.leadData); } catch(e) {} }
  return { text: parsed.text, stage: parsed.stage, qualified: parsed.qualified, leadData: parsed.leadData };
}

async function offerCalendarSlots(from, parsed) {
  try {
    const slots = await findAvailableSlots(parsed.leadData.urgency || "soon", 3);
    if (slots && slots.length > 0) {
      parsed.leadData.available_slots = slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), travelEnd: s.travelEnd.toISOString() }));
      updateConversation(from, "selecting_slot", parsed.leadData);
      const slotsText = formatSlotsForSMS(slots);
      const confirmText = parsed.text + "\n\nGreat news! Let's get your free assessment on the calendar. Our Executive Director, Matthew, will come to you personally:\n\n" + slotsText + "\n\nWhich works best? Reply with the number (1, 2, or 3), or let me know if you need a different day!";
      saveLead(from, parsed.leadData);
      syncLeadToHubSpot(from, parsed.leadData).catch(console.error);
      logMessage(from, "assistant", confirmText, null);
      return { text: confirmText, stage: "selecting_slot", qualified: true, leadData: parsed.leadData };
    }
  } catch (e) { console.error("Calendar error:", e.message); }
  saveLead(from, parsed.leadData); syncLeadToHubSpot(from, parsed.leadData).catch(console.error);
  try { scheduleFollowUps(from, parsed.leadData); } catch(e) {}
  return { text: parsed.text, stage: parsed.stage, qualified: parsed.qualified, leadData: parsed.leadData };
}

async function handleSlotSelection(from, body, conversation) {
  const leadData = JSON.parse(conversation.lead_data || "{}");
  const slots = leadData.available_slots;
  if (!slots || !slots.length) return { text: "Our team will call to schedule. Call 208-888-3611 anytime!", stage: "complete", qualified: true, leadData };
  const t = body.trim().toLowerCase();
  let idx = -1;
  if (t.includes("1") || t.includes("first")) idx = 0;
  else if (t.includes("2") || t.includes("second")) idx = 1;
  else if (t.includes("3") || t.includes("third")) idx = 2;
  else if (t.includes("none") || t.includes("different") || t.includes("other")) {
    const ns = await findAvailableSlots(leadData.urgency || "soon", 3);
    if (ns && ns.length) { leadData.available_slots = ns.map(s=>({start:s.start.toISOString(),end:s.end.toISOString(),travelEnd:s.travelEnd.toISOString()})); updateConversation(from,"selecting_slot",leadData); const r="No problem! Here are other openings:\n\n"+formatSlotsForSMS(ns)+"\n\nDo any work?"; logMessage(from,"assistant",r,null); return{text:r,stage:"selecting_slot",qualified:true,leadData}; }
  }
  if (idx >= 0 && idx < slots.length) {
    const recon = slots.map(s=>({start:new Date(s.start),end:new Date(s.end),travelEnd:new Date(s.travelEnd)}));
    const result = await bookAssessment(leadData, idx, recon);
    if (result.success) {
      leadData.calendar_event_id=result.eventId; leadData.travel_event_id=result.travelEventId; leadData.assessment_time=result.startTime; delete leadData.available_slots;
      updateConversation(from,"assessment_booked",leadData); saveLead(from,leadData); syncLeadToHubSpot(from,leadData).catch(console.error);
      try{scheduleFollowUps(from,leadData);}catch(e){}
      const r="You're all set!\n\nOur Executive Director, Matthew, will be there "+result.startTime+".\n\nOur team will give you a quick call beforehand to confirm everything and answer any questions.\n\nIf you need anything before then, call 208-888-3611 or text here anytime. We look forward to meeting you!";
      logMessage(from,"assistant",r,null); return{text:r,stage:"assessment_booked",qualified:true,leadData};
    } else {
      const ns=await findAvailableSlots(leadData.urgency||"soon",3);
      if(ns&&ns.length){leadData.available_slots=ns.map(s=>({start:s.start.toISOString(),end:s.end.toISOString(),travelEnd:s.travelEnd.toISOString()}));updateConversation(from,"selecting_slot",leadData);const r="That time just got taken! Here are fresh openings:\n\n"+formatSlotsForSMS(ns)+"\n\nWhich works?";logMessage(from,"assistant",r,null);return{text:r,stage:"selecting_slot",qualified:true,leadData};}
      return{text:"Our team will call to schedule. Call 208-888-3611!",stage:"complete",qualified:true,leadData};
    }
  }
  const mh=buildMessageHistory(from);const sc=buildStateContext(conversation,{score:"neutral",override:false,summary:""});const ar=await callClaude(mh,sc);logMessage(from,"assistant",ar,null);return{text:ar,stage:"selecting_slot",qualified:true,leadData};
}

async function handleCancellation(from, body, conversation) {
  const ld=JSON.parse(conversation.lead_data||"{}");
  if(ld.calendar_event_id) await cancelAssessment(ld.calendar_event_id,ld.travel_event_id);
  const r="No problem at all! I've cancelled your assessment"+(ld.assessment_time?" for "+ld.assessment_time:"")+".\n\nWould you mind sharing what changed? It helps us improve. And if you'd like to reschedule, just let me know.\n\nYou can also call 208-888-3611 whenever you're ready.";
  delete ld.calendar_event_id;delete ld.travel_event_id;delete ld.assessment_time;
  updateConversation(from,"cancelled",ld);try{scheduleFollowUps(from,ld);}catch(e){}
  logMessage(from,"assistant",r,null);return{text:r,stage:"cancelled",qualified:true,leadData:ld};
}

function isCancellationRequest(t){const l=t.toLowerCase();return l.includes("cancel")||l.includes("can't make it")||l.includes("cant make it")||l.includes("need to reschedule")||l.includes("won't be able");}
function isSlotSelection(t){const l=t.trim().toLowerCase();return /^[1-3]$/.test(l)||l.includes("first")||l.includes("second")||l.includes("third")||l.includes("one")||l.includes("two")||l.includes("three")||l.includes("none")||l.includes("different")||l.includes("other day");}
function isOptOut(m){return["stop","unsubscribe","cancel","quit","opt out","optout"].includes(m.trim().toLowerCase());}
function handleOptOut(p){db.prepare("UPDATE conversations SET stage='opted_out',updated_at=datetime('now') WHERE phone=?").run(p);return{text:"You've been unsubscribed. Text again or call (208) 888-3611 anytime. Take care!",stage:"opted_out",qualified:false,leadData:{}};}

async function callClaude(mh,sc){try{const c=getClient();const r=await c.messages.create({model:"claude-sonnet-4-6",max_tokens:500,system:SYSTEM_PROMPT+"\n\n"+sc,messages:mh});return r.content[0].text;}catch(e){console.error("Claude API error:",e.message);return"Thanks for your message! Call (208) 888-3611 for help.";}}

function buildMessageHistory(phone){const rows=db.prepare("SELECT role,content FROM messages WHERE phone=? ORDER BY created_at ASC LIMIT 30").all(phone);const m=[];for(const r of rows){const l=m[m.length-1];if(l&&l.role===r.role)l.content+="\n"+r.content;else m.push({role:r.role,content:r.content});}if(m.length>0&&m[0].role==="assistant")m.shift();return m;}

function buildStateContext(conv,sentiment={}){const d=conv.lead_data?JSON.parse(conv.lead_data):{};return`
CURRENT STATE: Stage=${conv.stage||"new_contact"} Data=${JSON.stringify(d)} Messages=${conv.message_count||0} Sentiment=${sentiment.summary||"N/A"}
${sentiment.override?"SENTIMENT OVERRIDE: Treat as IMMEDIATE urgency.":""}
STAGE INSTRUCTIONS: ${getStageInstructions(conv.stage,d)}
ADDRESS: When close to qualifying, ask where in Treasure Valley care would be. If scheduling, get EXACT address. Tag: [[LEAD_DATA:address=1234 Maple St, Boise, ID 83642]]
FORMAT: Keep under 320 chars. Tag data at END: [[LEAD_DATA:field=value]]. Fields: relationship,contact_name,care_recipient_name,care_type,in_service_area,urgency,name,phone,email,insurance,referral_source,address. When qualified (name+phone+address+NOT Medicaid+adult): [[QUALIFIED]]`;}

function getStageInstructions(s,d){const i={new_contact:"Greet warmly. Ask if care is for them or a loved one.",greeting:"Greet warmly. Ask if care is for them or a loved one.",needs:"Get BOTH names (contact + recipient). Ask care type. For: "+(d.relationship||"someone"),location:"Care: "+(d.care_type||"TBD")+". Ask Treasure Valley area. Confirm service area. Ask referral.",referral:"Ask referral source + insurance.",insurance:"Screen insurance. Medicaid=at capacity. Medicare=no coverage. VA/LTC/private=continue.",urgency:"Ask timeline. Get exact address for assessment.",capture_info:"Get remaining: name,phone,email(optional),ADDRESS. Push free assessment. Have: "+JSON.stringify(d),selecting_slot:"Slots offered. System handles booking. Answer other questions.",assessment_booked:"Booked: "+(d.assessment_time||"soon")+". Coordinator will call. Handle cancellation warmly.",cancelled:"Cancelled. Ask feedback gently. Offer reschedule.",complete:"Captured. Coordinator in touch. 208-888-3611.",out_of_area:"Outside area. visitingangels.com/office-locator.",medicaid_screened:"Medicaid at capacity. 2-1-1.",under_18:"Adults 18+ only.",job_inquiry:"visitingangels.com/boise/employment."};return i[s]||"Guide toward qualification and scheduling.";}

function parseAIResponse(ai,body,conv){const ed=conv.lead_data?JSON.parse(conv.lead_data):{};const nd={...ed};let st=conv.stage||"greeting";let q=false;const dp=/\[\[LEAD_DATA:(\w+)=([^\]]+)\]\]/g;let m;while((m=dp.exec(ai))!==null){const[,f,v]=m;nd[f]=v.trim();if(f==="relationship"&&st==="greeting")st="needs";if(f==="care_type"&&["needs","greeting"].includes(st))st="location";if(f==="in_service_area")st=v.toLowerCase().includes("no")?"out_of_area":"referral";if(f==="referral_source"&&st==="referral")st="insurance";if(f==="insurance")st=v.toLowerCase().includes("medicaid")?"medicaid_screened":"urgency";if(f==="urgency"&&st==="urgency")st="capture_info";if(["name","contact_name","phone","email","address"].includes(f))st="capture_info";}
if(ai.includes("[[QUALIFIED]]")){q=true;st="complete";}if(nd.name&&(nd.phone||nd.email)&&nd.address&&!q&&!(nd.insurance||"").toLowerCase().includes("medicaid")){q=true;st="complete";}
return{text:ai.replace(/\[\[LEAD_DATA:[^\]]+\]\]/g,"").replace(/\[\[QUALIFIED\]\]/g,"").trim(),stage:st,qualified:q,leadData:nd};}

function getOrCreateConversation(p){let c=db.prepare("SELECT * FROM conversations WHERE phone=?").get(p);if(!c){db.prepare("INSERT INTO conversations(phone,stage,lead_data,message_count,created_at,updated_at)VALUES(?,'greeting','{}',0,datetime('now'),datetime('now'))").run(p);c=db.prepare("SELECT * FROM conversations WHERE phone=?").get(p);}if(c.stage==="opted_out"){db.prepare("UPDATE conversations SET stage='greeting',lead_data='{}',message_count=0,updated_at=datetime('now') WHERE phone=?").run(p);c=db.prepare("SELECT * FROM conversations WHERE phone=?").get(p);}return c;}
function updateConversation(p,s,ld){db.prepare("UPDATE conversations SET stage=?,lead_data=?,message_count=message_count+2,updated_at=datetime('now') WHERE phone=?").run(s,JSON.stringify(ld),p);}
function logMessage(p,r,c,sid){db.prepare("INSERT INTO messages(phone,role,content,message_sid,created_at)VALUES(?,?,?,?,datetime('now'))").run(p,r,c,sid);}
function saveLead(p,ld){const e=db.prepare("SELECT * FROM leads WHERE phone=?").get(p);if(e){db.prepare("UPDATE leads SET name=?,email=?,care_type=?,care_recipient_name=?,relationship=?,urgency=?,insurance_type=?,referral_source=?,in_service_area=?,qualified=1,updated_at=datetime('now') WHERE phone=?").run(ld.name,ld.email,ld.care_type,ld.care_recipient_name,ld.relationship,ld.urgency,ld.insurance,ld.referral_source,ld.in_service_area,p);}else{db.prepare("INSERT INTO leads(phone,name,email,care_type,care_recipient_name,relationship,urgency,insurance_type,referral_source,in_service_area,qualified,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))").run(p,ld.name,ld.email,ld.care_type,ld.care_recipient_name,ld.relationship,ld.urgency,ld.insurance,ld.referral_source,ld.in_service_area);}console.log("Lead saved: "+ld.name+" ("+p+")");}
