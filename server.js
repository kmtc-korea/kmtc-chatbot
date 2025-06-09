/* backend/index.js – KMTC AI 2025-06-09 (v5: GPT가 type·cremated 결정) */
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

/* ────────── 단가표 & 상수 ────────── */
const wages     = { doctor:1_000_000, nurse:500_000, handler:1_000_000, staff:400_000 };
const equipCost = { ventilator:5_000_000, ecmo:20_000_000, base:4_500_000 };
const medCost   = { high:400_000, medium:200_000, low:100_000 };
const ACC = 250_000, SHIP = 3_300, CHARTER = 15_000;

/* ────────── 자연어 → 출발·도착 ────────── */
function parseLoc(t=""){ const m=t.match(/(.+?)에서\s+(.+?)까지/); return m?{depLoc:m[1].trim(),arrLoc:m[2].trim()}:{}; }

/* ────────── 주소 → 좌표 ────────── */
async function geocode(addr){
  const url=`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr)}&format=json&limit=1`;
  const js=await fetch(url,{headers:{'User-Agent':'kmtc'}}).then(r=>r.json());
  if(!js.length) throw new Error("notfound");
  return {lat:+js[0].lat,lon:+js[0].lon};
}

/* ────────── 주요 공항 좌표 ────────── */
const airports={ icn:{lat:37.4691,lon:126.4505}, sgnh:{lat:10.8188,lon:106.6520}, gimpo:{lat:37.5583,lon:126.7901} };

/* ────────── 거리·시간 계산 ────────── */
const distKm=(a,b)=>haversine(a,b)/1000;
const timeHr=(km,s)=>+(km/s).toFixed(1);
async function leg(from,to,v){ const km=distKm(from,to); return{km:+km.toFixed(0),hr:timeHr(km,v)}; }
async function routeInfo(depLoc,arrLoc,depAir,arrAir){
  const from=await geocode(depLoc), to=await geocode(arrLoc);
  return{
    leg1:await leg(from,airports[depAir],50),
    leg2:await leg(airports[depAir],airports[arrAir],800),
    leg3:await leg(airports[arrAir],to,40)
  };
}

/* ────────── GPT-4o 플랜 ────────── */
async function getPlan(ai,patient,km){
  const sys=`JSON ONLY:
{
 "type":"air|funeral|event",
 "cremated":bool,                   /* 화장(유골) 여부 — funeral일 때만 의미 */
 "risk":"low|medium|high",
 "transport":"civil|airAmbulance|charter|ship",
 "seat":"business|stretcher",
 "staff":["doctor","nurse"],
 "equipment":{"ventilator":bool,"ecmo":bool},
 "medLvl":"low|medium|high",
 "notes":["..."]
}`;
  const usr=`환자 정보
- 진단: ${patient.diagnosis||"unknown"}
- 의식: ${patient.consciousness||"unknown"}
- 거동: ${patient.mobility||"unknown"}
- 항공거리: ${km} km`;
  const {choices:[{message:{content}}]}=await ai.chat.completions.create({
    model:"gpt-4o",temperature:0.2,
    messages:[{role:"system",content:sys},{role:"user",content:usr}]
  });
  return JSON.parse(content.trim());
}

