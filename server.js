// backend/server.js – KMTC AI 2025-06-12 (vFuncCall+Geocode+Fallback+TransportCategories)
// · Function Calling으로 주소 해석→거리 계산→비용 산출까지 자동 처리
// · Google Geocoding + Distance Matrix API 사용, 실패 시 Haversine 법으로 대체
// · data/structured_단가표.json에 있는 “단가”와 “계산방식”만 참조
// · 이송 종류: 민항기, 국적기, 에어앰블런스, 전용기, 선박
// · 응답은 마크다운 형식으로 간결하게, 공감·애도 표현 포함
// · 세션 동안 대화 이력 유지, 모든 단계 에러 로깅

import express from "express";
import cors   from "cors";
import { config } from "dotenv";
import fetch  from "node-fetch";
import { OpenAI } from "openai";
import fs     from "fs";
import path   from "path";
import { fileURLToPath } from "url";

config();
const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const GMAPS_KEY      = process.env.GMAPS_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── Haversine 공식 (직선 거리 계산) ─────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = v => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return 6371 * c; // 지구 반지름 6371km
}

// ─── Google Geocoding API 호출 ─────────────────────────────────────────────
async function geocodeAddress({ address }) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(address)}` +
      `&key=${GMAPS_KEY}`;
    const js = await fetch(url).then(r => r.json());
    if (js.status !== "OK" || !js.results?.length) {
      throw new Error(`status=${js.status}`);
    }
    const loc = js.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error("🛑 geocodeAddress error:", err);
    throw new Error(`주소 해석 실패: ${err.message}`);
  }
}

// ─── Google Distance Matrix 또는 Haversine Fallback ────────────────────────
async function getDistance({ origin, destination }) {
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${origin}` +
      `&destinations=${destination}` +
      `&key=${GMAPS_KEY}&language=ko`;
    const js = await fetch(url).then(r => r.json());
    const elem = js.rows?.[0]?.elements?.[0];
    if (elem?.status === "OK" && elem.distance) {
      return {
        km: Math.round(elem.distance.value / 1000),
        hr: +(elem.duration.value / 3600).toFixed(1)
      };
    }
    throw new Error(`status=${elem?.status}`);
  } catch (err) {
    console.warn("⚠️ Distance Matrix failed, using Haversine:", err.message);
    const [olat, olon] = origin.split(",").map(Number);
    const [dlat, dlon] = destination.split(",").map(Number);
    const km = haversineDistance(olat, olon, dlat, dlon);
    const avgSpeedKmh = 500; // km/h
    return {
      km: Math.round(km),
      hr: +(km / avgSpeedKmh).toFixed(1)
    };
  }
}

// ─── 비용 계산 ───────────────────────────────────────────────────────────────
async function computeCost({ context, transport, km, days, patient }) {
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    // AI 플랜 생성 (JSON ONLY)
    const planRes = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`
        },
        {
          role: "user",
          content:
            `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"}` +
            ` / 거동:${patient.mobility||"unknown"} / 거리:${km}`
        }
      ]
    });
    let plan0;
    try {
      plan0 = JSON.parse(planRes.choices[0].message.content.trim());
    } catch (parseErr) {
      console.error("🛑 plan JSON parse error:", parseErr);
      plan0 = {
        type: "air", cremated: false, risk: "medium",
        transport, seat: "business",
        staff: ["doctor","nurse"],
        equipment: { ventilator:true, ecmo:false },
        medLvl: "medium", notes: []
      };
    }
    const ctxKey =
      plan0.type === "funeral" ? "고인이송"
      : plan0.type === "event"   ? "행사지원"
      :                            "항공이송";
    let total = 0;
    (prices[ctxKey] || []).forEach(item => {
      const u = item.단가;
      switch (item.계산방식) {
        case "단가x거리": total += u * km; break;
        case "단가x거리x인원": total += u * km * (plan0.staff.length||1); break;
        case "단가x일수": total += u * days; break;
        case "단가x일수x인원": total += u * days * (plan0.staff.length||1); break;
        case "단가": total += u; break;
      }
    });
    return { plan: plan0, context: ctxKey, km, days, total };
  } catch (err) {
    console.error("🛑 computeCost error:", err);
    throw new Error("비용 산출 중 오류가 발생했습니다.");
  }
}

// ─── Function Calling 정의 ─────────────────────────────────────────────────
const functions = [
  {
    name: "geocodeAddress",
    description: "사용자 입력 주소를 위경도로 변환합니다.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "출발지 또는 도착지 주소" }
      },
      required: ["address"]
    }
  },
  {
    name: "getDistance",
    description: "위경도로부터 거리(km)와 시간(hr)을 계산합니다.",
    parameters: {
      type: "object",
      properties: {
        origin:      { type: "string", description: "출발지 lat,lng" },
        destination: { type: "string", description: "도착지 lat,lng" }
      },
      required: ["origin","destination"]
    }
  },
  {
    name: "computeCost",
    description: "context, transport, 거리, 일수, patient 정보를 바탕으로 비용을 계산합니다.",
    parameters: {
      type: "object",
      properties: {
        context:   { type: "string", enum:["항공이송","고인이송","행사지원"] },
        transport: { type: "string" },
        km:        { type: "number" },
        days:      { type: "number" },
        patient:   { type: "object" }
      },
      required: ["context","transport","km","days"]
    }
  }
];

