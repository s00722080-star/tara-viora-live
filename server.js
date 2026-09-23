import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const n8nBase = String(process.env.N8N_BASE_URL || "").replace(/\/$/,"");

const modules = [
  "فيديو حقيقي ومونتاج بروفيشنال","توليد فيديو بالذكاء الاصطناعي","صور وإعلانات","Carousel",
  "Motion Graphics","حملات ممولة","محتوى Organic","تحليل السوق","تحليل المنافسين","Trends & Hooks",
  "تحليل التعليقات وصوت العميل","أفضل وقت للنشر","قاعدة بيانات العملاء والسوق B2B","Analytics",
  "Budget / Credits","Approvals","WhatsApp"
];

function routeCommand(q="") {
  let module = 6;
  if (/فيديو|ريل|reel/i.test(q)) module = 0;
  else if (/توليد.*فيديو|ai video/i.test(q)) module = 1;
  else if (/صورة|صور|اعلان بصري/i.test(q)) module = 2;
  else if (/كاروسيل|carousel/i.test(q)) module = 3;
  else if (/موشن|motion/i.test(q)) module = 4;
  else if (/اعلان|حملة|ممول/i.test(q)) module = 5;
  else if (/سوق/i.test(q)) module = 7;
  else if (/منافس/i.test(q)) module = 8;
  else if (/ترند|hook|هوك/i.test(q)) module = 9;
  else if (/تعليق|صوت العميل|voc/i.test(q)) module = 10;
  else if (/وقت النشر|افضل وقت/i.test(q)) module = 11;
  else if (/صيدلي|عياد|b2b|داتا|موزع/i.test(q)) module = 12;
  else if (/تحليل نتائج|analytics|اداء/i.test(q)) module = 13;
  else if (/ميزانية|كريدت|budget/i.test(q)) module = 14;
  else if (/موافقة|approval/i.test(q)) module = 15;
  else if (/واتساب|whatsapp/i.test(q)) module = 16;
  return module;
}

function buildOrders(module) {
  return [
    {team:"البحث والتحليل", order:"اجمعي المعلومات اللازمة وحددي الفرص والمخاطر والفرضيات.", status:"issued"},
    {team:"المحتوى", order:"حوّلي النتيجة إلى Brief واضح مع 5 Hooks أصلية مناسبة لهوية TARA VIORA.", status:"issued"},
    {team:modules[module], order:"نفّذي مسودة أولية قابلة للمراجعة ولا تنتقلي لأي نشر أو صرف قبل الموافقة.", status:"issued"},
    {team:"الجودة والموافقات", order:"راجعي الجودة والادعاءات وأوقفي أي خطوة حساسة عند Approval Gate.", status:"issued"}
  ];
}

function localFallbackAnswer(q, module) {
  const label = modules[module];
  return `تم استلام الطلب وتشغيله بوضع الأتمتة المحلي مؤقتًا إلى أن يتم تمويل OpenAI API.

المهمة: ${q}
الوحدة: ${label}

ما سيتم تنفيذه الآن:
1) تحويل الطلب إلى Brief واضح.
2) إنشاء مسودة أولية داخل الوحدة المناسبة.
3) إرسال أي خطوة نشر/صرف/إرسال/Final Render إلى بوابة الموافقة قبل التنفيذ.

يمكنك متابعة نتيجة الأتمتة من القسم الظاهر أسفل هذا الرد.`;
}

const systemPrompt = `
أنت المدير التنفيذي الذكي الداخلي لشركة TARA VIORA لمستحضرات التجميل.
تحدث بالعربية الواضحة، واستخدم أسلوبًا فاخرًا هادئًا وعلميًا وغير مبالغ.
حوّل طلب المستخدم إلى خطة تنفيذ فعلية، ثم أعطِ نتيجة مفيدة مباشرة قدر الإمكان.
لا تدّعِ أنك نشرت أو صرفت ميزانية أو أرسلت رسالة أو أنشأت رندرًا نهائيًا ما لم يكن ذلك متصلًا فعليًا.
أي نشر أو صرف إعلاني أو رندر مدفوع نهائي أو تواصل ترويجي يحتاج موافقة بشرية.
عند تحليل السوق أو المنافسين، ميّز بين الاستنتاجات العامة وبين البيانات الحية غير المتصلة.
اجعل الإجابة عملية، مرتبة، ومباشرة، وتتضمن: النتيجة، الخطوات التالية، وأي نقاط تحتاج موافقة.
`;

