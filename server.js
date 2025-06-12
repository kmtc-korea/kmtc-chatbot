// backend/server.js – KMTC AI 2025-06-12 (vFuncCall)
// · 함수 호출(Function Calling)으로 AI가 스스로 의도 파악→거리 계산→비용 산출까지 처리
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 에 있는 “단가”와 “계산방식”만 참조
// · 응답은 마크다운 형식으로 간결하게, 공감·애도 표현 포함
// · 세션 동안 대화 이력 유지

import express from "express";
import cors from "cors";
import { config } from "dotenv";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
const __dirname       = path.dirname(fileURLToPath(import.meta.url));
const GMAPS_KEY       = process.env.GMAPS_KEY;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── Google Distance Matrix API 호출 ────────────────────────────────────────
async function getDistance({ origin, destination }) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
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

// ─── 비용 계산 ───────────────────────────────────────────────────────────────
async function computeCost({ context, transport, km, days, patient }) {
  // 1) AI 플랜 생성 (JSON ONLY)
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const planRes = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages:[
      {
        role: "system",
        content: `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`
      },
      { role: "user", content:
        `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"}` +
        ` / 거동:${patient.mobility||"unknown"} / 거리:${km}`
      }
    ]
  });
  let plan0;
  try {
    plan0 = JSON.parse(planRes.choices[0].message.content.trim());
  } catch {
    // 실패 시 기본 플랜
    plan0 = {
      type: "air",
      cremated: false,
      risk: "medium",
      transport,
      seat: "business",
      staff: ["doctor","nurse"],
      equipment: { ventilator:true, ecmo:false },
      medLvl: "medium",
      notes: []
    };
  }

  // 2) 실제 비용 계산
  const ctxKey = plan0.type==="funeral" ? "고인이송"
               : plan0.type==="event"   ? "행사지원"
               :                           "항공이송";
  let total = 0;
  (prices[ctxKey]||[]).forEach(item => {
    const u = item.단가;
    switch(item.계산방식) {
      case "단가x거리":
        total += u * km; break;
      case "단가x거리x인원":
        total += u * km * (plan0.staff.length||1); break;
      case "단가x일수":
        total += u * days; break;
      case "단가x일수x인원":
        total += u * days * (plan0.staff.length||1); break;
      case "단가":
        total += u; break;
    }
  });

  return { plan: plan0, context: ctxKey, km, hr:0, total };
}

// ─── Function Calling 정의 ─────────────────────────────────────────────────
const functions = [
  {
    name: "getDistance",
    description: "출발지와 도착지 간 거리(km)와 시간(hr)을 계산합니다.",
    parameters: {
      type: "object",
      properties: {
        origin:      { type: "string", description: "출발지 주소 또는 장소" },
        destination: { type: "string", description: "도착지 주소 또는 장소" }
      },
      required: ["origin","destination"]
    }
  },
  {
    name: "computeCost",
    description: "context, transport, 거리, 일수, patient 정보를 바탕으로 비용을 계산합니다.",
    parameters:{
      type:"object",
      properties:{
        context:   { type:"string", enum:["항공이송","고인이송","행사지원"] },
        transport: { type:"string" },
        km:        { type:"number" },
        days:      { type:"number" },
        patient:   { type:"object" }
      },
      required:["context","transport","km","days"]
    }
  }
];

// ─── Express 설정 ───────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post("/chat", async (req, res) => {
  const { sessionId="def", message="", days=1, patient={} } = req.body;
  const ses = sessions[sessionId] ||= {
    history: [{
      role: "system",
      content: `
당신은 KMTC AI 상담원입니다.
- 서비스: 항공이송, 고인이송, 행사 의료지원
- 비용 계산: data/structured_단가표.json만 참조
- 거리 계산: Google Distance Matrix API
- 응답은 마크다운, 공감·애도 표현 포함
- 타업체 언급 금지`
    }]
  };

  // 1) AI에게 의도 분석+함수 호출 요청
  ses.history.push({ role:"user", content: message });
  const first = await new OpenAI({ apiKey: OPENAI_API_KEY })
    .chat.completions.create({
      model: "gpt-4o",
      messages: ses.history,
      functions,
      function_call: "auto"
    });

  const msg = first.choices[0].message;
  ses.history.push(msg);

  // 2) getDistance 호출 필요 시 실제 실행
  if (msg.function_call?.name === "getDistance") {
    const args = JSON.parse(msg.function_call.arguments);
    let dist;
    try {
      dist = await getDistance(args);
    } catch (err) {
      const warn = "⚠️ 거리 계산 실패. 주소를 다시 확인해주세요.";
      ses.history.push({ role:"assistant", content: warn });
      return res.json({ reply: warn });
    }
    // 호출 결과를 AI에게 다시 전달
    ses.history.push({
      role: "function",
      name: "getDistance",
      content: JSON.stringify(dist)
    });
    const second = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: ses.history,
      functions,
      function_call: "auto"
    });
    ses.history.push(second.choices[0].message);
    // 이제 computeCost 호출
    return completeCost(second.choices[0].message);
  }

  // 3) computeCost 호출 필요 시
  if (msg.function_call?.name === "computeCost") {
    return completeCost(msg);
  }

  // 4) 일반 답변
  const reply = msg.content;
  return res.json({ reply });
  
  // — 내부 헬퍼: computeCost를 실행하고 최종 응답
  async function completeCost(fnMsg) {
    const args = JSON.parse(fnMsg.function_call.arguments);
    const costRes = await computeCost({
      context: args.context,
      transport: args.transport,
      km: args.km,
      days,
      patient
    });
    ses.history.push({
      role: "function",
      name: "computeCost",
      content: JSON.stringify(costRes)
    });
    // 최종 렌더링
    const final = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: ses.history
    });
    const finalReply = final.choices[0].message.content;
    ses.history.push({ role:"assistant", content: finalReply });
    return res.json({ reply: finalReply });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
