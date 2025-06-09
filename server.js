/* backend/index.js – KMTC AI 2025-06-09 (auto-주소 파싱 + 오류 fallback) */
import express from "express";
import cors from "cors";
import { config } from "dotenv";
import fetch from "node-fetch";
import haversine from "haversine-distance";
import { OpenAI } from "openai";

config();
const app   = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ── 단가표 ───────────────────────────────── */
const wages      = { doctor:1_000_000, nurse:500_000, handler:1_000_000, staff:400_000 };
const equipCost  = { ventilator:5_000_000, ecmo:20_000_000, base:4_500_000 };
const medCost    = { high:400_000, medium:200_000, low:100_000 };
const ACC=250_000, SHIP=3_300, CHARTER=15_000;

/* ── 자연어 → 출발·도착지 파싱 ────────────── */
function parseLoc(text=""){
  const m = text.match(/(.+?)에서\s+(.+?)까지/);              // “…에서 …까지”
  if(!m) return {};
  return { depLoc:m[1].trim(), arrLoc:m[2].trim() };
}

/* ── 주소 → 좌표 ──────────────────────────── */
async function geocode(addr){
  const url=`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr)}&format=json&limit=1`;
  const js = await fetch(url,{headers:{'User-Agent':'kmtc'}}).then(r=>r.json());
  if(!js.length) throw new Error("notfound");
  return { lat:+js[0].lat, lon:+js[0].lon };
}

/* ── 공항 좌표(샘플) ───────────────────────── */
const airports={
  icn:{lat:37.4691,lon:126.4505},  // 인천
  sgnh:{lat:10.8188,lon:106.6520}, // 호치민(SGN)
  gimpo:{lat:37.5583,lon:126.7901}
};

/* ── 거리·시간 산출 ──────────────────────── */
const distKm=(a,b)=>haversine(a,b)/1000;
const timeHr=(km,speed)=>+(km/speed).toFixed(1);

async function calcLeg(from,to,spd){ const km=distKm(from,to); return{km:+km.toFixed(0),hr:timeHr(km,spd)}; }

async function getRouteInfo(depLoc,arrLoc,depAir,arrAir){
  const from = await geocode(depLoc);
  const to   = await geocode(arrLoc);
  const leg1 = await calcLeg(from,airports[depAir],50);
  const leg2 = await calcLeg(airports[depAir],airports[arrAir],800);
  const leg3 = await calcLeg(airports[arrAir],to,40);
  return { leg1, leg2, leg3, totalKm:leg2.km };
}

/* ── GPT-4o 로 이송 플랜 ──────────────────── */
async function getPlan(ai,patient,km){
  const sys=`JSON ONLY:
{"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr=`진단:${patient.diagnosis}\n의식:${patient.consciousness}\n거동:${patient.mobility}\n거리:${km}`;
  const {choices:[{message:{content}}]}=await ai.chat.completions.create({
    model:"gpt-4o",temperature:0.2,messages:[{role:"system",content:sys},{role:"user",content:usr}]
  });
  return JSON.parse(content.trim());
}

/* ── 비용 계산 ───────────────────────────── */
function cost(plan,km,days){
  const c={항공료:0,인건비:0,장비비:0,숙식:0,기타:3_000_000+400_000*2};
  plan.staff.forEach(s=>{ if(wages[s]) c.인건비+=wages[s]*days; });
  c.숙식=ACC*plan.staff.length*days;
  c.장비비 = equipCost.base*days
           + (plan.equipment.ventilator?equipCost.ventilator*days:0)
           + (plan.equipment.ecmo?equipCost.ecmo*days:0)
           + medCost[plan.medLvl]*days;

  if(plan.transport==="ship")        c.항공료=km*SHIP*(1+plan.staff.length*2);
  else if(plan.transport!=="civil")  c.항공료=km*CHARTER;
  else{
    c.항공료 += plan.seat==="stretcher"?km*150*6:km*350;
    c.항공료 += km*150*plan.staff.length;
    c.항공료 += km*(plan.seat==="business"?300:150)*plan.staff.length;
  }
  c.총=Object.values(c).reduce((a,b)=>a+b,0);
  return c;
}

/* ── /chat ─────────────────────────────── */
const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});

app.post("/chat",async(req,res)=>{
  const { message="", depLoc="", arrLoc="", depAirport="sgnh", arrAirport="icn", days=3, patient={} }=req.body;

  /* 1️⃣ 자연어에서 출발·도착 자동 추출 */
  const auto=parseLoc(message);
  const from=depLoc||auto.depLoc||"", to=arrLoc||auto.arrLoc||"";
  if(!from||!to) return res.json({reply:"📝 \"...에서 ...까지\" 형식으로 말씀해 주시거나 주소·병원명을 입력해 주세요."});

  /* 2️⃣ 거리·시간 */
  let route;
  try{ route=await getRouteInfo(from,to,depAirport,arrAirport); }
  catch{ return res.json({reply:`⚠️ 위치를 찾을 수 없습니다. 정확한 병원/주소를 입력해 주세요.`}); }

  /* 3️⃣ GPT 계획 */
  let plan;
  try{ plan=await getPlan(openai,patient,route.totalKm); }
  catch{ return res.json({reply:"⚠️ AI 계획 생성 실패"}); }

  /* 4️⃣ 비용 */
  const c=cost(plan,route.totalKm,days);
  const fmt=n=>`약 ${n.toLocaleString()}원`;

  /* 5️⃣ 응답 */
  const md=`
### 📝 이송 요약
- 위험도 **${plan.risk.toUpperCase()}**
- 수단 ${plan.transport} / 좌석 ${plan.seat}
- 인력 ${plan.staff.join(", ")}

### 📍 이동 구간
|구간|km|h|
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

### 🔧 장비·약품
- 장비: ${(plan.equipment.ventilator?"벤틀레이터, ":"")+(plan.equipment.ecmo?"ECMO, ":"")}기본세트
- 약품 set: ${plan.medLvl}

### ⚠️ 주의사항
${plan.notes.map(n=>`- ${n}`).join("\n")}
`.trim();

  res.json({reply:md});
});

/* ── start ─────────────────────────────── */
app.listen(3000,()=>console.log("🚀 KMTC AI 3000"));
