// backend/server.js – KMTC AI 2025-06-12 (v14.3)
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
const GMAPS_KEY = process.env.GMAPS_KEY;

// ─── 단가표 로드 ─────────────────────────────────────────────────────────────
const prices = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data/structured_단가표.json"), "utf8")
);

// ─── OpenAI 클라이언트 ─────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Google Distance Matrix로 거리/시간 계산 ─────────────────────────────────────
async function routeInfo(fromAddr, toAddr) {
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(fromAddr)}` +
    `&destinations=${encodeURIComponent(toAddr)}` +
    `&key=${GMAPS_KEY}&language=ko`;
  console.log("[DEBUG] DistanceMatrix 요청 URL:", url);
  const js = await fetch(url).then(r => r.json());
  console.log("[DEBUG] DistanceMatrix 응답:", js);
  const elem = js.rows?.[0]?.elements?.[0];
  if (!elem || elem.status !== "OK" || !elem.distance) {
    console.error("[ERROR] 거리 계산 실패:", elem?.status, js.error_message);
    throw new Error(`거리 계산 실패: status=${elem?.status}`);
  }
  return {
    km:  Math.round(elem.distance.value / 1000),
    hr: +(elem.duration.value / 3600).toFixed(1),
  };
}

// ─── 간결한 system prompt ──────────────────────────────────────────────────
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
    message = "",
    days = 1,
    patient = {}
  } = req.body;

  // 세션 초기화 및 히스토리 유지
  const ses = sessions[sessionId] ||= {
    history: [{ role: "system", content: systemPrompt }]
  };

  // 1) 항공이송/고인이송일 때만 거리 계산
  let km = 0, hr = 0;
  if (/항공이송|고인이송/.test(message)) {
    const m = message.match(/(.+)에서 (.+)까지/);
    if (m) {
      const from = m[1].trim();
      const to = m[2].trim();
      try {
        ({ km, hr } = await routeInfo(from, to));
        ses.history.push({
          role: "system",
          content: `거리: ${km}km, 소요시간: ${hr}h`
        });
      } catch {
        // 거리 계산 실패해도 이어서 진행
      }
    }
  }

  // 2) 사용자 메시지 히스토리에 추가
  ses.history.push({ role: "user", content: message });

  // 3) ChatCompletion 호출
  const chat = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: ses.history
  });
  let reply = chat.choices[0].message.content.trim();

  // 4) 예측 견적 안내 문구 추가 (항공이송·고인이송일 경우)
  if (/항공이송|고인이송/.test(message)) {
    reply += `

*이 견적은 예측 견적이며, 정확한 견적은 환자의 소견서 및 국제 유가, 항공료 등에 따라 달라집니다. 자세한 견적은 KMTC 유선전화로 문의하세요.*`;
  }

  // 5) 어시스턴트 답변 히스토리에 추가
  ses.history.push({ role: "assistant", content: reply });

  // 6) 클라이언트에 응답
  res.json({ reply });
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
