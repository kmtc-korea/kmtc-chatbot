// backend/server.js – KMTC AI 2025-06-12 (v15.0)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 의 “단가”와 “계산방식”만 참조
// · 응답은 Markdown 형식으로 간결하게, 공감·애도 표현 포함
// · 세션이 살아있는 동안 대화 이력 유지
// · 마지막에 예측 견적 안내 문구 추가 (항공이송·고인이송)

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
); // :contentReference[oaicite:0]{index=0}

// ─── OpenAI 클라이언트 ─────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Google Distance Matrix로 거리/시간 계산 ─────────────────────────────────────
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
    hr: +(elem.duration.value / 3600).toFixed(1),
  };
}

// ─── AI 플랜 생성 (JSON ONLY) ─────────────────────────────────────────────────
async function gptPlan(diagnosis, km) {
  // AI에게 필요한 staff•equipment 구성까지 “판단”시킴
  const sys = `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr = `진단명:${diagnosis} / 거리:${km}`;
  const { choices: [{ message }] } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: usr }
    ]
  });
  return JSON.parse(message.content.trim());
}

// ─── 비용 계산 ───────────────────────────────────────────────────────────────
function calcCost(ctx, plan, km, days) {
  let total = 0;
  const breakdown = {};
  const items = prices[ctx] || []; // 예: "행사지원" :contentReference[oaicite:1]{index=1}

  items.forEach(item => {
    const unit = item.단가;
    let cost = 0;
    switch (item.계산방식) {
      case "단가x거리":
        cost = unit * km;
        break;
      case "단가x거리x인원":
        cost = unit * km * (plan.staff.length || 1);
        break;
      case "단가x일수":
        cost = unit * days;
        break;
      case "단가x일수x인원":
        cost = unit * days * (plan.staff.length || 1);
        break;
      case "단가":
        cost = unit;
        break;
    }
    // 항목별로 합산
    breakdown[item.품목] = (breakdown[item.품목] || 0) + cost;
    total += cost;
  });

  return { breakdown, total };
}

// ─── Express 설정 ───────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post("/chat", async (req, res) => {
  const { sessionId="def", message="", days=1, diagnosis="unknown" } = req.body;

  // 세션 히스토리 유지
  const ses = sessions[sessionId] ||= {
    history: []
  };

  // (1) 고객 메시지 저장
  ses.history.push({ role: "user", content: message });

  // (2) “견적 계산” 키워드 있으면 CALCULATE, 아니면 그냥 일반 챗
  const isCalc = /견적/.test(message);

  if (!isCalc) {
    // 일반 상담
    const chat = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        { role:"system", content:
          "당신은 KMTC AI 상담원입니다. 외부 업체 언급 금지; 공감 표현 필수." },
        ...ses.history
      ]
    });
    const reply = chat.choices[0].message.content.trim();
    ses.history.push({ role:"assistant", content: reply });
    return res.json({ reply });
  }

  // (3) 거리/시간 계산 (항공이송/고인이송만)
  let km=0, hr=0, ctx="행사지원";
  if (/항공이송|고인이송/.test(message)) {
    const m = message.match(/(.+)에서 (.+)까지/);
    if (m) {
      try {
        ({ km, hr } = await routeInfo(m[1].trim(), m[2].trim()));
      } catch{
        // 실패 시 무시
      }
    }
    // 고인/환자 여부에 따라 ctx 설정
    ctx = /고인/.test(message) ? "고인이송" : "항공이송";
  }

  // (4) AI에게 planner → staff·equipment 구성 지시
  const plan = await gptPlan(diagnosis, km);

  // (5) 비용 계산
  //    행사: ctx="행사지원"; 항공/고인: ctx 설정
  if (ctx === "행사지원") plan.staff = []; // 거리 무시
  const { breakdown, total } = calcCost(ctx, plan, km, days);

  // (6) Markdown으로 포맷팅
  const lines = [];
  // 서비스명 + 공감·애도
  if (ctx === "고인이송") {
    lines.push(`**삼가 고인의 명복을 빕니다.**`);
  } else if (ctx === "항공이송") {
    lines.push(`환자분의 상황이 많이 힘드셨을 텐데, 빠른 회복을 기원합니다.`);
  }
  lines.push(`## ${ctx} 견적`);
  lines.push(`- **진단명**: ${diagnosis}`);
  if (ctx !== "행사지원") {
    lines.push(`- **거리/시간**: ${km}km / ${hr}h`);
  }
  lines.push(`\n### 필요 인력 & 장비`);
  lines.push(`- **인력**: ${plan.staff.join(", ") || "없음"}`);
  lines.push(`- **장비**: ${
    Object.entries(plan.equipment)
      .filter(([, v])=>v)
      .map(([k])=>k).join(", ") || "없음"
  }`);

  lines.push(`\n### 예상 비용`);
  for (const [item, cost] of Object.entries(breakdown)) {
    lines.push(`- ${item}: ${cost.toLocaleString()}원`);
  }
  lines.push(`- **총합계**: ${total.toLocaleString()}원`);

  // (7) 예측 견적 안내 (항공이송·고인이송만)
  if (ctx !== "행사지원") {
    lines.push(
      `\n*이 견적은 예측 견적이며, 정확한 견적은 환자의 소견서 및 국제 유가, 항공료 등에 따라 달라집니다. 자세한 견적은 KMTC 유선전화로 문의하세요.*`
    );
  }

  const reply = lines.join("\n");
  ses.history.push({ role:"assistant", content: reply });
  return res.json({ reply });
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
