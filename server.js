import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import multer from "multer";
import OpenAI from "openai";
import { db, one, all, run, json, audit, setting, DATA_DIR } from "./db.js";

const app=express();
app.use(express.json({limit:"5mb"}));
app.use(express.urlencoded({extended:true}));
const __filename=fileURLToPath(import.meta.url), __dirname=path.dirname(__filename);
const port=process.env.PORT||3000;
const client=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
const model=process.env.OPENAI_MODEL||"gpt-5.6-luna";
const n8nBase=String(process.env.N8N_BASE_URL||"").replace(/\/$/,"");
const sessionHours=Number(process.env.SESSION_HOURS||168);

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
  return one(`SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND datetime(s.expires_at)>datetime('now')`,h)||null;
}
function requireAuth(req,res,next){const u=currentUser(req); if(!u)return res.status(401).json({ok:false,error:"auth_required"}); req.user=u; next();}
function setSession(res,userId){
  const token=crypto.randomBytes(32).toString("hex"), h=tokenHash(token);
  run("DELETE FROM sessions WHERE datetime(expires_at)<=datetime('now')");
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now',?))",h,userId,`+${sessionHours} hours`);
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
app.get("/health",(_req,res)=>res.json({ok:true,app:"TARA VIORA Command Center",db:"SQLITE_PERSISTENT",dataDir:DATA_DIR}));
app.get("/api/status",(req,res)=>res.json({ok:true,configured:authStatus(),executive:client?"OPENAI_CONFIGURED":"LOCAL_ROUTER",n8n:n8nBase?"CONNECTED":"NOT_CONNECTED",model}));

// Everything below is private
app.use("/api", (req,res,next)=>{
  if(["/auth/status","/auth/setup","/auth/login","/status"].includes(req.path)) return next();
  return requireAuth(req,res,next);
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
app.get("/api/approvals",(req,res)=>res.json({ok:true,items:all(`SELECT a.*,j.type,j.provider,j.payload_json FROM approvals a JOIN jobs j ON j.id=a.job_id ORDER BY a.id DESC`).map(x=>({...x,payload:json(x.payload_json)}))}));
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

// Integrations live status
app.get("/api/integrations",async(req,res)=>{
  let hf="NOT_CONNECTED",tt="NOT_CONNECTED";
  if(n8nBase){
    try{const r=await postN8n("tara-viora-higgsfield-check",{source:"integration-status"});hf=r.data?.provider||"NOT_CONNECTED";}catch{}
    try{const r=await postN8n("tara-viora-tiktok-check",{source:"integration-status"});tt=r.data?.provider||"NOT_CONNECTED";}catch{}
  }
  const providers={
    openai:{label:"OpenAI Executive",connected:Boolean(client),status:client?"CONFIGURED":"NOT_CONNECTED"},
    n8n:{label:"n8n Automation",connected:Boolean(n8nBase),status:n8nBase?"CONNECTED":"NOT_CONNECTED"},
    higgsfield:{label:"Higgsfield Video",connected:hf==="HIGGSFIELD_READY",status:hf},
    tiktok:{label:"TikTok",connected:tt==="TIKTOK_READY",status:tt},
    meta:{label:"Instagram + Facebook",connected:Boolean(process.env.META_ACCESS_TOKEN&&process.env.META_PAGE_ID),status:process.env.META_ACCESS_TOKEN?"CONFIGURED":"NOT_CONNECTED"},
    whatsapp:{label:"WhatsApp Business",connected:Boolean(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID),status:process.env.WHATSAPP_ACCESS_TOKEN?"CONFIGURED":"NOT_CONNECTED"},
    elevenlabs:{label:"ElevenLabs Voice",connected:Boolean(process.env.ELEVENLABS_API_KEY),status:process.env.ELEVENLABS_API_KEY?"CONFIGURED":"NOT_CONNECTED"},
    cloudinary:{label:"Cloudinary",connected:Boolean(process.env.CLOUDINARY_URL),status:process.env.CLOUDINARY_URL?"CONFIGURED":"OPTIONAL_NOT_CONNECTED"},
    storage:{label:"Persistent Media Storage",connected:true,status:"LOCAL_VOLUME_READY"}
  };
  res.json({ok:true,providers});
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

// Safe external-action endpoints. They require an already-approved job.
app.post("/api/actions/higgsfield",async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId)); if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  try{const r=await postN8n("tara-viora-render",{...req.body,approved:true});run("UPDATE jobs SET status=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",r.ok?"submitted":"failed",JSON.stringify(r.data),job.id);audit("higgsfield_submit",{userId:req.user.id,entityType:"job",entityId:job.id});res.status(r.ok?200:502).json({ok:r.ok,result:r.data});}catch(e){res.status(502).json({ok:false,error:String(e.message)});}
});
app.post("/api/actions/tiktok",async(req,res)=>{
  const job=one("SELECT * FROM jobs WHERE id=?",Number(req.body?.jobId)); if(!job||job.status!=="approved")return res.status(403).json({ok:false,error:"approved_job_required"});
  if(!req.body?.creatorConfirmed)return res.status(400).json({ok:false,error:"creator_confirmation_required"});
  try{const r=await postN8n("tara-viora-tiktok-publish",{...req.body,approved:true,creatorConfirmed:true});run("UPDATE jobs SET status=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",r.ok?"submitted":"failed",JSON.stringify(r.data),job.id);audit("tiktok_submit",{userId:req.user.id,entityType:"job",entityId:job.id});res.status(r.ok?200:502).json({ok:r.ok,result:r.data});}catch(e){res.status(502).json({ok:false,error:String(e.message)});}
});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(port,"0.0.0.0",()=>console.log(`TARA VIORA Production OS listening on ${port} • persistent DB ${DATA_DIR}`));