app.get("/health", (_req, res) => res.json({ ok: true, app: "TARA VIORA Command Center" }));


app.get("/api/integrations", async (_req, res) => {
  let higgsfieldConnected = false;
  let higgsfieldProvider = "NOT_CONNECTED";
  let tiktokConnected = false;
  let tiktokProvider = "NOT_CONNECTED";

  if (n8nBase) {
    try {
      const hr = await fetch(`${n8nBase}/webhook/tara-viora-higgsfield-check`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({source:"integrations-status"})
      });
      const raw = await hr.text();
      let result; try { result = JSON.parse(raw); } catch { result = {}; }
      higgsfieldProvider = result?.provider || "NOT_CONNECTED";
      higgsfieldConnected = Boolean(hr.ok && result?.provider === "HIGGSFIELD_READY");
    } catch {}

    try {
      const tr = await fetch(`${n8nBase}/webhook/tara-viora-tiktok-check`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({source:"integrations-status"})
      });
      const raw = await tr.text();
      let result; try { result = JSON.parse(raw); } catch { result = {}; }
      tiktokProvider = result?.provider || "NOT_CONNECTED";
      tiktokConnected = Boolean(tr.ok && result?.provider === "TIKTOK_READY");
    } catch {}
  }

  res.json({
    ok:true,
    providers:{
      meta:{
        label:"Instagram + Facebook",
        connected:Boolean(process.env.META_ACCESS_TOKEN && process.env.META_PAGE_ID)
      },
      whatsapp:{
        label:"WhatsApp Business",
        connected:Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
      },
      tiktok:{
        label:"TikTok",
        connected:tiktokConnected,
        status:tiktokProvider
      },
      higgsfield:{
        label:"Higgsfield Video",
        connected:higgsfieldConnected,
        status:higgsfieldProvider
      }
    }
  });
});

app.get("/api/tiktok-check", async (_req, res) => {
  if (!n8nBase) return res.status(503).json({ok:false, provider:"NOT_CONNECTED", reason:"n8n_not_connected"});
  try {
    const tr = await fetch(`${n8nBase}/webhook/tara-viora-tiktok-check`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({source:"tiktok-preflight"})
    });
    const raw = await tr.text();
    let result; try { result = JSON.parse(raw); } catch { result = {raw}; }
    res.status(tr.ok ? 200 : 502).json({ok:Boolean(tr.ok && result?.provider==="TIKTOK_READY"), result});
  } catch (err) {
    res.status(502).json({ok:false, provider:"UNKNOWN", error:String(err?.message||err)});
  }
});

app.get("/api/status", (_req, res) => res.json({
  ok: true,
  executive: client ? "OPENAI_CONNECTED" : "LOCAL_ROUTER",
  ai: client ? "CONNECTED" : "NOT_CONNECTED",
  n8n: process.env.N8N_BASE_URL ? "CONNECTED" : "NOT_CONNECTED",
  model
}));


app.get("/api/higgsfield-check", async (_req, res) => {
  if (!n8nBase) return res.status(503).json({ok:false, provider:"NOT_CONNECTED", reason:"n8n_not_connected"});
  try {
    const nr = await fetch(`${n8nBase}/webhook/tara-viora-higgsfield-check`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        command:"TARA VIORA Higgsfield connectivity preflight",
        prompt:"Connectivity check only. Do not render.",
        approved:false,
        source:"higgsfield-preflight"
      })
    });
    const raw = await nr.text();
    let result; try { result = JSON.parse(raw); } catch { result = {raw}; }
    const provider = result?.provider || "UNKNOWN";
    const safeBlocked = result?.finalRenderBlocked === true && result?.approvalRequired === true;
    res.status(nr.ok && safeBlocked ? 200 : 502).json({
      ok:Boolean(nr.ok && safeBlocked && provider === "HIGGSFIELD_READY"),
      provider,
      n8nStatus:nr.status,
      finalRenderBlocked:result?.finalRenderBlocked,
      approvalRequired:result?.approvalRequired,
      paidRenderTriggered:false,
      result
    });
  } catch (err) {
    res.status(502).json({ok:false, provider:"UNKNOWN", paidRenderTriggered:false, error:String(err?.message||err)});
  }
});

