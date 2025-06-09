// server.js
import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function calculateEstimate(data) {
  const {
    type, distanceKm = 0, days = 1, staff = [],
    useVentilator, useECMO,
    funeralType, personnel = 0, audienceSize = 0, eventScale = "소규모"
  } = data;

  let laborCost = 0;
  let equipmentCost = 0;
  let transportCost = 0;
  let total = 0;

  if (type === "항공이송") {
    const wages = {
      doctor: 1000000,
      nurse: 500000,
      handler: 1000000,
      staff: 400000,
    };

    staff.forEach(role => {
      laborCost += wages[role] * days;
    });

    equipmentCost = 4500000 * days;
    if (useVentilator) equipmentCost += 5000000 * days;
    if (useECMO) equipmentCost += 20000000 * days;

    transportCost = distanceKm * 150 * 6;
    total = laborCost + equipmentCost + transportCost;
  }

  else if (type === "행사의료지원") {
    const wages = {
      specialist: 650000,
      general: 550000,
      nurse: 250000,
      assistant: 150000,
      staff: 150000,
    };

    staff.forEach(role => {
      laborCost += wages[role] * days;
    });

    equipmentCost = 300000 * days;
    let drugCost = 200000;
    if (audienceSize > 1000) drugCost = 650000;

    total = laborCost + equipmentCost + drugCost;
  }

  else if (type === "고인이송") {
    const transportUnit = 2900;
    const documentFee = 2000000;
    const embalmingCost = 15000000;
    const funeralPeopleCost = funeralType === "관" ? personnel * 200000 : 0;
    const cremationCost = funeralType === "화장" ? 3500000 : 0;
    const flightCost = funeralType === "관" ? 6000000 : 1250000;

    transportCost = distanceKm * transportUnit;
    total = transportCost + documentFee + embalmingCost + funeralPeopleCost + cremationCost + flightCost;
  }

  return {
    유형: type,
    항공료: transportCost,
    인건비: laborCost,
    장비비: equipmentCost,
    총합계: total
  };
}

app.post("/chat", async (req, res) => {
  const { message, patient, transportData } = req.body;

  const estimate = transportData ? calculateEstimate(transportData) : null;

  let aiContext = `당신은 전문 견적 및 의학적 상담 AI입니다. 사용자가 항공이송, 행사·방송 의료지원, 고인 이송 요청 시 상황을 파악하고 적절한 인력, 장비, 기간, 이송 여부를 판단하여 정리해줍니다.`;

  if (patient) {
    aiContext += `\n\n[환자 정보]\n- 나이: ${patient.age}\n- 질병: ${patient.diagnosis}\n- 과거력: ${patient.history}\n- 수술여부: ${patient.surgery}\n- 시술여부: ${patient.procedure}\n- 현재 상태: ${patient.status}\n- 의식 유무: ${patient.consciousness}`;
    aiContext += `\n\n위 정보를 토대로 이송 가능 여부, 필요한 의료 인원, 장비, 예상 이송일 등을 제시하세요.`;
  }

  if (estimate) {
    aiContext += `\n\n[계산된 견적]\n- 항공료: ${estimate.항공료.toLocaleString()}원\n- 인건비: ${estimate.인건비.toLocaleString()}원\n- 장비비: ${estimate.장비비.toLocaleString()}원\n- 총합계: ${estimate.총합계.toLocaleString()}원`;
  }

  aiContext += `\n\n항공이송은 환자상태(영상, 진단서, 의식유무)를 기반으로 판단하고, 고인 이송은 화장/관 여부에 따라 분기됩니다. 행사의료지원은 인원 수, 행사유형, 법적 요건에 따라 의사 필요 여부를 판단합니다.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: aiContext },
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

app.listen(3000, () => console.log("✅ KMTC 상담서버 실행 중 on port 3000"));