/* ────────── 비용 계산 ────────── */
function calcCost(ctx,plan,km,days){
  const c={항공료:0,인건비:0,장비비:0,숙식:0,기타:3_000_000+400_000*2};
  plan.staff.forEach(s=>{ if(wages[s]) c.인건비+=wages[s]*days; });
  c.숙식 = ACC*plan.staff.length*days;
  c.장비비 = equipCost.base*days
           + (plan.equipment.ventilator?equipCost.ventilator*days:0)
           + (plan.equipment.ecmo?equipCost.ecmo*days:0)
           + medCost[plan.medLvl]*days;

  if(ctx==="고인이송"){                 /* 관 / 유골 */
    if(plan.cremated){                 /* 유골함 */
      c.항공료 = 1_250_000;            /* 100~150만 중간값 */
      c.기타  += 3_500_000;            /* 현지 화장·부대비용 */
    }else{                             /* 관(시신) */
      c.항공료 = 6_000_000;            /* 500~700만 중간값 */
      c.기타  += 15_000_000;           /* 엠바밍·특수관·장의차 */
    }
  }else if(plan.transport==="ship"){
    c.항공료 = km*SHIP*(1+plan.staff.length*2);
  }else if(plan.transport!=="civil"){
    c.항공료 = km*CHARTER;
  }else{
    c.항공료 += plan.seat==="stretcher"?km*150*6:km*350;
    c.항공료 += km*150*plan.staff.length;
    c.항공료 += km*(plan.seat==="business"?300:150)*plan.staff.length;
  }
  c.총 = Object.values(c).reduce((a,b)=>a+b,0);
  return c;
}

/* ────────── 세션 메모리 ────────── */
const sessions={};

/* ────────── /chat 엔드포인트 ────────── */
const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});

app.post("/chat",async(req,res)=>{
  const { sessionId="default", message="", depLoc="", arrLoc="", depAirport="sgnh", arrAirport="icn", days=3, patient={} }=req.body;
  const ses=sessions[sessionId] ||= {};
  if(patient) ses.patient={...ses.patient,...patient};

  /* 출발·도착 */
  const auto=parseLoc(message);
  const from=depLoc||auto.depLoc||"", to=arrLoc||auto.arrLoc||"";
  if(!from||!to) return res.json({reply:"📝 문장에 \"…에서 …까지\"를 포함하거나 주소·병원명을 입력해 주세요."});

  /* 거리·시간 */
  let legs; try{ legs=await routeInfo(from,to,depAirport,arrAirport);}catch{return res.json({reply:"⚠️ 위치 찾기 실패. 정확한 주소로 다시 입력해 주세요."});}
  const km=legs.leg2.km;

  /* GPT 플랜 */
  let plan; try{ plan=await getPlan(openai,ses.patient||{},km);}catch{return res.json({reply:"⚠️ AI 계획 생성 실패"});}
  const ctx = plan.type==="funeral" ? "고인이송" : plan.type==="event" ? "행사의료지원" : "항공이송";
  ses.contextType = ctx;
  if(ctx==="고인이송") plan.seat="coffin";

  /* 비용 계산 */
  const cost=calcCost(ctx,plan,km,days);
  const fmt=n=>`약 ${n.toLocaleString()}원`;

  /* 응답 */
  const md=`
### 📝 이송 요약
- 유형 **${ctx}** / 위험도 **${plan.risk.toUpperCase()}**
- 수단 ${plan.transport}${ctx==="고인이송" ? "" : " / 좌석 "+plan.seat}
- 인력 ${plan.staff.join(", ")}

### 📍 이동 구간
|구간|km|h|
|---|---|---|
|병원→출발공항|${legs.leg1.km}|${legs.leg1.hr}|
|출발공항→도착공항|${legs.leg2.km}|${legs.leg2.hr}|
|도착공항→목적병원|${legs.leg3.km}|${legs.leg3.hr}|

### 💰 예상 비용
|항목|금액|
|---|---|
|✈️ 항공료|${fmt(cost.항공료)}|
|🧑‍⚕️ 인건비|${fmt(cost.인건비)}|
|🛠️ 장비·약품|${fmt(cost.장비비)}|
|🏨 숙식|${fmt(cost.숙식)}|
|기타|${fmt(cost.기타)}|
|**합계**|**${fmt(cost.총)}**|

### 🔧 장비·약품
- 장비: ${(plan.equipment.ventilator?"벤틀레이터, ":"")+(plan.equipment.ecmo?"ECMO, ":"")}기본세트
- 약품 set: ${plan.medLvl}

### ⚠️ 주의사항
${plan.notes.map(n=>`- ${n}`).join("\n")}
`.trim();

  res.json({reply:md});
});

/* ────────── start ────────── */
app.listen(3000,()=>console.log("🚀 KMTC AI 3000"));
