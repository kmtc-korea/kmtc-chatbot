/* backend/index.js – KMTC AI 2025-06-10 (v8 최종)
   · GPT-4o가 type / cremated 판정
   · 공항 좌표 자동 캐시(IATA → Nominatim)
   · 지오코딩 3-단계(원문→국가명 붙여 재조회)
   · ‘항공/고인’만 주소 필수, 행사 의료지원은 주소 불필요
*/

import express from "express";
import cors    from "cors";
import { config } from "dotenv";
import fetch   from "node-fetch";
import haversine from "haversine-distance";
import { OpenAI } from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ────── JSON 파일 수동 로드 ────── */
const airportsInit = JSON.parse(fs.readFileSync(path.join(__dirname,"data/airports.json"), "utf8"));
const countries    = JSON.parse(fs.readFileSync(path.join(__dirname,"data/countries.json"), "utf8"));

config();
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ── 단가표 ──────────────────────────────────────── */
const wages     = { doctor:1_000_000, nurse:500_000, handler:1_000_000, staff:400_000 };
const equipCost = { ventilator:5_000_000, ecmo:20_000_000, base:4_500_000 };
const medCost   = { high:400_000, medium:200_000, low:100_000 };
const ACC = 250_000, SHIP = 3_300, CHARTER = 15_000;

/* ── 공항 좌표 캐시 ──────────────────────────────── */
const airportCache = Object.fromEntries(
  airportsInit
    .filter(a => a.iata_code)
    .map(a => [a.iata_code.toLowerCase(), { lat:+a.latitude_deg, lon:+a.longitude_deg }])
);
async function airportCoord(iata){
  const key = iata.toLowerCase();
  if (airportCache[key]) return airportCache[key];

  const url = `https://nominatim.openstreetmap.org/search?q=${iata}%20airport&format=json&limit=1`;
  const js  = await fetch(url, {headers:{'User-Agent':'kmtc'}}).then(r=>r.json());
  if (!js.length) throw new Error("AIRPORT_NOT_FOUND");
  airportCache[key] = { lat:+js[0].lat, lon:+js[0].lon };
  return airportCache[key];
}

/* ── “…에서 …까지” 파싱 ─────────────────────────── */
const parseLoc = t => {
  const m = t.match(/(.+?)에서\s+(.+?)까지/);
  return m ? { depLoc:m[1].trim(), arrLoc:m[2].trim() } : {};
};

/* ── 주소 → 좌표 (3-단계 재조회) ─────────────────── */
async function geocode(addr){
  const base="https://nominatim.openstreetmap.org/search?";
  const opt ="&format=json&limit=1&accept-language=ko,en";

  for (const q of [addr, ...countries.flatMap(c=>[`${addr} ${c.ko}`, `${addr} ${c.en}`])]){
    const js = await fetch(base+"q="+encodeURIComponent(q)+opt, {headers:{'User-Agent':'kmtc'}}).then(r=>r.json());
    if (js.length) return { lat:+js[0].lat, lon:+js[0].lon };
  }
  throw new Error("NOT_FOUND");
}

/* ── 거리·시간 계산 ─────────────────────────────── */
const distKm=(a,b)=>haversine(a,b)/1000;
const hr     =(km,s)=>+(km/s).toFixed(1);
const leg    = async(f,t,v)=>{const km=distKm(f,t);return{km:+km.toFixed(0),hr:hr(km,v)}};

async function routeInfo(depLoc, arrLoc, depIata, arrIata){
  const from = await geocode(depLoc), to = await geocode(arrLoc);
  const depA = await airportCoord(depIata), arrA = await airportCoord(arrIata);
  return {
    leg1: await leg(from,  depA, 50),
    leg2: await leg(depA,  arrA, 800),
    leg3: await leg(arrA,  to,   40)
  };
}

