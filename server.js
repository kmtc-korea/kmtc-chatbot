// backend/server.js – KMTC AI 2025-06-12 (vLogicCorrected)
// · Render.com 배포용 PORT 바인딩(process.env.PORT || 3000)
// · [수정] Function Calling을 통해 이송 계획 수립 → 계획 기반 비용 계산 로직
// · Google Geocoding + Distance Matrix API 사용, 실패 시 Haversine 법으로 대체
// · [수정] data/structured_단가표.json의 항목을 '계획'에 따라 선별적으로 계산
// · 이송 종류: 민항기, 에어앰블런스, 전용기, 선박 등
// · 응답은 마크다운 형식으로, 공감·애도 표현 포함
// · 세션 동안 대화 이력 유지, 모든 단계 에러 로깅

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── 유틸리티 함수 ──────────────────────────────────────────────────────────
const toRad = v => (v * Math.PI) / 180;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c; // 지구 반지름 6371km
}

// ─── API 및 핵심 로직 함수 (AI가 호출) ───────────────────────────────────────

// 주소 -> 위경도 변환
async function geocodeAddress({ address }) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GMAPS_KEY}`;
    const js = await fetch(url).then(r => r.json());
    if (js.status !== "OK" || !js.results?.length) throw new Error(`Geocoding API status: ${js.status}`);
    const loc = js.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error("🛑 geocodeAddress error:", err);
    return { error: `주소 해석 실패: ${address}` };
  }
}

// 위경도 -> 거리/시간 계산
async function getDistance({ origin, destination }) {
  try {
    const originStr = `${origin.lat},${origin.lng}`;
    const destinationStr = `${destination.lat},${destination.lng}`;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originStr}&destinations=${destinationStr}&key=${GMAPS_KEY}&language=ko`;
    const js = await fetch(url).then(r => r.json());
    const elem = js.rows?.[0]?.elements?.[0];
    if (elem?.status === "OK" && elem.distance) {
      return { km: Math.round(elem.distance.value / 1000) };
    }
    throw new Error(`Distance Matrix API status: ${elem?.status}`);
  } catch (err) {
    console.warn("⚠️ Distance Matrix failed, using Haversine:", err.message);
    const km = haversineDistance(origin.lat, origin.lng, destination.lat, destination.lng);
    return { km: Math.round(km) };
  }
}

