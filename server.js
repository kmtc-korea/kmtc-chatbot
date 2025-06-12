// backend/server.js – KMTC AI 2025-06-12 (v13.0)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · 단가표(JSON)만 참고하여 계산

import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { OpenAI } from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const { choices: [{ message }] } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: usr }
    ]
  });
  return JSON.parse(message.content.trim());
}

// ─── 비용 계산 ───────────────────────────────────────────────────────────────
function calcCost(ctx, plan, km, days) {
  const c = {
    인건비: 0,
    장비비: 0,
    숙식: prices.mealLodging * plan.staff.length * days,
    기타: prices.misc,
    항공료: 0
  };

  // 1) 인건비
  plan.staff.forEach(r => {
    if (prices.wages[r] != null) {
      c.인건비 += prices.wages[r] * days;
    }
  });

  // 2) 장비비
  c.장비비 += prices.equipment.baseDaily * days;
  if (plan.equipment.ventilator) c.장비비 += prices.equipment.ventilator * days;
  if (plan.equipment.ecmo)      c.장비비 += prices.equipment.ecmo      * days;

  // 3) 장례 이송 특별 처리
  if (ctx === "고인이송") {
    if (plan.cremated) {
      c.항공료 = prices.funeral.cremation;
      c.기타 += 3_500_000;
    } else {
      c.항공료 = prices.funeral.coffin;
      c.기타 += 15_000_000;
    }
  }
  // 4) 거리 기반 운송료 (항공/전용기/에어앰뷸런스/선박)
  else if (ctx !== "행사의료지원") {
    const f = prices.air[plan.transport] || prices.ship;
    c.항공료 = f.perKm * km;
    // 스트레쳐 좌석
    if (f.stretcherSeats && plan.seat === "stretcher") {
      c.항공료 = f.perKm * km * f.stretcherSeats;
      c.항공료 += (f.staffPerKm || 0) * km * plan.staff.length;
    }
    // 선박 크루 배수
    if (f.crewMultiplier) {
      c.항공료 *= f.crewMultiplier;
    }
  }

  c.총합계 = Object.values(c).reduce((s, v) => s + v, 0);
  return c;
}

// ─── 함수 호출 스키마 ───────────────────────────────────────────────────────
const functions = [{
  name: "decideIntentAndParams",
  description: "사용자 입력에서 intent와 파라미터(distanceKm, scenarios)를 추출합니다.",
  parameters: {
    type: "object",
    properties: {
      intent:      { type: "string", enum: ["GENERAL", "EXPLAIN_COST", "CALCULATE_COST"] },
      distanceKm:  { type: "number" },
      scenarios:   { type: "array", items: { type: "string" } }
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
  const { sessionId = "def", message = "", days = 3, patient = {} } = req.body;
  const ses = sessions[sessionId] ||= {};
  if (Object.keys(patient).length) ses.patient = { ...ses.patient, ...patient };

  // 1) intent 분류 & 파라미터 추출
  const cl = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    messages: [
      { role: "system", content:
        "당신은 KMTC AI입니다. 외부 업체 언급 금지. 사용자 입력을 intent와 파라미터로만 반환하세요." },
      { role: "user",   content: message }
    ],
    functions,
    function_call: { name: "decideIntentAndParams" }
  });
  const args = JSON.parse(cl.choices[0].message.function_call.arguments || "{}");
  const intent     = args.intent;
  const km         = args.distanceKm || 0;
  const scenarios  = Array.isArray(args.scenarios) ? args.scenarios : [];

  // 2) GENERAL
  if (intent === "GENERAL") {
    const chat = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        { role: "system", content:
          "당신은 KMTC AI 상담원입니다. KMTC는 해외 환자 항공이송, 행사 의료지원, 방송 의료지원, 고인 이송 등 종합 의료 지원 서비스를 제공합니다. 외부 업체 언급 금지." },
        { role: "user",   content: message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 3) 비용 구조 설명
  if (intent === "EXPLAIN_COST") {
    const chat = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        { role: "system", content: "당신은 KMTC AI 상담원입니다. 비용 구조만 설명하세요." },
        { role: "user",   content: message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 4) 실제 계산 (CALCULATE_COST)
  const plan0 = await gptPlan(ses.patient || {}, km);
  const ctx = plan0.type === "funeral" ? "고인이송"
            : plan0.type === "event"   ? "행사의료지원"
            :                             "항공이송";

  // 행사 지원은 거리 무시
  const transports = scenarios.length ? scenarios : [plan0.transport];
  const results = transports.map(t => {
    const plan = { ...plan0, transport: t };
    if (ctx === "고인이송") plan.seat = "coffin";
    const cost = calcCost(ctx, plan, km, days);
    return { transport: t, total: cost.총합계 };
  });

  // 5) 응답 조합
  if (results.length === 1) {
    return res.json({
      reply:
        `🚩 서비스: ${ctx}\n` +
        (ctx !== "행사의료지원" ? `🚗 거리: ${km}km\n` : "") +
        `💰 총 예상 비용: 약 ${results[0].total.toLocaleString()}원`
    });
  } else {
    const lines = results
      .map(r => `- ${r.transport}: 약 ${r.total.toLocaleString()}원`)
      .join("\n");
    return res.json({
      reply:
        `🚩 서비스: ${ctx}\n` +
        (ctx !== "행사의료지원" ? `🚗 거리: ${km}km\n` : "") +
        `💸 비용 비교:\n${lines}`
    });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
