/* backend/server.js – KMTC AI 2025-06-10 (v12.4)
   · GPT-4o type / cremated 판정
   · Google Geocoding API → 실패 시 OSM(Nominatim) 3-단계
   · Google Distance Matrix API 로 단일 구간 거리·시간
   · ‘항공/고인’만 주소 필수, 행사 의료지원은 주소 불필요
   · UTF-8 BOM 제거 후 JSON.parse
*/

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

const strip = b => b.toString("utf8").replace(/^\uFEFF/, "");
const countries = JSON.parse(strip(
  fs.readFileSync(path.join(__dirname, "data/countries.json"))
));

async function googleGeocode(q) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?key=${GMAPS_KEY}`
            + `&address=${encodeURIComponent(q)}&language=ko`;
  const js = await fetch(url).then(r=>r.json());
  if (js.status === "OK") {
    const p = js.results[0].geometry.location;
    return { lat: p.lat, lon: p.lng };
  }
  throw new Error("G_FAIL");
}

async function osmGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}`
            + `&format=json&limit=1`;
  const js = await fetch(url, { headers:{ "User-Agent":"kmtc" } }).then(r=>r.json());
  if (js.length) return { lat:+js[0].lat, lon:+js[0].lon };
  throw new Error("OSM_FAIL");
}

async function geocode(addr) {
  try { return await googleGeocode(addr); } catch {}
  const parts = addr.trim().split(/\s+/);
  if (parts.length >= 2) {
    try {
      return await googleGeocode(`${parts.slice(0,-1).join(" ")}, ${parts.at(-1)}`);
    } catch {}
  }
  for (const q of [ addr, ...countries.flatMap(c=>[`${addr} ${c.ko}`, `${addr} ${c.en}`]) ]) {
    try { return await googleGeocode(q); } catch {}
    try { return await osmGeocode(q); } catch {}
  }
  throw new Error("NOT_FOUND");
}

async function gDist(o, d) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
            + `?origins=${o.lat},${o.lon}`
            + `&destinations=${d.lat},${d.lon}`
            + `&key=${GMAPS_KEY}`;
  const js = await fetch(url).then(r=>r.json());
  if (js.status !== "OK") throw new Error("DIST_FAIL");
  const e = js.rows[0].elements[0];
  return { km:+(e.distance.value/1000).toFixed(0), hr:+(e.duration.value/3600).toFixed(1) };
}

const parseLoc = t => {
  const m = t.match(/(.+?)에서\s+(.+?)까지/);
  return m ? { depLoc:m[1].trim(), arrLoc:m[2].trim() } : {};
};

