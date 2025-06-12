// backend/server.js – KMTC AI 2025-06-12 (v15.2)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API와 내부 비용 계산 함수를 OpenAI function-calling으로 자동 호출
// · data/structured_단가표.json 의 “단가”와 “계산방식”만 참조
// · 응답은 Markdown 형식
// · 세션별 대화 이력 유지, AI가 스스로 의도 파악 및 함수 호출 결정

import express from "express";
import cors from "cors";
import { config } from "dotenv";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const GMAPS_KEY      = process.env.GMAPS_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 비용 단가표 로드
const priceTable = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// OpenAI 클라이언트
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 함수 스키마 정의
const functions = [
  {
    name: "getDistance",
    description: "두 지점 사이 거리(킬로미터)와 소요시간(시간)을 반환",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "출발지 주소" },
        destination: { type: "string", description: "도착지 주소" }
      },
      required: ["origin","destination"]
    }
  },
  {
    name: "computeCost",
    description: "이송 컨텍스트, staff, equipment, 거리, 일수를 받아 총 비용을 계산",
    parameters: {
      type: "object",
      properties: {
        context: { type:"string", enum:["air","funeral","event"] },
        staff: { type:"array", items:{ type:"string" } },
        equipment: { type:"object", additionalProperties:{ type:"boolean" } },
        km: { type:"number" },
        days: { type:"number" }
      },
      required: ["context","staff","equipment","km","days"]
    }
  }
];

// 거리 계산 함수
async function getDistance({ origin, destination }) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destination)}` +
    `&key=${GMAPS_KEY}&language=ko`;
  const js = await fetch(url).then(r=>r.json());
  const e = js.rows[0].elements[0];
  if (e.status!="OK") throw new Error(e.status);
  return { km: Math.round(e.distance.value/1000), hr: +(e.duration.value/3600).toFixed(1) };
}

// 비용 계산 함수
function computeCost({ context, staff, equipment, km, days }) {
  let total = 0;
  const items = priceTable[context] || [];
  for (const it of items) {
    const unit = it.단가;
    switch (it.계산방식) {
      case "단가x거리": total += unit*km; break;
      case "단가x거리x인원": total += unit*km*staff.length; break;
      case "단가x일수": total += unit*days; break;
      case "단가x일수x인원": total += unit*days*staff.length; break;
      case "단가": total += unit; break;
    }
  }
  return { total };
}

// Express 앱
const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post("/chat", async (req, res) => {
  const { sessionId = "def", message = "", days = 1, patient = {} } = req.body;
  const ses = sessions[sessionId] ||= { history: [] };

  ses.history.push({ role:"user", content: message });

  // AI에게 모든 로직 위임: intent 파악, 함수 호출 등
  const chat = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role:"system", content: `
당신은 KMTC AI 상담원입니다.
- 서비스: 항공이송, 고인이송, 행사 의료지원
- 비용 계산 시 structured_단가표.json만 참조
- 필요시 getDistance, computeCost 함수를 호출하여 거리/비용 산출
- 응답은 Markdown 형식으로 간결하게, 공감·애도 문구 포함
- **절대** 타업체 언급 금지
` },
      ...ses.history
    ],
    functions,
    function_call: "auto"
  });

  let messageObj = chat.choices[0].message;

  // 함수 호출 응답 처리
  if (messageObj.function_call) {
    const { name, arguments: argsJson } = messageObj.function_call;
    const args = JSON.parse(argsJson);
    let fnResult;
    try {
      if (name === "getDistance") fnResult = await getDistance(args);
      if (name === "computeCost") fnResult = await computeCost(args);
    } catch (e) {
      fnResult = { error: e.message };
    }
    // 함수 결과를 시스템 메시지로 재호출
    ses.history.push(messageObj);
    ses.history.push({ role:"function", name, content: JSON.stringify(fnResult) });
    // 재귀 호출
    const followUp = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      messages: ses.history
    });
    messageObj = followUp.choices[0].message;
  }

  const reply = messageObj.content.trim();
  ses.history.push({ role:"assistant", content: reply });
  res.json({ reply });
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