/* ── GPT-4o 로 이송 계획 ───────────────────────── */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function gptPlan(patient, km){
  const sys = `JSON ONLY:
{"type":"air|funeral|event","cremated":bool,"risk":"low|medium|high","transport":"civil|airAmbulance|charter|ship","seat":"business|stretcher","staff":["doctor","nurse"],"equipment":{"ventilator":bool,"ecmo":bool},"medLvl":"low|medium|high","notes":["..."]}`;
  const usr = `진단:${patient.diagnosis||"unknown"} / 의식:${patient.consciousness||"unknown"} / 거동:${patient.mobility||"unknown"} / 거리:${km}`;
  const {choices:[{message}]} = await openai.chat.completions.create({
    model:"gpt-4o", temperature:0.2,
    messages:[{role:"system",content:sys},{role:"user",content:usr}]
  });
  return JSON.parse(message.content.trim());
}

/* ── 비용 계산 ─────────────────────────────────── */
function calcCost(ctx, plan, km, days){
  const c={항공료:0, 인건비:0, 장비비:0, 숙식:ACC*plan.staff.length*days, 기타:3_000_000+400_000*2};

  plan.staff.forEach(s => { if(wages[s]) c.인건비 += wages[s]*days; });
  c.장비비 = equipCost.base*days
           + (plan.equipment.ventilator ? equipCost.ventilator*days : 0)
           + (plan.equipment.ecmo       ? equipCost.ecmo*days       : 0)
           + medCost[plan.medLvl]*days;

  if(ctx==="고인이송"){
    if(plan.cremated){ c.항공료=1_250_000; c.기타+=3_500_000; }
    else             { c.항공료=6_000_000; c.기타+=15_000_000; }
  }else if(plan.transport==="ship")      c.항공료 = km*SHIP*(1+plan.staff.length*2);
  else if(plan.transport!=="civil")      c.항공료 = km*CHARTER;
  else{
    c.항공료 += plan.seat==="stretcher" ? km*150*6 : km*350;
    c.항공료 += km*150*plan.staff.length;
    c.항공료 += km*(plan.seat==="business"?300:150)*plan.staff.length;
  }
  c.총 = Object.values(c).reduce((a,b)=>a+b,0);
  return c;
}

/* ── 세션 메모리 ──────────────────────────────── */
const sessions = {};

/* ── /chat 엔드포인트 ────────────────────────── */
app.post("/chat", async (req, res) => {
  const { sessionId="default", message="", depLoc="", arrLoc="",
          depAirport="sgnh", arrAirport="icn", days=3, patient={} } = req.body;

  const ses = sessions[sessionId] ||= {};
  if (Object.keys(patient).length) ses.patient = { ...ses.patient, ...patient };

  /* 1. GPT로 type 판정 */
  const plan0 = await gptPlan(ses.patient||{}, 0);    // km=0 임시
  const ctx   = plan0.type==="funeral" ? "고인이송"
              : plan0.type==="event"   ? "행사의료지원" : "항공이송";
  const requireAddr = ctx !== "행사의료지원";

  /* 2. 출발·도착 파싱 (항공/고인만 필수) */
  const auto = parseLoc(message);
  const from = depLoc || auto.depLoc;
  const to   = arrLoc || auto.arrLoc;
  if (requireAddr && (!from || !to))
    return res.json({ reply:"📝 \"…에서 …까지\" 형식 또는 출발·도착 주소를 입력해 주세요." });

  /* 3. 거리·시간 (행사는 0) */
  let legs={leg1:{km:0,hr:0},leg2:{km:0,hr:0},leg3:{km:0,hr:0}}, km=0;
  if (requireAddr){
    try{ legs = await routeInfo(from, to, depAirport, arrAirport); km=legs.leg2.km; }
    catch{ return res.json({reply:"⚠️ 위치 검색 실패. 주소를 다시 확인해 주세요."}); }
  }

  /* 4. km 확정 후 최종 GPT 플랜 */
  const plan = km ? await gptPlan(ses.patient||{}, km) : plan0;
  if(ctx==="고인이송") plan.seat="coffin";

  /* 5. 비용 */
  const cost = calcCost(ctx, plan, km, days);
  const fmt  = n=>`약 ${n.toLocaleString()}원`;

  /* 6. 응답 */
  res.json({ reply: `
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
${plan.notes.map(n=>" - "+n).join("\\n")}
`.trim() });
});

app.listen(3000, () => console.log("🚀 KMTC AI 3000"));
