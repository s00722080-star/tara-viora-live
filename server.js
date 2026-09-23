import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import multer from "multer";
import OpenAI from "openai";
import { db, dbMode, one, all, run, json, audit, setting, DATA_DIR } from "./db.js";

const app=express();
app.use(express.json({limit:"5mb",verify:(req,_res,buf)=>{req.rawBody=Buffer.from(buf)}}));
app.use(express.urlencoded({extended:true}));
const __filename=fileURLToPath(import.meta.url), __dirname=path.dirname(__filename);
const port=process.env.PORT||3000;
const client=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
const model=process.env.OPENAI_MODEL||"gpt-5.6-luna";
const n8nBase=String(process.env.N8N_BASE_URL||"").replace(/\/$/,"");
const sessionHours=Number(process.env.SESSION_HOURS||168);
const stagingMode=String(process.env.STAGING_MODE||"false").toLowerCase()==="true";

const uploadDir=path.join(DATA_DIR,"uploads");
const renderDir=path.join(DATA_DIR,"renders");
fs.mkdirSync(uploadDir,{recursive:true}); fs.mkdirSync(renderDir,{recursive:true});
const upload=multer({dest:uploadDir,limits:{fileSize:1024*1024*1024}});

const modules=[
"فيديو حقيقي ومونتاج بروفيشنال","توليد فيديو بالذكاء الاصطناعي","صور وإعلانات","Carousel","Motion Graphics",
"حملات ممولة","محتوى Organic","تحليل السوق","تحليل المنافسين","Trends & Hooks","تحليل التعليقات وصوت العميل",
"أفضل وقت للنشر","قاعدة بيانات العملاء والسوق B2B","Analytics","Budget / Credits","Approvals","WhatsApp"
];

