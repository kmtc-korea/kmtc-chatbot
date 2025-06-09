/* backend/index.js – KMTC AI (2025-06-09) */
import express from "express";
import cors from "cors";
import { config } from "dotenv";
import fetch from "node-fetch";
import haversine from "haversine-distance";
import { OpenAI } from "openai";

config();
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ── 단가표 ───────────────────────────── */
const wages = { doctor:1_000_000, nurse:500_000, handler:1_000_000, staff:400_000 };
const equipCost = { ventilator:5_000_000, ecmo:20_000_000, base:4_500_000 };
const medCost = { high:400_000, medium:200_000, low:100_000 };
const ACC = 250_000, SHIP = 3_300, CHARTER = 15_000;

/* ── ❶ 위치→좌표 ─────────────────────── */
async function geocode(addr){
  const q = encodeURIComponent(addr);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
  const js = await fetch(url,{headers:{'User-Agent':'kmtc'}}).then(r=>r.json());
  if(!js.length) throw new Error("위치 찾기 실패");
  return {lat:+js[0].lat, lon:+js[0].lon};
}

/* ── ❷ 공항코드→좌표 (간단 DB) ───────── */
const airports = {
  icn:{lat:37.4691,lon:126.4505},
  sgnh:{lat:10.8188,lon:106.6520}, // SGN
  gimpo:{lat:37.5583,lon:126.7901}
  // 필요 시 추가
};

/* ── ❸ 거리·시간 산출 ───────────────── */
function distKm(a,b){ return haversine(a,b)/1000; }
function timeHr(km,speed){ return +(km/speed).toFixed(1); } // h

async function calcLeg(from,to,avgKmH){
  const km = distKm(from,to);
  return { km: +km.toFixed(0), hr: timeHr(km,avgKmH) };
}

async function getRouteInfo(depLoc,depAirport,arrAirport,arrLoc){
  const fromAddr = await geocode(depLoc);
  const toAddr   = await geocode(arrLoc);
  const leg1 = await calcLeg(fromAddr, airports[depAirport], 50);   // 구급차 50km/h
  const leg2 = await calcLeg(airports[depAirport], airports[arrAirport], 800); // 항공
  const leg3 = await calcLeg(airports[arrAirport], toAddr, 40);     // 국내 구급차
  return { leg1, leg2, leg3, totalKm:leg2.km };
}

/* ── ❹ AI에 플랜 요청 ────────────────── */
async function getPlan(openai, patient, km){
  const sys = `너는 중증도·이송계획 전문가. JSON ONLY로:
{"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr = `진단:${patient.diagnosis} / 의식:${patient.consciousness} / 거동:${patient.mobility} / 거리:${km}`;
  const {choices:[{message:{content}}]} = await openai.chat.completions.create({
    model:"gpt-4o",temperature:0.2,messages:[{role:"system",content:sys},{role:"user",content:usr}]
  });
  return JSON.parse(content.trim());
}

/* ── ❺ 비용 계산 ─────────────────────── */
function cost(plan,km,days){
  const c={항공료:0,인건비:0,장비비:0,숙식:0,기타:3_000_000+400_000*2};
  plan.staff.forEach(s=>{ c.인건비+=wages[s]*days; });
  c.숙식 = ACC*plan.staff.length*days;
  c.장비비 = equipCost.base*days + (plan.equipment.ventilator?equipCost.ventilator*days:0)
           + (plan.equipment.ecmo?equipCost.ecmo*days:0) + medCost[plan.medLvl]*days;
  if(plan.transport==="ship")      c.항공료 = km*SHIP*(1+plan.staff.length*2);
  else if(plan.transport!=="civil")c.항공료 = km*CHARTER;
  else {
    c.항공료 += plan.seat==="stretcher"?km*150*6:km*350;
    c.항공료 += km*150*plan.staff.length;
    c.항공료 += km*(plan.seat==="business"?300:150)*plan.staff.length;
  }
  c.총 = Object.values(c).reduce((a,b)=>a+b,0);
  return c;
}

/* ── /chat 엔드포인트 ───────────────── */
const openai = new OpenAI({ apiKey:process.env.OPENAI_API_KEY });

app.post("/chat", async (req,res)=>{
  const { depLoc="", arrLoc="", depAirport="sgnh", arrAirport="icn", days=3, patient={} } = req.body;
  if(!depLoc||!arrLoc) return res.json({reply:"📝 출발지·도착지 주소를 입력하세요."});

  /* 1) 거리·시간 계산 */
  let route; try{ route = await getRouteInfo(depLoc,depAirport,arrAirport,arrLoc);}catch{ return res.json({reply:"⚠️ 거리 계산 실패"});}

  /* 2) 계획 생성 */
  let plan; try{ plan = await getPlan(openai,patient,route.totalKm);}catch{ return res.json({reply:"⚠️ 계획 생성 실패"});}

  /* 3) 비용 계산 */
  const c = cost(plan,route.totalKm,days);

  /* 4) 응답 */
  const fmt = n=>`약 ${n.toLocaleString()}원`;
  const md = `
### 📝 이송 요약
- 위험도: **${plan.risk.toUpperCase()}**
- 수단: **${plan.transport}** / 좌석: **${plan.seat}**
- 인력: ${plan.staff.join(", ")}

### 📍 이동 구간
|구간|거리(km)|예상시간(h)|
|---|---|---|
|병원→출발공항|${route.leg1.km}|${route.leg1.hr}|
|출발공항→도착공항|${route.leg2.km}|${route.leg2.hr}|
|도착공항→목적병원|${route.leg3.km}|${route.leg3.hr}|

### 💰 예상 비용
|항목|금액|
|---|---|
|✈️ 항공료|${fmt(c.항공료)}|
|🧑‍⚕️ 인건비|${fmt(c.인건비)}|
|🛠️ 장비·약품|${fmt(c.장비비)}|
|🏨 숙식|${fmt(c.숙식)}|
|기타|${fmt(c.기타)}|
|**합계**|**${fmt(c.총)}**|

### 🔧 장비 · 약품
- 장비: ${plan.equipment.ventilator?"벤틀레이터, ":""}${plan.equipment.ecmo?"ECMO, ":""}기본세트
- 약품 세트: ${plan.medLvl}

### ⚠️ 주의사항
${plan.notes.map(n=>`- ${n}`).join("\n")}`.trim();

  res.json({reply:md});
});

/* ── run ─────────────────────────────── */
app.listen(3000,()=>console.log("🚀 KMTC AI 3000"));