// ─── 이송 종류 라벨 맵핑 ────────────────────────────────────────────────────
const transportLabels = {
  civil:         "민항기 (상업용 여객기)",
  national:      "국적기 (대한항공·아시아나 등)",
  airAmbulance:  "에어앰블런스",
  charter:       "전용기 (임차 전용기)",
  ship:          "선박"
};

// ─── Express 서버 설정 ───────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post("/chat", async (req, res) => {
  try {
    const { sessionId="def", message="", days=1, patient={} } = req.body;
    const ses = sessions[sessionId] ||= {
      history: [{
        role: "system",
        content: `
당신은 KMTC AI 상담원입니다.
- 서비스: 항공이송, 고인이송, 행사 의료지원
- 주소 변환: Google Geocoding API
- 거리 계산: Distance Matrix → Haversine Fallback
- 비용 계산: data/structured_단가표.json 참조
- 이송 종류 구분: 민항기, 국적기, 에어앰블런스, 전용기, 선박
- 응답은 마크다운, 공감·애도 표현 포함
- 타업체 언급 금지
        `.trim()
      }]
    };

    // 1) 사용자 메시지 히스토리에 추가
    ses.history.push({ role: "user", content: message });

    // 2) Function Calling 첫 요청
    const first = await new OpenAI({ apiKey: OPENAI_API_KEY })
      .chat.completions.create({
        model: "gpt-4o",
        messages: ses.history,
        functions,
        function_call: "auto"
      });
    const msg = first.choices[0].message;
    ses.history.push(msg);

    // 3) 주소 → 위경도
    if (msg.function_call?.name === "geocodeAddress") {
      const { address } = JSON.parse(msg.function_call.arguments);
      const loc = await geocodeAddress({ address });
      ses.history.push({
        role: "function",
        name: "geocodeAddress",
        content: JSON.stringify(loc)
      });
      return invokeNext();
    }

    // 4) 위경도 → 거리/시간
    if (msg.function_call?.name === "getDistance") {
      const { origin, destination } = JSON.parse(msg.function_call.arguments);
      const dist = await getDistance({ origin, destination });
      ses.history.push({
        role: "function",
        name: "getDistance",
        content: JSON.stringify(dist)
      });
      return invokeNext();
    }

    // 5) 비용 산출
    if (msg.function_call?.name === "computeCost") {
      return completeCost(msg);
    }

    // 6) 일반 대화 응답
    return res.json({ reply: msg.content });

    // ── 헬퍼: geocode/getDistance 후 다시 AI에게 넘기기
    async function invokeNext() {
      const next = await new OpenAI({ apiKey: OPENAI_API_KEY })
        .chat.completions.create({
          model: "gpt-4o",
          messages: ses.history,
          functions,
          function_call: "auto"
        });
      const m2 = next.choices[0].message;
      ses.history.push(m2);
      if (m2.function_call?.name === "computeCost") {
        return completeCost(m2);
      }
      return res.json({ reply: m2.content });
    }

    // ── 헬퍼: computeCost 실행 후 최종 마크다운 직접 렌더링
    async function completeCost(fnMsg) {
      const args    = JSON.parse(fnMsg.function_call.arguments);
      const costRes = await computeCost({
        context:   args.context,
        transport: args.transport,
        km:        args.km,
        days,
        patient
      });
      ses.history.push({
        role: "function",
        name: "computeCost",
        content: JSON.stringify(costRes)
      });

      // 직접 마크다운 조립
      const { plan, context, km, days: d, total, transport } = costRes;
      let reply = "";

      // 공감·애도
      if (context === "고인이송") {
        reply += "**삼가 고인의 명복을 빕니다.**\n\n";
      } else if (context === "항공이송") {
        reply += "환자분의 상황이 많이 힘드셨을 텐데… 빠른 쾌유를 기원합니다.\n\n";
      }

      // 이송 종류
      reply += "**이송 종류**\n";
      Object.entries(transportLabels).forEach(([key,label]) => {
        reply += (key === transport ? "▶ " : "• ") + label + "\n";
      });
      reply += "\n";

      // 상세 견적
      reply += `### ${context} 견적 정보\n\n`;
      reply += `- 거리/시간: ${km.toLocaleString()} km / ${costRes.hr} h\n`;
      reply += `- 진단명: ${patient.diagnosis || "알 수 없음"}\n`;
      reply += `- 필요 인력: ${plan.staff.join(", ")}\n`;
      reply += `- 장비: ${Object.entries(plan.equipment).filter(([,v])=>v).map(([k])=>k).join(", ")||"없음"}\n\n`;
      reply += `### 예상 비용\n\n`;
      reply += `- ${transportLabels[transport]}: **${total.toLocaleString()}원**\n\n`;
      reply += `*이 견적은 예측 견적이며, 환자 상태·국제 유가·항공료 등에 따라 달라집니다. 자세한 견적은 KMTC 유선전화로 문의하세요.*\n`;

      ses.history.push({ role: "assistant", content: reply });
      return res.json({ reply });
    }

  } catch (err) {
    console.error("🛑 /chat error:", err);
    return res.json({
      reply: "⚠️ 서버 내부에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."
    });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
