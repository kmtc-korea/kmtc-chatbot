// backend/server.js – KMTC AI 2025-06-12 (vMultiOption)
// · [수정] AI가 환자 상태 분석 후, 가능한 모든 이송 옵션(민항기,선박,에어앰블런스)과 견적을 비교 제시
// · [수정] 환자 진단명에 따른 필요 의료장비, 약물, 인력 등을 AI가 판단하여 명시
// · All-Inclusive(전용기)와 A la carte(민항기) 비용 계산 로직 유지
// · Google Geocoding + Distance Matrix API 사용, 실패 시 Haversine 법으로 대체
// · 응답은 마크다운 형식으로, 공감·애도 표현 포함

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
  return 6371 * c;
}

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

// ─── 핵심 로직: 계획 수립 및 비용 계산 ───────────────────────────────────────

/**
 * 단일 이송 계획에 대한 비용을 계산하는 헬퍼 함수
 */
async function calculateSinglePlanCost({ plan, km, days }) {
    let totalCost = 0;
    const priceCategory = prices[plan.context] || [];
    const allInclusiveTransports = ["전용기", "에어앰블런스", "헬기"];

    const findAndAdd = (filters, qty = 1) => {
        const item = priceCategory.find(p => 
            Object.entries(filters).every(([key, value]) => p[key] === value)
        );
        if (item) {
            let cost = 0;
            switch(item.계산방식) {
                case "단가": cost = item.단가 * qty; break;
                case "단가x거리": cost = item.단가 * km; break;
                case "단가x일수": cost = item.단가 * days * qty; break;
                case "단가x거리x인원": cost = item.단가 * km * qty; break;
                case "단가x일수x인원": cost = item.단가 * days * qty; break;
            }
            if (cost > 0) totalCost += cost;
        }
    };
    
    const transportItem = priceCategory.find(p => p.세부구분 === plan.transport);
    if (transportItem) findAndAdd({ 등록번호: transportItem.등록번호 });

    if (!allInclusiveTransports.includes(plan.transport)) {
        plan.team.forEach(member => findAndAdd({ 품목: member, 세부구분: '인건비' }, days));
        plan.equipment.forEach(equip => findAndAdd({ 품목: equip, 세부구분: '의료장비' }, days));
        findAndAdd({ 종류: "현지업무처리" });
        findAndAdd({ 종류: "국내업무처리" });
        findAndAdd({ 종류: "의료장비화물료" });
        findAndAdd({ 품목: "의료용 의약품세트" });
        findAndAdd({ 종류: "현지구급차" });
        findAndAdd({ 종류: "국내구급차" });
    }
    return totalCost;
}


/**
 * AI가 호출하는 주 함수: 여러 이송 옵션을 생성하고 각각의 비용을 계산하여 최종 답변 생성
 */
async function generateMultipleTransportOptions({ origin, destination, patient, days = 1 }) {
    try {
        const distanceResult = await getDistance({ origin, destination });
        if (distanceResult.error) return distanceResult;
        const { km } = distanceResult;

        // 1. AI에게 환자 상태 분석 및 가능한 모든 옵션 생성을 요청
        const analysisPrompt = `
          당신은 최고의 의료 이송 전문가입니다. 아래 환자 정보와 이송 거리를 바탕으로, 가능한 모든 이송 옵션을 분석하고 각각의 계획을 JSON 배열 형식으로 제안해주세요.
          
          - 환자 정보: ${JSON.stringify(patient)}
          - 이송 거리: ${km} km (만약 1000km 미만이면 '선박' 옵션도 반드시 고려할 것)
          - 예상 소요 일수: ${days}일
          - 분석 항목: 각 옵션에 대해 이송 수단, 필요한 의료팀, 필수 장비 및 약물을 구체적으로 명시해야 합니다. 특히 환자 진단명에 맞춰 필수 장비를 선정하세요(예: 뇌출혈 환자는 ICP 모니터, 인공호흡기 등).
          
          JSON 형식:
          {
            "analysis": "환자(뇌출혈)는 현재 의식 명료하나, 비행 중 기압 변화로 인한 뇌압 상승 위험이 있어 지속적인 모니터링이 필수적임. 벤틸레이터 사용은 안정적인 호흡 유지를 위함.",
            "options": [
              {
                "context": "항공이송",
                "transport": "민항기",
                "transportDetail": "스트헤쳐",
                "team": ["의사", "간호사"],
                "equipment": ["환자감시모니터", "인공호흡기(Ventilator)", "자동제세동기", "썩션기"],
                "summary": "가장 비용 효율적인 옵션. 대한항공/아시아나 등 국적기 비즈니스석 9좌석을 사용하는 의료용 침대(Stretcher) 방식. 비행 안정성이 높음."
              },
              {
                "context": "항공이송",
                "transport": "에어앰블런스",
                "team": ["의사", "간호사", "응급구조사"],
                "equipment": ["환자감시모니터", "인공호흡기(Ventilator)", "자동제세동기", "썩션기", "ICP모니터"],
                "summary": "가장 신속하고 안전한 옵션. 환자만을 위한 전용 의료 제트기로, 지상 구급차와 동일한 수준의 의료 환경을 제공. 비용이 가장 높음."
              },
              {
                "context": "항공이송",
                "transport": "선박",
                "transportDetail": "비즈니스실",
                "team": ["의사", "간호사"],
                "equipment": ["환자감시모니터", "인공호흡기(Ventilator)"],
                "summary": "단거리(일본, 중국, 제주 등) 전용 옵션. 기압 변화가 없어 안정적이나, 이동 시간이 길다는 단점이 있음."
              }
            ]
          }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: analysisPrompt }]
        });

        const result = JSON.parse(response.choices[0].message.content);

        // 2. 생성된 각 옵션에 대해 비용 계산
        for (const option of result.options) {
            option.cost = await calculateSinglePlanCost({ plan: option, km, days });
        }
        
        // 3. 최종 답변 포맷팅
        let reply = `환자분의 빠른 쾌유를 진심으로 기원합니다.\n요청하신 내용을 바탕으로, 환자분께 적용 가능한 이송 옵션과 예상 견적을 함께 안내해 드립니다.\n\n`;
        reply += `### 🩺 **의료팀 소견**\n`;
        reply += `${result.analysis}\n\n`;
        reply += `--- \n\n`;

        const transportLabels = { 민항기: "✈️ 민항기", 에어앰블런스: "🚑 에어앰블런스", 선박: "🚢 선박" };

        result.options.forEach(option => {
            if (option.cost > 0) { // 비용이 계산된 유효한 옵션만 표시
                reply += `### ${transportLabels[option.transport] || option.transport} 옵션\n`;
                reply += `**${option.summary}**\n\n`;
                reply += `- **예상 비용**: **${Math.round(option.cost).toLocaleString()}원**\n`;
                reply += `- **필요 의료팀**: ${option.team.join(", ")}\n`;
                reply += `- **필수 장비/약품**: ${option.equipment.join(", ")}\n\n`;
            }
        });
        
        reply += `--- \n`;
        reply += `* 위 견적은 AI의 분석에 따른 예측 금액이며, 실제 비용은 실시간 항공료, 환자 상태의 변화, 현지 상황 등 여러 요인에 따라 달라질 수 있습니다. 정확한 진행을 위해 상담사와 최종 확인이 필요합니다.*\n`;
        
        return { reply };

    } catch (err) {
        console.error("🛑 generateMultipleTransportOptions error:", err);
        return { error: "옵션 생성 또는 비용 계산 중 오류가 발생했습니다." };
    }
}