function hashPassword(password,salt=crypto.randomBytes(16).toString("hex")){
  return {salt,hash:crypto.scryptSync(password,salt,64).toString("hex")};
}
function parseCookies(req){return Object.fromEntries(String(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return [decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));}
function tokenHash(t){return crypto.createHash("sha256").update(t).digest("hex")}
function authStatus(){return one("SELECT count(*) c FROM users").c>0}
function currentUser(req){
  const token=parseCookies(req).tv_session; if(!token)return null;
  const h=tokenHash(token);
  return one(`SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND expires_at>CURRENT_TIMESTAMP`,h)||null;
}
function requireAuth(req,res,next){const u=currentUser(req); if(!u)return res.status(401).json({ok:false,error:"auth_required"}); req.user=u; next();}
function setSession(res,userId){
  const token=crypto.randomBytes(32).toString("hex"), h=tokenHash(token);
  run("DELETE FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP");
  const expires=new Date(Date.now()+sessionHours*3600*1000).toISOString();
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",h,userId,expires);
  res.setHeader("Set-Cookie",`tv_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionHours*3600}`);
}
function routeCommand(q=""){
  if(/فيديو|ريل|reel/i.test(q)) return 0;
  if(/صورة|صور|اعلان بصري/i.test(q)) return 2;
  if(/كاروسيل|carousel/i.test(q)) return 3;
  if(/موشن|motion/i.test(q)) return 4;
  if(/اعلان|حملة|ممول/i.test(q)) return 5;
  if(/سوق/i.test(q)) return 7;
  if(/منافس/i.test(q)) return 8;
  if(/ترند|hook|هوك/i.test(q)) return 9;
  if(/تعليق|صوت العميل|voc/i.test(q)) return 10;
  if(/وقت النشر|افضل وقت/i.test(q)) return 11;
  if(/صيدلي|عياد|b2b|داتا|موزع/i.test(q)) return 12;
  if(/تحليل نتائج|analytics|اداء/i.test(q)) return 13;
  if(/ميزانية|كريدت|budget/i.test(q)) return 14;
  if(/موافقة|approval/i.test(q)) return 15;
  if(/واتساب|whatsapp/i.test(q)) return 16;
  return 6;
}
function brandContext(){
  return all("SELECT kind,title,content FROM brand_knowledge WHERE active=1 ORDER BY id").map(x=>`[${x.kind}] ${x.title}: ${x.content}`).join("\n");
}
function safeJson(v){try{return JSON.parse(v)}catch{return {raw:v}}}
const encSecret=String(process.env.APP_ENCRYPTION_KEY||"");
function vaultKey(){if(!encSecret)throw new Error("encryption_key_missing");return crypto.createHash("sha256").update(encSecret).digest();}
function encryptValue(value){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",vaultKey(),iv);
  const enc=Buffer.concat([cipher.update(String(value),"utf8"),cipher.final()]),tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString("base64");
}
function decryptValue(blob){
  const b=Buffer.from(String(blob||""),"base64"),iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28);
  const decipher=crypto.createDecipheriv("aes-256-gcm",vaultKey(),iv);decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc),decipher.final()]).toString("utf8");
}
function putSecret(provider,key,value){
  run("INSERT INTO integration_secrets(provider,key,value_enc,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(provider,key) DO UPDATE SET value_enc=excluded.value_enc,updated_at=CURRENT_TIMESTAMP",provider,key,encryptValue(value));
}
function getSecret(provider,key){
  const r=one("SELECT value_enc FROM integration_secrets WHERE provider=? AND key=?",provider,key);
  if(!r)return null;try{return decryptValue(r.value_enc)}catch{return null}
}
function hasSecret(provider,key){return Boolean(one("SELECT 1 v FROM integration_secrets WHERE provider=? AND key=?",provider,key))}
function publicBaseUrl(){return "https://"+String(process.env.RAILWAY_PUBLIC_DOMAIN||"tara-viora-live-production.up.railway.app").replace(/^https?:\/\//,"").replace(/\/$/,"")}
async function tiktokAccessToken(){
  const access=getSecret("tiktok","access_token"),exp=Number(getSecret("tiktok","expires_at")||0);
  if(access && Date.now()<exp-120000)return access;
  const refresh=getSecret("tiktok","refresh_token"),clientKey=getSecret("tiktok","client_key"),clientSecret=getSecret("tiktok","client_secret");
  if(!refresh||!clientKey||!clientSecret)return null;
  const body=new URLSearchParams({client_key:clientKey,client_secret:clientSecret,grant_type:"refresh_token",refresh_token:refresh});
  const r=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const d=await r.json().catch(()=>({}));if(!r.ok||!d.access_token)throw new Error("tiktok_refresh_failed");
  putSecret("tiktok","access_token",d.access_token);if(d.refresh_token)putSecret("tiktok","refresh_token",d.refresh_token);
  putSecret("tiktok","expires_at",String(Date.now()+Number(d.expires_in||86400)*1000));if(d.open_id)putSecret("tiktok","open_id",d.open_id);
  return d.access_token;
}
async function postN8n(pathName,body){
  if(!n8nBase) throw new Error("n8n_not_connected");
  const r=await fetch(`${n8nBase}/webhook/${pathName}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const raw=await r.text(); return {ok:r.ok,status:r.status,data:safeJson(raw)};
}
function createJob({type,title,payload={},provider=null,requiresApproval=false,costEstimate=0,idempotencyKey=null,status="queued"}){
  const key=idempotencyKey||crypto.randomUUID();
  const r=run("INSERT INTO jobs(type,title,status,payload_json,provider,cost_estimate,requires_approval,idempotency_key,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
    type,title,status,JSON.stringify(payload),provider,costEstimate,requiresApproval?1:0,key);
  const id=Number(r.lastInsertRowid);
  if(requiresApproval){
    run("INSERT INTO approvals(job_id,action_type,summary,expected_cost) VALUES(?,?,?,?)",id,type,title,costEstimate);
    run("UPDATE jobs SET status='waiting_approval' WHERE id=?",id);
  }
  return id;
}
function createContentDraftLocal(q){
  return {hook:`قبل ما تختاري المنتج، اسألي عن هذا التفصيل: ${q}`,body:`مسودة أولية مبنية على هوية TARA VIORA: ${q}`,caption:`TARA VIORA — معرفة أوضح، اختيار أهدأ. ${q}`,cta:"احفظي المنشور وراجعي التفاصيل قبل القرار."};
}

// Auth
app.get("/api/auth/status",(req,res)=>res.json({ok:true,configured:authStatus(),authenticated:Boolean(currentUser(req)),user:currentUser(req)}));
app.post("/api/auth/setup",(req,res)=>{
  if(authStatus())return res.status(409).json({ok:false,error:"already_configured"});
  const username=String(req.body?.username||"owner").trim(), password=String(req.body?.password||"");
  if(password.length<10)return res.status(400).json({ok:false,error:"password_min_10"});
  const {salt,hash}=hashPassword(password);
  const r=run("INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,'owner')",username,hash,salt);
  setSession(res,Number(r.lastInsertRowid)); audit("owner_setup",{userId:Number(r.lastInsertRowid)});
  res.json({ok:true});
});
app.post("/api/auth/login",(req,res)=>{
  const username=String(req.body?.username||"").trim(), password=String(req.body?.password||"");
  const u=one("SELECT * FROM users WHERE username=?",username);
  if(!u)return res.status(401).json({ok:false,error:"invalid_login"});
  const {hash}=hashPassword(password,u.salt);
  if(!crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(u.password_hash)))return res.status(401).json({ok:false,error:"invalid_login"});
  setSession(res,u.id); run("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?",u.id); audit("login",{userId:u.id});
  res.json({ok:true,user:{id:u.id,username:u.username,role:u.role}});
});
app.post("/api/auth/logout",requireAuth,(req,res)=>{
  const t=parseCookies(req).tv_session; if(t)run("DELETE FROM sessions WHERE token_hash=?",tokenHash(t));
  res.setHeader("Set-Cookie","tv_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"); res.json({ok:true});
});

// Health & setup-safe status
app.get("/health",(_req,res)=>res.json({ok:true,app:"TARA VIORA Command Center",db:dbMode,dataDir:DATA_DIR}));
app.get("/health/ready",(_req,res)=>{
  let dbOk=false,volumeOk=false,ffmpegOk=false;
  try{dbOk=Number(one("SELECT 1 v").v)===1}catch{}
  try{const p=path.join(DATA_DIR,".ready");fs.writeFileSync(p,"ok");volumeOk=fs.readFileSync(p,"utf8")==="ok";fs.unlinkSync(p)}catch{}
  try{ffmpegOk=spawnSync("ffmpeg",["-version"],{stdio:"ignore"}).status===0}catch{}
  const ok=dbOk&&volumeOk&&ffmpegOk;
  res.status(ok?200:503).json({ok,db:dbOk,volume:volumeOk,ffmpeg:ffmpegOk,mode:stagingMode?"STAGING":"PRODUCTION",commit:process.env.RAILWAY_GIT_COMMIT_SHA||process.env.RAILWAY_GIT_COMMIT||"unknown"});
});
app.get("/health/deep",async(_req,res)=>{
  let dbOk=false,volumeOk=false,ffmpegOk=false,n8nOk=false,higgsfield="UNKNOWN";
  try{dbOk=Number(one("SELECT 1 v").v)===1;}catch{}
  try{const p=path.join(DATA_DIR,".health");fs.writeFileSync(p,"ok");volumeOk=fs.readFileSync(p,"utf8")==="ok";fs.unlinkSync(p);}catch{}
  try{ffmpegOk=spawnSync("ffmpeg",["-version"],{stdio:"ignore"}).status===0;}catch{}
  if(n8nBase){try{const r=await postN8n("tara-viora-higgsfield-check",{source:"deep-health"});n8nOk=r.ok;higgsfield=r.data?.provider||"UNKNOWN";}catch{}}
  const ok=dbOk&&volumeOk&&ffmpegOk&&n8nOk&&higgsfield==="HIGGSFIELD_READY";
  res.status(ok?200:503).json({ok,db:dbOk?"READY":"ERROR",volume:volumeOk?"READY":"ERROR",ffmpeg:ffmpegOk?"READY":"ERROR",n8n:n8nOk?"READY":"ERROR",higgsfield});
});
app.get("/api/status",(req,res)=>res.json({ok:true,configured:authStatus(),executive:client?"OPENAI_CONFIGURED":"LOCAL_ROUTER",n8n:n8nBase?"CONNECTED":"NOT_CONNECTED",model}));
app.get("/api/maintenance/status",requireAuth,(req,res)=>res.json({ok:true,...maintenanceState}));
app.post("/api/maintenance/run",requireAuth,async(req,res)=>{
  try{const r=await maintenanceCycle({manual:true,userId:req.user?.id||null});res.json({ok:true,...r})}
  catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}
});



// Self-healing maintenance bot
let maintenanceState={lastRun:null,status:"IDLE",checks:{},repairs:[],errors:[]};

async function maintenanceCycle({manual=false,userId=null}={}){
  const checks={},repairs=[],errors=[];
  const started=new Date().toISOString();
  maintenanceState={lastRun:started,status:"RUNNING",checks:{},repairs:[],errors:[]};

  try{
    checks.database=Number(one("SELECT 1 v")?.v)===1?"READY":"ERROR";
  }catch(e){checks.database="ERROR";errors.push("database:"+String(e.message||e))}

  try{
    const hp=path.join(DATA_DIR,".maintenance-health");
    fs.writeFileSync(hp,"ok");checks.volume=fs.readFileSync(hp,"utf8")==="ok"?"READY":"ERROR";fs.unlinkSync(hp);
  }catch(e){checks.volume="ERROR";errors.push("volume:"+String(e.message||e))}

  try{checks.ffmpeg=spawnSync("ffmpeg",["-version"],{stdio:"ignore"}).status===0?"READY":"ERROR"}catch(e){checks.ffmpeg="ERROR";errors.push("ffmpeg:"+String(e.message||e))}

  try{
    const before=one("SELECT COUNT(*) c FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP")?.c||0;
    if(Number(before)>0){run("DELETE FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP");repairs.push(`expired_sessions_cleaned:${before}`)}
    checks.sessions="READY";
  }catch(e){checks.sessions="ERROR";errors.push("sessions:"+String(e.message||e))}

  try{
    const stale=all("SELECT id FROM jobs WHERE status IN ('running','queued') AND updated_at < CURRENT_TIMESTAMP - INTERVAL '2 hours' LIMIT 50");
    for(const j of stale){run("UPDATE jobs SET status='failed',error='maintenance_stale_job',updated_at=CURRENT_TIMESTAMP WHERE id=?",j.id)}
    if(stale.length)repairs.push(`stale_jobs_closed:${stale.length}`);
    checks.jobs="READY";
  }catch(e){
    // SQLite fallback syntax
    try{
      const stale=all("SELECT id FROM jobs WHERE status IN ('running','queued') AND datetime(updated_at) < datetime('now','-2 hours') LIMIT 50");
      for(const j of stale){run("UPDATE jobs SET status='failed',error='maintenance_stale_job',updated_at=CURRENT_TIMESTAMP WHERE id=?",j.id)}
      if(stale.length)repairs.push(`stale_jobs_closed:${stale.length}`);
      checks.jobs="READY";
    }catch(e2){checks.jobs="ERROR";errors.push("jobs:"+String(e2.message||e2))}
  }

  if(n8nBase){
    try{
      const r=await postN8n("tara-viora-higgsfield-check",{source:"maintenance-bot"});
      checks.n8n=r.ok?"READY":"ERROR";
      checks.higgsfield=r.data?.provider||"UNKNOWN";
    }catch(e){checks.n8n="ERROR";checks.higgsfield="ERROR";errors.push("n8n:"+String(e.message||e))}
  }else{checks.n8n="NOT_CONNECTED";checks.higgsfield="NOT_CONNECTED"}

  try{
    if(hasSecret("tiktok","refresh_token")){
      const token=await tiktokAccessToken();
      checks.tiktok=token?"CONNECTED":"ERROR";
      checks.tiktokPublish=String(getSecret("tiktok","scope")||"").split(",").map(x=>x.trim()).includes("video.publish")?"READY":"WAITING";
      if(token)repairs.push("tiktok_token_checked");
    }else{checks.tiktok="NOT_CONNECTED";checks.tiktokPublish="WAITING"}
  }catch(e){checks.tiktok="REAUTH_REQUIRED";checks.tiktokPublish="WAITING";errors.push("tiktok:"+String(e.message||e))}

  try{
    const pending=all("SELECT id,result_json FROM jobs WHERE type='tiktok_publish' AND status='submitted' ORDER BY id DESC LIMIT 20");
    for(const job of pending){
      const stored=json(job.result_json,{})||{};
      const publishId=stored?.publish?.data?.publish_id||stored?.publish_id;
      if(!publishId)continue;
      try{
        const token=await tiktokAccessToken();if(!token)break;
        const r=await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/",{
          method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json; charset=UTF-8"},
          body:JSON.stringify({publish_id:publishId})
        });
        const d=await r.json().catch(()=>({}));
        if(r.ok&&d?.error?.code==="ok"){
          const st=String(d?.data?.status||"UNKNOWN");
          const mapped=st==="PUBLISH_COMPLETE"?"completed":st==="FAILED"?"failed":"submitted";
          const merged={...stored,tiktokStatus:d.data,statusCheckedAt:new Date().toISOString()};
          run("UPDATE jobs SET status=?,result_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
            mapped,JSON.stringify(merged),st==="FAILED"?String(d?.data?.fail_reason||"tiktok_publish_failed"):null,job.id);
          if(mapped!=="submitted")repairs.push(`tiktok_job_${job.id}_${mapped}`);
        }
      }catch(e){errors.push(`tiktok_job_${job.id}:`+String(e.message||e))}
    }
    checks.tiktokJobs="READY";
  }catch(e){checks.tiktokJobs="ERROR";errors.push("tiktokJobs:"+String(e.message||e))}

  const critical=["database","volume","ffmpeg"].some(k=>checks[k]==="ERROR");
  const degraded=errors.length>0||Object.values(checks).some(v=>["ERROR","REAUTH_REQUIRED"].includes(v));
  const status=critical?"CRITICAL":degraded?"DEGRADED":"HEALTHY";
  maintenanceState={lastRun:new Date().toISOString(),status,checks,repairs,errors};
  try{audit("maintenance_cycle",{userId,entityType:"maintenance",metadata:{manual,status,checks,repairs,errors}})}catch{}
  return maintenanceState;
}

setInterval(()=>{maintenanceCycle().catch(()=>{})},10*60*1000);
setTimeout(()=>{maintenanceCycle().catch(()=>{})},30*1000);

// Public platform webhooks (verification + inbound events)
app.get("/webhooks/meta",(req,res)=>{
  const token=process.env.WEBHOOK_VERIFY_TOKEN;
  if(token && req.query["hub.mode"]==="subscribe" && req.query["hub.verify_token"]===token) return res.status(200).send(String(req.query["hub.challenge"]||""));
  return res.sendStatus(403);
});
app.post("/webhooks/meta",(req,res)=>{
  try{
    const secret=process.env.META_APP_SECRET;
    if(secret){
      const sig=String(req.headers["x-hub-signature-256"]||"");
      const expected="sha256="+crypto.createHmac("sha256",secret).update(req.rawBody||Buffer.from(JSON.stringify(req.body||{}))).digest("hex");
      if(sig && sig!==expected)return res.sendStatus(403);
    }
    const entries=Array.isArray(req.body?.entry)?req.body.entry:[];
    for(const entry of entries){
      const changes=Array.isArray(entry.changes)?entry.changes:[];
      for(const ch of changes){
        const v=ch.value||{};
        const messages=Array.isArray(v.messages)?v.messages:[];
        for(const m of messages){
          const txt=m?.text?.body||m?.button?.text||m?.interactive?.button_reply?.title||"";
          if(txt){
            try{run("INSERT INTO voc_items(platform,external_id,text,category,sentiment,intent,content_idea) VALUES(?,?,?,?,?,?,?)",
              "whatsapp",m.id||null,String(txt),"inbound","neutral","customer_message","راجع الرسالة وحوّل الأسئلة المتكررة إلى محتوى");}catch{}
          }
        }
        const comments=Array.isArray(v.comments)?v.comments:[];
        for(const c of comments){
          const txt=c?.text||c?.message||"";if(!txt)continue;
          try{run("INSERT INTO voc_items(platform,external_id,text,category,sentiment,intent,content_idea) VALUES(?,?,?,?,?,?,?)",
            "instagram",c.id||null,String(txt),"comment","neutral","social_comment","حوّل السؤال أو الاعتراض إلى Hook أو FAQ");}catch{}
        }
      }
    }
    audit("meta_webhook_received",{entityType:"webhook",metadata:{entries:entries.length}});
  }catch{}
  res.sendStatus(200);
});

// TikTok OAuth callback (public, state-protected)
app.get("/oauth/tiktok/callback",async(req,res)=>{
  const cookies=parseCookies(req),state=String(req.query.state||""),expected=String(cookies.tv_tiktok_state||"");
  if(!state||!expected||state!==expected)return res.status(403).send("TikTok OAuth state mismatch");
  const code=String(req.query.code||"");if(!code)return res.status(400).send("TikTok authorization was not completed.");
  const clientKey=getSecret("tiktok","client_key"),clientSecret=getSecret("tiktok","client_secret");
  if(!clientKey||!clientSecret)return res.status(503).send("TikTok developer credentials are not configured.");
  try{
    const redirectUri=publicBaseUrl()+"/oauth/tiktok/callback";
    const body=new URLSearchParams({client_key:clientKey,client_secret:clientSecret,code,grant_type:"authorization_code",redirect_uri:redirectUri});
    const r=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.access_token)throw new Error(d.error_description||d.error||"token_exchange_failed");
    putSecret("tiktok","access_token",d.access_token);if(d.refresh_token)putSecret("tiktok","refresh_token",d.refresh_token);
    if(d.open_id)putSecret("tiktok","open_id",d.open_id);if(d.scope)putSecret("tiktok","scope",d.scope);
    putSecret("tiktok","expires_at",String(Date.now()+Number(d.expires_in||86400)*1000));
    res.setHeader("Set-Cookie","tv_tiktok_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    return res.redirect("/?integration=tiktok-connected");
  }catch(e){return res.status(502).send("TikTok connection failed: "+String(e.message||e));}
});

// Everything below is private
app.use("/api", (req,res,next)=>{
  if(["/auth/status","/auth/setup","/auth/login","/status"].includes(req.path)) return next();
  return requireAuth(req,res,next);
});

app.post("/api/integrations/credentials",(req,res)=>{
  const provider=String(req.body?.provider||"").toLowerCase(),fields=req.body?.fields||{};
  const allowed={
    tiktok:["client_key","client_secret"],
    meta:["app_id","app_secret","access_token","page_id","ig_user_id","graph_version"],
    whatsapp:["access_token","phone_number_id","verify_token","app_secret"],
    elevenlabs:["api_key"]
  };
  if(!allowed[provider])return res.status(400).json({ok:false,error:"provider_not_supported"});
  let saved=0;for(const k of allowed[provider]){const v=fields[k];if(typeof v==="string"&&v.trim()){putSecret(provider,k,v.trim());saved++;}}
  audit("integration_credentials_updated",{userId:req.user.id,entityType:"integration",entityId:provider,metadata:{saved,keys:Object.keys(fields).filter(k=>allowed[provider].includes(k))}});
  res.json({ok:true,provider,saved});
});
app.get("/api/integrations/tiktok/connect",(req,res)=>{
  const clientKey=getSecret("tiktok","client_key");if(!clientKey)return res.status(409).json({ok:false,error:"tiktok_developer_credentials_required"});
  const state=crypto.randomBytes(24).toString("hex"),redirectUri=publicBaseUrl()+"/oauth/tiktok/callback";
  res.setHeader("Set-Cookie",`tv_tiktok_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  const q=new URLSearchParams({client_key:clientKey,response_type:"code",scope:"user.info.basic",redirect_uri:redirectUri,state});
  res.json({ok:true,authorizeUrl:"https://www.tiktok.com/v2/auth/authorize/?"+q.toString(),redirectUri});
});
app.get("/api/integrations/tiktok/connect-publish",(req,res)=>{
  const clientKey=getSecret("tiktok","client_key");if(!clientKey)return res.status(409).json({ok:false,error:"tiktok_developer_credentials_required"});
  const state=crypto.randomBytes(24).toString("hex"),redirectUri=publicBaseUrl()+"/oauth/tiktok/callback";
  res.setHeader("Set-Cookie",`tv_tiktok_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  const q=new URLSearchParams({client_key:clientKey,response_type:"code",scope:"user.info.basic,video.publish",redirect_uri:redirectUri,state});
  res.json({ok:true,authorizeUrl:"https://www.tiktok.com/v2/auth/authorize/?"+q.toString(),redirectUri});
});
app.get("/api/integrations/tiktok/check",async(req,res)=>{
  try{
    const token=await tiktokAccessToken();
    if(!token)return res.json({ok:false,provider:"TIKTOK_NOT_CONNECTED"});
    const openId=getSecret("tiktok","open_id");
    const scope=getSecret("tiktok","scope")||"";
    const expiresAt=Number(getSecret("tiktok","expires_at")||0);
    try{
      const r=await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",{headers:{Authorization:`Bearer ${token}`}});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d?.data?.user){
        return res.json({ok:true,provider:"TIKTOK_CONNECTED",user:d.data.user,scope,expiresAt,check:"live_api"});
      }
      // Sandbox/basic-login fallback: OAuth itself succeeded and a non-expired token is stored.
      if(openId && (!expiresAt || Date.now()<expiresAt)){
        return res.json({ok:true,provider:"TIKTOK_CONNECTED",user:{open_id:openId},scope,expiresAt,check:"oauth_token",warning:d?.error||null});
      }
      return res.status(502).json({ok:false,provider:"TIKTOK_AUTH_ERROR",error:d?.error||null});
    }catch(inner){
      if(openId && (!expiresAt || Date.now()<expiresAt)){
        return res.json({ok:true,provider:"TIKTOK_CONNECTED",user:{open_id:openId},scope,expiresAt,check:"oauth_token",warning:String(inner.message||inner)});
      }
      throw inner;
    }
  }catch(e){res.status(502).json({ok:false,provider:"TIKTOK_AUTH_ERROR",error:String(e.message||e)})}
});
app.post("/api/integrations/elevenlabs/check",async(req,res)=>{
  const key=getSecret("elevenlabs","api_key");if(!key)return res.status(409).json({ok:false,provider:"NOT_CONNECTED"});
  try{const r=await fetch("https://api.elevenlabs.io/v1/models",{headers:{"xi-api-key":key}});res.status(r.ok?200:502).json({ok:r.ok,provider:r.ok?"ELEVENLABS_READY":"ELEVENLABS_AUTH_ERROR"});}catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
});
app.post("/api/integrations/meta/check",async(req,res)=>{
  const token=getSecret("meta","access_token");if(!token)return res.status(409).json({ok:false,provider:"NOT_CONNECTED"});
  const version=getSecret("meta","graph_version")||process.env.META_GRAPH_VERSION||"v24.0";
  try{const r=await fetch(`https://graph.facebook.com/${version}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);const d=await r.json().catch(()=>({}));res.status(r.ok?200:502).json({ok:r.ok,provider:r.ok?"META_READY":"META_AUTH_ERROR",account:r.ok?{id:d.id,name:d.name}:null});}catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
});
app.post("/api/integrations/whatsapp/check",async(req,res)=>{
  const token=getSecret("whatsapp","access_token"),phoneId=getSecret("whatsapp","phone_number_id");if(!token||!phoneId)return res.status(409).json({ok:false,provider:"NOT_CONNECTED"});
  const version=getSecret("meta","graph_version")||process.env.META_GRAPH_VERSION||"v24.0";
  try{const r=await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`);const d=await r.json().catch(()=>({}));res.status(r.ok?200:502).json({ok:r.ok,provider:r.ok?"WHATSAPP_READY":"WHATSAPP_AUTH_ERROR",phone:r.ok?d:null});}catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
});

app.get("/api/dashboard",(req,res)=>{
  const jobs=one("SELECT count(*) c FROM jobs").c, pending=one("SELECT count(*) c FROM approvals WHERE status='pending'").c;
  const leads=one("SELECT count(*) c FROM leads").c, assets=one("SELECT count(*) c FROM assets").c;
  const spend=one("SELECT coalesce(sum(amount),0) v FROM spend").v;
  res.json({ok:true,jobs,pendingApprovals:pending,leads,assets,spend});
});

app.get("/api/jobs",(req,res)=>res.json({ok:true,items:all("SELECT * FROM jobs ORDER BY id DESC LIMIT 200").map(x=>({...x,payload:json(x.payload_json),result:json(x.result_json,null)}))}));
app.post("/api/jobs",(req,res)=>{
  const b=req.body||{}; const id=createJob({type:String(b.type||"task"),title:String(b.title||"Untitled"),payload:b.payload||{},provider:b.provider||null,requiresApproval:Boolean(b.requiresApproval),costEstimate:Number(b.costEstimate||0)});
  audit("job_created",{userId:req.user.id,entityType:"job",entityId:id,metadata:{type:b.type}}); res.json({ok:true,id});
});

app.post("/api/tiktok/test-publish/prepare",(req,res)=>{
  const assetId=Number(req.body?.assetId||0);
  const existing=all("SELECT id,status,payload_json FROM jobs WHERE type='tiktok_publish' AND status IN ('waiting_approval','approved','submitted') ORDER BY id DESC LIMIT 50")
    .find(j=>Number(json(j.payload_json,{})?.assetId)===assetId);
  if(existing)return res.status(409).json({ok:false,error:"tiktok_test_job_already_active",jobId:existing.id,status:existing.status});
  const asset=one("SELECT id,name,mime,kind FROM assets WHERE id=?",assetId);
  if(!asset)return res.status(404).json({ok:false,error:"asset_not_found"});
  if(!String(asset.mime||"").startsWith("video/"))return res.status(400).json({ok:false,error:"video_asset_required"});
  const title=String(req.body?.title||"TARA VIORA TikTok private test").slice(0,2200);
  const payload={assetId,title,privacy_level:"SELF_ONLY",creatorConfirmed:true,brand_organic_toggle:true,is_aigc:false};
  const jobId=createJob({
    type:"tiktok_publish",
    title:`TikTok private test — Asset #${assetId} ${asset.name}`,
    payload,
    provider:"TIKTOK",
    requiresApproval:true,
    costEstimate:0,
    status:"waiting_approval"
  });
  audit("tiktok_test_publish_prepared",{userId:req.user.id,entityType:"job",entityId:jobId,metadata:{assetId,privacy:"SELF_ONLY"}});
  res.json({ok:true,jobId,asset,privacy:"SELF_ONLY"});
});

app.get("/api/approvals",(req,res)=>res.json({ok:true,items:all(`SELECT a.*,j.type,j.provider,j.status job_status,j.payload_json,j.result_json,j.error job_error FROM approvals a JOIN jobs j ON j.id=a.job_id ORDER BY a.id DESC`).map(x=>({...x,payload:json(x.payload_json),result:json(x.result_json,null)}))}));
app.post("/api/approvals/:id/decision",(req,res)=>{
  const id=Number(req.params.id), decision=String(req.body?.decision||"").toLowerCase();
  const approved=["approve","approved","موافقة","موافق"].includes(decision);
  const a=one("SELECT * FROM approvals WHERE id=?",id); if(!a)return res.status(404).json({ok:false,error:"not_found"});
  if(a.status!=="pending")return res.status(409).json({ok:false,error:"already_decided"});
  run("UPDATE approvals SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=?",approved?"approved":"rejected",req.user.id,id);
  run("UPDATE jobs SET status=?,approved_at=?,approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",approved?"approved":"rejected",approved?new Date().toISOString():null,approved?req.user.id:null,a.job_id);
  audit("approval_decision",{userId:req.user.id,entityType:"approval",entityId:id,metadata:{approved,jobId:a.job_id}});
  res.json({ok:true,approved,jobId:a.job_id});
});

app.get("/api/leads",(req,res)=>res.json({ok:true,items:all("SELECT * FROM leads ORDER BY fit_score DESC,id DESC")}));
app.post("/api/leads",(req,res)=>{
  const b=req.body||{}; const score=Math.max(0,Math.min(100,Number(b.fit_score||0))); const priority=score>=85?"A":score>=70?"B":score>=55?"C":"D";
  try{
    const r=run(`INSERT INTO leads(name,category,area,phone,email,website,source_url,fit_score,priority,notes,consent_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      String(b.name||"").trim(),b.category||null,b.area||null,b.phone||null,b.email||null,b.website||null,b.source_url||null,score,priority,b.notes||null,b.consent_status||"unknown");
    audit("lead_created",{userId:req.user.id,entityType:"lead",entityId:Number(r.lastInsertRowid)}); res.json({ok:true,id:Number(r.lastInsertRowid)});
  }catch(e){res.status(409).json({ok:false,error:"duplicate_or_invalid_lead"});}
});

app.get("/api/spend",(req,res)=>res.json({ok:true,items:all("SELECT * FROM spend ORDER BY id DESC")}));
app.post("/api/spend",(req,res)=>{
  const b=req.body||{}; const r=run("INSERT INTO spend(provider,category,amount,currency,credits,job_id,note) VALUES(?,?,?,?,?,?,?)",b.provider||null,b.category||null,Number(b.amount||0),b.currency||"USD",Number(b.credits||0),b.job_id||null,b.note||null);
  audit("spend_recorded",{userId:req.user.id,entityType:"spend",entityId:Number(r.lastInsertRowid),metadata:{amount:Number(b.amount||0),currency:b.currency||"USD"}});
  res.json({ok:true,id:Number(r.lastInsertRowid)});
});

app.get("/api/brand",(req,res)=>res.json({ok:true,items:all("SELECT * FROM brand_knowledge WHERE active=1 ORDER BY id")}));
app.post("/api/brand",(req,res)=>{
  const b=req.body||{}; const r=run("INSERT INTO brand_knowledge(kind,title,content) VALUES(?,?,?)",String(b.kind||"note"),String(b.title||"Knowledge"),String(b.content||""));
  audit("brand_knowledge_added",{userId:req.user.id,entityType:"brand_knowledge",entityId:Number(r.lastInsertRowid)}); res.json({ok:true,id:Number(r.lastInsertRowid)});
});

// Assets + media
app.post("/api/assets/upload",upload.single("file"),(req,res)=>{
  if(!req.file)return res.status(400).json({ok:false,error:"file_required"});
  const r=run("INSERT INTO assets(name,kind,path,mime,size_bytes,metadata_json) VALUES(?,?,?,?,?,?)",
    req.file.originalname,String(req.body?.kind||"raw"),req.file.path,req.file.mimetype,req.file.size,JSON.stringify({uploadedBy:req.user.id}));
  const id=Number(r.lastInsertRowid); audit("asset_uploaded",{userId:req.user.id,entityType:"asset",entityId:id,metadata:{name:req.file.originalname}});
  res.json({ok:true,id,name:req.file.originalname,size:req.file.size,mime:req.file.mimetype});
});
app.get("/api/assets",(req,res)=>res.json({ok:true,items:all("SELECT id,name,kind,mime,size_bytes,public,source_asset_id,metadata_json,created_at FROM assets ORDER BY id DESC").map(x=>({...x,metadata:json(x.metadata_json)}))}));
app.post("/api/assets/:id/public",(req,res)=>{run("UPDATE assets SET public=? WHERE id=?",req.body?.public?1:0,Number(req.params.id)); audit("asset_public_changed",{userId:req.user.id,entityType:"asset",entityId:req.params.id,metadata:{public:Boolean(req.body?.public)}}); res.json({ok:true});});
app.get("/media/:id",(req,res)=>{
  const a=one("SELECT * FROM assets WHERE id=?",Number(req.params.id)); if(!a)return res.sendStatus(404);
  if(!a.public && !currentUser(req))return res.sendStatus(403);
  if(!fs.existsSync(a.path))return res.sendStatus(404);
  res.type(a.mime||"application/octet-stream").sendFile(path.resolve(a.path));
});

function ffmpeg(args){return new Promise((resolve,reject)=>{const p=spawn("ffmpeg",args);let err="";p.stderr.on("data",d=>err+=d);p.on("close",c=>c===0?resolve():reject(new Error(err.slice(-2000))));});}
app.post("/api/video/process",async(req,res)=>{
  const b=req.body||{}, asset=one("SELECT * FROM assets WHERE id=?",Number(b.assetId));
  if(!asset)return res.status(404).json({ok:false,error:"asset_not_found"});
  const out=path.join(renderDir,`render-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`);
  const vf=[];
  if(b.aspect==="9:16")vf.push("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2");
  if(b.aspect==="1:1")vf.push("scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2");
  const args=["-y","-i",asset.path];
  if(vf.length)args.push("-vf",vf.join(","));
  args.push("-c:v","libx264","-preset","medium","-crf",String(b.crf||20),"-c:a","aac","-b:a","192k",out);
  const jobId=createJob({type:"video_edit",title:`Edit ${asset.name}`,payload:b,provider:"FFMPEG_LOCAL",requiresApproval:false,status:"running"});
  try{
    await ffmpeg(args);
    const st=fs.statSync(out), ar=run("INSERT INTO assets(name,kind,path,mime,size_bytes,source_asset_id,metadata_json) VALUES(?,?,?,?,?,?,?)",
      path.basename(out),"edited_video",out,"video/mp4",st.size,asset.id,JSON.stringify({aspect:b.aspect||"original",crf:b.crf||20}));
    const assetId=Number(ar.lastInsertRowid);
    run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({assetId}),jobId);
    audit("video_processed",{userId:req.user.id,entityType:"job",entityId:jobId,metadata:{assetId}});
    res.json({ok:true,jobId,assetId});
  }catch(e){
    run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),jobId); res.status(500).json({ok:false,error:"ffmpeg_failed",detail:String(e.message).slice(-500)});
  }
});


app.post("/api/video/compose",async(req,res)=>{
  const b=req.body||{},video=one("SELECT * FROM assets WHERE id=?",Number(b.assetId));
  if(!video)return res.status(404).json({ok:false,error:"asset_not_found"});
  const logo=b.logoAssetId?one("SELECT * FROM assets WHERE id=?",Number(b.logoAssetId)):null;
  const music=b.musicAssetId?one("SELECT * FROM assets WHERE id=?",Number(b.musicAssetId)):null;
  const out=path.join(renderDir,`cinematic-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`);
  const args=["-y"];
  if(Number(b.start)>0)args.push("-ss",String(Number(b.start)));
  args.push("-i",video.path);
  let logoIndex=-1,musicIndex=-1,next=1;
  if(logo){logoIndex=next++;args.push("-i",logo.path);}
  if(music){musicIndex=next++;args.push("-stream_loop","-1","-i",music.path);}
  if(Number(b.duration)>0)args.push("-t",String(Number(b.duration)));

  let base="eq=contrast=1.05:saturation=1.08:brightness=0.01,fade=t=in:st=0:d=0.25";
  if(b.aspect==="9:16")base+=",scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";
  else if(b.aspect==="1:1")base+=",scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2";
  else if(b.aspect==="16:9")base+=",scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
  const filters=[`[0:v]${base}[v0]`];
  let current="v0",stage=1,textFile=null;
  if(String(b.overlayText||"").trim()){
    textFile=path.join(DATA_DIR,`overlay-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.txt`);
    fs.writeFileSync(textFile,String(b.overlayText),"utf8");
    filters.push(`[${current}]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile='${textFile.replaceAll("'","\\'")}':fontcolor=white:fontsize=${Number(b.fontSize||46)}:borderw=2:bordercolor=black@0.45:x=(w-text_w)/2:y=h-text_h-120[v${stage}]`);
    current=`v${stage++}`;
  }
  if(logo){
    filters.push(`[${logoIndex}:v]scale=${Number(b.logoWidth||190)}:-1[lg]`);
    filters.push(`[${current}][lg]overlay=W-w-35:35[v${stage}]`);
    current=`v${stage++}`;
  }
  args.push("-filter_complex",filters.join(";"),"-map",`[${current}]`);
  if(music){
    args.push("-map",`${musicIndex}:a:0`,"-shortest","-af",`volume=${Number(b.musicVolume||0.22)}`);
  }else args.push("-map","0:a?");
  args.push("-c:v","libx264","-preset","medium","-crf",String(b.crf||19),"-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-movflags","+faststart",out);

  const jobId=createJob({type:"pro_video_edit",title:`Pro edit ${video.name}`,payload:b,provider:"FFMPEG_PRO",status:"running"});
  try{
    await ffmpeg(args);
    if(textFile)try{fs.unlinkSync(textFile)}catch{}
    const st=fs.statSync(out), ar=run("INSERT INTO assets(name,kind,path,mime,size_bytes,source_asset_id,metadata_json) VALUES(?,?,?,?,?,?,?)",
      path.basename(out),"cinematic_video",out,"video/mp4",st.size,video.id,JSON.stringify({aspect:b.aspect||"original",logoAssetId:b.logoAssetId||null,musicAssetId:b.musicAssetId||null,overlayText:Boolean(b.overlayText)}));
    const assetId=Number(ar.lastInsertRowid);run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({assetId}),jobId);
    audit("pro_video_composed",{userId:req.user.id,entityType:"job",entityId:jobId,metadata:{assetId}});res.json({ok:true,jobId,assetId});
  }catch(e){if(textFile)try{fs.unlinkSync(textFile)}catch{};run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),jobId);res.status(500).json({ok:false,error:"video_compose_failed",detail:String(e.message).slice(-700)});}
});

// Content/Research intelligence
app.post("/api/content/generate",async(req,res)=>{
  const q=String(req.body?.brief||req.body?.command||"").trim(); if(!q)return res.status(400).json({ok:false,error:"brief_required"});
  const jobId=createJob({type:"content",title:q,payload:req.body||{},provider:client?"OPENAI":"LOCAL",requiresApproval:false,status:"running"});
  let result;
  try{
    if(client){
      const r=await client.responses.create({model,instructions:`أنت Content Director لشركة TARA VIORA. استخدم هوية الشركة أدناه:\n${brandContext()}\nأنتج JSON فقط بالمفاتيح hook,body,caption,cta,platformNotes. لا تستخدم ادعاءات طبية غير موثقة.`,input:q});
      result=safeJson(r.output_text||"{}");
      if(!result.hook)result={raw:r.output_text};
    }else result=createContentDraftLocal(q);
    run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),jobId);
    res.json({ok:true,jobId,result});
  }catch(e){
    result=createContentDraftLocal(q); run("UPDATE jobs SET status='completed',result_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),String(e.message),jobId);
    res.json({ok:true,jobId,result,fallback:true});
  }
});
app.post("/api/research",async(req,res)=>{
  const q=String(req.body?.query||"").trim(); if(!q)return res.status(400).json({ok:false,error:"query_required"});
  const jobId=createJob({type:"research",title:q,payload:req.body||{},provider:client?"OPENAI_WEB":"NOT_CONNECTED",status:"running"});
  if(!client){run("UPDATE jobs SET status='blocked',error='OpenAI API unavailable or no credits',updated_at=CURRENT_TIMESTAMP WHERE id=?",jobId);return res.status(503).json({ok:false,jobId,error:"research_provider_unavailable"});}
  try{
    const r=await client.responses.create({model,tools:[{type:"web_search"}],instructions:`ابحث في المصادر العامة فقط. لخّص النتائج مع URLs/المصادر وتاريخها. لا تخترع بيانات. سياق العلامة:\n${brandContext()}`,input:q});
    const result={text:r.output_text||"",responseId:r.id};
    run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),jobId);
    res.json({ok:true,jobId,result});
  }catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),jobId);res.status(502).json({ok:false,jobId,error:"research_failed"});}
});


app.get("/api/content",(req,res)=>res.json({ok:true,items:all("SELECT * FROM content_items ORDER BY id DESC LIMIT 300")}));
app.post("/api/content",(req,res)=>{
  const b=req.body||{};
  const r=run("INSERT INTO content_items(title,platform,format,objective,hook,body,caption,cta,status,asset_id,scheduled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    String(b.title||"Untitled"),b.platform||null,b.format||null,b.objective||null,b.hook||null,b.body||null,b.caption||null,b.cta||null,b.status||"draft",b.asset_id||null,b.scheduled_at||null);
  const id=Number(r.lastInsertRowid);audit("content_created",{userId:req.user.id,entityType:"content",entityId:id});res.json({ok:true,id});
});
app.post("/api/content/:id/status",(req,res)=>{
  const id=Number(req.params.id),status=String(req.body?.status||"draft");
  run("UPDATE content_items SET status=? WHERE id=?",status,id);audit("content_status_changed",{userId:req.user.id,entityType:"content",entityId:id,metadata:{status}});res.json({ok:true});
});

app.post("/api/analytics/ingest",(req,res)=>{
  const rows=Array.isArray(req.body?.items)?req.body.items:[req.body];
  let count=0;
  for(const x of rows){
    if(!x?.platform||!x?.metric||!Number.isFinite(Number(x?.value)))continue;
    run("INSERT INTO analytics(platform,content_id,metric,value,measured_at,raw_json) VALUES(?,?,?,?,?,?)",
      String(x.platform),x.content_id||null,String(x.metric),Number(x.value),x.measured_at||new Date().toISOString(),JSON.stringify(x.raw||{}));count++;
  }
  audit("analytics_ingested",{userId:req.user.id,entityType:"analytics",metadata:{count}});res.json({ok:true,count});
});
app.get("/api/analytics/summary",(req,res)=>{
  const byMetric=all("SELECT platform,metric,round(sum(value),2) total,count(*) samples FROM analytics GROUP BY platform,metric ORDER BY platform,metric");
  const recent=all("SELECT * FROM analytics ORDER BY id DESC LIMIT 100");
  res.json({ok:true,byMetric,recent});
});
app.get("/api/analytics/best-time",(req,res)=>{
  const rows=all(`
    SELECT c.platform,
           cast(strftime('%w',coalesce(c.published_at,c.scheduled_at)) as integer) weekday,
           cast(strftime('%H',coalesce(c.published_at,c.scheduled_at)) as integer) hour,
           round(avg(a.value)::numeric,2)::double precision score,
           count(*) samples
    FROM content_items c JOIN analytics a ON a.content_id=c.id
    WHERE a.metric IN ('engagement','engagement_rate','clicks','conversions')
      AND coalesce(c.published_at,c.scheduled_at) IS NOT NULL
    GROUP BY c.platform,weekday,hour
    HAVING count(*)>=1
    ORDER BY score DESC LIMIT 30
  `);
  res.json({ok:true,items:rows});
});

app.get("/api/voc",(req,res)=>res.json({ok:true,items:all("SELECT * FROM voc_items ORDER BY id DESC LIMIT 300")}));
app.post("/api/voc/ingest",async(req,res)=>{
  const items=Array.isArray(req.body?.items)?req.body.items:[req.body];let added=0;
  for(const x of items){
    const text=String(x?.text||"").trim();if(!text)continue;
    let category="other",sentiment="neutral",intent="unknown",contentIdea="";
    if(/سعر|غالي|price|cost/i.test(text))category="price";
    else if(/نتيجة|result|فعّال|يفيد/i.test(text))category="results";
    else if(/كيف|استخدام|use/i.test(text))category="usage";
    else if(/آمن|حساسية|safety|allergy/i.test(text))category="safety";
    if(/ممتاز|حبيت|love|great|رائع/i.test(text))sentiment="positive";
    if(/سيء|ما عجب|bad|مشكل/i.test(text))sentiment="negative";
    contentIdea=category==="price"?"اشرح القيمة مقابل السعر":category==="usage"?"فيديو طريقة الاستخدام":category==="safety"?"محتوى توعوي عن الاستخدام الآمن":"حوّل السؤال إلى FAQ";
    try{run("INSERT INTO voc_items(platform,source_url,external_id,text,category,sentiment,intent,content_idea) VALUES(?,?,?,?,?,?,?,?)",
      x.platform||null,x.source_url||null,x.external_id||null,text,category,sentiment,intent,contentIdea);added++;}catch{}
  }
  audit("voc_ingested",{userId:req.user.id,entityType:"voc",metadata:{added}});res.json({ok:true,added});
});

app.get("/api/campaigns",(req,res)=>res.json({ok:true,items:all("SELECT * FROM campaigns ORDER BY id DESC")}));
app.post("/api/campaigns",(req,res)=>{
  const b=req.body||{},budget=Number(b.budget||0);
  const r=run("INSERT INTO campaigns(name,platform,objective,audience_json,budget,status) VALUES(?,?,?,?,?,'draft')",
    String(b.name||"Campaign"),b.platform||null,b.objective||null,JSON.stringify(b.audience||{}),budget);
  const id=Number(r.lastInsertRowid);
  const jobId=createJob({type:"paid_campaign",title:`Launch campaign: ${b.name||"Campaign"}`,payload:{campaignId:id,...b},provider:String(b.platform||"META").toUpperCase(),requiresApproval:true,costEstimate:budget});
  audit("campaign_draft_created",{userId:req.user.id,entityType:"campaign",entityId:id,metadata:{jobId,budget}});
  res.json({ok:true,id,jobId,approvalRequired:true});
});

app.get("/api/budget",(req,res)=>{
  const monthly=Number(setting("monthly_budget_usd")||500);
  const spent=Number(one("SELECT coalesce(sum(amount),0) v FROM spend WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").v||0);
  res.json({ok:true,monthly,spent,remaining:Math.max(0,monthly-spent)});
});
app.post("/api/budget",(req,res)=>{
  const amount=Math.max(0,Number(req.body?.monthly||0));setting("monthly_budget_usd",amount);audit("budget_updated",{userId:req.user.id,entityType:"settings",entityId:"monthly_budget_usd",metadata:{amount}});res.json({ok:true,monthly:amount});
});

app.get("/api/backup",(req,res)=>{
  const stamp=new Date().toISOString().replace(/[:.]/g,"-"),file=path.join(DATA_DIR,`backup-${stamp}.json`);
  const payload={
    exportedAt:new Date().toISOString(),
    brand:all("SELECT * FROM brand_knowledge"),jobs:all("SELECT * FROM jobs"),approvals:all("SELECT * FROM approvals"),
    assets:all("SELECT id,name,kind,mime,size_bytes,public,source_asset_id,metadata_json,created_at FROM assets"),
    leads:all("SELECT * FROM leads"),content:all("SELECT * FROM content_items"),analytics:all("SELECT * FROM analytics"),
    spend:all("SELECT * FROM spend"),voc:all("SELECT * FROM voc_items"),campaigns:all("SELECT * FROM campaigns"),audit:all("SELECT * FROM audit_log")
  };
  fs.writeFileSync(file,JSON.stringify(payload,null,2));
  audit("backup_created",{userId:req.user.id,entityType:"backup",entityId:path.basename(file)});res.download(file,path.basename(file));
});


app.post("/api/carousel/generate",async(req,res)=>{
  const topic=String(req.body?.topic||req.body?.brief||"").trim();if(!topic)return res.status(400).json({ok:false,error:"topic_required"});
  const jobId=createJob({type:"carousel",title:`Carousel: ${topic}`,payload:req.body||{},provider:client?"OPENAI":"LOCAL",status:"running"});
  let slides;
  try{
    if(client){
      const r=await client.responses.create({model,instructions:`أنت Creative Director لـ TARA VIORA. أنشئ JSON فقط بالشكل {"slides":[{"title":"","body":""}],"caption":"","cta":""}. اجعل الكاروسيل 5-7 شرائح، فاخر، علمي، مختصر، ولا تستخدم ادعاءات طبية غير موثقة. Brand context:\n${brandContext()}`,input:topic});
      slides=safeJson(r.output_text||"{}");
    }else{
      slides={slides:[
        {title:"المشكلة",body:topic},{title:"ما المهم معرفته؟",body:"ركّزي على المكونات والاستخدام المناسب."},
        {title:"كيف نقيّم المنتج؟",body:"التركيبة، الملاءمة، وطريقة الاستخدام أهم من الوعود."},
        {title:"TARA VIORA",body:"اختيار هادئ مبني على معرفة أوضح."},
        {title:"الخطوة التالية",body:"احفظي الكاروسيل وراجعي التفاصيل قبل القرار."}
      ],caption:`دليل مبسّط: ${topic}`,cta:"احفظي المنشور"};
    }
    run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(slides),jobId);
    res.json({ok:true,jobId,result:slides});
  }catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),jobId);res.status(502).json({ok:false,jobId,error:"carousel_failed"});}
});

app.post("/api/images/prepare",(req,res)=>{
  const prompt=String(req.body?.prompt||"").trim();if(!prompt)return res.status(400).json({ok:false,error:"prompt_required"});
  const id=createJob({type:"image_generation",title:`Image: ${prompt.slice(0,90)}`,payload:{...req.body,prompt},provider:"OPENAI_IMAGE",requiresApproval:true,costEstimate:Number(req.body?.costEstimate||0)});
  audit("image_generation_prepared",{userId:req.user.id,entityType:"job",entityId:id});res.json({ok:true,jobId:id,approvalRequired:true});
});
app.post("/api/actions/openai-image",async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId));if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  if(!client)return res.status(503).json({ok:false,error:"openai_not_connected"});
  const p=json(job.payload_json),prompt=String(req.body?.prompt||p.prompt||"");
  try{
    const r=await client.images.generate({model:process.env.OPENAI_IMAGE_MODEL||"gpt-image-1",prompt,size:req.body?.size||p.size||"1024x1024",response_format:"b64_json"});
    const b64=r.data?.[0]?.b64_json;if(!b64)throw new Error("image_missing");
    const buf=Buffer.from(b64,"base64"),out=path.join(renderDir,`image-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`);
    fs.writeFileSync(out,buf);
    const ar=run("INSERT INTO assets(name,kind,path,mime,size_bytes,metadata_json) VALUES(?,?,?,?,?,?)",path.basename(out),"generated_image",out,"image/png",buf.length,JSON.stringify({prompt,model:process.env.OPENAI_IMAGE_MODEL||"gpt-image-1"}));
    const assetId=Number(ar.lastInsertRowid);run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({assetId}),job.id);
    audit("image_generated",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{assetId}});res.json({ok:true,assetId});
  }catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),job.id);res.status(502).json({ok:false,error:String(e.message)});}
});

app.post("/api/b2b/research",async(req,res)=>{
  const q=String(req.body?.query||"").trim()||"صيدليات ومراكز تجميل وعيادات وموزعين محتملين في لبنان";
  const jobId=createJob({type:"b2b_research",title:q,payload:req.body||{},provider:client?"OPENAI_WEB":"NOT_CONNECTED",status:"running"});
  if(!client){run("UPDATE jobs SET status='blocked',error='Research provider unavailable',updated_at=CURRENT_TIMESTAMP WHERE id=?",jobId);return res.status(503).json({ok:false,jobId,error:"research_provider_unavailable"});}
  try{
    const r=await client.responses.create({model,tools:[{type:"web_search"}],instructions:`ابحث فقط في بيانات عامة أو مخوّلة. أعد JSON فقط {"leads":[{"name":"","category":"","area":"","phone":"","email":"","website":"","source_url":"","fit_score":0}]}. لا تختلق أرقام هاتف أو إيميلات؛ اتركها فارغة إن لم تظهر في المصدر. ركّز على لبنان.`,input:q});
    const result=safeJson(r.output_text||"{}"),leads=Array.isArray(result.leads)?result.leads:[];
    let inserted=0;
    for(const x of leads){
      const score=Math.max(0,Math.min(100,Number(x.fit_score||0))),priority=score>=85?"A":score>=70?"B":score>=55?"C":"D";
      try{run("INSERT INTO leads(name,category,area,phone,email,website,source_url,fit_score,priority,consent_status) VALUES(?,?,?,?,?,?,?,?,?,'unknown')",
        String(x.name||"").trim(),x.category||null,x.area||null,x.phone||null,x.email||null,x.website||null,x.source_url||null,score,priority);inserted++;}catch{}
    }
    run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({inserted,leads}),jobId);
    audit("b2b_research_completed",{userId:req.user.id,entityType:"job",entityId:jobId,metadata:{inserted}});res.json({ok:true,jobId,inserted,leads});
  }catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),jobId);res.status(502).json({ok:false,jobId,error:"b2b_research_failed"});}
});

function createBackupFile(){
  const stamp=new Date().toISOString().replace(/[:.]/g,"-"),dir=path.join(DATA_DIR,"backups");fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`backup-${stamp}.json`);
  const tables=["settings","users","jobs","approvals","audit_log","assets","leads","content_items","analytics","spend","brand_knowledge","voc_items","campaigns","experiments"];
  const payload={exportedAt:new Date().toISOString()};
  for(const t of tables){try{payload[t]=all(`SELECT * FROM ${t}`)}catch{}}
  fs.writeFileSync(file,JSON.stringify(payload,null,2));
  const files=fs.readdirSync(dir).filter(x=>x.endsWith(".json")).sort();
  while(files.length>14){const old=files.shift();try{fs.unlinkSync(path.join(dir,old))}catch{}}
  return file;
}
setInterval(()=>{try{createBackupFile();audit("automatic_backup_created",{entityType:"backup"})}catch{}},24*60*60*1000);

// Integrations live status
app.get("/api/integrations",async(req,res)=>{
  let hf="NOT_CONNECTED",tt="NOT_CONNECTED",meta="NOT_CONNECTED",wa="NOT_CONNECTED",el="NOT_CONNECTED";
  if(n8nBase){try{const r=await postN8n("tara-viora-higgsfield-check",{source:"integration-status"});hf=r.data?.provider||"NOT_CONNECTED";}catch{}}
  try{const token=await tiktokAccessToken();const openId=getSecret("tiktok","open_id");const exp=Number(getSecret("tiktok","expires_at")||0);tt=token&&openId&&(!exp||Date.now()<exp)?"TIKTOK_CONNECTED":"TIKTOK_AUTH_ERROR";}catch{tt="TIKTOK_AUTH_ERROR"}
  if(hasSecret("meta","access_token"))meta="CONFIGURED";
  if(hasSecret("whatsapp","access_token")&&hasSecret("whatsapp","phone_number_id"))wa="CONFIGURED";
  if(hasSecret("elevenlabs","api_key"))el="CONFIGURED";
  const providers={
    openai:{label:"OpenAI Executive",connected:Boolean(client),status:client?"CONFIGURED":"NOT_CONNECTED"},
    n8n:{label:"n8n Automation",connected:Boolean(n8nBase),status:n8nBase?"CONNECTED":"NOT_CONNECTED"},
    higgsfield:{label:"Higgsfield Video",connected:hf==="HIGGSFIELD_READY",status:hf},
    tiktok:{label:"TikTok",connected:tt==="TIKTOK_CONNECTED",status:tt,publishReady:String(getSecret("tiktok","scope")||"").split(",").map(x=>x.trim()).includes("video.publish"),needsDeveloperCredentials:!hasSecret("tiktok","client_key")||!hasSecret("tiktok","client_secret")},
    meta:{label:"Instagram + Facebook",connected:meta==="CONFIGURED",status:meta},
    whatsapp:{label:"WhatsApp Business",connected:wa==="CONFIGURED",status:wa},
    elevenlabs:{label:"ElevenLabs Voice",connected:el==="CONFIGURED",status:el},
    storage:{label:"Persistent Media Storage",connected:true,status:"LOCAL_VOLUME_READY"},
    postgres:{label:"PostgreSQL",connected:dbMode==="POSTGRES",status:dbMode}
  };
  res.json({ok:true,providers,redirects:{tiktok:publicBaseUrl()+"/oauth/tiktok/callback",metaWebhook:publicBaseUrl()+"/webhooks/meta"}});
});

app.get("/api/audit",(req,res)=>res.json({ok:true,items:all("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300").map(x=>({...x,metadata:json(x.metadata_json)}))}));

// Central director
app.post("/api/command",async(req,res)=>{
  const q=String(req.body?.command||"").trim(); if(!q)return res.status(400).json({ok:false,error:"command_required"});
  const module=routeCommand(q), moduleName=modules[module];
  const sensitive=/نشر|صرف|ممولة|render|رندر|إرسال|send|publish|launch/i.test(q);
  const jobId=createJob({type:"director_command",title:q,payload:{module,moduleName},provider:"DIRECTOR",requiresApproval:sensitive,status:sensitive?"waiting_approval":"running"});
  let answer="",aiStatus="NOT_CONNECTED",automationStatus="NOT_CONNECTED",automationResult=null;
  if(client){
    try{
      const r=await client.responses.create({model,instructions:`أنت المدير التنفيذي الذكي الداخلي لـ TARA VIORA. الهوية والمعرفة:\n${brandContext()}\nلا تدّعِ تنفيذ أي نشر/صرف/إرسال/رندر ما لم يرجع لك تنفيذ فعلي. قدّم خطة مختصرة وعملية بالعربية.`,input:`طلب المستخدم: ${q}\nالوحدة: ${moduleName}`});
      answer=r.output_text||""; aiStatus="CONNECTED";
    }catch(e){answer=`تم استلام الطلب: ${q}\nالوحدة: ${moduleName}\nسيتم التنفيذ ضمن النظام مع بوابة موافقة للخطوات الحساسة.`;aiStatus=/429|credits|quota/i.test(String(e.message))?"NO_CREDITS":"ERROR";}
  }else answer=`تم استلام الطلب: ${q}\nالوحدة: ${moduleName}\nسيتم التنفيذ ضمن النظام مع بوابة موافقة للخطوات الحساسة.`;
  if(n8nBase){
    try{const r=await postN8n("tara-viora-command",{command:q,module,moduleName,source:"tara-viora-command-center"});automationStatus=r.ok?"CONNECTED":"ERROR";automationResult=r.data;}catch(e){automationStatus="ERROR";automationResult={error:String(e.message)};}
  }
  run("UPDATE jobs SET status=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",sensitive?"waiting_approval":"completed",JSON.stringify({answer,automationResult}),jobId);
  audit("director_command",{userId:req.user.id,entityType:"job",entityId:jobId,metadata:{module,moduleName,sensitive}});
  res.json({ok:true,jobId,command:q,module,moduleName,answer,aiStatus,automationStatus,automationResult,approvalRequired:sensitive});
});

function blockExternalInStaging(req,res,next){
  if(stagingMode)return res.status(423).json({ok:false,error:"staging_external_actions_disabled"});
  next();
}
// Safe external-action endpoints. They require an already-approved job.
app.post("/api/actions/higgsfield",blockExternalInStaging,async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId)); if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  try{const r=await postN8n("tara-viora-render",{...req.body,approved:true});run("UPDATE jobs SET status=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",r.ok?"submitted":"failed",JSON.stringify(r.data),job.id);audit("higgsfield_submit",{userId:req.user.id,entityType:"job",entityId:job.id});res.status(r.ok?200:502).json({ok:r.ok,result:r.data});}catch(e){res.status(502).json({ok:false,error:String(e.message)});}
});
app.post("/api/actions/tiktok",blockExternalInStaging,async(req,res)=>{
  const requestedJobId=Number(req.body?.jobId);
  const job=one("SELECT * FROM jobs WHERE id=?",requestedJobId);
  const approval=job?one("SELECT status,decided_at FROM approvals WHERE job_id=? ORDER BY id DESC LIMIT 1",job.id):null;
  const approvalValid=Boolean(job&&(job.status==="approved"||Boolean(job.approved_at)||approval?.status==="approved"));
  if(!approvalValid)return res.status(403).json({
    ok:false,error:"approved_job_required",
    requestedJobId:Number.isFinite(requestedJobId)?requestedJobId:null,
    jobFound:Boolean(job),jobStatus:job?.status||null,
    approvedAt:job?.approved_at||null,approvalStatus:approval?.status||null
  });
  if(!req.body?.creatorConfirmed)return res.status(400).json({ok:false,error:"creator_confirmation_required"});
  try{
    const token=await tiktokAccessToken();if(!token)return res.status(503).json({ok:false,error:"tiktok_not_connected"});
    const scope=String(getSecret("tiktok","scope")||"");
    if(!scope.split(",").map(x=>x.trim()).includes("video.publish"))return res.status(409).json({ok:false,error:"video_publish_scope_not_authorized",connected:true});

    const cr=await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/",{
      method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json; charset=UTF-8"},body:"{}"
    });
    const cd=await cr.json().catch(()=>({}));
    if(!cr.ok||cd?.error?.code!=="ok")throw new Error(cd?.error?.message||"tiktok_creator_info_failed");

    const privacy=String(req.body?.privacy_level||"SELF_ONLY"),allowed=cd?.data?.privacy_level_options||[];
    if(allowed.length&&!allowed.includes(privacy))return res.status(400).json({ok:false,error:"privacy_level_not_allowed",allowed});

    const post_info={
      title:String(req.body?.title||"").slice(0,2200),
      privacy_level:privacy,
      disable_duet:Boolean(req.body?.disable_duet),
      disable_comment:Boolean(req.body?.disable_comment),
      disable_stitch:Boolean(req.body?.disable_stitch),
      brand_organic_toggle:req.body?.brand_organic_toggle!==false,
      is_aigc:Boolean(req.body?.is_aigc)
    };

    let source_info,asset=null,fileBuffer=null,mime="video/mp4";
    const assetId=Number(req.body?.assetId||0);
    if(assetId){
      asset=one("SELECT * FROM assets WHERE id=?",assetId);
      if(!asset)return res.status(404).json({ok:false,error:"asset_not_found"});
      if(!fs.existsSync(asset.path))return res.status(404).json({ok:false,error:"asset_file_missing"});
      const st=fs.statSync(asset.path),videoSize=Number(st.size);
      if(!videoSize)return res.status(400).json({ok:false,error:"empty_video_file"});
      mime=["video/mp4","video/quicktime","video/webm"].includes(asset.mime)?asset.mime:"video/mp4";
      const MB=1024*1024,maxChunk=64*MB,minChunk=5*MB;
      let chunkSize;
      if(videoSize<=128*MB) chunkSize=Math.min(videoSize,maxChunk);
      else chunkSize=maxChunk;
      if(videoSize>=minChunk&&chunkSize<minChunk)chunkSize=minChunk;
      const totalChunkCount=Math.max(1,Math.floor(videoSize/chunkSize));
      source_info={source:"FILE_UPLOAD",video_size:videoSize,chunk_size:chunkSize,total_chunk_count:totalChunkCount};
      fileBuffer=fs.readFileSync(asset.path);
    }else{
      const videoUrl=String(req.body?.videoUrl||"").trim();
      if(!videoUrl)return res.status(400).json({ok:false,error:"asset_id_or_video_url_required"});
      source_info={source:"PULL_FROM_URL",video_url:videoUrl};
    }

    const payload={post_info,source_info};
    const r=await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/",{
      method:"POST",
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json; charset=UTF-8"},
      body:JSON.stringify(payload)
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d?.error?.code!=="ok")throw new Error(d?.error?.message||"tiktok_publish_init_failed");

    if(source_info.source==="FILE_UPLOAD"){
      const uploadUrl=d?.data?.upload_url;
      if(!uploadUrl)throw new Error("tiktok_upload_url_missing");
      const total=fileBuffer.length,chunkSize=source_info.chunk_size,totalCount=source_info.total_chunk_count;
      let offset=0;
      for(let i=0;i<totalCount;i++){
        const remaining=total-offset;
        const thisSize=(i===totalCount-1)?remaining:Math.min(chunkSize,remaining);
        const last=offset+thisSize-1;
        const chunk=fileBuffer.subarray(offset,last+1);
        const ur=await fetch(uploadUrl,{
          method:"PUT",
          headers:{"Content-Type":mime,"Content-Length":String(chunk.length),"Content-Range":`bytes ${offset}-${last}/${total}`},
          body:chunk
        });
        if(!ur.ok){
          const ut=await ur.text().catch(()=>"");
          throw new Error(`tiktok_file_upload_failed_${ur.status}: ${ut.slice(0,300)}`);
        }
        offset=last+1;
      }
      if(offset!==total)throw new Error("tiktok_file_upload_incomplete");
    }

    run("UPDATE jobs SET status='submitted',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({publish:d,source:source_info.source,assetId:asset?.id||null}),job.id);
    audit("tiktok_submit",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{publishId:d?.data?.publish_id||null,source:source_info.source,assetId:asset?.id||null}});
    res.json({ok:true,result:d,source:source_info.source,assetId:asset?.id||null});
  }catch(e){
    run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),job.id);
    res.status(502).json({ok:false,error:String(e.message)});
  }
});

app.post("/api/tiktok/status/:jobId",async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.params.jobId));
  if(!job||job.type!=="tiktok_publish")return res.status(404).json({ok:false,error:"tiktok_publish_job_not_found"});
  const stored=json(job.result_json,{})||{};
  const publishId=stored?.publish?.data?.publish_id||stored?.publish_id||null;
  if(!publishId)return res.status(409).json({ok:false,error:"publish_id_missing",jobStatus:job.status});
  try{
    const token=await tiktokAccessToken();if(!token)return res.status(503).json({ok:false,error:"tiktok_not_connected"});
    const r=await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/",{
      method:"POST",
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json; charset=UTF-8"},
      body:JSON.stringify({publish_id:publishId})
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d?.error?.code!=="ok")return res.status(502).json({ok:false,error:d?.error?.message||d?.error?.code||"tiktok_status_failed",raw:d});
    const status=String(d?.data?.status||"UNKNOWN");
    const mapped=status==="PUBLISH_COMPLETE"?"completed":status==="FAILED"?"failed":"submitted";
    const merged={...stored,tiktokStatus:d.data,statusCheckedAt:new Date().toISOString()};
    run("UPDATE jobs SET status=?,result_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      mapped,JSON.stringify(merged),status==="FAILED"?String(d?.data?.fail_reason||"tiktok_publish_failed"):null,job.id);
    audit("tiktok_publish_status",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{publishId,status,failReason:d?.data?.fail_reason||null}});
    res.json({ok:true,jobId:job.id,publishId,status,jobStatus:mapped,data:d.data});
  }catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
});



function graphVersion(){return getSecret("meta","graph_version")||process.env.META_GRAPH_VERSION||"v24.0"}
async function graphPost(pathName,token,payload){
  const r=await fetch(`https://graph.facebook.com/${graphVersion()}/${pathName}`,{
    method:"POST",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  });
  const raw=await r.text(); const data=safeJson(raw);
  if(!r.ok)throw new Error(data?.error?.message||`graph_${r.status}`);
  return data;
}
async function instagramPublish(payload){
  const token=getSecret("meta","access_token")||process.env.META_ACCESS_TOKEN, ig=getSecret("meta","ig_user_id")||process.env.META_IG_USER_ID;
  if(!token||!ig)throw new Error("meta_not_connected");
  const p={caption:String(payload.caption||"")};
  if(payload.mediaType==="REELS"||payload.videoUrl){p.media_type="REELS";p.video_url=payload.videoUrl;}
  else p.image_url=payload.imageUrl;
  const created=await graphPost(`${ig}/media`,token,p);
  if(!created.id)throw new Error("instagram_container_missing");
  if(p.media_type==="REELS"){
    for(let i=0;i<12;i++){
      await new Promise(r=>setTimeout(r,2500));
      const sr=await fetch(`https://graph.facebook.com/${graphVersion()}/${created.id}?fields=status_code&access_token=${encodeURIComponent(token)}`);
      const sd=await sr.json().catch(()=>({}));
      if(sd.status_code==="FINISHED")break;
      if(sd.status_code==="ERROR")throw new Error("instagram_media_processing_failed");
    }
  }
  return graphPost(`${ig}/media_publish`,token,{creation_id:created.id});
}
async function facebookPublish(payload){
  const token=getSecret("meta","access_token")||process.env.META_ACCESS_TOKEN,page=getSecret("meta","page_id")||process.env.META_PAGE_ID;
  if(!token||!page)throw new Error("meta_not_connected");
  if(payload.imageUrl)return graphPost(`${page}/photos`,token,{url:payload.imageUrl,message:String(payload.message||payload.caption||"")});
  return graphPost(`${page}/feed`,token,{message:String(payload.message||payload.caption||"")});
}
async function whatsappSend(payload){
  const token=getSecret("whatsapp","access_token")||process.env.WHATSAPP_ACCESS_TOKEN,phoneId=getSecret("whatsapp","phone_number_id")||process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!token||!phoneId)throw new Error("whatsapp_not_connected");
  const body=payload.templateName?{
    messaging_product:"whatsapp",to:String(payload.to),type:"template",
    template:{name:String(payload.templateName),language:{code:String(payload.language||"en_US")},components:payload.components||[]}
  }:{
    messaging_product:"whatsapp",recipient_type:"individual",to:String(payload.to),type:"text",
    text:{preview_url:false,body:String(payload.message||"")}
  };
  return graphPost(`${phoneId}/messages`,token,body);
}

app.post("/api/voiceover/prepare",(req,res)=>{
  const text=String(req.body?.text||"").trim(),voiceId=String(req.body?.voiceId||"").trim();
  if(!text||!voiceId)return res.status(400).json({ok:false,error:"text_and_voice_required"});
  const jobId=createJob({type:"voiceover",title:`Voiceover: ${text.slice(0,80)}`,payload:{text,voiceId,modelId:req.body?.modelId||"eleven_multilingual_v2"},provider:"ELEVENLABS",requiresApproval:true,costEstimate:text.length});
  audit("voiceover_prepared",{userId:req.user.id,entityType:"job",entityId:jobId,metadata:{characters:text.length}});
  res.json({ok:true,jobId,approvalRequired:true,estimatedCharacters:text.length});
});
app.post("/api/actions/elevenlabs",async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId)); if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  const key=getSecret("elevenlabs","api_key")||process.env.ELEVENLABS_API_KEY;if(!key)return res.status(503).json({ok:false,error:"elevenlabs_not_connected"});
  const p=json(job.payload_json),voiceId=String(req.body?.voiceId||p.voiceId||""),text=String(req.body?.text||p.text||"");
  try{
    const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,{
      method:"POST",headers:{"xi-api-key":key,"Content-Type":"application/json"},
      body:JSON.stringify({text,model_id:req.body?.modelId||p.modelId||"eleven_multilingual_v2"})
    });
    if(!r.ok)throw new Error(`elevenlabs_${r.status}`);
    const buf=Buffer.from(await r.arrayBuffer()),out=path.join(renderDir,`voice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`);
    fs.writeFileSync(out,buf);
    const ar=run("INSERT INTO assets(name,kind,path,mime,size_bytes,metadata_json) VALUES(?,?,?,?,?,?)",path.basename(out),"voiceover",out,"audio/mpeg",buf.length,JSON.stringify({voiceId,characters:text.length}));
    const assetId=Number(ar.lastInsertRowid);
    run("UPDATE jobs SET status='completed',result_json=?,cost_actual=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({assetId}),text.length,job.id);
    run("INSERT INTO spend(provider,category,amount,currency,credits,job_id,note) VALUES('ElevenLabs','voiceover',0,'USD',?,?,?)",text.length,job.id,`${text.length} characters`);
    audit("voiceover_generated",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{assetId,characters:text.length}});
    res.json({ok:true,assetId});
  }catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),job.id);res.status(502).json({ok:false,error:String(e.message)});}
});