app.get("/api/selftest", async (_req, res) => {
  if (!n8nBase) return res.status(503).json({ok:false,n8n:"NOT_CONNECTED"});
  try {
    const nr = await fetch(`${n8nBase}/webhook/tara-viora-command`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({command:"اكتب 3 أفكار محتوى لسيروم فيتامين C",source:"selftest"})
    });
    const raw = await nr.text();
    let result; try { result = JSON.parse(raw); } catch { result = {raw}; }
    res.status(nr.ok?200:502).json({ok:nr.ok,n8nStatus:nr.status,result});
  } catch (err) {
    res.status(502).json({ok:false,n8nStatus:"unreachable",error:String(err?.message||err)});
  }
});

app.post("/api/command", async (req, res) => {
  const q = String(req.body?.command || "").trim();
  if (!q) return res.status(400).json({ ok:false, error:"command_required" });

  const module = routeCommand(q);
  const orders = buildOrders(module);

  let answer = "";
  let aiStatus = "NOT_CONNECTED";
  let automationStatus = "NOT_CONNECTED";
  let automationResult = null;

  if (client) {
    try {
      const response = await client.responses.create({
        model,
        instructions: systemPrompt,
        input: `طلب المستخدم: ${q}\nالوحدة الأساسية: ${modules[module]}\nقدّم جوابًا تنفيذيًا واضحًا بالعربية.`
      });
      answer = response.output_text || "";
      aiStatus = "CONNECTED";
    } catch (err) {
      console.error("OpenAI error:", err?.message || err);
      const msg = String(err?.message || err || "");
      if (msg.includes("429") || /no credits|insufficient_quota/i.test(msg)) {
        answer = localFallbackAnswer(q, module);
        aiStatus = "NO_CREDITS";
      } else {
        answer = localFallbackAnswer(q, module);
        aiStatus = "ERROR";
      }
    }
  } else {
    answer = localFallbackAnswer(q, module);
  }

  if (n8nBase) {
    try {
      const nr = await fetch(`${n8nBase}/webhook/tara-viora-command`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({command:q,module,moduleName:modules[module],source:"tara-viora-command-center"})
      });
      const textBody = await nr.text();
      try { automationResult = JSON.parse(textBody); } catch { automationResult = {raw:textBody}; }
      automationStatus = nr.ok ? "CONNECTED" : "ERROR";
    } catch (err) {
      console.error("n8n error:", err?.message || err);
      automationStatus = "ERROR";
      automationResult = {error:"n8n_unreachable"};
    }
  }

  res.json({
    ok:true,
    command:q,
    module,
    moduleName:modules[module],
    orders,
    answer,
    aiStatus,
    automationStatus,
    automationResult,
    links:{
      module:`#module-${module + 1}`,
      tasks:"#tasks",
      approvals:"#approvals",
      integrations:"#integrations"
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(port, "0.0.0.0", () => {
  console.log(`TARA VIORA Command Center listening on ${port}`);
  if (n8nBase) {
    setTimeout(async () => {
      try {
        const r = await fetch(`${n8nBase}/webhook/tara-viora-command`, {
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({command:"اختبار ربط TARA VIORA",source:"startup-selftest"})
        });
        const body = await r.text();
        console.log("TARA_VIORA_STARTUP_SELFTEST", r.status, body.slice(0,1000));
        try {
          const hr = await fetch(`${n8nBase}/webhook/tara-viora-higgsfield-check`, {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              command:"TARA VIORA Higgsfield startup preflight",
              prompt:"Connectivity check only. Do not render.",
              approved:false,
              source:"startup-higgsfield-preflight"
            })
          });
          const hbody = await hr.text();
          console.log("TARA_VIORA_HIGGSFIELD_PREFLIGHT", hr.status, hbody.slice(0,1000));
        } catch (he) {
          console.error("TARA_VIORA_HIGGSFIELD_PREFLIGHT_ERROR", he?.message || he);
        }
        try {
          const tr = await fetch(`${n8nBase}/webhook/tara-viora-tiktok-check`, {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({source:"startup-tiktok-preflight"})
          });
          const tbody = await tr.text();
          console.log("TARA_VIORA_TIKTOK_PREFLIGHT", tr.status, tbody.slice(0,1000));
        } catch (te) {
          console.error("TARA_VIORA_TIKTOK_PREFLIGHT_ERROR", te?.message || te);
        }
      } catch (e) {
        console.error("TARA_VIORA_STARTUP_SELFTEST_ERROR", e?.message || e);
      }
    }, 4000);
  }
});
