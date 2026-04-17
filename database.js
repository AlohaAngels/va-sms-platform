// ============================================
// Database Layer — SQLite via better-sqlite3
// ============================================
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || "./data/conversations.db";

// Ensure data directory exists
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initDatabase() {
  db.exec(`
    -- Active conversation state per phone number
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      stage TEXT NOT NULL DEFAULT 'greeting',
      lead_data TEXT DEFAULT '{}',
      message_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Full message log
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      message_sid TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (phone) REFERENCES conversations(phone)
    );

    -- Qualified leads (denormalized for easy access)
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT,
      care_type TEXT,
      care_recipient_name TEXT,
      relationship TEXT,
      urgency TEXT,
      insurance_type TEXT,
      referral_source TEXT,
      in_service_area TEXT,
      qualified INTEGER DEFAULT 0,
      coordinator_notified INTEGER DEFAULT 0,
      consultation_scheduled INTEGER DEFAULT 0,
      email_unsubscribed INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Email follow-up queue
    CREATE TABLE IF NOT EXISTS email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      email_type TEXT NOT NULL,
      send_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'skipped')),
      sent_at TEXT,
      lead_data TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(phone, email_type)
    );

    -- Text message follow-up queue
    CREATE TABLE IF NOT EXISTS text_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      text_type TEXT NOT NULL,
      send_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'skipped')),
      sent_at TEXT,
      lead_data TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(phone, text_type)
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_qualified ON leads(qualified);
    CREATE INDEX IF NOT EXISTS idx_leads_urgency ON leads(urgency);
    CREATE INDEX IF NOT EXISTS idx_conversations_stage ON conversations(stage);
    CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status, send_at);
    CREATE INDEX IF NOT EXISTS idx_text_queue_status ON text_queue(status, send_at);
  `);

  // Add columns to leads table if they don't exist (for upgrades)
  const columns = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
  
  const newColumns = [
    { name: "care_recipient_name", type: "TEXT" },
    { name: "insurance_type", type: "TEXT" },
    { name: "referral_source", type: "TEXT" },
    { name: "email_unsubscribed", type: "INTEGER DEFAULT 0" },
  ];

  for (const col of newColumns) {
    if (!columns.includes(col.name)) {
      try {
        db.exec(`ALTER TABLE leads ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added column: leads.${col.name}`);
      } catch (e) {
        // Column might already exist
      }
    }
  }

  console.log("✅ Database initialized (v2.1)");
}