async function routeInfo(depLoc, arrLoc) {
  const from = await geocode(depLoc);
  const to   = await geocode(arrLoc);
  return await gDist(from, to);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function gptPlan(patient, km) {
  const sys = `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr = `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"} / 거동:${patient.mobility||"unknown"} / 거리:${km}`;
  const { choices:[{ message }] } = await openai.chat.completions.create({
    model:"gpt-4o", temperature:0.2,
    messages: [
      { role:"system", content:sys },
      { role:"user",   content:usr }
    ]
  });
  return JSON.parse(message.content.trim());
}

const wages = { doctor:1_000_000, nurse:500_000, handler:1_000_000, staff:400_000 };
const equip  = { ventilator:5_000_000, ecmo:20_000_000, base:4_500_000 };
const meds   = { high:400_000, medium:200_000, low:100_000 };
const ACC    = 250_000;

function calcCost(ctx, plan, km, days) {
  const c = {
    항공료:0, 인건비:0,
    장비비:0,
    숙식:ACC*plan.staff.length*days,
    기타:3_000_000+400_000*2
  };
  plan.staff.forEach(r=>{ if(wages[r]) c.인건비 += wages[r]*days; });
  c.장비비 =
    equip.base*days +
    (plan.equipment.ventilator?equip.ventilator*days:0) +
    (plan.equipment.ecmo?equip.ecmo*days:0) +
    meds[plan.medLvl]*days;

  if (ctx==="고인이송") {
    if (plan.cremated) { c.항공료=1_250_000; c.기타+=3_500_000; }
    else               { c.항공료=6_000_000; c.기타+=15_000_000; }
  } else if (plan.transport==="ship") {
    c.항공료 = km*3_300*(1+plan.staff.length*2);
  } else if (plan.transport!=="civil") {
    c.항공료 = km*15_000;
  } else {
    c.항공료 += plan.seat==="stretcher"?km*150*6:km*350;
    c.항공료 += km*150*plan.staff.length;
    c.항공료 += km*(plan.seat==="business"?300:150)*plan.staff.length;
  }

  c.총 = Object.values(c).reduce((a,b)=>a+b,0);
  return c;
}

// ——— Intent & Params 추출 ———
async function decideIntentAndParams(text) {
  const prompt = `당신은 KMTC AI입니다.
사용자의 입력이 세 가지 중 무엇인지 판단하고, 필요한 파라미터를 추출해 JSON으로만 응답하세요:

1) GENERAL : 일반 개념·절차 문의
2) EXPLAIN_COST : 비용 구조나 형성이 어떻게 되는지 물어보는 개념 설명
3) CALCULATE_COST : 실제 경로·조건이 주어져 비용을 계산해야 하는 요청

추출할 필드:
- intent: "GENERAL" | "EXPLAIN_COST" | "CALCULATE_COST"
- from: 출발지 (…에서 …까지 형식에서 왼쪽)
- to: 도착지 (…에서 …까지 형식에서 오른쪽)
- scenarios: (비교 요청 시 transport 옵션 목록, 예: ["civil","airAmbulance"])

JSON ONLY:`;
  const res = await openai.chat.completions.create({
    model:"gpt-4o", temperature:0,
    messages:[
      { role:"system", content:prompt },
      { role:"user",   content:text }
    ]
  });
  return JSON.parse(res.choices[0].message.content.trim());
}
// —————————————————

const sessions = {};
const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  const {
    sessionId="def",
    message="",
    days=3,
    patient={}
  } = req.body;

  const ses = sessions[sessionId] ||= {};
  if (Object.keys(patient).length) ses.patient = {...ses.patient, ...patient};

  // 1) 사용자의 의도 및 파라미터 판단
  const { intent, from, to, scenarios=[] } = await decideIntentAndParams(message);

  // 2) 일반 문의
  if (intent === "GENERAL") {
    const chat = await openai.chat.completions.create({
      model:"gpt-4o", temperature:0.7,
      messages:[
        { role:"system", content:"당신은 KMTC AI 상담원입니다. 일반 개념·절차를 설명해주세요." },
        { role:"user",   content:message }
      ]
    });
    return res.json({ reply:chat.choices[0].message.content.trim() });
  }

  // 3) 비용 구조 설명
  if (intent === "EXPLAIN_COST") {
    const chat = await openai.chat.completions.create({
      model:"gpt-4o", temperature:0.7,
      messages:[
        { role:"system", content:"당신은 KMTC AI 상담원입니다. 비용 구조와 형성이 어떻게 되는지 설명해주세요." },
        { role:"user",   content:message }
      ]
    });
    return res.json({ reply:chat.choices[0].message.content.trim() });
  }

  // 4) 실제 계산
  let km=0, hr=0;
  try {
    ({ km, hr } = await routeInfo(from, to));
  } catch {
    return res.json({ reply:"⚠️ 위치 검색 실패. 주소를 확인해주세요." });
  }

  // 기본 플랜 생성
  const planBase = await gptPlan(ses.patient||{}, km);
  const ctx = planBase.type==="funeral"? "고인이송"
             : planBase.type==="event"? "행사의료지원"
             : "항공이송";

  // 시나리오별 계산
  const list = scenarios.length ? scenarios : [planBase.transport];
  const results = await Promise.all(list.map(async transport => {
    const plan = { ...planBase, transport };
    if (ctx==="고인이송") plan.seat="coffin";
    const cost = calcCost(ctx, plan, km, days);
    return { transport, total: cost.총 };
  }));

  // 5) 응답 생성
  if (results.length === 1) {
    return res.json({
      reply: `🛫 ${from} → ${to} (${km}km / ${hr}h)\n총 예상 비용: 약 ${results[0].total.toLocaleString()}원`
    });
  } else {
    const lines = results.map(r=>`- ${r.transport}: 약 ${r.total.toLocaleString()}원`).join("\n");
    return res.json({
      reply: `🛫 ${from} → ${to} (${km}km / ${hr}h)\n비용 비교:\n${lines}`
    });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI 3000"));