// [핵심 수정] 계획 수립 및 비용 계산
async function generatePlanAndCalculateCost({ origin, destination, patient, transportType, days = 1 }) {
  try {
    const distanceResult = await getDistance({ origin, destination });
    if (distanceResult.error) return distanceResult;
    const { km } = distanceResult;

    // 1. AI를 통해 환자 상태, 거리를 기반으로 상세 계획 수립
    const planPrompt = `
      환자 정보와 이송 정보를 바탕으로 가장 적합한 이송 계획을 JSON 형식으로 세워주세요.
      - 환자 정보: ${JSON.stringify(patient)}
      - 희망 이송수단: ${transportType}
      - 총 거리: ${km} km
      - 예상 소요 일수: ${days}일

      JSON 형식:
      {
        "context": "항공이송" | "고인이송" | "행사지원",
        "transport": "민항기" | "전용기" | "에어앰블런스" | "선박" | "헬기",
        "transportDetail": "스트헤쳐" | "비즈니스" | "전용기" | "에어앰블런스" | "비즈니스실" | "헬리콥터",
        "team": ["의사", "간호사", "응급구조사", "핸들러"],
        "equipment": ["환자감시모니터", "자동제세동기", "썩션기"],
        "cremated": boolean (고인이송 시)
      }
    `;

    const planResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "You are a helpful assistant that creates transport plans in JSON format." }, { role: "user", content: planPrompt }]
    });

    const plan = JSON.parse(planResponse.choices[0].message.content);

    // 2. 생성된 plan을 기반으로 비용 계산
    let totalCost = 0;
    const breakdown = [];
    const priceCategory = prices[plan.context] || [];

    const findAndAdd = (품목, 계산방식, 수량 = 1) => {
        const item = priceCategory.find(p => p.품목 === 품목);
        if (item) {
            let cost = 0;
            switch(계산방식) {
                case "단가": cost = item.단가; break;
                case "단가x거리": cost = item.단가 * km; break;
                case "단가x일수": cost = item.단가 * days; break;
                case "단가x거리x인원": cost = item.단가 * km * 수량; break;
                case "단가x일수x인원": cost = item.단가 * days * 수량; break;
            }
            if (cost > 0) {
                totalCost += cost;
                breakdown.push({ 항목: 품목, 비용: cost });
            }
        }
    };
    
    // 항공/선박료 계산
    const transportItem = priceCategory.find(p => p.세부구분 === plan.transport && p.종류 === plan.transportDetail);
    if(transportItem) {
        findAndAdd(transportItem.품목, transportItem.계산방식);
    }

    // 의료팀 인건비 계산
    plan.team.forEach(member => findAndAdd(member, "단가x일수"));

    // 장비 비용 계산
    plan.equipment.forEach(equip => findAndAdd(equip, "단가x일수"));

    // 기타 필수 비용 추가 (핸들링, 구급차 등)
    findAndAdd("핸들링비용", "단가"); // 현지+국내 핸들링 비용은 예시로 하나만 추가, 실제로는 더 세분화 필요
    findAndAdd("지상구급차", "단가"); // 현지 구급차
    findAndAdd("지상구급차", "단가x거리"); // 국내 구급차


    // 3. 최종 결과 생성
    const transportLabels = {
        민항기: "민항기 (상업용 여객기)",
        국적기: "국적기 (대한항공·아시아나 등)", // 필요시 추가
        에어앰블런스: "에어앰블런스",
        전용기: "전용기 (임차 전용기)",
        선박: "선박"
    };

    let reply = "";
    if (plan.context === "고인이송") {
      reply += "**삼가 고인의 명복을 빕니다.**\n\n";
    } else {
      reply += "환자분의 빠른 쾌유를 진심으로 기원합니다.\n요청하신 내용을 바탕으로 예상 견적을 안내해 드립니다.\n\n";
    }

    reply += `### 📋 이송 계획 요약\n`;
    reply += `- **이송 종류**: ${plan.context}\n`;
    reply += `- **운송 수단**: ${transportLabels[plan.transport] || plan.transport}\n`;
    reply += `- **총 거리**: 약 ${km.toLocaleString()} km\n`;
    reply += `- **예상 소요 기간**: ${days}일\n`;
    reply += `- **의료팀 구성**: ${plan.team.join(", ")}\n\n`;
    reply += `### 💰 예상 비용\n`;
    reply += `**총 예상 비용: ${Math.round(totalCost).toLocaleString()}원**\n\n`;
    reply += `*이 견적은 AI가 수립한 계획에 따른 예측 금액이며, 실제 비용은 환자 상태, 항공/선박 운임 변동, 현지 상황 등 여러 요인에 따라 달라질 수 있습니다. 정확한 비용은 전문 상담사와 상담 후 확정됩니다.*\n`;

    return { plan, calculation: { totalCost, breakdown, km }, reply };

  } catch (err) {
    console.error("🛑 generatePlanAndCalculateCost error:", err);
    return { error: "계획 수립 또는 비용 계산 중 오류가 발생했습니다." };
  }
}


