// backend/server.js – KMTC AI 2025-06-12 (vFuncCall+Geocode+Logging)
// · Function Calling으로 주소 해석→거리 계산→비용 산출까지 자동 처리
// · Google Geocoding + Distance Matrix API 사용
// · data/structured_단가표.json에 있는 “단가”와 “계산방식”만 참조
// · 응답은 마크다운 형식으로 간결하게, 공감·애도 표현 포함
// · 세션 동안 대화 이력 유지
// · 모든 단계에서 에러를 잡아 터미널에 로깅하고, 사용자에겐 친절한 메시지 반환

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

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

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

// ─── Google Distance Matrix API 호출 ────────────────────────────────────────
async function getDistance({ origin, destination }) {
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${origin}` +
      `&destinations=${destination}` +
      `&key=${GMAPS_KEY}&language=ko`;
    const js = await fetch(url).then(r => r.json());
    const elem = js.rows?.[0]?.elements?.[0];
    if (!elem || elem.status !== "OK" || !elem.distance) {
      throw new Error(`status=${elem?.status}`);
    }
    return {
      km: Math.round(elem.distance.value / 1000),
      hr: +(elem.duration.value / 3600).toFixed(1)
    };
  } catch (err) {
    console.error("🛑 getDistance error:", err);
    throw new Error(`거리 계산 실패: ${err.message}`);
  }
}

// ─── 비용 계산 ───────────────────────────────────────────────────────────────
async function computeCost({ context, transport, km, days, patient }) {
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    // 1) AI 플랜 생성 (JSON ONLY)
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
    } catch (err) {
      console.error("🛑 plan JSON parse error:", err);
      plan0 = {
        type: "air", cremated: false, risk: "medium",
        transport, seat: "business",
        staff: ["doctor","nurse"],
        equipment: { ventilator:true, ecmo:false },
        medLvl: "medium", notes: []
      };
    }
    // 2) 실제 비용 계산
    const ctxKey =
      plan0.type === "funeral" ? "고인이송"
      : plan0.type === "event"   ? "행사지원"
      :                            "항공이송";
    let total = 0;
    (prices[ctxKey] || []).forEach(item => {
      const u = item.단가;
      switch (item.계산방식) {
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
- 거리 계산: Google Distance Matrix API
- 비용 계산: data/structured_단가표.json 참조
- 응답은 마크다운, 공감·애도 표현 포함
- 타업체 언급 금지`
      }]
    };

    // 사용자 메시지 추가
    ses.history.push({ role: "user", content: message });

    // 1) AI에 처음 요청 (Function Calling)
    const first = await new OpenAI({ apiKey: OPENAI_API_KEY })
      .chat.completions.create({
        model: "gpt-4o",
        messages: ses.history,
        functions,
        function_call: "auto"
      });
    const msg = first.choices[0].message;
    ses.history.push(msg);

    // 2) geocodeAddress
    if (msg.function_call?.name === "geocodeAddress") {
      const { address } = JSON.parse(msg.function_call.arguments);
      let loc = await geocodeAddress({ address });
      ses.history.push({
        role: "function", name: "geocodeAddress",
        content: JSON.stringify(loc)
      });
      return invokeNext();
    }

    // 3) getDistance
    if (msg.function_call?.name === "getDistance") {
      const { origin, destination } = JSON.parse(msg.function_call.arguments);
      let dist = await getDistance({ origin, destination });
      ses.history.push({
        role: "function", name: "getDistance",
        content: JSON.stringify(dist)
      });
      return invokeNext();
    }

    // 4) computeCost
    if (msg.function_call?.name === "computeCost") {
      return completeCost(msg);
    }

    // 5) 일반 대화 응답
    return res.json({ reply: msg.content });

    // 헬퍼: geocode → distance → cost 흐름 유도
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

    // 헬퍼: 최종 비용 산출 및 렌더링
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
        role: "function", name: "computeCost",
        content: JSON.stringify(costRes)
      });
      const fin = await new OpenAI({ apiKey: OPENAI_API_KEY })
        .chat.completions.create({
          model: "gpt-4o",
          messages: ses.history
        });
      const finalReply = fin.choices[0].message.content;
      ses.history.push({ role: "assistant", content: finalReply });
      return res.json({ reply: finalReply });
    }

  } catch (err) {
    console.error("🛑 /chat error:", err);
    return res.json({
      reply: "⚠️ 서버 내부에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."
    });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
