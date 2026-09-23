import { parentPort, workerData } from "worker_threads";
import pg from "pg";
const { Client } = pg;
const client = new Client({connectionString:workerData.databaseUrl,ssl:false});
await client.connect();

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER DEFAULT 50,
  payload_json TEXT DEFAULT '{}',
  result_json TEXT,
  provider TEXT,
  cost_estimate DOUBLE PRECISION DEFAULT 0,
  cost_actual DOUBLE PRECISION DEFAULT 0,
  requires_approval INTEGER DEFAULT 0,
  approved_at TIMESTAMPTZ,
  approved_by BIGINT,
  idempotency_key TEXT UNIQUE,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS approvals (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  expected_cost DOUBLE PRECISION DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by BIGINT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  event TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS assets (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  size_bytes BIGINT DEFAULT 0,
  public INTEGER DEFAULT 0,
  source_asset_id BIGINT,
  metadata_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedupe ON leads(lower(name),coalesce(phone,''),coalesce(email,''));
CREATE TABLE IF NOT EXISTS content_items (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  platform TEXT,
  format TEXT,
  objective TEXT,
  hook TEXT,
  body TEXT,
  caption TEXT,
  cta TEXT,
  status TEXT DEFAULT 'draft',
  asset_id BIGINT,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  external_post_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS analytics (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  content_id BIGINT,
  metric TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  measured_at TIMESTAMPTZ DEFAULT NOW(),
  raw_json TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS spend (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT,
  category TEXT,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'USD',
  credits DOUBLE PRECISION DEFAULT 0,
  job_id BIGINT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS brand_knowledge (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS voc_items (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT,
  source_url TEXT,
  external_id TEXT,
  text TEXT NOT NULL,
  category TEXT,
  sentiment TEXT,
  intent TEXT,
  content_idea TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS voc_external_dedupe ON voc_items(platform,external_id);
CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  objective TEXT,
  audience_json TEXT DEFAULT '{}',
  budget DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'draft',
  external_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS experiments (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  hypothesis TEXT,
  variant_a TEXT,
  variant_b TEXT,
  metric TEXT,
  status TEXT DEFAULT 'planned',
  result_json TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;
await client.query(schema);

function translate(sql,args){
  let q=sql;
  q=q.replace(/datetime\('now'\)/gi,"NOW()");
  q=q.replace(/datetime\('now',\?\)/gi,"?");
  q=q.replace(/strftime\('%Y-%m',created_at\)=strftime\('%Y-%m','now'\)/gi,"to_char(created_at,'YYYY-MM')=to_char(NOW(),'YYYY-MM')");
  q=q.replace(/cast\(strftime\('%w',coalesce\(c\.published_at,c\.scheduled_at\)\) as integer\)/gi,"CAST(EXTRACT(DOW FROM COALESCE(c.published_at,c.scheduled_at)) AS INTEGER)");
  q=q.replace(/cast\(strftime\('%H',coalesce\(c\.published_at,c\.scheduled_at\)\) as integer\)/gi,"CAST(EXTRACT(HOUR FROM COALESCE(c.published_at,c.scheduled_at)) AS INTEGER)");
  let i=0;
  q=q.replace(/\?/g,()=>'$'+(++i));
  return {q,args};
}
function maybeReturning(sql){
  const m=sql.trim().match(/^INSERT\s+INTO\s+([a-zA-Z0-9_]+)/i);
  if(!m||/\bRETURNING\b/i.test(sql))return sql;
  const table=m[1].toLowerCase();
  if(["settings","sessions"].includes(table))return sql;
  return sql.replace(/;?\s*$/," RETURNING id");
}
function writeResult(sab,payload){
  const header=new Int32Array(sab,0,2), bytes=new Uint8Array(sab,8);
  const encoded=new TextEncoder().encode(JSON.stringify(payload));
  if(encoded.length>bytes.length) {
    const err=new TextEncoder().encode(JSON.stringify({ok:false,error:"result_too_large"}));
    bytes.set(err.subarray(0,bytes.length)); Atomics.store(header,1,Math.min(err.length,bytes.length));
  } else { bytes.set(encoded); Atomics.store(header,1,encoded.length); }
  Atomics.store(header,0,1); Atomics.notify(header,0,1);
}
parentPort.on("message",async msg=>{
  const {sab,type,sql,args=[]}=msg;
  try{
    let {q}=translate(sql,args);
    if(type==="run")q=maybeReturning(q);
    if(/datetime\('now',\$\d+\)/i.test(q)){
      // not expected after server-side expiry computation
    }
    const r=await client.query(q,args);
    if(type==="one")writeResult(sab,{ok:true,value:r.rows[0]||null});
    else if(type==="all")writeResult(sab,{ok:true,value:r.rows||[]});
    else writeResult(sab,{ok:true,value:{changes:r.rowCount,lastInsertRowid:r.rows?.[0]?.id?Number(r.rows[0].id):0}});
  }catch(e){writeResult(sab,{ok:false,error:String(e.message||e),code:e.code||null});}
});
