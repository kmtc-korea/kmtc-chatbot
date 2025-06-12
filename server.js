// backend/server.js – KMTC AI 2025-06-12 (v13.5)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 에 있는 “단가”와 “계산방식”만 참조

import express from "express";
import cors from "cors";
import { config } from "dotenv";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GMAPS_KEY = process.env.GMAPS_KEY;

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── OpenAI 클라이언트 ─────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── AI 플랜 생성 (JSON ONLY) ─────────────────────────────────────────────────
async function gptPlan(patient, km) {
  const sys = `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr =
    `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"}` +
    ` / 거동:${patient.mobility||"unknown"} / 거리:${km}`;
  const { choices:[{ message }] } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: usr }
    ]
  });
  return JSON.parse(message.content.trim());
}

// ─── 거리 계산 (Google Distance Matrix) ───────────────────────────────────────
async function routeInfo(fromAddr, toAddr) {
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(fromAddr)}` +
    `&destinations=${encodeURIComponent(toAddr)}` +
    `&key=${GMAPS_KEY}&language=ko`;
  const js = await fetch(url).then(r => r.json());
  const elem = js.rows?.[0]?.elements?.[0];
  if (!elem || elem.status !== "OK" || !elem.distance) {
    throw new Error(`거리 계산 실패: status=${elem?.status}`);
  }
  return {
    km:  Math.round(elem.distance.value / 1000),
    hr: +(elem.duration.value / 3600).toFixed(1)
  };
}

// ─── 비용 계산 (structured_단가표.json 만 참조) ───────────────────────────────
function calcCost(ctx, plan, km, days) {
  let total = 0;
  const items = prices[ctx] || [];
  for (const item of items) {
    const unit = item.단가;
    switch (item.계산방식) {
      case "단가x거리":
        total += unit * km; break;
      case "단가x거리x인원":
        total += unit * km * (plan.staff.length||1); break;
      case "단가x일수":
        total += unit * days; break;
      case "단가x일수x인원":
        total += unit * days * (plan.staff.length||1); break;
      case "단가":
        total += unit; break;
    }
  }
  return total;
}

// ─── function‐calling 스키마 ─────────────────────────────────────────────────
const functions = [{
  name: "decideIntentAndParams",
  description: "intent, from/to, scenarios 등을 추출합니다.",
  parameters: {
    type: "object",
    properties: {
      intent:    { type: "string", enum: ["GENERAL","EXPLAIN_COST","CALCULATE_COST"] },
      from:      { type: "string" },
      to:        { type: "string" },
      scenarios: { type: "array",  items: { type: "string" } }
    },
    required: ["intent"]
  }
}];

// ─── 서버 & 핸들러 ─────────────────────────────────────────────────────────
const sessions = {};
const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { sessionId="def", message="", days=1, patient={} } = req.body;
  const ses = sessions[sessionId] ||= {};
  if (Object.keys(patient).length) ses.patient = { ...ses.patient, ...patient };

  // 1) intent 분류 시도
  const cl = await openai.chat.completions.create({
    model: "gpt-4o", temperature: 0,
    messages: [
      { role:"system", content:
        "당신은 KMTC AI입니다. 외부 업체 언급 금지. intent와 파라미터만 반환하세요." },
      { role:"user",   content: message }
    ],
    functions,
    function_call: "auto"
  });

  const choice = cl.choices[0].message;

  // 2) 일반 메시지 → 일반 응답
  if (choice.content) {
    const chat = await openai.chat.completions.create({
      model: "gpt-4o", temperature: 0.7,
      messages: [
        { role:"system", content: "KMTC AI 상담원입니다. 무엇을 도와드릴까요?" },
        { role:"user",   content: message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 3) function_call → 파라미터 파싱
  const args     = JSON.parse(choice.function_call.arguments||"{}");
  const intent   = args.intent;
  const from     = args.from;
  const to       = args.to;
  const scenarios= args.scenarios||[];

  // 4) GENERAL
  if (intent === "GENERAL") {
    const chat = await openai.chat.completions.create({
      model: "gpt-4o", temperature: 0.7,
      messages: [
        { role:"system", content: "KMTC AI 상담원입니다. KMTC 서비스를 소개합니다." },
        { role:"user",   content: message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 5) EXPLAIN_COST
  if (intent === "EXPLAIN_COST") {
    const chat = await openai.chat.completions.create({
      model: "gpt-4o", temperature: 0.7,
      messages: [
        { role:"system", content: "비용 구조만 설명하세요. 단가표만 참조합니다." },
        { role:"user",   content: message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 6) CALCULATE_COST
  let km = 0, hr = 0;
  const plan0 = await gptPlan(ses.patient||{}, 0);
  const ctx   = plan0.type === "funeral" ? "고인이송"
              : plan0.type === "event"   ? "행사의료지원"
              :                             "항공이송";

  // → 오직 항공이송/고인이송만 거리 계산
  if (ctx === "항공이송" || ctx === "고인이송") {
    if (!from || !to) {
      return res.json({ reply: '📝 "…에서 …까지" 형식으로 출발지와 도착지를 알려주세요.' });
    }
    try { ({ km, hr } = await routeInfo(from, to)); }
    catch { return res.json({ reply: "⚠️ 거리 계산 실패. 주소를 다시 확인해주세요." }); }
  }

  // 7) 견적 계산
  const transports = scenarios.length ? scenarios : [plan0.transport];
  const results = transports.map(t => {
    const plan = { ...plan0, transport: t };
    if (ctx === "고인이송") plan.seat = "coffin";
    return calcCost(ctx, plan, km, days);
  });

  // 8) 응답 생성 (행사의료지원엔 거리가 표시되지 않음)
  if (results.length === 1) {
    return res.json({
      reply:
        `🚩 서비스: ${ctx}\n` +
        (ctx !== "행사의료지원" ? `🚗 거리: ${km}km (${hr}h)\n` : "") +
        `💰 총 예상 비용: 약 ${results[0].toLocaleString()}원`
    });
  } else {
    const lines = transports
      .map((t, i) => `- ${t}: 약 ${results[i].toLocaleString()}원`)
      .join("\n");
    return res.json({
      reply:
        `🚩 서비스: ${ctx}\n` +
        (ctx !== "행사의료지원" ? `🚗 거리: ${km}km (${hr}h)\n` : "") +
        `💸 비용 비교:\n${lines}`
    });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
