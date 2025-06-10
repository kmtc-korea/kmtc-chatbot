/* backend/server.js – KMTC AI 2025-06-10 (v12.1)  
   · GPT-4o type / cremated 판정  
   · Google Geocoding API ➝ 실패 시 OSM(Nominatim) 3-단계  
   · Google Distance Matrix API 로 거리·시간  
   · 공항 IATA 좌표 캐시(airports.json) + 동적 API 조회  
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
const GMAPS_KEY = process.env.GMAPS_KEY;          // Render Env 에 반드시 추가

/* ---------- JSON 로드 (BOM 제거) ---------- */
const strip = b => b.toString("utf8").replace(/^\uFEFF/, "");
const airports  = JSON.parse(strip(fs.readFileSync(path.join(__dirname,"data/airports.json"))));
const countries = JSON.parse(strip(fs.readFileSync(path.join(__dirname,"data/countries.json"))));

/* ---------- 공항 좌표 캐시 ---------- */
const airportCache = Object.fromEntries(
  airports.filter(a=>a.iata_code)
          .map(a=>[a.iata_code.toLowerCase(),{lat:+a.latitude_deg, lon:+a.longitude_deg}])
);
async function airportCoord(iata){
  const key = iata.toLowerCase();
  if (airportCache[key]) return airportCache[key];

  try{
    const geo = await googleGeocode(`${iata} airport`);
    return airportCache[key] = geo;
  }catch{
    const geo = await osmGeocode(`${iata} airport`);
    return airportCache[key] = geo;
  }
}

/* ---------- Google Geocoding ---------- */
async function googleGeocode(q){
  const url = "https://maps.googleapis.com/maps/api/geocode/json"
            + `?key=${GMAPS_KEY}&address=${encodeURIComponent(q)}&language=ko`;
  const js  = await fetch(url).then(r=>r.json());
  if(js.status==="OK"){
    const p = js.results[0].geometry.location;
    return {lat:p.lat, lon:p.lng};
  }
  throw new Error("G_FAIL");
}

/* ---------- OSM Geocoding ---------- */
async function osmGeocode(q){
  const url = "https://nominatim.openstreetmap.org/search"
            + `?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const js  = await fetch(url,{headers:{'User-Agent':'kmtc'}}).then(r=>r.json());
  if(js.length) return {lat:+js[0].lat, lon:+js[0].lon};
  throw new Error("OSM_FAIL");
}

/* ---------- 주소 → 좌표 ---------- */
async function geocode(addr){
  try{ return await googleGeocode(addr);}catch{}
  const parts = addr.trim().split(/\s+/);
  if(parts.length>=2){
    try{ return await googleGeocode(`${parts.slice(0,-1).join(" ")}, ${parts.at(-1)}`);}catch{}
  }
  for(const q of [addr,...countries.flatMap(c=>[`${addr} ${c.ko}`,`${addr} ${c.en}`])]){
    try{ return await googleGeocode(q);}catch{}
    try{ return await osmGeocode(q);}catch{}
  }
  throw new Error("NOT_FOUND");
}

/* ---------- Google Distance Matrix ---------- */
async function gDist(o,d){
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json"
            + `?origins=${o.lat},${o.lon}&destinations=${d.lat},${d.lon}&key=${GMAPS_KEY}`;
  const js  = await fetch(url).then(r=>r.json());
  if(js.status!=="OK") throw new Error("DIST_FAIL");
  const e = js.rows[0].elements[0];
  return { km:+(e.distance.value/1000).toFixed(0), hr:+(e.duration.value/3600).toFixed(1) };
}

/* ---------- “…에서 …까지” 파싱 ---------- */
const parseLoc = t=>{ const m=t.match(/(.+?)에서\s+(.+?)까지/); return m?{depLoc:m[1].trim(),arrLoc:m[2].trim()}:{}; };

/* ---------- 전체 경로 ---------- */
async function routeInfo(depLoc,arrLoc,depIata,arrIata){
  const from = await geocode(depLoc);
  const to   = await geocode(arrLoc);
  const depA = await airportCoord(depIata);
  const arrA = await airportCoord(arrIata);

  return {
    leg1: await gDist(from, depA),
    leg2: await gDist(depA, arrA),
    leg3: await gDist(arrA, to)
  };
}

/* ---------- GPT 계획 ---------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function gptPlan(patient,km){
  const sys=`JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr=`진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"} / 거동:${patient.mobility||"unknown"} / 거리:${km}`;
  const {choices:[{message}]}=await openai.chat.completions.create({
    model:"gpt-4o",temperature:0.2,
    messages:[{role:"system",content:sys},{role:"user",content:usr}]
  });
  return JSON.parse(message.content.trim());
}

