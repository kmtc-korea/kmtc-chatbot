// backend/server.js – KMTC AI 2025-06-12 (vProfessional-Final)
// · [수정] 민항기 모델(이코노미 6석), 기본 의료팀(의사/간호사/핸들러) 규칙 AI 프롬프트에 명시
// · [수정] 민항기/선박 이용 시 체류일 3일 자동 적용 로직 추가
// · [수정] 지상 이동(병원↔공항), 항공 이동 시간 계산 및 답변에 포함
// · [수정] 사용자에게 위도/경도 등 불필요한 정보 노출되지 않도록 시스템 프롬프트 강화
// · AI가 환자 상태 분석 후, 가능한 모든 이송 옵션과 견적을 비교 제시

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

const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── 유틸리티 및 API 호출 함수 ──────────────────────────────────────────────
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
        if (js.status !== "OK" || !js.results?.length) throw new Error(`Geocoding failed for ${address}`);
        const { lat, lng } = js.results[0].geometry.location;
        const name = js.results[0].formatted_address;
        return { lat, lng, name };
    } catch (err) {
        console.error("🛑 geocodeAddress error:", err);
        return { error: `주소 해석 실패: ${address}` };
    }
}

async function getDistance(origin, destination) {
    try {
        const originStr = `${origin.lat},${origin.lng}`;
        const destinationStr = `${destination.lat},${destination.lng}`;
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originStr}&destinations=${destinationStr}&key=${GMAPS_KEY}&language=ko`;
        const js = await fetch(url).then(r => r.json());
        const elem = js.rows?.[0]?.elements?.[0];
        if (elem?.status === "OK" && elem.distance) {
            return { km: Math.round(elem.distance.value / 1000), duration: elem.duration.text };
        }
        throw new Error(`Distance Matrix status: ${elem?.status}`);
    } catch (err) {
        console.warn("⚠️ Distance Matrix failed, estimating with Haversine:", err.message);
        const km = haversineDistance(origin.lat, origin.lng, destination.lat, destination.lng);
        return { km: Math.round(km), duration: `약 ${Math.round(km/80)}시간` }; // 80km/h로 단순 계산
    }
}


// ─── 핵심 로직: 계획 수립 및 비용 계산 ───────────────────────────────────────

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
            const teamSize = plan.team ? plan.team.length : 3;
            switch(item.계산방식) {
                case "단가": cost = item.단가 * qty; break;
                case "단가x거리": cost = item.단가 * km; break;
                case "단가x일수": cost = item.단가 * days * qty; break;
                case "단가x거리x인원": cost = item.단가 * km * teamSize; break;
                case "단가x일수x인원": cost = item.단가 * days * teamSize; break;
            }
            if (cost > 0) totalCost += cost;
        }
    };

    // 환자 항공료
    if(plan.transport === '민항기') {
        findAndAdd({세부구분: '민항기', 종류: '스트헤쳐', 품목: '환자항공료'}); // 6좌석 스트레쳐 비용
        findAndAdd({세부구분: '민항기', 종류: '스트헤쳐', 품목: '의료팀왕복항공료'}); // 의료팀 항공료는 인원수 기반
    } else {
        const transportItem = priceCategory.find(p => p.세부구분 === plan.transport);
        if (transportItem) findAndAdd({ 등록번호: transportItem.등록번호 });
    }

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


async function generateMultipleTransportOptions({ originAddress, destinationAddress, patient }) {
    try {
        // 1. 병원 주소 -> 위경도 변환
        const origin = await geocodeAddress({ address: originAddress });
        const destination = await geocodeAddress({ address: destinationAddress });
        if (origin.error || destination.error) return { error: "병원 주소를 찾을 수 없습니다." };

        const totalKm = haversineDistance(origin.lat, origin.lng, destination.lat, destination.lng);
        const flightHours = Math.round(totalKm / 800) || 1; // 평균 시속 800km로 비행시간 추정

        // 2. AI에게 현업 규칙을 포함한 상세 분석 및 계획 생성 요청
        const analysisPrompt = `
          당신은 KMTC의 최고 의료 이송 전문가입니다. 아래 정보를 바탕으로, 가능한 모든 이송 옵션을 분석하고 각각의 계획을 JSON 배열 형식으로 제안해주세요.

          ### 기본 정보
          - 출발 병원: ${originAddress}
          - 도착 병원: ${destinationAddress}
          - 환자 정보: ${JSON.stringify(patient)}
          - 총 항공 이동 거리: 약 ${Math.round(totalKm)} km

          ### 필수 규칙 및 지시사항
          1.  **공항 식별**: 출발지와 도착지에 가장 적합한 국제공항(예: 호치민-SGN, 서울-ICN)을 식별하여 결과에 포함시켜주세요.
          2.  **의료팀 구성**:
              - 모든 이송에는 '의사', '간호사', '핸들러'가 **기본팀**으로 포함됩니다.
              - 환자가 위중(의식 없음, 거동 불가 등)할 경우, '의약품담당자', '장비담당자'를 **추가**하는 것을 강력히 고려하세요.
          3.  **민항기 규칙**:
              - 민항기(대한항공 등) 옵션은 **이코노미석 6개를 사용한 스트레쳐(Stretcher)** 방식입니다.
              - 이 옵션을 계획할 때는 **환자용 스트레쳐(6석) 항공료**와 **기본팀 인원수만큼의 왕복 항공료**가 모두 필요합니다.
          4.  **옵션 고려**: 환자 상태와 거리를 고려하여 '민항기', '에어앰블런스' 옵션을 기본으로 제안하고, 1000km 미만 단거리일 경우 '선박'도 고려하세요.
          5.  **환자 분석**: 환자 진단명에 맞춰 필요한 핵심 장비와 이송 시 주의사항을 구체적으로 서술하세요.

          ### JSON 출력 형식
          {
            "analysis": "환자(뇌출혈)는 이송 중 기압 변화로 인한 뇌압 상승 위험이 있어 지속적인 모니터링이 필수적입니다...",
            "airports": { "departure": "탄손누트 국제공항 (SGN)", "arrival": "인천 국제공항 (ICN)" },
            "options": [
              {
                "context": "항공이송",
                "transport": "민항기",
                "team": ["의사", "간호사", "핸들러", "의약품담당자", "장비담당자"],
                "equipment": ["환자감시모니터", "인공호흡기", "ICP모니터", "자동제세동기"],
                "summary": "가장 비용 효율적인 옵션. 국적기 이코노미 6좌석을 사용하는 의료용 침대 방식입니다."
              },
              {
                "context": "항공이송",
                "transport": "에어앰블런스",
                "team": ["의사", "간호사", "응급구조사"],
                "equipment": ["환자감시모니터", "인공호흡기", "ICP모니터"],
                "summary": "가장 신속하고 안전한 옵션. 환자 전용 의료 제트기로, 위급 상황에 즉각 대처 가능합니다."
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
        
        // 3. 지상 이동 정보 계산
        const departureAirport = await geocodeAddress({ address: result.airports.departure });
        const arrivalAirport = await geocodeAddress({ address: result.airports.arrival });
        const ground1 = await getDistance(origin, departureAirport);
        const ground2 = await getDistance(arrivalAirport, destination);

        // 4. 각 옵션에 대해 비용 계산 및 정보 종합
        for (const option of result.options) {
            const days = (option.transport === '민항기' || option.transport === '선박') ? 3 : 1;
            option.cost = await calculateSinglePlanCost({ plan: option, km: totalKm, days });
        }
        
        // 5. 최종 답변 포맷팅
        let reply = `환자분의 빠른 쾌유를 진심으로 기원합니다.\n요청하신 내용을 바탕으로, 환자분께 적용 가능한 이송 옵션과 상세 정보를 안내해 드립니다.\n\n`;
        reply += `### 🩺 **의료팀 소견**\n${result.analysis}\n\n`;
        reply += `--- \n\n`;

        const transportLabels = { 민항기: "✈️ 민항기", 에어앰블런스: "🚑 에어앰블런스", 선박: "🚢 선박" };

        result.options.forEach(option => {
            if (option.cost > 0) {
                reply += `### ${transportLabels[option.transport] || option.transport} 옵션\n`;
                reply += `**${option.summary}**\n\n`;
                reply += `- **예상 총 비용**: **${Math.round(option.cost).toLocaleString()}원**\n`;
                reply += `\n**세부 이동 정보:**\n`;
                reply += `  - 지상[1]: ${originAddress} → ${result.airports.departure} (약 ${ground1.duration})\n`;
                reply += `  - 항공: ${result.airports.departure} → ${result.airports.arrival} (약 ${flightHours}시간)\n`;
                reply += `  - 지상[2]: ${result.airports.arrival} → ${destinationAddress} (약 ${ground2.duration})\n`;
                reply += `\n**의료 지원팀:**\n`;
                reply += `  - 팀 구성: ${option.team.join(", ")}\n`;
                reply += `  - 필수 장비: ${option.equipment.join(", ")}\n\n`;
            }
        });
        
        reply += `--- \n* 위 견적은 AI의 분석에 따른 예측 금액이며, 실제 비용은 실시간 항공료, 환자 상태의 변화 등 여러 요인에 따라 달라질 수 있습니다. 정확한 진행을 위해 상담사와 최종 확인이 필요합니다.*\n`;
        
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
        description: "출발지와 도착지 병원 이름, 환자 정보를 받아 가능한 모든 이송 옵션을 분석하고, 각 옵션별 비용과 상세 정보를 계산하여 비교 가능한 최종 답변을 생성합니다.",
        parameters: {
            type: "object",
            properties: {
                originAddress: { type: "string", description: "출발지 병원 이름 (예: 베트남 쵸레이병원)"},
                destinationAddress: { type: "string", description: "도착지 병원 이름 (예: 서울대학교병원)"},
                patient: { type: "object", description: "진단명, 의식상태, 거동가능 여부 등 환자 관련 정보" },
            },
            required: ["originAddress", "destinationAddress", "patient"],
        },
    },
}];

const availableFunctions = {
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
- 사용자에게 절대 위도, 경도 좌표를 직접 보여주지 마세요. 이 정보는 내부 계산용입니다.
- 환자 정보(진단명, 의식, 거동 가능 여부)가 부족하면 정중하게 질문하여 파악하세요.
- 항상 공감과 위로의 표현을 사용하고, 감성적이고 따뜻한 태도를 유지하세요.
        `.trim()
      }]
    };

    session.history.push({ role: "user", content: message });
    
    const simplifiedHistory = session.history.map(h => ({role: h.role, content: h.content}));

    let response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: simplifiedHistory,
        tools: functions,
        tool_choice: "auto",
    });

    let responseMessage = response.choices[0].message;

    if (responseMessage.tool_calls) {
        session.history.push(responseMessage);
        const toolCall = responseMessage.tool_calls[0];
        const functionName = toolCall.function.name;
        const functionToCall = availableFunctions[functionName];
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`🤖 Calling main function: ${functionName}`, functionArgs);
        const functionResponse = await functionToCall(functionArgs);

        const finalReply = functionResponse.reply || JSON.stringify(functionResponse);
        session.history.push({ role: "assistant", content: finalReply });
        return res.json({ reply: finalReply });
    }
    
    const reply = responseMessage.content;
    session.history.push({ role: "assistant", content: reply });
    return res.json({ reply });

  } catch (err) {
    console.error("🛑 /chat error:", err);
    return res.status(500).json({ reply: "⚠️ 서버 내부 오류가 발생했습니다. 관리자에게 문의해주세요." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 KMTC AI (vProfessional) running on port ${PORT}`));
