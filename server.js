// backend/server.js – KMTC AI 2025-06-12 (v15.0)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 에 있는 “단가”와 “계산방식”만 참조
// · 응답은 마크다운 형식으로 간결하게, 공감·애도 표현 포함
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
const GMAPS_KEY       = process.env.GMAPS_KEY;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── OpenAI 클라이언트 ─────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
async function gptPlan(patient, km) {
  const sys = `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr =
    `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"}` +
    ` / 거동:${patient.mobility||"unknown"} / 거리:${km}`;
  const { choices:[{ message }] } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: usr }
    ]
  });
  
  // 안전하게 JSON 파싱
  try {
    return JSON.parse(message.content.trim());
  } catch {
    // 파싱 실패 시 기본 플랜 반환
    return {
      type:      "air",
      cremated:  false,
      risk:      "medium",
      transport: "civil",
      seat:      "business",
      staff:     ["doctor","nurse"],
      equipment: { ventilator: true, ecmo: false },
      medLvl:    "medium",
      notes:     []
    };
  }
}

// ─── 비용 계산 (structured_단가표.json 만 참조) ───────────────────────────────
function calcCost(ctx, plan, km, days) {
  let total = 0;
  (prices[ctx] || []).forEach(item => {
    const u = item.단가;
    switch (item.계산방식) {
      case "단가x거리":
        total += u * km; break;
      case "단가x거리x인원":
        total += u * km * (plan.staff.length||1); break;
      case "단가x일수":
        total += u * days; break;
      case "단가x일수x인원":
        total += u * days * (plan.staff.length||1); break;
      case "단가":
        total += u; break;
    }
  });
  return total;
}

// ─── system prompt ────────────────────────────────────────────────────────────
const systemPrompt = `
당신은 KMTC AI 상담원입니다.
- 제공 서비스: 항공이송, 고인이송, 행사 의료지원
- 견적 계산 시 data/structured_단가표.json만 참고
- 항공이송·고인이송: Google Distance Matrix API로 km/hr 계산
- 행사 의료지원: 거리 무시
- 응답은 마크다운으로 간결하게
- **공감·애도 표현 필수**:
  - 고인이송: "삼가 고인의 명복을 빕니다." 등 애도 문구
  - 환자 이송: "환자분의 상황이 많이 힘드셨을 텐데…" 등 공감 문구
- **절대** 타업체 언급 금지
`;

// ─── Express 설정 ───────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post("/chat", async (req, res) => {
  const {
    sessionId = "def",
    message   = "",
    days      = 1,
    patient   = {}
  } = req.body;

  // 세션 초기화 및 히스토리 유지
  const ses = sessions[sessionId] ||= {
    history: [{ role: "system", content: systemPrompt }]
  };

  // 1) 항공이송/고인이송일 때: 출발·도착지 확보
  let km = 0, hr = 0;
  if (/항공이송|고인이송/.test(message)) {
    const m = message.match(/(.+)에서\s*(.+)까지/);
    if (!m) {
      // 주소 없으면 요청
      const ask = "📝 출발지와 도착지를 알려주세요. 예: `호치민에서 인천까지`";
      ses.history.push({ role: "assistant", content: ask });
      return res.json({ reply: ask });
    }
    const from = m[1].trim(), to = m[2].trim();
    try {
      ({ km, hr } = await routeInfo(from, to));
      ses.history.push({
        role: "system",
        content: `거리: ${km}km, 소요시간: ${hr}h`
      });
    } catch {
      const warn = "⚠️ 거리 계산 실패. 주소를 다시 확인해주세요.";
      ses.history.push({ role: "assistant", content: warn });
      return res.json({ reply: warn });
    }
  }

  // 2) 사용자 메시지 히스토리에 추가
  ses.history.push({ role: "user", content: message });

  // 3) AI 플랜 생성
  const plan0 = await gptPlan(patient, km);
  const ctx   = plan0.type === "funeral" ? "고인이송"
              : plan0.type === "event"   ? "행사지원"
              :                             "항공이송";
  const transports = [ plan0.transport ];

  // 4) 비용 계산
  const results = transports.map(t => {
    const plan = { ...plan0, transport: t };
    if (ctx === "고인이송") plan.seat = "coffin";
    return {
      transport: t,
      total:     calcCost(ctx, plan, km, days)
    };
  });

  // 5) 답변 조합
  let reply = "";

  // 감정 표현 및 헤더
  if (ctx === "고인이송") {
    reply += "**삼가 고인의 명복을 빕니다.**\n\n";
  } else if (ctx === "항공이송") {
    reply += "환자분의 상황이 많이 힘드셨을 텐데… 빠른 쾌유를 기원합니다.\n\n";
  }

  // 본문
  if (ctx === "행사지원") {
    reply += `### 행사지원 견적\n\n`;
    reply += `- 필요 인력 & 장비:  
  - 인력: ${plan0.staff.join(", ")}  
  - 장비: 없음\n\n`;
    reply += `### 예상 비용\n\n`;
    reply += `- 총합계: ${results[0].total.toLocaleString("ko-KR")}원\n\n`;
  } else {
    reply += `### ${ctx === "항공이송" ? "항공이송" : "고인이송"} 견적\n\n`;
    reply += `- 거리/시간: ${km}km / ${hr}h\n`;
    reply += `- 필요 인력 & 장비:  
  - 인력: ${plan0.staff.join(", ")}  
  - 장비: ${Object.entries(plan0.equipment)
        .filter(([,v]) => v)
        .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1))
        .join(", ") || "없음"}\n\n`;
    reply += `### 예상 비용\n\n`;
    results.forEach(r => {
      reply += `- ${r.transport}: ${r.total.toLocaleString("ko-KR")}원\n`;
    });
    reply += "\n";
    // 예측 견적 안내
    reply += `*이 견적은 예측 견적이며, 정확한 견적은 환자의 소견서 및 국제 유가, 항공료 등에 따라 달라집니다. 자세한 견적은 KMTC 유선전화로 문의하세요.*\n`;
  }

  // 6) 어시스턴트 답변 히스토리에 추가
  ses.history.push({ role: "assistant", content: reply });

  // 7) 응답 전송
  res.json({ reply });
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