/* ---------- 단가 & 비용 계산 ---------- */
const wages={doctor:1_000_000,nurse:500_000,handler:1_000_000,staff:400_000};
const equip={ventilator:5_000_000,ecmo:20_000_000,base:4_500_000};
const meds ={high:400_000,medium:200_000,low:100_000};
const ACC=250_000, SHIP=3_300, CHARTER=15_000;

function calcCost(ctx,plan,km,days){
  const c={항공료:0,인건비:0,장비비:0,숙식:ACC*plan.staff.length*days,기타:3_000_000+400_000*2};
  plan.staff.forEach(r=>{if(wages[r])c.인건비+=wages[r]*days;});
  c.장비비 = equip.base*days
           + (plan.equipment.ventilator ? equip.ventilator*days : 0)
           + (plan.equipment.ecmo       ? equip.ecmo*days       : 0)
           + meds[plan.medLvl]*days;
  if(ctx==="고인이송"){
    if(plan.cremated){c.항공료=1_250_000;c.기타+=3_500_000;}
    else             {c.항공료=6_000_000;c.기타+=15_000_000;}
  }else if(plan.transport==="ship")      c.항공료=km*SHIP*(1+plan.staff.length*2);
  else if(plan.transport!=="civil")      c.항공료=km*CHARTER;
  else{
    c.항공료+=plan.seat==="stretcher"?km*150*6:km*350;
    c.항공료+=km*150*plan.staff.length;
    c.항공료+=km*(plan.seat==="business"?300:150)*plan.staff.length;
  }
  c.총=Object.values(c).reduce((a,b)=>a+b,0);
  return c;
}

/* ---------- Express ---------- */
const sessions={};
const app=express();
app.use(cors()); app.use(express.json());

app.post("/chat",async(req,res)=>{
  const {
    sessionId="def",
    message="",
    depLoc="", arrLoc="",
    depAirport="sgn",  // ★ 기본값을 SGN 으로 수정
    arrAirport="icn",
    days=3,
    patient={}
  }=req.body;

  const ses=sessions[sessionId] ||= {};
  if(Object.keys(patient).length) ses.patient={...ses.patient,...patient};

  const plan0=await gptPlan(ses.patient||{},0);
  const ctx = plan0.type==="funeral"?"고인이송":plan0.type==="event"?"행사의료지원":"항공이송";
  const needAddr = ctx!=="행사의료지원";

  const auto=parseLoc(message);
  const from=depLoc||auto.depLoc, to=arrLoc||auto.arrLoc;
  if(needAddr && (!from||!to))
    return res.json({reply:"📝 \"…에서 …까지\" 형식 또는 출발·도착 주소를 입력해 주세요."});

  let legs={leg1:{km:0,hr:0},leg2:{km:0,hr:0},leg3:{km:0,hr:0}}, km=0;
  if(needAddr){
    try{legs=await routeInfo(from,to,depAirport,arrAirport); km=legs.leg2.km;}
    catch{return res.json({reply:"⚠️ 위치 검색 실패. 주소를 다시 확인해 주세요."});}
  }

  const plan = km ? await gptPlan(ses.patient||{},km) : plan0;
  if(ctx==="고인이송") plan.seat="coffin";

  const c   = calcCost(ctx,plan,km,days);
  const fmt = n=>`약 ${n.toLocaleString()}원`;

  res.json({reply:`
### 📝 이송 요약
- 유형 **${ctx}** / 위험도 **${plan.risk.toUpperCase()}**
- 수단 ${plan.transport}${ctx==="고인이송"?"":" / 좌석 "+plan.seat}
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
${plan.notes.map(n=>" - "+n).join("\\n")}
`.trim()} );
});

app.listen(3000,()=>console.log("🚀 KMTC AI 3000"));
