import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;

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

  const orders = [
    {team:"البحث والتحليل", order:"اجمعي الإشارات المتاحة وحددي الفرضيات والفرص والمخاطر.", status:"issued"},
    {team:"المحتوى", order:"حوّلي النتيجة إلى Brief واضح مع 5 Hooks أصلية مناسبة لهوية TARA VIORA.", status:"issued"},
    {team:modules[module], order:"نفّذي مسودة أولية قابلة للمراجعة ولا تنتقلي لأي نشر أو صرف قبل الموافقة.", status:"issued"},
    {team:"الجودة والموافقات", order:"راجعي الادعاءات والجودة وأوقفي أي خطوة حساسة عند Approval Gate.", status:"issued"}
  ];

  return { module, moduleName: modules[module], orders };
}

app.get("/health", (_req, res) => res.json({ ok: true, app: "TARA VIORA Command Center" }));
app.get("/api/status", (_req, res) => res.json({
  ok: true,
  executive: "LOCAL_ROUTER",
  ai: process.env.OPENAI_API_KEY ? "CONNECTED" : "NOT_CONNECTED",
  n8n: process.env.N8N_BASE_URL ? "CONNECTED" : "NOT_CONNECTED"
}));
app.post("/api/command", (req, res) => {
  const q = String(req.body?.command || "").trim();
  if (!q) return res.status(400).json({ ok:false, error:"command_required" });
  const routed = routeCommand(q);
  res.json({
    ok:true,
    command:q,
    ...routed,
    links:{
      module:`#module-${routed.module + 1}`,
      tasks:"#tasks",
      approvals:"#approvals",
      integrations:"#integrations"
    },
    note: process.env.OPENAI_API_KEY
      ? "AI backend connected."
      : "تم إصدار أوامر تشغيل داخلية. الذكاء التوليدي الخارجي غير موصول بعد."
  });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(port, "0.0.0.0", () => {
  console.log(`TARA VIORA Command Center listening on ${port}`);
});
