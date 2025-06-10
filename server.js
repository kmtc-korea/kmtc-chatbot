/* backend/server.js – KMTC AI 2025-06-10 (v12.5)
   · GPT-4o type / cremated 판정
   · Google Geocoding API → 실패 시 OSM(Nominatim) 3-단계
   · Google Distance Matrix API 로 단일 구간 거리·시간
   · ‘항공/고인’만 주소 필수, 행사 의료지원은 주소 불필요
   · function-calling 으로 intent 분류 및 파라미터 추출
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
  const js = await fetch(url).then(r => r.json());
  if (js.status === "OK") return { lat: js.results[0].geometry.location.lat, lon: js.results[0].geometry.location.lng };
  throw new Error("G_FAIL");
}

async function osmGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const js = await fetch(url, { headers:{ "User-Agent":"kmtc" } }).then(r => r.json());
  if (js.length) return { lat:+js[0].lat, lon:+js[0].lon };
  throw new Error("OSM_FAIL");
}

async function geocode(addr) {
  try { return await googleGeocode(addr); } catch {}
  const parts = addr.trim().split(/\s+/);
  if (parts.length >= 2) {
    try { return await googleGeocode(`${parts.slice(0,-1).join(" ")}, ${parts.at(-1)}`); } catch {}
  }
  for (const q of [ addr, ...countries.flatMap(c=>[`${addr} ${c.ko}`,`${addr} ${c.en}`]) ]) {
    try { return await googleGeocode(q); } catch {}
    try { return await osmGeocode(q); } catch {}
  }
  throw new Error("NOT_FOUND");
}

async function gDist(o, d) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
            + `?origins=${o.lat},${o.lon}&destinations=${d.lat},${d.lon}&key=${GMAPS_KEY}`;
  const js = await fetch(url).then(r => r.json());
  if (js.status !== "OK") throw new Error("DIST_FAIL");
  const e = js.rows[0].elements[0];
  return { km:+(e.distance.value/1000).toFixed(0), hr:+(e.duration.value/3600).toFixed(1) };
}

async function routeInfo(depLoc, arrLoc) {
  const from = await geocode(depLoc);
  const to   = await geocode(arrLoc);
  return await gDist(from, to);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// GPT 플랜
async function gptPlan(patient, km) {
  const sys = `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr = `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"} / 거동:${patient.mobility||"unknown"} / 거리:${km}`;
  const { choices:[{ message }] } = await openai.chat.completions.create({
    model:"gpt-4o", temperature:0.2,
    messages:[
      { role:"system", content:sys },
      { role:"user",   content:usr }
    ]
  });
  return JSON.parse(message.content.trim());
}

// 비용 계산
const wages = { doctor:1_000_000,nurse:500_000,handler:1_000_000,staff:400_000 };
const equip  = { ventilator:5_000_000,ecmo:20_000_000,base:4_500_000 };
const meds   = { high:400_000,medium:200_000,low:100_000 };
const ACC    = 250_000;

function calcCost(ctx, plan, km, days) {
  const c = { 항공료:0, 인건비:0, 장비비:0, 숙식:ACC*plan.staff.length*days, 기타:3_000_000+400_000*2 };
  plan.staff.forEach(r=>{ if(wages[r]) c.인건비+=wages[r]*days; });
  c.장비비 = equip.base*days
           + (plan.equipment.ventilator?equip.ventilator*days:0)
           + (plan.equipment.ecmo?equip.ecmo*days:0)
           + meds[plan.medLvl]*days;
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

// 함수 스키마
const functions = [
  {
    name: "decideIntentAndParams",
    description: "사용자 입력에서 intent와 파라미터를 뽑아냅니다.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["GENERAL","EXPLAIN_COST","CALCULATE_COST"]
        },
        from:      { type: "string" },
        to:        { type: "string" },
        scenarios: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["intent"]
    }
  }
];

const sessions = {};
const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { sessionId="def", message="", days=3, patient={} } = req.body;
  const ses = sessions[sessionId] ||= {};
  if (Object.keys(patient).length) ses.patient = { ...ses.patient, ...patient };

  // 1) intent 분류 및 파라미터 추출
  const cl = await openai.chat.completions.create({
    model: "gpt-4o", temperature:0,
    messages: [
      { role:"system", content:"당신은 KMTC AI입니다. …(의도 분류 prompt)…" },
      { role:"user",   content:message }
    ],
    functions,
    function_call: { name:"decideIntentAndParams" }
  });
  const args = JSON.parse(cl.choices[0].message.function_call.arguments);
  const { intent, from, to, scenarios=[] } = args;

  // 2) GENERAL
  if (intent==="GENERAL") {
    const chat = await openai.chat.completions.create({
      model:"gpt-4o", temperature:0.7,
      messages:[
        { role:"system", content:"당신은 KMTC AI 상담원입니다. 일반 개념·절차를 설명해주세요." },
        { role:"user",   content:message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 3) EXPLAIN_COST
  if (intent==="EXPLAIN_COST") {
    const chat = await openai.chat.completions.create({
      model:"gpt-4o", temperature:0.7,
      messages:[
        { role:"system", content:"당신은 KMTC AI 상담원입니다. 비용 구조와 형성을 설명해주세요." },
        { role:"user",   content:message }
      ]
    });
    return res.json({ reply: chat.choices[0].message.content.trim() });
  }

  // 4) CALCULATE_COST
  let km=0, hr=0;
  try { ({ km, hr } = await routeInfo(from, to)); }
  catch { return res.json({ reply:"⚠️ 위치 검색 실패. 주소를 확인해주세요." }); }

  const planBase = await gptPlan(ses.patient||{}, km);
  const ctx = planBase.type==="funeral" ? "고인이송" : planBase.type==="event" ? "행사의료지원" : "항공이송";

  const list = scenarios.length ? scenarios : [ planBase.transport ];
  const results = await Promise.all(list.map(async transport => {
    const plan = { ...planBase, transport };
    if (ctx==="고인이송") plan.seat="coffin";
    return calcCost(ctx, plan, km, days).총;
  }));

  if (results.length===1) {
    return res.json({
      reply: `🛫 ${from}→${to} (${km}km/${hr}h)\n총 예상 비용: 약 ${results[0].toLocaleString()}원`
    });
  } else {
    const lines = list.map((t,i)=>`- ${t}: 약 ${results[i].toLocaleString()}원`).join("\n");
    return res.json({
      reply: `🛫 ${from}→${to} (${km}km/${hr}h)\n비용 비교:\n${lines}`
    });
  }
});

app.listen(3000, () => console.log("🚀 KMTC AI 3000"));
