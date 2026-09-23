import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "worker_threads";

export const DATA_DIR=process.env.DATA_DIR||"/data";
fs.mkdirSync(DATA_DIR,{recursive:true});
fs.mkdirSync(path.join(DATA_DIR,"uploads"),{recursive:true});
fs.mkdirSync(path.join(DATA_DIR,"renders"),{recursive:true});

const databaseUrl=process.env.DATABASE_URL||"";
const sqlitePath=path.join(DATA_DIR,"tara-viora.db");
export const dbMode=databaseUrl?"POSTGRES":"SQLITE_PERSISTENT";

let sqlite=null,worker=null;
if(databaseUrl){
  worker=new Worker(new URL("./db_worker.js",import.meta.url),{workerData:{databaseUrl}});
}else{
  sqlite=new DatabaseSync(sqlitePath);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'owner',created_at TEXT DEFAULT CURRENT_TIMESTAMP,last_login_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',priority INTEGER DEFAULT 50,payload_json TEXT DEFAULT '{}',result_json TEXT,provider TEXT,cost_estimate REAL DEFAULT 0,cost_actual REAL DEFAULT 0,requires_approval INTEGER DEFAULT 0,approved_at TEXT,approved_by INTEGER,idempotency_key TEXT UNIQUE,error TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT,job_id INTEGER NOT NULL,action_type TEXT NOT NULL,summary TEXT NOT NULL,expected_cost REAL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',decided_by INTEGER,decided_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,event TEXT NOT NULL,entity_type TEXT,entity_id TEXT,metadata_json TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS assets (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,mime TEXT,size_bytes INTEGER DEFAULT 0,public INTEGER DEFAULT 0,source_asset_id INTEGER,metadata_json TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,category TEXT,area TEXT,phone TEXT,email TEXT,website TEXT,source_url TEXT,fit_score INTEGER DEFAULT 0,priority TEXT,notes TEXT,consent_status TEXT DEFAULT 'unknown',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedupe ON leads(lower(name),coalesce(phone,''),coalesce(email,''));
CREATE TABLE IF NOT EXISTS content_items (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,platform TEXT,format TEXT,objective TEXT,hook TEXT,body TEXT,caption TEXT,cta TEXT,status TEXT DEFAULT 'draft',asset_id INTEGER,scheduled_at TEXT,published_at TEXT,external_post_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,content_id INTEGER,metric TEXT NOT NULL,value REAL NOT NULL,measured_at TEXT DEFAULT CURRENT_TIMESTAMP,raw_json TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,category TEXT,amount REAL NOT NULL,currency TEXT DEFAULT 'USD',credits REAL DEFAULT 0,job_id INTEGER,note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS brand_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS voc_items (id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT,source_url TEXT,external_id TEXT,text TEXT NOT NULL,category TEXT,sentiment TEXT,intent TEXT,content_idea TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS voc_external_dedupe ON voc_items(platform,external_id);
CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,platform TEXT,objective TEXT,audience_json TEXT DEFAULT '{}',budget REAL DEFAULT 0,status TEXT DEFAULT 'draft',external_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS experiments (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,hypothesis TEXT,variant_a TEXT,variant_b TEXT,metric TEXT,status TEXT DEFAULT 'planned',result_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS growth_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  content_id INTEGER,
  campaign_id INTEGER,
  signal_type TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  dimension_json TEXT DEFAULT '{}',
  measured_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS winning_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  score REAL DEFAULT 0,
  evidence_count INTEGER DEFAULT 0,
  metrics_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'learning',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform,pattern_type,pattern_key)
);
CREATE TABLE IF NOT EXISTS customer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  customer_key_hash TEXT,
  event_type TEXT NOT NULL,
  content_id INTEGER,
  campaign_id INTEGER,
  value REAL DEFAULT 0,
  consent_status TEXT DEFAULT 'unknown',
  metadata_json TEXT DEFAULT '{}',
  occurred_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS budget_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER,
  platform TEXT,
  action TEXT NOT NULL,
  current_budget REAL DEFAULT 0,
  suggested_budget REAL DEFAULT 0,
  reason TEXT,
  confidence REAL DEFAULT 0,
  status TEXT DEFAULT 'proposed',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS platform_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  published_at TEXT,
  impact TEXT DEFAULT 'review',
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_updates_source_dedupe ON platform_updates(source_url);
CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS integration_secrets (
  provider TEXT NOT NULL,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider,key)
);
`);
}

function callSync(type,sql,args=[]){
  if(!worker){
    const st=sqlite.prepare(sql);
    if(type==="one")return st.get(...args)||null;
    if(type==="all")return st.all(...args);
    return st.run(...args);
  }
  const sab=new SharedArrayBuffer(8+1024*1024),head=new Int32Array(sab,0,2);
  worker.postMessage({sab,type,sql,args});
  const wait=Atomics.wait(head,0,0,30000);
  if(wait==="timed-out")throw new Error("database_timeout");
  const len=Atomics.load(head,1),txt=new TextDecoder().decode(new Uint8Array(sab,8,len));
  const payload=JSON.parse(txt||"{}");
  if(!payload.ok)throw new Error(payload.error||"database_error");
  return payload.value;
}
export function one(sql,...args){return callSync("one",sql,args)}
export function all(sql,...args){return callSync("all",sql,args)}
export function run(sql,...args){return callSync("run",sql,args)}
export function json(v,fallback={}){try{return JSON.parse(v||"")}catch{return fallback}}
export function audit(event,{userId=null,entityType=null,entityId=null,metadata={}}={}){
  run("INSERT INTO audit_log(user_id,event,entity_type,entity_id,metadata_json) VALUES(?,?,?,?,?)",userId,event,entityType,entityId==null?null:String(entityId),JSON.stringify(metadata));
}
export function setting(key,value){
  if(value===undefined){const r=one("SELECT value FROM settings WHERE key=?",key);return r?.value??null}
  run("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",key,String(value));return value;
}

function migrateLegacySqlite(){
  if(!databaseUrl||!fs.existsSync(sqlitePath))return;
  try{
    const done=one("SELECT value FROM settings WHERE key=?","legacy_sqlite_migrated_v1");
    if(done?.value==="1")return;
    const legacy=new DatabaseSync(sqlitePath,{readOnly:true});
    const tables=["settings","users","sessions","jobs","approvals","audit_log","assets","leads","content_items","analytics","spend","brand_knowledge","voc_items","campaigns","experiments"];
    const existing=new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
    for(const table of tables){
      if(!existing.has(table))continue;
      const rows=legacy.prepare(`SELECT * FROM ${table}`).all();
      for(const row of rows){
        const cols=Object.keys(row); if(!cols.length)continue;
        const placeholders=cols.map(()=>"?").join(",");
        const vals=cols.map(c=>row[c]);
        try{run(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${placeholders}) ON CONFLICT DO NOTHING`,...vals)}catch{}
      }
    }
    for(const table of ["users","jobs","approvals","audit_log","assets","leads","content_items","analytics","spend","brand_knowledge","voc_items","campaigns","experiments"]){
      try{run(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}),1),1), true)`)}catch{}
    }
    run("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP","legacy_sqlite_migrated_v1","1");
    legacy.close();
  }catch{}
}
migrateLegacySqlite();

function seedBrand(){
  const c=Number(one("SELECT count(*) c FROM brand_knowledge")?.c||0);
  if(c===0){
    run("INSERT INTO brand_knowledge(kind,title,content) VALUES(?,?,?)","voice","Brand voice","فاخر، هادئ، علمي، غير مبالغ. نتجنب الوعود الطبية أو النتائج المضمونة.");
    run("INSERT INTO brand_knowledge(kind,title,content) VALUES(?,?,?)","rules","Execution rules","لا نشر، لا صرف إعلاني، لا إرسال ترويجي، ولا Final Render مدفوع بدون موافقة بشرية.");
    run("INSERT INTO brand_knowledge(kind,title,content) VALUES(?,?,?)","audience","Core audience","عملاء مستحضرات التجميل في لبنان، مع مسار B2B للصيدليات ومراكز التجميل والعيادات والموزعين.");
  }
}
seedBrand();

export const db={mode:dbMode};