// ─── Function Calling 정의 ─────────────────────────────────────────────────
const functions = [{
    type: "function",
    function: {
        name: "generateMultipleTransportOptions",
        description: "출발지, 도착지, 환자 정보를 받아 가능한 모든 이송 옵션(민항기,선박,에어앰블런스)을 분석하고, 각 옵션별 비용을 계산하여 비교 가능한 최종 답변을 생성합니다.",
        parameters: {
            type: "object",
            properties: {
                origin: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" }}, description: "출발지 위경도. geocodeAddress를 통해 얻어야 합니다." },
                destination: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" }}, description: "도착지 위경도. geocodeAddress를 통해 얻어야 합니다." },
                patient: { type: "object", description: "진단명, 의식상태, 거동가능 여부 등 환자 관련 정보", properties: { diagnosis: { type: "string" }, consciousness: { type: "string" }, mobility: { type: "string" }}},
                days: { type: "number", description: "예상 소요 일수, 기본값은 1", default: 1 }
            },
            required: ["origin", "destination", "patient"],
        },
    },
}, {
    type: "function",
    function: {
        name: "geocodeAddress",
        description: "주소를 위도와 경도로 변환합니다.",
        parameters: { type: "object", properties: { address: { type: "string", description: "변환할 주소" }}, required: ["address"] },
    },
}];

const availableFunctions = {
  geocodeAddress,
  generateMultipleTransportOptions,
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
당신은 KMTC 소속의 최고 의료 이송 컨설턴트 AI입니다.
- 당신의 임무는 사용자의 요청(출발지, 도착지, 환자상태)을 분석하여 'generateMultipleTransportOptions' 함수를 호출하고, 그 결과를 사용자에게 친절하고 상세하게 전달하는 것입니다.
- 환자의 상태, 진단명을 최우선으로 고려하여 답변을 생성해야 합니다.
- 주소만 언급되면, 'geocodeAddress'를 먼저 호출하여 위경도를 알아내야 합니다.
- 모든 정보(출발지/도착지 위경도, 환자 정보)가 준비되면 'generateMultipleTransportOptions'를 호출하세요.
- 환자 정보가 부족하면 정중하게 질문하여 파악하세요.
- 항상 공감과 위로의 표현을 사용하고, 감성적이고 따뜻한 태도를 유지하세요.
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
        const secondResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: session.history,
            tools: functions,
            tool_choice: "auto",
        });
        responseMessage = secondResponse.choices[0].message;
    }

    const reply = responseMessage.content;
    session.history.push({ role: "assistant", content: reply });
    
    try {
        const parsedReply = JSON.parse(reply);
        if(parsedReply.reply) return res.json({ reply: parsedReply.reply });
    } catch (e) {}

    return res.json({ reply });

  } catch (err) {
    console.error("🛑 /chat error:", err);
    return res.status(500).json({
      reply: "⚠️ 서버 내부에서 심각한 오류가 발생했습니다. 관리자에게 문의해주세요."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 KMTC AI (Multi-Option Consultant) running on port ${PORT}`));
