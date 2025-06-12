// backend/server.js – KMTC AI 2025-06-12 (v15.0)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 에 있는 “단가”와 “계산방식”만 참조
// · 응답은 마크다운 형식으로 간결하게, 공감·애도 표현 포함
// · 세션이 살아있는 동안 대화 이력 유지 & Intent 기반 분기

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

// ─── Intent 분류 함수 스키마 ─────────────────────────────────────────────────
const intentFunctions = [{
  name: "decideIntentAndParams",
  description: "사용자 입력에서 intent와 파라미터를 추출합니다.",
  parameters: {
    type: "object",
    properties: {
      intent:      { type:"string", enum:["GENERAL","EXPLAIN_COST","CALCULATE_COST"] },
      from:        { type:"string" },
      to:          { type:"string" },
      diagnosis:   { type:"string" },
      days:        { type:"number" }
    },
    required: ["intent"]
  }
}];

// ─── Google Distance Matrix 호출 ─────────────────────────────────────────────
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

// ─── 비용 계산 (structured 단가표만 참조) ─────────────────────────────────
function calcCost(ctx, plan, km, days) {
  let total = 0;
  const items = prices[ctx] || [];
  items.forEach(item => {
    const unit = item.단가;
    switch (item.계산방식) {
      case "단가x거리":
        total += unit * km; break;
      case "단가x거리x인원":
        total += unit * km * (plan.staff?.length||1); break;
      case "단가x일수":
        total += unit * days; break;
      case "단가x일수x인원":
        total += unit * days * (plan.staff?.length||1); break;
      case "단가":
        total += unit; break;
    }
  });
  return total;
}

// ─── Express 설정 & 핸들러 ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
const sessions = {};

app.post('/chat', async (req, res) => {
  const { sessionId='def', message='', patient={}, days=1 } = req.body;

  // 세션 초기화 및 히스토리 유지
  const ses = sessions[sessionId] ||= {
    history: [
      { role:'system', content:
        `당신은 KMTC AI 상담원입니다. 외부 업체 언급 금지.
        - 서비스: 항공이송, 고인이송, 행사 의료지원
        - 행사 의료지원: 가격 설명만 제공
        - 항공·고인 이송: 거리 계산 후 견적 제공
        - 공감/애도 문구 포함
        - 마지막에 예측 견적 안내 문구 삽입`
      }
    ]
  };

  // 1) Intent 분류 & 파라미터 추출
  const classify = await openai.chat.completions.create({
    model:'gpt-4o', temperature:0,
    messages:[
      ...ses.history,
      { role:'user', content: message }
    ],
    functions: intentFunctions,
    function_call:{ name:'decideIntentAndParams' }
  });
  const fn = classify.choices[0].message.function_call;
  const args = JSON.parse(fn.arguments);
  const intent = args.intent;

  // 2) GENERAL 안내
  if (intent === 'GENERAL') {
    const reply = `안녕하세요! KMTC AI입니다. 항공이송, 고인이송, 행사 의료지원 중 원하시는 서비스를 말씀해주세요.`;
    return res.json({ reply });
  }

  // 3) EXPLAIN_COST (행사 의료지원)
  if (intent === 'EXPLAIN_COST') {
    const reply = `**행사 의료지원 비용 안내**
- 인력 비용: 현장 규모 및 요구사항에 따라 산출됩니다.
- 장비 대여: 행사 특성에 따라 결정됩니다.

*정확한 견적은 행사 기획사 또는 KMTC 유선 문의를 통해 제공됩니다.*`;
    return res.json({ reply });
  }

  // 4) CALCULATE_COST (항공/고인 이송)
  // 거리 계산
  let km=0, hr=0;
  try {
    ({ km, hr } = await routeInfo(args.from, args.to));
  } catch {
    return res.json({ reply:'⚠️ 거리 계산 실패: 주소를 다시 확인해주세요.' });
  }

  // AI 플랜 생성 (진단 기반 staff/equipment 결정)
  const planSys = `JSON ONLY: {"type":"air|funeral","diagnosis":"..","transport":"civil|airAmbulance|charter","staff":["doctor","nurse"],"equipment":{"ventilator":bool}}`;
  const planUsr = `진단:${args.diagnosis} / 거리:${km}`;
  const planRes = await openai.chat.completions.create({
    model:'gpt-4o', temperature:0.2,
    messages:[ {role:'system',content:planSys},{role:'user',content:planUsr} ]
  });
  const plan = JSON.parse(planRes.choices[0].message.content);

  // 비용 산출
  const ctx = plan.type==='funeral'?'고인이송':'항공이송';
  const cost = calcCost(ctx, plan, km, days);

  // 감정 표현 + 견적
  let reply = '';
  if (ctx==='고인이송') {
    reply += '삼가 고인의 명복을 빕니다.\n';
  } else {
    reply += '환자분의 상황이 많이 힘드셨을 텐데요. 빠른 쾌유를 기원합니다.\n';
  }
  reply += `**${ctx} 견적**
- 진단명: ${args.diagnosis}
- 출발→도착: ${args.from}→${args.to} (${km}km / ${hr}h)
- 필요 인력: ${plan.staff.join(', ')}
- 필요 장비: ${Object.entries(plan.equipment).filter(([k,v])=>v).map(([k])=>k).join(', ')||'없음'}

💰 **총 예상 비용: 약 ${cost.toLocaleString()}원**

*이 견적은 예측 견적이며, 정확한 견적은 환자의 소견서 및 국제 유가, 항공료 등에 따라 달라집니다. 자세한 견적은 KMTC 유선전화로 문의하세요.*`;

  // 5) 히스토리 저장 & 응답
  ses.history.push({ role:'assistant', content:reply });
  res.json({ reply });
});

app.listen(3000,()=>console.log('🚀 KMTC AI running on port 3000'));
