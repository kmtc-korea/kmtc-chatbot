// backend/server.js – KMTC AI 2025-06-12 (v14.5)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 에 있는 “항목”, “단가”와 “계산방식”만 참조
// · 응답은 마크다운 형식으로 간결하게, 공감·애도 표현 포함
// · 세션이 살아있는 동안 대화 이력 유지
// · 마지막에 예측 견적 안내 문구 추가 (항공이송·고인이송)
// · 환자 진단명만으로 AI가 인력·장비 구성 후 견적 산출
// · gptPlan: function_call 강제 → 항상 JSON 반환

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

// ─── Google Distance Matrix로 거리/시간 계산 ─────────────────────────────────────
async function routeInfo(fromAddr, toAddr) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
    + `?origins=${encodeURIComponent(fromAddr)}`
    + `&destinations=${encodeURIComponent(toAddr)}`
    + `&key=${GMAPS_KEY}&language=ko`;
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

// ─── gptPlan 함수 정의 (function-calling) ────────────────────────────────────
const planFunction = {
  name: "createPlan",
  description: "환자의 진단과 거리(km)에 따라 staff, equipment, transport, seat 등을 결정",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["air","funeral","event"] },
      cremated: { type: "boolean" },
      risk: { type: "string", enum: ["low","medium","high"] },
      transport: { type: "string", enum: ["civil","airAmbulance","charter","ship"] },
      seat: { type: "string", enum: ["business","stretcher"] },
      staff: {
        type: "array",
        items: { type: "string", enum: ["doctor","nurse","paramedic"] }
      },
      equipment: {
        type: "object",
        properties: {
          ventilator: { type: "boolean" },
          ecmo: { type: "boolean" }
        }
      },
      medLvl: { type: "string", enum: ["low","medium","high"] },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["type","transport","staff","equipment","medLvl"]
  }
};

async function gptPlan(diagnosis, km) {
  const sys = `JSON ONLY:\n${JSON.stringify(planFunction.parameters,null,2)}`;
  const usr = `진단:${diagnosis || "unknown"} / 거리:${km}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    messages: [
      { role:"system", content: sys },
      { role:"user", content: usr }
    ],
    functions: [planFunction],
    function_call: { name: "createPlan" }
  });
  return JSON.parse(resp.choices[0].message.function_call.arguments);
}

// ─── 비용 계산 ───────────────────────────────────────────────────────────────
function calcCost(ctx, plan, km, days) {
  const breakdown = {};
  const items = prices[ctx] || [];

  items.forEach(item => {
    const unit = item.단가;
    let val = 0;
    switch (item.계산방식) {
      case "단가x거리":             val = unit * km; break;
      case "단가x거리x인원":        val = unit * km * plan.staff.length; break;
      case "단가x일수":             val = unit * days; break;
      case "단가x일수x인원":        val = unit * days * plan.staff.length; break;
      case "단가":                  val = unit; break;
    }
    breakdown[item.항목] = val;
  });

  breakdown.총합계 = Object.values(breakdown).reduce((a,b)=>a+b,0);
  return breakdown;
}

// ─── system prompt ───────────────────────────────────────────────────────────
const systemPrompt = `
당신은 KMTC AI 상담원입니다.
- 서비스: 항공이송, 고인이송, 행사 의료지원
- 견적 계산 시 structured_단가표.json만 참고
- 공감·애도 표현 필수
  - 고인이송: "삼가 고인의 명복을 빕니다."
  - 환자 이송: "환자분의 상황이 많이 힘드셨을 텐데…"
- 절대 타업체 언급 금지
`;

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post("/chat", async (req, res) => {
  const { sessionId="def", message="", days=1, patient={} } = req.body;
  const diagnosis = patient.diagnosis || "";

  // 세션 초기화
  const ses = sessions[sessionId] ||= {
    history: [{ role:"system", content: systemPrompt }]
  };
  ses.history.push({ role:"user", content: message });

  // 거리 계산 (항공이송·고인이송만)
  let km=0, hr=0, from="", to="";
  if (/항공이송|고인이송/.test(message)) {
    const m = message.match(/(.+)에서 (.+)까지/);
    if (m) {
      from = m[1].trim();
      to   = m[2].trim();
      try { ({ km, hr } = await routeInfo(from,to)); }
      catch {}
    }
  }

  // AI 플랜 & 비용 산출
  const plan = await gptPlan(diagnosis, km);
  const ctx  = plan.type === "funeral" ? "고인이송"
             : plan.type === "event"   ? "행사지원"
             :                            "항공이송";
  const cost = calcCost(ctx, plan, km, days);

  // 마크다운 조립
  let md = `## ${ctx} 견적\n\n`;
  if (ctx !== "행사지원") {
    md += `- **진단명**: ${diagnosis}\n`;
    md += `- **출발지**: ${from}\n`;
    md += `- **도착지**: ${to}\n`;
    md += `- **거리·시간**: ${km}km ${hr}h\n\n`;
  }
  md += `### 필요 인력 & 장비\n`;
  md += `- **인력**: ${plan.staff.join(", ")}\n`;
  const eqs = Object.entries(plan.equipment)
                .filter(([,f])=>f).map(([e])=>e).join(", ") || "없음";
  md += `- **장비**: ${eqs}\n\n`;
  md += `### 예상 비용\n`;
  Object.entries(cost).forEach(([k,v])=>{
    if(k!=="총합계") md += `- ${k}: ${v.toLocaleString("ko-KR")}원\n`;
  });
  md += `- **총합계**: ${cost.총합계.toLocaleString("ko-KR")}원\n\n`;

  if (ctx !== "행사지원") {
    md += `*이 견적은 예측 견적이며, 정확한 견적은 환자의 소견서 및 국제 유가, 항공료 등에 따라 달라집니다.*\n`;
    md += `*자세한 견적은 KMTC 유선전화로 문의하세요.*`;
  }

  ses.history.push({ role:"assistant", content: md });
  res.json({ reply: md });
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
