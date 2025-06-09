// server.js
import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 견적 계산 함수: 항공이송, 행사지원, 고인 이송 분기
function calculateEstimate(data) {
  if (!data || !data.type) return null;

  const days = data.days || 3;
  let total = 0;

  if (data.type === "air") {
    const wages = { doctor: 1000000, nurse: 500000, handler: 1000000, staff: 400000 };
    let labor = 0;
    data.staff?.forEach(role => labor += (wages[role] || 0) * days);
    let equip = 4500000 * days;
    if (data.useVentilator) equip += 5000000 * days;
    if (data.useECMO) equip += 20000000 * days;
    const flight = data.distanceKm * 150 * 6;
    total = labor + equip + flight;
    return { category: "항공이송", 인건비: labor, 장비비: equip, 항공료: flight, 총합계: total };
  }

  if (data.type === "event") {
    const wages = { doctor: 650000, general: 550000, nurse: 250000, assistant: 150000, staff: 150000 };
    let labor = 0;
    data.staff?.forEach(role => labor += (wages[role] || 0) * days);
    const equip = 300000 * days;
    const medicine = 300000;
    const quarantine = 150000;
    total = labor + equip + medicine + quarantine;
    return { category: "행사지원", 인건비: labor, 장비비: equip, 의약품비: medicine, 방역비: quarantine, 총합계: total };
  }

  if (data.type === "deceased") {
    const base = data.method === "urn" ? 1500000 : 6000000;
    const legal = 2000000;
    total = base + legal;
    return { category: "고인 이송", 항공료: base, 서류처리: legal, 총합계: total };
  }

  return null;
}

app.post("/chat", async (req, res) => {
  const { message, userId, patient, transportData } = req.body;

  const estimate = transportData ? calculateEstimate(transportData) : null;

  let systemPrompt = `당신은 의학적 상담 및 예상 견적, 이송 가능성, 행사·고인 이송 가능 여부를 판단하는 AI입니다. 사용자의 질문에 따라 필요한 인력, 장비, 이송 기간 등을 안내하고, 직접적인 견적 예시를 Markdown 형식으로 깔끔하게 출력해야 합니다.`;

  if (patient) {
    systemPrompt += `\n\n[환자 정보]\n- 나이: ${patient.age}\n- 진단명: ${patient.diagnosis}\n- 과거력: ${patient.history}\n- 수술: ${patient.surgery}\n- 시술: ${patient.procedure}\n- 상태: ${patient.status}\n- 의식: ${patient.consciousness}`;
    systemPrompt += `\n\n이 정보를 바탕으로 이송 가능성, 필요한 인력 및 장비, 예상 기간 등을 제시하세요.`;
  }

  if (estimate) {
    systemPrompt += `\n\n[예상 견적 요약]\n**유형:** ${estimate.category}\n\n| 항목 | 금액 |\n|------|------|\n`;
    Object.entries(estimate).forEach(([k, v]) => {
      if (k !== "category") systemPrompt += `| ${k} | ${v.toLocaleString()}원 |\n`;
    });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    temperature: 0.4,
    max_tokens: 2000
  });

  const aiReply = response.choices[0].message.content;

  const sensitiveTrigger = /단가|계산식|어떻게 나온|근거|세부.*금액/i;
  const fixedReply = "📌 해당 정보는 계약 체결 후 제공 가능한 내부 기준입니다. 양해 부탁드립니다.";

  const reply = sensitiveTrigger.test(message) ? fixedReply : aiReply;
  res.json({ reply });
});

app.listen(3000, () => console.log("✅ KMTC 견적/상담 서버 실행 중 (port 3000)"));
