// backend/server.js – KMTC AI 2025-06-12 (v14.0)
// · GPT-4o type / cremated 판정
// · 외부 업체 언급 금지
// · Google Distance Matrix API만 사용
// · data/structured_단가표.json 에 있는 “단가”와 “계산방식”만 참조
// · 응답은 간결하게, 마크다운 형식 사용

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

// ─── Google Distance Matrix로 거리/시간 계산 ─────────────────────────────────────────
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

// ─── Express 설정 ───────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const systemPrompt = `
당신은 KMTC AI 상담원입니다.
- 제공 서비스: 항공이송, 고인이송, 행사 의료지원
- 견적 계산 시 data/structured_단가표.json만 참고
- 항공이송·고인이송은 Google Distance Matrix API로 km/hr 계산
- 행사의료지원은 거리 무시
- 응답은 간결하게, 마크다운 형식으로만
`;

app.post("/chat", async (req, res) => {
  const { message = "", days = 1, patient = {} } = req.body;

  // 1) 거리 계산 (항공이송/고인이송에만)
  let km = 0, hr = 0;
  if (/항공이송|고인이송/.test(message)) {
    const m = message.match(/(.+)에서 (.+)까지/);
    if (m) {
      const from = m[1].trim();
      const to = m[2].trim();
      try {
        ({ km, hr } = await routeInfo(from, to));
      } catch {}
    }
  }

  // 2) ChatCompletion 호출
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: message }
  ];
  if (km) {
    msgs.push({ role: "system", content: `거리: ${km}km, 소요시간: ${hr}h` });
  }

  const chat = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: msgs
  });

  // 3) 결과 반환
  res.json({ reply: chat.choices[0].message.content.trim() });
});

app.listen(3000, () => console.log("🚀 KMTC AI running on port 3000"));
