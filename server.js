import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ 견적 계산 로직
function calculateCosts(type, data) {
  let total = 0;
  const result = {
    category: type,
    항공료: 0,
    인건비: 0,
    장비비: 0,
    기타비용: 0,
    총합계: 0
  };

  if (type === "항공이송") {
    const { distanceKm = 0, days = 3, staff = [], useVentilator, useECMO } = data;

    const wages = {
      doctor: 1000000,
      nurse: 500000,
      handler: 1000000,
      staff: 400000
    };
    staff.forEach(role => {
      if (wages[role]) result.인건비 += wages[role] * days;
    });

    result.장비비 += 4500000 * days;
    if (useVentilator) result.장비비 += 5000000 * days;
    if (useECMO) result.장비비 += 20000000 * days;

    result.항공료 += distanceKm * 150 * 6;
    result.기타비용 += 3000000 + 400000 * 2;
  }

  else if (type === "행사의료지원") {
    const { attendees = 100, hours = 8, includeDefib, includeAmbulance } = data;

    result.인건비 = (hours > 8 ? 700000 : 400000) * 3;
    result.장비비 = 300000;
    if (includeDefib) result.장비비 += 200000;
    if (includeAmbulance) result.기타비용 += 3000000;
  }

  else if (type === "고인이송") {
    const { cremation, distanceKm = 0, isInternational } = data;

    result.항공료 = isInternational
      ? (cremation ? 1500000 : 6000000)
      : distanceKm * 2900;

    result.기타비용 += cremation ? 3500000 : 15000000;
    result.기타비용 += 2000000; // 핸들링
  }

  total = result.항공료 + result.인건비 + result.장비비 + result.기타비용;
  result.총합계 = total;

  return result;
}

// ✅ 상담 요청 처리
app.post("/chat", async (req, res) => {
  const { message, contextType, patient, transportData } = req.body;

  const sensitiveTrigger = /단가|계산식|어떻게 나온|근거|세부.*금액/i;
  const fixedReply = "📌 해당 정보는 계약 체결 후 제공 가능한 내부 기준입니다. 양해 부탁드립니다.";

  const estimate = contextType ? calculateCosts(contextType, transportData || {}) : null;

  let systemPrompt = `
당신은 항공이송, 행사/방송 의료지원, 고인 해외 이송에 대해 상담과 예상 견적, 이송 여부, 필요 장비와 인력을 판단하는 전문가 AI입니다.

📌 마크다운 형식으로 출력하십시오.
📌 계산식, 단가는 절대 공개하지 마십시오.
📌 사용자가 '단가', '계산식' 등을 요청하면 "${fixedReply}"로 답변하세요.

⛑️ 환자 정보가 주어지면 아래 기준으로 판단:
- 나이, 진단명, 수술/시술 여부, 의식 유무 등을 종합 평가
- 이송 가능 여부, 필수 의료인력, 장비 구성, 이송 기간 제시

💬 출력 형식은 아래를 따르세요:

---

📌 **요약**
- 유형: 항공이송 / 행사 / 고인 이송
- 정보: 출발지~도착지, 대상자 상태 요약

📦 **이송 구성**
- 인력: ○○
- 장비: ○○
- 기간/수단: ○○

💰 **예상 총 비용**
- 항공료: ○○원
- 인건비: ○○원
- 장비비: ○○원
- 기타: ○○원
- **합계: ○○원**

📝 **주의사항**
- 단가는 계약 후 제공
- 실제 상황/현지 조건에 따라 변동될 수 있음
`;

  if (patient) {
    systemPrompt += `\n\n[환자 정보 분석]\n- 나이: ${patient.age}\n- 진단명: ${patient.diagnosis}\n- 과거력: ${patient.history}\n- 수술: ${patient.surgery}, 시술: ${patient.procedure}\n- 현재 상태: ${patient.status}, 의식: ${patient.consciousness}`;
  }

  if (estimate) {
    systemPrompt += `\n\n[자동 계산된 견적 요약]\n- 항공료: ${estimate.항공료.toLocaleString()}원\n- 인건비: ${estimate.인건비.toLocaleString()}원\n- 장비비: ${estimate.장비비.toLocaleString()}원\n- 기타비용: ${estimate.기타비용.toLocaleString()}원\n- 총합계: ${estimate.총합계.toLocaleString()}원`;
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    temperature: 0.3
  });

  const aiReply = completion.choices[0].message.content;
  const reply = sensitiveTrigger.test(message) ? fixedReply : aiReply;

  res.json({ reply });
});

app.listen(3000, () => console.log("✅ KMTC 견적 AI 서버 실행 중 (포트 3000)"));
