/* 📄 backend/index.js */
import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { OpenAI } from "openai";

config();                                   // .env에 OPENAI_API_KEY 작성
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ── 견적 계산 로직 ───────────────────────── */
function calculateCosts(type, data = {}) {
  const res = { category:type, 항공료:0, 인건비:0, 장비비:0, 기타비용:0, 총합계:0 };

  if (type === "항공이송") {
    const { distanceKm=0, days=3, staff=[], useVentilator, useECMO } = data;
    const wages = { doctor:1_000_000, nurse:500_000, handler:1_000_000, staff:400_000 };
    staff.forEach(r => { if (wages[r]) res.인건비 += wages[r]*days; });

    res.장비비 += 4_500_000*days;
    if (useVentilator) res.장비비 += 5_000_000*days;
    if (useECMO)       res.장비비 += 20_000_000*days;

    res.항공료 += distanceKm * 150 * 6;       // 스트레처 6석
    res.기타비용 += 3_000_000 + 400_000*2;    // 구급차·숙박 등
  }

  else if (type === "행사의료지원") {
    const { hours=8, includeDefib, includeAmbulance } = data;
    res.인건비 = (hours>8?700_000:400_000)*3;
    res.장비비 = 300_000 + (includeDefib?200_000:0);
    if (includeAmbulance) res.기타비용 += 3_000_000;
  }

  else if (type === "고인이송") {
    const { cremation, distanceKm=0, isInternational } = data;
    res.항공료 = isInternational ? (cremation?1_500_000:6_000_000) : distanceKm*2_900;
    res.기타비용 += (cremation?3_500_000:15_000_000) + 2_000_000; // 핸들링
  }

  res.총합계 = res.항공료 + res.인건비 + res.장비비 + res.기타비용;
  return res;
}

/* ── /chat 엔드포인트 ─────────────────────── */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.post("/chat", async (req, res) => {
  const { message="", contextType, patient, transportData } = req.body;
  if (!contextType) return res.json({ reply:"contextType 누락" });

  const estimate = calculateCosts(contextType, transportData);
  const sensitive = /단가|계산식|어떻게 나온|근거|세부.*금액/i;
  const blockMsg  = "📌 해당 정보는 계약 체결 후 제공 가능한 내부 기준입니다. 양해 부탁드립니다.";

  /* system 프롬프트 */
  let sys = `
당신은 항공이송·행사/방송 의료지원·고인 이송 견적 전문가 AI입니다.
출력은 마크다운. 단가·계산식 요청 시 "${blockMsg}" 로만 답변.
-- 형식 -------------------------------------------------
📌 **요약**  …  
📦 **이송 구성** …  
💰 **예상 총 비용** …  
📝 **주의사항** …
--------------------------------------------------------`;

  if (patient) {
    sys += `\n[환자]\n나이:${patient.age}, 진단:${patient.diagnosis}, 상태:${patient.status}`;
  }
  sys += `\n[자동견적]\n항공료:${estimate.항공료.toLocaleString()}원\n인건비:${estimate.인건비.toLocaleString()}원\n장비비:${estimate.장비비.toLocaleString()}원\n기타:${estimate.기타비용.toLocaleString()}원\n총합계:${estimate.총합계.toLocaleString()}원`;

  /* OpenAI 호출 */
  const { choices:[{ message:ai }] } = await openai.chat.completions.create({
    model:"gpt-4o",
    temperature:0.3,
    messages:[ {role:"system",content:sys}, {role:"user",content:message} ]
  });

  res.json({ reply: sensitive.test(message) ? blockMsg : ai.content });
});

/* ── 서버 시작 ─────────────────────────────── */
app.listen(3000, () => console.log("✅ KMTC 견적 AI 서버(3000)"));
