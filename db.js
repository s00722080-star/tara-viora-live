import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.DATA_DIR || "/data";
fs.mkdirSync(DATA_DIR,{recursive:true});
fs.mkdirSync(path.join(DATA_DIR,"uploads"),{recursive:true});
fs.mkdirSync(path.join(DATA_DIR,"renders"),{recursive:true});

export const db = new DatabaseSync(path.join(DATA_DIR,"tara-viora.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER DEFAULT 50,
  payload_json TEXT DEFAULT '{}',
  result_json TEXT,
  provider TEXT,
  cost_estimate REAL DEFAULT 0,
  cost_actual REAL DEFAULT 0,
  requires_approval INTEGER DEFAULT 0,
  approved_at TEXT,
  approved_by INTEGER,
  idempotency_key TEXT UNIQUE,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  expected_cost REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by INTEGER,
  decided_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  event TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER DEFAULT 0,
  public INTEGER DEFAULT 0,
  source_asset_id INTEGER,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  area TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  source_url TEXT,
  fit_score INTEGER DEFAULT 0,
  priority TEXT,
  notes TEXT,
  consent_status TEXT DEFAULT 'unknown',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedupe ON leads(lower(name),coalesce(phone,''),coalesce(email,''));
CREATE TABLE IF NOT EXISTS content_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  platform TEXT,
  format TEXT,
  objective TEXT,
  hook TEXT,
  body TEXT,
  caption TEXT,
  cta TEXT,
  status TEXT DEFAULT 'draft',
  asset_id INTEGER,
  scheduled_at TEXT,
  published_at TEXT,
  external_post_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  content_id INTEGER,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  measured_at TEXT DEFAULT CURRENT_TIMESTAMP,
  raw_json TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  category TEXT,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  credits REAL DEFAULT 0,
  job_id INTEGER,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS brand_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const seed = db.prepare("SELECT count(*) c FROM brand_knowledge").get().c;
if(!seed){
  const ins=db.prepare("INSERT INTO brand_knowledge(kind,title,content) VALUES(?,?,?)");
  ins.run("voice","Brand voice","فاخر، هادئ، علمي، غير مبالغ. نتجنب الوعود الطبية أو النتائج المضمونة.");
  ins.run("rules","Execution rules","لا نشر، لا صرف إعلاني، لا إرسال ترويجي، ولا Final Render مدفوع بدون موافقة بشرية.");
  ins.run("audience","Core audience","عملاء مستحضرات التجميل في لبنان، مع مسار B2B للصيدليات ومراكز التجميل والعيادات والموزعين.");
}

export function one(sql,...args){ return db.prepare(sql).get(...args); }
export function all(sql,...args){ return db.prepare(sql).all(...args); }
export function run(sql,...args){ return db.prepare(sql).run(...args); }
export function json(v,fallback={}){ try{return JSON.parse(v||"")}catch{return fallback} }
export function audit(event,{userId=null,entityType=null,entityId=null,metadata={}}={}){
  run("INSERT INTO audit_log(user_id,event,entity_type,entity_id,metadata_json) VALUES(?,?,?,?,?)",
      userId,event,entityType,entityId==null?null:String(entityId),JSON.stringify(metadata));
}
export function setting(key,value){
  if(value===undefined){ const r=one("SELECT value FROM settings WHERE key=?",key); return r?.value??null; }
  run("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",key,String(value));
  return value;
}
export { DATA_DIR };