app.post("/api/actions/instagram",blockExternalInStaging,async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId));if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  try{const result=await instagramPublish(req.body);run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),job.id);audit("instagram_publish",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{result}});res.json({ok:true,result});}
  catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),job.id);res.status(502).json({ok:false,error:String(e.message)});}
});
app.post("/api/actions/facebook",blockExternalInStaging,async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId));if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  try{const result=await facebookPublish(req.body);run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),job.id);audit("facebook_publish",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{result}});res.json({ok:true,result});}
  catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),job.id);res.status(502).json({ok:false,error:String(e.message)});}
});
app.post("/api/actions/whatsapp",blockExternalInStaging,async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId));if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  try{const result=await whatsappSend(req.body);run("UPDATE jobs SET status='completed',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),job.id);audit("whatsapp_send",{userId:req.user.id,entityType:"job",entityId:job.id,metadata:{to:req.body?.to}});res.json({ok:true,result});}
  catch(e){run("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",String(e.message),job.id);res.status(502).json({ok:false,error:String(e.message)});}
});

app.post("/api/schedule",(req,res)=>{
  const b=req.body||{},scheduledAt=String(b.scheduledAt||"");
  if(!scheduledAt||!b.platform)return res.status(400).json({ok:false,error:"platform_and_scheduledAt_required"});
  const id=createJob({type:"scheduled_publish",title:String(b.title||`Scheduled ${b.platform} publish`),payload:{...b,scheduledAt},provider:String(b.platform).toUpperCase(),requiresApproval:true,costEstimate:Number(b.costEstimate||0)});
  audit("scheduled_publish_created",{userId:req.user.id,entityType:"job",entityId:id,metadata:{platform:b.platform,scheduledAt}});
  res.json({ok:true,jobId:id,approvalRequired:true});
});