// ─── Function Calling 정의 ─────────────────────────────────────────────────
const functions = [
  {
    type: "function",
    function: {
      name: "generatePlanAndCalculateCost",
      description: "출발지, 도착지, 환자 정보를 받아 이송 계획을 세우고 총 예상 비용을 계산하여 사용자에게 보여줄 최종 답변을 생성합니다.",
      parameters: {
        type: "object",
        properties: {
          origin: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lng: { type: "number" },
            },
            description: "출발지 위경도. geocodeAddress를 통해 얻어야 합니다."
          },
          destination: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lng: { type: "number" },
            },
            description: "도착지 위경도. geocodeAddress를 통해 얻어야 합니다."
          },
          patient: {
            type: "object",
            description: "진단명, 의식상태, 거동가능 여부 등 환자 관련 정보",
            properties: {
              diagnosis: { type: "string" },
              consciousness: { type: "string" },
              mobility: { type: "string" },
            }
          },
          transportType: { type: "string", description: "사용자가 명시적으로 선호하는 이송 수단 (예: '선박', '항공기')" },
          days: { type: "number", description: "예상 소요 일수, 기본값은 1", default: 1 }
        },
        required: ["origin", "destination", "patient"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "geocodeAddress",
      description: "주소를 위도와 경도로 변환합니다.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "변환할 주소 (예: '서울대학교병원')" },
        },
        required: ["address"],
      },
    },
  },
];

const availableFunctions = {
  geocodeAddress,
  generatePlanAndCalculateCost,
};


// ─── Express 서버 설정 ───────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
const sessions = {};

app.post("/chat", async (req, res) => {
  try {
    const { sessionId = "default-session", message, patient = {} } = req.body;
    const session = sessions[sessionId] ||= {
      history: [{
        role: "system",
        content: `
당신은 KMTC 의료 이송 전문 AI 상담원입니다.
- 당신의 주요 임무는 사용자의 요청(출발지, 도착지, 환자상태)을 분석하여 'generatePlanAndCalculateCost' 함수를 호출하고, 그 결과를 사용자에게 친절하게 전달하는 것입니다.
- 출발지나 도착지 주소만 언급되면, 'geocodeAddress'를 먼저 호출하여 위경도를 알아내야 합니다.
- 모든 정보(출발지 위경도, 도착지 위경도, 환자 정보)가 준비되면 'generatePlanAndCalculateCost'를 호출하세요.
- 환자 정보(진단명, 의식, 거동 가능 여부)가 부족하면 정중하게 질문하여 파악하세요.
- 항상 공감과 위로의 표현을 사용하고, 감성적이고 따뜻한 태도를 유지하세요.
- 절대 타업체를 언급하지 마세요.
        `.trim()
      }]
    };

    session.history.push({ role: "user", content: message });

    let response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: session.history,
        tools: functions,
        tool_choice: "auto",
    });

    let responseMessage = response.choices[0].message;

    // AI가 함수 호출을 결정했을 때
    while (responseMessage.tool_calls) {
        session.history.push(responseMessage);
        const toolCalls = responseMessage.tool_calls;
        
        for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const functionToCall = availableFunctions[functionName];
            const functionArgs = JSON.parse(toolCall.function.arguments);
            
            console.log(`🤖 Calling function: ${functionName}`, functionArgs);

            const functionResponse = await functionToCall(functionArgs);

            session.history.push({
                tool_call_id: toolCall.id,
                role: "tool",
                name: functionName,
                content: JSON.stringify(functionResponse),
            });
        }

        // 함수 실행 결과를 바탕으로 다시 AI에게 응답 생성 요청
        const secondResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: session.history,
            tools: functions,
            tool_choice: "auto",
        });

        responseMessage = secondResponse.choices[0].message;
    }

    // 최종 답변을 히스토리에 추가하고 클라이언트에게 전송
    const reply = responseMessage.content;
    session.history.push({ role: "assistant", content: reply });
    
    // 최종 결과에서 reply만 추출하여 전송 (만약 function result가 content에 담겨 왔다면)
    try {
        const parsedReply = JSON.parse(reply);
        if(parsedReply.reply) {
            return res.json({ reply: parsedReply.reply });
        }
    } catch (e) {
        // 일반 텍스트 응답이므로 그대로 전송
    }

    return res.json({ reply });

  } catch (err) {
    console.error("🛑 /chat error:", err);
    return res.status(500).json({
      reply: "⚠️ 서버 내부에서 심각한 오류가 발생했습니다. 관리자에게 문의해주세요."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 KMTC AI (Corrected) running on port ${PORT}`));