const RETRY_DELAYS_MS=[60_000,5*60_000,15*60_000,30*60_000,60*60_000,2*60*60_000];
let continuityState={lastRun:null,status:"IDLE",upcoming24h:0,recoveryQueue:0,humanActionRequired:0,issues:[]};

function transientPublishError(message=""){
  return /timeout|timed out|429|rate|temporar|unavailable|502|503|504|network|fetch failed|ECONN|EAI_AGAIN|socket|processing/i.test(String(message));
}
function authPublishError(message=""){
  return /token|auth|permission|scope|reauth|unauthor|forbidden|access|credential/i.test(String(message));
}
function jobResult(job){return json(job.result_json,{})||{}}
function saveJobResult(jobId,obj){run("UPDATE jobs SET result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(obj),jobId)}

async function scheduledTikTokPublish(p,job){
  const token=await tiktokAccessToken();if(!token)throw new Error("tiktok_not_connected");
  const scope=String(getSecret("tiktok","scope")||"");
  if(!scope.split(",").map(x=>x.trim()).includes("video.publish"))throw new Error("video_publish_scope_not_authorized");
  const cr=await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json; charset=UTF-8"},body:"{}"});
  const cd=await cr.json().catch(()=>({}));if(!cr.ok||cd?.error?.code!=="ok")throw new Error(cd?.error?.message||"tiktok_creator_info_failed");
  const privacy=String(p.privacy_level||"SELF_ONLY"),allowed=cd?.data?.privacy_level_options||[];
  if(allowed.length&&!allowed.includes(privacy))throw new Error("privacy_level_not_allowed");

  let source_info,fileBuffer=null,mime="video/mp4",asset=null;
  const assetId=Number(p.assetId||p.asset_id||0);
  if(assetId){
    asset=one("SELECT * FROM assets WHERE id=?",assetId);
    if(!asset||!fs.existsSync(asset.path))throw new Error("scheduled_asset_missing");
    const size=Number(fs.statSync(asset.path).size),maxChunk=64*1024*1024;
    const chunkSize=Math.min(size,maxChunk),totalChunkCount=Math.max(1,Math.floor(size/chunkSize));
    source_info={source:"FILE_UPLOAD",video_size:size,chunk_size:chunkSize,total_chunk_count:totalChunkCount};
    fileBuffer=fs.readFileSync(asset.path);mime=asset.mime||mime;
  }else{
    const videoUrl=String(p.videoUrl||"").trim();if(!videoUrl)throw new Error("scheduled_tiktok_media_missing");
    source_info={source:"PULL_FROM_URL",video_url:videoUrl};
  }
  const payload={post_info:{title:String(p.title||p.caption||"").slice(0,2200),privacy_level:privacy,disable_duet:Boolean(p.disable_duet),disable_comment:Boolean(p.disable_comment),disable_stitch:Boolean(p.disable_stitch),brand_organic_toggle:p.brand_organic_toggle!==false,is_aigc:Boolean(p.is_aigc)},source_info};
  const r=await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json; charset=UTF-8"},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));if(!r.ok||d?.error?.code!=="ok")throw new Error(d?.error?.message||"tiktok_publish_init_failed");
  const prior=jobResult(job);saveJobResult(job.id,{...prior,publish:d,source:source_info.source,attemptAcceptedAt:new Date().toISOString()});
  if(source_info.source==="FILE_UPLOAD"){
    const uploadUrl=d?.data?.upload_url;if(!uploadUrl)throw new Error("tiktok_upload_url_missing");
    const total=fileBuffer.length,chunkSize=source_info.chunk_size,totalCount=source_info.total_chunk_count;
    let offset=0;
    for(let i=0;i<totalCount;i++){
      const remaining=total-offset,thisSize=(i===totalCount-1)?remaining:Math.min(chunkSize,remaining),last=offset+thisSize-1;
      const chunk=fileBuffer.subarray(offset,last+1);
      const ur=await fetch(uploadUrl,{method:"PUT",headers:{"Content-Type":mime,"Content-Length":String(chunk.length),"Content-Range":`bytes ${offset}-${last}/${total}`},body:chunk});
      if(!ur.ok)throw new Error(`tiktok_file_upload_failed_${ur.status}`);
      offset=last+1;
    }
  }
  return {publish:d,source:source_info.source,assetId:asset?.id||null};
}

async function executeScheduled(job,p){
  const platform=String(p.platform||"").toLowerCase();
  if(platform==="instagram")return instagramPublish(p);
  if(platform==="facebook")return facebookPublish(p);
  if(platform==="whatsapp")return whatsappSend(p);
  if(platform==="tiktok")return scheduledTikTokPublish(p,job);
  throw new Error("unsupported_platform");
}

function scheduleRetry(job,error){
  const prev=jobResult(job),attempts=Number(prev.retry?.attempts||0)+1;
  if(attempts>RETRY_DELAYS_MS.length)return {retry:false,attempts};
  const nextAt=new Date(Date.now()+RETRY_DELAYS_MS[attempts-1]).toISOString();
  const result={...prev,retry:{attempts,nextAt,lastError:String(error),lastFailureAt:new Date().toISOString()}};
  run("UPDATE jobs SET status='retry_wait',result_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify(result),String(error),job.id);
  audit("scheduled_publish_retry_scheduled",{entityType:"job",entityId:job.id,metadata:{attempts,nextAt,error:String(error)}});
  return {retry:true,attempts,nextAt};
}

async function runScheduledJobs(){
  const candidates=all("SELECT * FROM jobs WHERE type='scheduled_publish' AND status IN ('approved','retry_wait') ORDER BY id LIMIT 50");
  for(const job of candidates){
    const p=json(job.payload_json),when=new Date(p.scheduledAt||0),rj=jobResult(job);
    if(!Number.isFinite(when.getTime())||when.getTime()>Date.now())continue;
    if(job.status==="retry_wait"){
      const nextAt=new Date(rj?.retry?.nextAt||0);if(Number.isFinite(nextAt.getTime())&&nextAt.getTime()>Date.now())continue;
    }
    run("UPDATE jobs SET status='running',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",job.id);
    const started={...rj,continuity:{...(rj.continuity||{}),attemptStartedAt:new Date().toISOString()}};
    saveJobResult(job.id,started);
    try{
      const result=await executeScheduled({...job,result_json:JSON.stringify(started)},p);
      run("UPDATE jobs SET status='completed',result_json=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",JSON.stringify({...started,providerResult:result,retry:null,completedAt:new Date().toISOString()}),job.id);
      audit("scheduled_publish_completed",{entityType:"job",entityId:job.id,metadata:{platform:p.platform}});
    }catch(e){
      const message=String(e.message||e),latest=one("SELECT * FROM jobs WHERE id=?",job.id)||job;
      const accepted=Boolean(jobResult(latest)?.publish?.data?.publish_id);
      if(accepted){
        run("UPDATE jobs SET status='submitted',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",message,job.id);
        audit("scheduled_publish_accepted_needs_status_check",{entityType:"job",entityId:job.id,metadata:{error:message}});
      }else if(authPublishError(message)){
        run("UPDATE jobs SET status='human_action_required',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",message,job.id);
        audit("scheduled_publish_human_action_required",{entityType:"job",entityId:job.id,metadata:{error:message}});
      }else if(transientPublishError(message)){
        const retry=scheduleRetry(latest,message);
        if(!retry.retry){
          run("UPDATE jobs SET status='human_action_required',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",message,job.id);
          audit("scheduled_publish_retry_exhausted",{entityType:"job",entityId:job.id,metadata:{error:message}});
        }
      }else{
        run("UPDATE jobs SET status='human_action_required',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",message,job.id);
        audit("scheduled_publish_human_action_required",{entityType:"job",entityId:job.id,metadata:{error:message}});
      }
    }
  }
}

async function publishingContinuityCycle(){
  const issues=[];
  const now=Date.now(),h24=now+24*60*60*1000,h7=now+7*24*60*60*1000;
  const scheduled=all("SELECT * FROM jobs WHERE type='scheduled_publish' AND status NOT IN ('completed','rejected') ORDER BY id DESC LIMIT 500");
  let upcoming24h=0,upcoming7d=0,recoveryQueue=0,humanActionRequired=0;
  for(const job of scheduled){
    const p=json(job.payload_json),t=new Date(p.scheduledAt||0).getTime();
    if(Number.isFinite(t)&&t>=now&&t<=h24)upcoming24h++;
    if(Number.isFinite(t)&&t>=now&&t<=h7)upcoming7d++;
    if(job.status==="retry_wait")recoveryQueue++;
    if(job.status==="human_action_required")humanActionRequired++;
    if(Number.isFinite(t)&&t>=now&&t<=h24){
      const platform=String(p.platform||"").toLowerCase();
      if(platform==="tiktok"){
        if(!hasSecret("tiktok","refresh_token"))issues.push({jobId:job.id,type:"tiktok_reauth_required"});
        if(!String(getSecret("tiktok","scope")||"").split(",").map(x=>x.trim()).includes("video.publish"))issues.push({jobId:job.id,type:"tiktok_video_publish_missing"});
        const aid=Number(p.assetId||p.asset_id||0);if(aid){const a=one("SELECT path FROM assets WHERE id=?",aid);if(!a||!fs.existsSync(a.path))issues.push({jobId:job.id,type:"media_missing"});}
      }
      if(platform==="instagram"&&!hasSecret("meta","access_token"))issues.push({jobId:job.id,type:"meta_reauth_required"});
      if(platform==="facebook"&&!hasSecret("meta","access_token"))issues.push({jobId:job.id,type:"meta_reauth_required"});
      if(platform==="whatsapp"&&(!hasSecret("whatsapp","access_token")||!hasSecret("whatsapp","phone_number_id")))issues.push({jobId:job.id,type:"whatsapp_reauth_required"});
    }
  }
  continuityState={lastRun:new Date().toISOString(),status:humanActionRequired||issues.length?"ATTENTION":recoveryQueue?"RECOVERING":"HEALTHY",upcoming24h,upcoming7d,recoveryQueue,humanActionRequired,bufferDays:upcoming7d?7:0,issues};
  return continuityState;
}

if(!stagingMode)setInterval(()=>runScheduledJobs().catch(()=>{}),30000);
if(!stagingMode)setInterval(()=>publishingContinuityCycle().catch(()=>{}),5*60*1000);
setTimeout(()=>publishingContinuityCycle().catch(()=>{}),15000);

app.get("/api/continuity/status",requireAuth,async(req,res)=>{try{res.json({ok:true,...await publishingContinuityCycle()})}catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}});
app.post("/api/continuity/run",requireAuth,async(req,res)=>{try{await runScheduledJobs();res.json({ok:true,...await publishingContinuityCycle()})}catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}});


app.use(express.static(path.join(__dirname,"public")));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(port,"0.0.0.0",()=>{
  console.log(`TARA VIORA Production OS listening on ${port} • persistent DB ${DATA_DIR}`);
  setTimeout(async()=>{try{
    let hf="UNKNOWN";if(n8nBase){const r=await postN8n("tara-viora-higgsfield-check",{source:"startup-production-health"});hf=r.data?.provider||"UNKNOWN";}
    const dbOk=Number(one("SELECT 1 v").v)===1,vol=fs.existsSync(DATA_DIR),ff=spawnSync("ffmpeg",["-version"],{stdio:"ignore"}).status===0;
    console.log("TARA_VIORA_PRODUCTION_HEALTH",JSON.stringify({db:dbOk,volume:vol,ffmpeg:ff,n8n:Boolean(n8nBase),higgsfield:hf}));
  }catch(e){console.error("TARA_VIORA_PRODUCTION_HEALTH_ERROR",e?.message||e)}},3000);
});
