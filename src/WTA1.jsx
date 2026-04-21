import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { createClient } from '@supabase/supabase-js';

// ─── SUPABASE ─────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://nqwkcenrzlllkbjnclnb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7vQBgE8Wx0bzlgHEkl5sJA_9A1esyZO';
const supabase          = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── ANTHROPIC API ────────────────────────────────────────────────────
// WARNING: Never expose production API keys in client-side code.
// Use an environment variable (e.g. import.meta.env.VITE_ANTHROPIC_KEY)
// or a Supabase Edge Function proxy for production deployments.
const ANTHROPIC_API_KEY = import.meta.env?.VITE_ANTHROPIC_KEY || '';

async function compressImage(base64Str) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxW = 800;
      const scale = Math.min(1, maxW / img.width);
      canvas.width  = img.width  * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.src = base64Str;
  });
}

function normaliseTrade(t) {
  const parseSafe = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'object' && v !== null) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return null;
  };

  // pipeline column now stores {snapshot:{...}, inp:{...}}
  // Fall back to treating the whole value as a snapshot for old records
  const pipeData    = parseSafe(t.pipeline) || {};
  const snapshot    = pipeData.snapshot
    ? pipeData.snapshot
    : (pipeData.POI || pipeData.TIME ? pipeData : parseSafe(t.pipelineSnapshot) || {});
  const inp         = pipeData.inp || {};

  const screenshots = Array.isArray(t.screenshots)
    ? t.screenshots
    : (parseSafe(t.screenshots) || []);

  return {
    // ── Core Supabase columns ──────────────────────────────────────────
    id:               t.id,
    pair:             t.pair             || '',
    setup:            t.setup            || '',
    setupType:        t.setup            || t.setupType || '',
    session:          t.session          || '',
    htfBias:          t.htf_bias         || t.htfBias   || '',
    direction:        t.direction        || '',
    poi:              t.poi              || '',
    liquidity:        t.liquidity        || '',
    model:            t.model            || '',
    grade:            t.grade            || '',
    outcome:          t.outcome          || '',
    rAchieved:        t.r_achieved       ?? t.rAchieved ?? 0,
    notes:            t.notes            || '',
    date:             t.trade_date       || t.date       || '',
    savedAt:          t.created_at       || t.savedAt    || '',
    isBacktest:       inp.isBacktest     || t.backtest   || t.isBacktest || false,
    screenshots,
    images: screenshots,

    // ── Pipeline snapshot (for checklist render) ───────────────────────
    pipelineSnapshot: snapshot,

    // ── Granular inp fields (restored from pipeline.inp blob) ──────────
    poiLocation:      inp.poiLocation    || t.poi        || '',
    poiSizePips:      inp.poiSizePips    || '',
    poiType:          inp.poiType        || '',
    m5Build:          inp.m5Build        || false,
    m5Ind:            inp.m5Ind          || false,
    m5Push:           inp.m5Push         || false,
    liquidityType:    inp.liquidityType  ||
                      (t.liquidity ? t.liquidity.split(', ').filter(Boolean) : []),
    multiLayerTrap:   inp.multiLayerTrap || false,
    trapWho:          inp.trapWho        || '',
    trapClarity:      inp.trapClarity    || '',
    dispQuality:      inp.dispQuality    || '',
    fvgPresent:       inp.fvgPresent     || '',
    failType:         inp.failType       || '',
    firstLeg:         inp.firstLeg       || false,
    secondLeg:        inp.secondLeg      || false,
    bosStatus:        inp.bosStatus      || '',
    entryIdea:        inp.entryIdea      || '',
    ltfConfirm:       inp.ltfConfirm     || '',
    stopPips:         inp.stopPips       || '',
    riskPct:          inp.riskPct        || '',
    estRR:            inp.estRR          || '',
    rangeLoc:         inp.rangeLoc       || '',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// WTA-1  v3  —  WISDOM TRADING ARCHITECTURE
// "No trap. No failure. No trade."
//
// Features:
//  ▸ Step-by-step pipeline evaluation (real-time)
//  ▸ Decision trees per model (live status from inputs)
//  ▸ Trade journal (localStorage — requires browser)
//  ▸ Analytics: win rate by condition, grade distribution
//  ▸ Similar trade finder
//  ▸ Adaptive grading (adjusts to your personal stats)
//  ▸ Personal weakness flags (auto-flags conditions you lose on)
// ═══════════════════════════════════════════════════════════════════════

// ─── CONSTANTS ────────────────────────────────────────────────────────
const S = { PENDING: "PENDING", FAIL: "FAIL", FORMING: "FORMING", PASS: "PASS" };
const PIPELINE = ["POI","TIME","LIQ","INDUCE","DISP","FAIL","BOS","RIFC"];
const STEP_NAME = { POI:"Point of Interest", TIME:"Session / Timing", LIQ:"Liquidity",
  INDUCE:"Inducement (Trap)", DISP:"Displacement", FAIL:"Failure Model",
  BOS:"BOS / CHoCH", RIFC:"RIFC Entry" };

const EMPTY = {
  pair:"EURUSD", setupType:"", direction:"", session:"", htfBias:"", rangeLoc:"", backtestMode:false, backtestDate:"",
  poiLocation:"", poiSizePips:"", poiType:"htf",
  m5Build:false, m5Ind:false, m5Push:false,
  liquidityType:[], multiLayerTrap:false,
  trapWho:"", trapClarity:"",
  dispQuality:"", fvgPresent:"",
  failType:"", firstLeg:false, secondLeg:false, bosStatus:"",
  entryIdea:"", entryAtOrigin:"", ltfConfirm:"", demandBelow50:false,
  stopPips:"", riskPct:"", estRR:"",
  mgmtState:"NONE", mgmtMode:"", m1Shift:false, intBOS:false,
  // ── Precision validation (7 mandatory fields) ──
  rifcPipSize:"", rifcTimeframe:"",
  eqlSweepDistance:"", eqhSweepDistance:"",
  opposingZoneExists:false, opposingZoneStatus:"",
  dxyStructureDetail:"",
};

// ─── LABEL MAP ───────────────────────────────────────────────────────
// Single source of truth: raw form key → human-readable Supabase label.
// Every value written to Supabase must use these labels, not the raw keys.
const LABEL_MAP = {
  // Setup types
  reversal_bull: 'Bullish Reversal',    reversal_bear: 'Bearish Reversal',
  cont_bull:     'Bullish Continuation', cont_bear:    'Bearish Continuation',
  // Sessions
  london:        'London',              frankfurt:     'Frankfurt',
  ny1pm:         'NY 1PM',             ny2:           'NY 2nd Hour',
  ny2pm:         'NY 2nd Hour',        asia:          'Asia',
  london_lunch:  'London Lunch',       ny_lunch:      'NY After Lunch',
  outside:       'Outside Window',
  // HTF Bias
  bullish:       'Bullish',            bearish:       'Bearish',
  // Outcomes
  win:           'Win',                loss:          'Loss',
  be:            'Break Even',         valid_not_taken:'Valid -- Not Taken',
  // Liquidity types
  eq_high:       'Equal Highs',        eq_low:        'Equal Lows',
  sess_high:     'Session High',       sess_low:      'Session Low',
  hopd:          'HOPD',               hopw:          'High of Previous Week',
  trendline:     'Trendline Liquidity',
  internal:      'Internal Liquidity',
  frankfurt_h:   'Frankfurt High ✦',   frankfurt_l:   'Frankfurt Low ✦',
  london_h:      'London High ✦',      london_l:      'London Low ✦',
  smc_trap:      'SMC Trap Zone ✦',    swing_hl:      'Swing Highs & Lows',
  unclear:       'Unclear',
  // Opposing zone
  fresh:         'Fresh',              spent:         'Spent',
  // RIFC timeframes (keys and labels are identical — kept for completeness)
  M1: 'M1', M2: 'M2', M3: 'M3', M5: 'M5',
};

// Human-readable label lookups for the 7 precision-validation fields.
// Supabase inserts MUST use these labels — never the raw keys.
const RIFC_TF_LABELS         = { M1:"M1", M2:"M2", M3:"M3", M5:"M5" };
const OPPOSING_ZONE_LABELS   = { fresh:"Fresh", spent:"Spent" };
const OUTCOME_LABELS         = { win:"Win", loss:"Loss", be:"Break Even", valid_not_taken:"Valid -- Not Taken" };
const DXY_REQUIRED_PAIRS     = ["EURUSD","GBPUSD"];

// ═══════════════════════════════════════════════════════════════════════
// EVALUATION ENGINE  (identical logic to v2)
// ═══════════════════════════════════════════════════════════════════════

function evalPOI(inp) {
  if (!inp.pair?.trim()) return { s:S.FAIL, r:"Pair not specified" };
  if (!inp.poiLocation?.trim()) return { s:S.FAIL, r:"POI location not described" };
  if (!inp.htfBias || inp.htfBias==="unclear") return { s:S.FAIL, r:"HTF bias not established" };
  if (!inp.rangeLoc || inp.rangeLoc==="unclear") return { s:S.FAIL, r:"Price location in dealing range not established" };
  if (inp.htfBias==="bullish" && inp.rangeLoc==="premium")
    return { s:S.FAIL, r:"Bullish bias — price in PREMIUM. Wrong location for longs. NO TRADE" };
  if (inp.htfBias==="bearish" && inp.rangeLoc==="discount")
    return { s:S.FAIL, r:"Bearish bias — price in DISCOUNT. Wrong location for shorts. NO TRADE" };
  const pips = parseFloat(inp.poiSizePips);
  if (!pips||isNaN(pips)) return { s:S.FAIL, r:"POI size not provided" };
  const isHTF = inp.poiType==="htf";
  if (isHTF) {
    if (pips<6) return { s:S.FAIL, r:`HTF POI ${pips}p — too tight (min 6p)` };
    if (pips>30) return { s:S.FORMING, r:`HTF POI ${pips}p — oversized (>30p). Look to refine and make it smaller` };
  } else {
    if (pips<4) return { s:S.FAIL, r:`LTF POI ${pips}p — too tight (min 4p)` };
    if (pips>30) return { s:S.FAIL, r:`LTF POI ${pips}p — too wide (>30p). Refine and make it smaller` };
    if (pips>10) return { s:S.FORMING, r:`LTF POI ${pips}p — this falls in HTF range (>10p). Switch to H1 or H4 and reclassify as HTF POI` };
  }
  const m5 = [inp.m5Build,inp.m5Ind,inp.m5Push].filter(Boolean).length;
  if (m5===0) return { s:S.FAIL, r:"No M5 internal structure — buildup/inducement/push-out required" };
  if (m5<3) return { s:S.FORMING, r:`M5 structure incomplete (${m5}/3)` };
  return { s:S.PASS, r:`POI valid — ${pips}p${isHTF?" (HTF)":""}, ${inp.rangeLoc}, M5 complete` };
}

function evalTime(inp) {
  if (!inp.session) return { s:S.FAIL, r:"Session not specified" };
  if (inp.session==="frankfurt") return { s:S.PASS, r:"Frankfurt Open — valid early window (07:00–08:00)" };
  if (inp.session==="london") return { s:S.PASS, r:"London Open — valid window (08:30–10:00)" };
  if (inp.session==="ny2") return { s:S.PASS, r:"NY second hour — valid execution window" };
  if (inp.session==="london_lunch") return { s:S.PASS, r:"London Lunch — valid continuation window" };
  if (inp.session==="ny1pm") return { s:S.PASS, r:"NY 1PM — valid continuation/expansion window" };
  if (inp.session==="outside") return { s:S.FAIL, r:"Outside valid execution window. NO TRADE" };
  return { s:S.FAIL, r:"Invalid session" };
}

function evalLiq(inp) {
  const liqArr = Array.isArray(inp.liquidityType)?inp.liquidityType:(inp.liquidityType?[inp.liquidityType]:[]);
  const active = liqArr.filter(v=>v&&v!=="unclear");
  if (liqArr.length===0) return { s:S.FAIL, r:"No liquidity pool identified" };
  if (liqArr.length===1&&liqArr[0]==="unclear") return { s:S.FORMING, r:"Liquidity present but type unclear" };
  if (active.length===0) return { s:S.FORMING, r:"Liquidity present but type unclear" };
  const premiumTypes = ["frankfurt_h","frankfurt_l","london_h","london_l","smc_trap"];
  const labels = { eq_high:"Equal highs", eq_low:"Equal lows", sess_high:"Session high",
    sess_low:"Session low", hopd:"HOPD", hopw:"HOPW", trendline:"Trendline liquidity",
    internal:"Internal liquidity", frankfurt_h:"Frankfurt High ✦", frankfurt_l:"Frankfurt Low ✦",
    london_h:"London Open High ✦", london_l:"London Open Low ✦",
    smc_trap:"SMC trap zone (weak demand/supply) ✦", swing_hl:"Swing Highs & Lows" };
  const hasPremium = active.some(v=>premiumTypes.includes(v));
  const isMulti = active.length>1;
  const labelStr = active.map(v=>labels[v]||v).join(" + ");
  return { s:S.PASS, r:`Liquidity — ${labelStr}${hasPremium?" (high-probability)":""}${isMulti?" ✦ Multi-layer trap":""}` };
}

function evalInduce(inp) {
  const isRev = inp.setupType?.startsWith("reversal");
  const desc = inp.trapWho?.trim()||"";
  if (!desc||desc.length<15) return { s:S.FAIL, r:isRev?"Inducement not explained — who got trapped in the WRONG direction?":"Inducement not explained — who is trapped and why?" };
  if (!inp.trapClarity) return { s:S.FORMING, r:"Trap described — assess clarity" };
  if (inp.trapClarity==="unclear") return { s:S.FAIL, r:"Trap unclear — cannot confirm. NO TRADE" };
  if (inp.trapClarity==="forming") return { s:S.FORMING, r:"Trap forming — wait for full confirmation" };
  if (inp.trapClarity==="clear") {
    const note = inp.multiLayerTrap?" | Multi-layer trap ✦":"";
    return { s:S.PASS, r:`Trap confirmed${note} — "${desc.substring(0,60)}${desc.length>60?"…":""}"` };
  }
  return { s:S.FAIL, r:"Inducement unresolved" };
}

function evalDisp(inp) {
  if (!inp.dispQuality) return { s:S.FAIL, r:"Displacement not assessed" };
  if (inp.dispQuality==="weak") return { s:S.FAIL, r:"Displacement weak — no intent. NO TRADE" };
  if (inp.dispQuality==="unclear") return { s:S.FORMING, r:"Displacement unclear — assess impulse" };
  if (inp.dispQuality==="moderate") return { s:S.FORMING, r:"Displacement moderate — confirm FVG first" };
  if (!inp.fvgPresent) return { s:S.FORMING, r:"Strong displacement — confirm FVG/imbalance" };
  if (inp.fvgPresent==="no") return { s:S.FAIL, r:"No FVG left — lacks structural intent. NO TRADE" };
  if (inp.fvgPresent==="unclear") return { s:S.FORMING, r:"Strong displacement — clarify FVG" };
  return { s:S.PASS, r:"Displacement valid — strong, impulsive, FVG confirmed" };
}

function evalFailModel(inp) {
  const isRev = inp.setupType?.startsWith("reversal");
  if (!inp.failType) return { s:S.FAIL, r:"Failure model not assessed" };
  if (inp.failType==="unclear") return { s:S.FORMING, r:"Failure forming — confirm No HH / No LL" };
  if (inp.failType==="neither") return { s:S.FAIL, r:"No failure detected — price still in impulse. WAIT or NO TRADE" };
  if (isRev && !inp.firstLeg) return { s:S.FORMING, r:"Failure identified — confirm first leg formed" };
  const label = inp.failType==="no_hh"?"No Higher High — bearish failure":
                inp.failType==="no_ll"?"No Lower Low — bullish failure":"Failure identified";
  const secNote = isRev && inp.secondLeg?" | Second leg ✦":"";
  return { s:S.PASS, r:`Failure confirmed — ${label}${secNote}` };
}

function evalBOS(inp, failResult) {
  if (!failResult||failResult.s!==S.PASS)
    return { s:S.FAIL, r:"BOS blocked — failure not confirmed (no skipping)" };
  if (!inp.bosStatus) return { s:S.FORMING, r:"Failure confirmed — monitoring for BOS/CHoCH" };
  if (inp.bosStatus==="wait") return { s:S.FORMING, r:"Waiting for BOS/CHoCH" };
  if (inp.bosStatus==="no") return { s:S.FAIL, r:"BOS not confirmed — no structure shift" };
  if (inp.bosStatus==="yes") return { s:S.PASS, r:"BOS/CHoCH confirmed — structure shifted" };
  return { s:S.FAIL, r:"BOS unresolved" };
}

function evalRIFC(inp) {
  if (!inp.entryIdea?.trim()) return { s:S.FAIL, r:"Entry zone not described" };
  if (!inp.entryAtOrigin) return { s:S.FORMING, r:"Entry described — confirm at BOS origin" };
  if (inp.entryAtOrigin==="unclear") return { s:S.FORMING, r:"Entry location unclear — must be at origin" };
  if (inp.entryAtOrigin==="no") return { s:S.FAIL, r:"Entry not at origin — mid/late move. REJECTED" };
  const isCont = inp.setupType?.startsWith("cont");
  if (isCont && !inp.demandBelow50) return { s:S.FAIL, r:"Continuation: demand must be below 50% of push. REJECTED" };
  const stop = parseFloat(inp.stopPips);
  if (!stop||isNaN(stop)) return { s:S.FAIL, r:"Stop size not provided" };
  if (stop<1.5) return { s:S.FAIL, r:`Stop ${stop}p — too tight (min 1.5p)` };
  if (stop>5) return { s:S.FAIL, r:`Stop ${stop}p — too wide (max 5p)` };
  const risk = parseFloat(inp.riskPct);
  if (!isNaN(risk)&&risk>1.5) return { s:S.FAIL, r:`Risk ${risk}% exceeds limit (max 1.5%)` };
  const rr = parseFloat(inp.estRR);
  if (!rr||isNaN(rr)||rr<5) return { s:S.FAIL, r:`RR 1:${inp.estRR||"?"} — minimum 1:5 required` };
  if (!inp.ltfConfirm||inp.ltfConfirm==="unclear")
    return { s:S.FORMING, r:`Origin entry, ${stop}p stop, 1:${rr} RR — awaiting LTF confirmation (engulf/M1 CHoCH)` };
  if (!isNaN(risk)&&risk>1.2&&risk<=1.5)
    return { s:S.FORMING, r:`Risk ${risk}% above ideal — entry otherwise valid` };
  const cl = inp.ltfConfirm==="both"?"Engulf + M1 CHoCH ✦✦":
             inp.ltfConfirm==="engulf_candle"?"Engulf candle ✦":
             inp.ltfConfirm==="m1_choch"?"M1 CHoCH ✦":"Confirmed";
  return { s:S.PASS, r:`RIFC valid — origin | ${stop}p | ${!isNaN(risk)?risk+"%":""} | 1:${rr} | ${cl}` };
}

// ─── PIPELINE RUNNER ──────────────────────────────────────────────────
function runPipeline(inp, journal) {
  const results = {};
  let stopped = false;
  for (const step of PIPELINE) {
    if (stopped) { results[step]={ s:S.PENDING, r:"Pipeline stopped at earlier step" }; continue; }
    let res;
    switch(step) {
      case "POI": res=evalPOI(inp); break;
      case "TIME": res=evalTime(inp); break;
      case "LIQ": res=evalLiq(inp); break;
      case "INDUCE": res=evalInduce(inp); break;
      case "DISP": res=evalDisp(inp); break;
      case "FAIL": res=evalFailModel(inp); break;
      case "BOS": res=evalBOS(inp,results.FAIL); break;
      case "RIFC": res=evalRIFC(inp); break;
      default: res={ s:S.FAIL, r:"Unknown step" };
    }
    results[step]=res;
    if (res.s===S.FAIL) stopped=true;
  }
  const allPass=PIPELINE.every(s=>results[s]?.s===S.PASS);
  const anyFail=PIPELINE.some(s=>results[s]?.s===S.FAIL);
  const anyForm=PIPELINE.some(s=>results[s]?.s===S.FORMING);
  let decision, decReason;
  let grade = allPass ? computeAdaptiveGrade(inp, journal) : (anyFail?"REJECTED":"FORMING");

  if (allPass) {
    decision = grade==="B"?"WAIT":"VALID_TRADE";
    decReason = grade==="B"
      ? `${grade} setup — conditions met but borderline. Extra caution`
      : `Valid ${grade} setup — full sequence confirmed. Entry phase active`;
  } else if (anyFail) {
    decision="NO_TRADE"; grade="REJECTED";
    const fs=PIPELINE.find(s=>results[s]?.s===S.FAIL);
    decReason=results[fs]?.r||`${fs} failed`;
  } else if (anyForm) {
    decision="WAIT"; grade="FORMING";
    const fs=PIPELINE.find(s=>results[s]?.s===S.FORMING);
    decReason=results[fs]?.r||`${fs} forming`;
  } else { decision="NO_TRADE"; grade="REJECTED"; decReason="Insufficient input"; }

  return { results, decision, decReason, grade, dynState:getDynState(results,inp),
           tradeAllowed:decision==="VALID_TRADE" };
}

// ═══════════════════════════════════════════════════════════════════════
// ANALYTICS ENGINE
// ═══════════════════════════════════════════════════════════════════════

function computeStats(trades) {
  const cats = { bySetupType:{}, bySession:{}, byTrapClarity:{}, byLtfConfirm:{},
                 byDispQuality:{}, byGrade:{}, byMultiLayer:{} };
  for (const t of trades) {
    const upd = (obj, key) => {
      if (!key && key !== false && key !== 0) return;
      const k = String(key);
      if (!obj[k]) obj[k]={ n:0, wins:0, losses:0, be:0, totalR:0 };
      obj[k].n++;
      if (t.outcome==="Win") obj[k].wins++;
      else if (t.outcome==="Loss") obj[k].losses++;
      else obj[k].be++;
      obj[k].totalR += (parseFloat(t.rAchieved)||0);
    };
    upd(cats.bySetupType, t.setupType);
    upd(cats.bySession, t.session);
    upd(cats.byTrapClarity, t.trapClarity);
    upd(cats.byLtfConfirm, t.ltfConfirm);
    upd(cats.byDispQuality, t.dispQuality);
    upd(cats.byGrade, t.grade);
    upd(cats.byMultiLayer, t.multiLayerTrap ? "Multi-layer" : "Single-layer");
  }
  for (const obj of Object.values(cats)) {
    for (const v of Object.values(obj)) {
      const d = v.wins+v.losses;
      v.winRate = d>0 ? v.wins/d : null;
      v.avgR = v.n>0 ? v.totalR/v.n : null;
    }
  }
  return cats;
}

function detectWeaknesses(stats, MIN_N=3, THRESH=0.45) {
  const flags = [];
  const check = (category, obj, fieldName) => {
    for (const [key, s] of Object.entries(obj)) {
      if (s.n>=MIN_N && s.winRate!==null && s.winRate<THRESH) {
        flags.push({ field:fieldName, value:key, winRate:s.winRate, n:s.n,
          severity: s.winRate<0.3?2:1,
          msg:`${category} "${key}" — ${Math.round(s.winRate*100)}% win rate over ${s.n} trades` });
      }
    }
  };
  check("Session", stats.bySession, "session");
  check("Trap clarity", stats.byTrapClarity, "trapClarity");
  check("LTF confirm", stats.byLtfConfirm, "ltfConfirm");
  check("Displacement", stats.byDispQuality, "dispQuality");
  return flags;
}

function findSimilarTrades(inp, journal, n=3) {
  if (!journal.length) return [];
  return journal
    .map(t => {
      let score = 0;
      if (t.setupType===inp.setupType)       score+=35;
      if (t.session===inp.session)            score+=20;
      const tLiq=Array.isArray(t.liquidityType)?t.liquidityType:[t.liquidityType];
      const iLiq=Array.isArray(inp.liquidityType)?inp.liquidityType:[inp.liquidityType];
      if(tLiq.some(x=>iLiq.includes(x))) score+=15;
      if (t.trapClarity===inp.trapClarity)    score+=15;
      if (t.ltfConfirm===inp.ltfConfirm)      score+=10;
      if (t.dispQuality===inp.dispQuality)    score+=5;
      return { ...t, score };
    })
    .filter(t => t.score>0)
    .sort((a,b)=>b.score-a.score)
    .slice(0,n);
}

function computeAdaptiveGrade(inp, journal) {
  let w = 0;
  const pips = parseFloat(inp.poiSizePips);
  if (isNaN(pips)||pips<6||pips>30) w++;
  if (!["london","ny2"].includes(inp.session)) w++;
  if (inp.trapClarity!=="clear") w+=2;
  else if (!inp.multiLayerTrap) w++;
  if (inp.dispQuality!=="strong") w++;
  const isRev = inp.setupType?.startsWith("reversal");
  if (isRev && !inp.secondLeg) w++;
  if (inp.ltfConfirm==="both") {}
  else if (inp.ltfConfirm==="engulf_candle"||inp.ltfConfirm==="m1_choch") w++;
  else w+=2;
  const rr = parseFloat(inp.estRR);
  if (isNaN(rr)||rr<5) w+=2; else if (rr<7) w++;
  const risk = parseFloat(inp.riskPct);
  if (!isNaN(risk)&&risk>1.2) w++;
  const isCont = inp.setupType?.startsWith("cont");
  if (isCont&&!inp.demandBelow50) w++;

  // Adaptive adjustments from personal history
  if (journal.length>=5) {
    const stats = computeStats(journal);
    // Boost if this setup type has personal high win rate
    const st = stats.bySetupType[inp.setupType];
    if (st&&st.n>=3&&st.winRate!==null&&st.winRate>0.80) w=Math.max(0,w-1);
    // Extra friction if personal weakness detected on this session
    const ss = stats.bySession[inp.session];
    if (ss&&ss.n>=3&&ss.winRate!==null&&ss.winRate<0.40) w+=1;
    // Extra friction if trap clarity FORMING is a personal weakness
    const tc = stats.byTrapClarity[inp.trapClarity];
    if (tc&&tc.n>=3&&tc.winRate!==null&&tc.winRate<0.40) w+=1;
    // Downgrade if no LTF confirm has been consistently bad
    const lc = stats.byLtfConfirm[inp.ltfConfirm];
    if (lc&&lc.n>=3&&lc.winRate!==null&&lc.winRate<0.40) w+=1;
  }

  if (w===0) return "A+";
  if (w<=2)  return "A";
  if (w<=4)  return "B";
  return "REJECTED";
}

// ─── DYNAMIC STATE ────────────────────────────────────────────────────
function getDynState(results, inp) {
  const failStep=PIPELINE.find(s=>results[s]?.s===S.FAIL);
  const formStep=PIPELINE.find(s=>results[s]?.s===S.FORMING);
  const allPass=PIPELINE.every(s=>results[s]?.s===S.PASS);
  const anyEval=PIPELINE.some(s=>results[s]&&results[s].s!==S.PENDING);
  const typeLabel={ reversal_bull:"Bullish Reversal", reversal_bear:"Bearish Reversal",
    cont_bull:"Bullish Continuation", cont_bear:"Bearish Continuation" }[inp.setupType]||"Setup";
  if (!anyEval) return { msg:`${typeLabel} — waiting for input`, next:"Select setup type, then fill all fields", phase:"IDLE" };
  if (failStep) return { msg:`Pipeline stopped at ${failStep} — ${results[failStep]?.r}`, next:null, phase:"BLOCKED" };
  if (formStep) {
    const nm={ POI:"Complete M5 structure", TIME:"Specify valid session window",
      LIQ:"Identify specific liquidity pool", INDUCE:"Confirm trap clarity — who is trapped?",
      DISP:"Confirm FVG and displacement quality", FAIL:"Confirm No HH or No LL",
      BOS:"Wait for BOS/CHoCH after failure",
      RIFC:inp.setupType?.startsWith("cont")?"Confirm demand below 50% + LTF confirmation":"Wait for engulf candle or M1 CHoCH" };
    return { msg:results[formStep]?.r||`${formStep} forming`, next:nm[formStep], phase:"FORMING" };
  }
  if (allPass) {
    const cl=inp.ltfConfirm==="both"?"Engulf + M1 CHoCH":inp.ltfConfirm==="engulf_candle"?"Engulf candle":inp.ltfConfirm==="m1_choch"?"M1 CHoCH":"";
    return { msg:`${typeLabel} — full sequence confirmed. Entry phase active${cl?` (${cl})`:""}`, next:"Execute at RIFC zone. Respect stop and RR", phase:"ACTIVE" };
  }
  return { msg:"Evaluation in progress", next:null, phase:"IDLE" };
}

// ─── DISCIPLINE ───────────────────────────────────────────────────────
function checkDiscipline(disc) {
  if (disc.trades>=2) return { locked:true, reason:"Daily trade limit reached (2/2)" };
  if (disc.pnl>=3) return { locked:true, reason:"+3R stop condition triggered. Close platforms. Journal. Done." };
  if (disc.pnl<=-2) return { locked:false, reason:"⚠️ Significant drawdown — assess conditions" };
  return { locked:false, reason:null };
}

function evalMgmt(inp) {
  const st=inp.mgmtState;
  if (!st||st==="NONE") return { state:"NONE",beOk:false,trailOk:false,partOk:false,comment:"No active trade." };
  if (st==="ENTRY") return { state:"ENTRY",beOk:false,trailOk:false,partOk:false,comment:"Entry phase — do not touch the trade. Highest vulnerability." };
  if (st==="CONFIRMATION") {
    const ok=inp.m1Shift&&inp.intBOS;
    return { state:"CONFIRMATION",beOk:ok,trailOk:ok,partOk:ok,
      comment:ok?"M1 shift + internal BOS confirmed — BE now permitted":"Awaiting M1 shift AND internal BOS" };
  }
  if (st==="CONTINUATION") return { state:"CONTINUATION",beOk:true,trailOk:true,partOk:true,comment:"Protected structure — trailing/partials permitted" };
  return { state:"NONE",beOk:false,trailOk:false,partOk:false,comment:"Unknown state." };
}

// ═══════════════════════════════════════════════════════════════════════
// DECISION TREE DEFINITIONS
// Each step: { id, q, detail, check: inp => 'pass'|'warn'|'fail'|'pending', failOut }
// ═══════════════════════════════════════════════════════════════════════

const makeTrees = () => ({
  reversal_bull: [
    { id:"ctx", q:"Price in DISCOUNT with Bullish HTF bias?",
      detail:"Main push defined. Price positioned in discount to enter long from demand.",
      check:i=>i.htfBias==="bullish"&&i.rangeLoc==="discount"?"pass":i.htfBias||i.rangeLoc?"fail":"pending",
      failOut:"NO TRADE — wrong location for longs" },
    { id:"sess", q:"London Open or valid NY execution window?",
      detail:"Timing is non-negotiable. Inducement expected within first 30 minutes.",
      check:i=>["london","ny2","ny1pm"].includes(i.session)?"pass":i.session?"fail":"pending",
      failOut:"NO TRADE — outside valid execution window" },
    { id:"poi", q:"Clean demand POI with M5 structure (buildup + inducement + push-out)?",
      detail:"POI must show all 3 elements on M5. Size 6–30p valid. RIFC zone nearby.",
      check:i=>{const m5=[i.m5Build,i.m5Ind,i.m5Push].every(Boolean);const p=parseFloat(i.poiSizePips);
        return m5&&p>=6&&p<=30?"pass":i.poiLocation?"warn":"pending"},
      failOut:"WAIT — POI not defined or M5 structure incomplete" },
    { id:"liq", q:"Meaningful liquidity pool identified (EQL, London low, Frankfurt low, trendline)?",
      detail:"Equal lows, London Open Low, Frankfurt Low, and SMC trap zones are highest probability.",
      check:i=>i.liquidityType&&i.liquidityType!=="unclear"?"pass":i.liquidityType==="unclear"?"warn":"pending",
      failOut:"WAIT — identify the specific liquidity pool" },
    { id:"bulltap", q:"Price gave a 'bull tap' first — pre-inducement liquidity grab?",
      detail:"Price brings in longs BEFORE the real inducement. This is the trap setup phase. Describe it.",
      check:i=>{const l=i.trapWho?.trim().length||0;return l>=30?"pass":l>=15?"warn":l>0?"warn":"pending"},
      failOut:"WAIT — describe who was lured in and how (the bull tap mechanism)" },
    { id:"induce", q:"Clear bullish inducement — sweep of lows trapping shorts + early longs?",
      detail:"Bearish displacement happens first (traps early longs). Then price reverses. Trap must be believable.",
      check:i=>i.trapClarity==="clear"?"pass":i.trapClarity==="forming"?"warn":i.trapClarity==="unclear"?"fail":"pending",
      failOut:"NO TRADE — trap not confirmed. Cannot identify who is trapped." },
    { id:"disp", q:"Strong bearish displacement with FVG / imbalance?",
      detail:"Displacement goes BEARISH first (this is part of the trap). Must be impulsive — no slow drift.",
      check:i=>i.dispQuality==="strong"&&i.fvgPresent==="yes"?"pass":
               i.dispQuality==="strong"?"warn":i.dispQuality==="weak"?"fail":"pending",
      failOut:"WAIT — displacement must be strong and impulsive with FVG" },
    { id:"fail", q:"Failure confirmed — No Lower Low after initial bearish leg?",
      detail:"First leg down must form. Then retracement. Price must FAIL to make a new LL. This is the failure model.",
      check:i=>i.failType==="no_ll"&&i.firstLeg?"pass":i.failType==="no_ll"&&!i.firstLeg?"warn":
               i.failType==="unclear"?"warn":i.failType==="neither"?"fail":"pending",
      failOut:"WAIT — failure not confirmed. Price may still be falling." },
    { id:"bos", q:"BOS / CHoCH confirmed to the UPSIDE?",
      detail:"After the failure, structure must shift. This confirms market intent has changed to bullish.",
      check:i=>i.bosStatus==="yes"?"pass":i.bosStatus==="wait"?"warn":i.bosStatus==="no"?"fail":"pending",
      failOut:"WAIT — no structure shift yet. Cannot enter." },
    { id:"ltf", q:"LTF confirmation at RIFC zone — engulf candle or M1 CHoCH?",
      detail:'"Just this candle alone is confirmation." Engulf at RIFC level = valid entry trigger. M1 CHoCH = entry signal.',
      check:i=>["engulf_candle","m1_choch","both"].includes(i.ltfConfirm)?"pass":i.ltfConfirm==="unclear"?"warn":"pending",
      failOut:"FORMING — wait for engulf candle or M1 CHoCH before entry" },
    { id:"rifc", q:"Entry at ORIGIN of BOS move? Stop 1.5–5p? RR ≥ 1:5?",
      detail:"Entry must be at the OB/FVG at the RIFC zone — where the BOS move originated from. No mid-move entries.",
      check:i=>{const s=parseFloat(i.stopPips),r=parseFloat(i.estRR);
        return i.entryAtOrigin==="yes"&&s>=1.5&&s<=5&&r>=5?"pass":i.entryAtOrigin==="no"?"fail":i.entryIdea?"warn":"pending"},
      failOut:"NO TRADE — entry not at origin, or stop/RR invalid" },
  ],

  reversal_bear: [
    { id:"ctx", q:"Price in PREMIUM with Bearish HTF bias?",
      detail:"Main push defined. Price in premium relative to the active dealing range.",
      check:i=>i.htfBias==="bearish"&&i.rangeLoc==="premium"?"pass":i.htfBias||i.rangeLoc?"fail":"pending",
      failOut:"NO TRADE — wrong location for shorts" },
    { id:"sess", q:"London Open or valid NY execution window?",
      detail:"London 08:30–10:00 is optimal. Inducement engineered within first 30 minutes.",
      check:i=>["london","ny2"].includes(i.session)?"pass":i.session?"fail":"pending",
      failOut:"NO TRADE — outside valid execution window" },
    { id:"poi", q:"Clean supply zone with M5 structure?",
      detail:"Supply zone must show M5 buildup + inducement + push-out. RIFC zone nearby.",
      check:i=>{const m5=[i.m5Build,i.m5Ind,i.m5Push].every(Boolean);const p=parseFloat(i.poiSizePips);
        return m5&&p>=6&&p<=30?"pass":i.poiLocation?"warn":"pending"},
      failOut:"WAIT — supply zone not defined or M5 structure incomplete" },
    { id:"liq", q:"Multiple liquidity pools engineered during complex push up?",
      detail:"Asia sellers, London buyers, SMC buyers — all should be trapped in the push up to supply. Multi-layer trap.",
      check:i=>i.liquidityType&&i.liquidityType!=="unclear"&&i.multiLayerTrap?"pass":
               i.liquidityType&&i.liquidityType!=="unclear"?"warn":i.liquidityType==="unclear"?"warn":"pending",
      failOut:"WAIT — identify liquidity pools. Multi-layer trap is key for bearish reversals." },
    { id:"supplytap", q:"Supply zone tapped with violent rejection (sellers in control)?",
      detail:"Price must tap supply and give a strong bearish reaction. Violent rejection = sellers confirmed. Not slow drift.",
      check:i=>i.trapClarity==="clear"?"pass":i.trapClarity==="forming"?"warn":i.trapClarity==="unclear"?"fail":"pending",
      failOut:"WAIT — supply tap not confirmed with violence" },
    { id:"disp", q:"Bearish displacement with FVG after supply tap?",
      detail:"Impulsive bearish move after the supply tap. Must leave FVG/imbalance. Shows structural intent.",
      check:i=>i.dispQuality==="strong"&&i.fvgPresent==="yes"?"pass":
               i.dispQuality==="strong"?"warn":i.dispQuality==="weak"?"fail":"pending",
      failOut:"WAIT — displacement weak or no FVG" },
    { id:"fail", q:"First leg formed + failure confirmed — No Higher High?",
      detail:"First leg down → retracement → price fails to make new HH. 'Failed swing high' = failure confirmation.",
      check:i=>i.failType==="no_hh"&&i.firstLeg?"pass":i.failType==="no_hh"&&!i.firstLeg?"warn":
               i.failType==="unclear"?"warn":i.failType==="neither"?"fail":"pending",
      failOut:"WAIT — no HH failure confirmed. May still be retracing." },
    { id:"bos", q:"BOS / CHoCH confirmed to the DOWNSIDE?",
      detail:"After failure, structure must break lower. Internal BOS confirms bearish intent.",
      check:i=>i.bosStatus==="yes"?"pass":i.bosStatus==="wait"?"warn":i.bosStatus==="no"?"fail":"pending",
      failOut:"WAIT — no structure shift confirmed" },
    { id:"leg2", q:"Second leg forming back to supply? (Optional — adds grade)",
      detail:"Price respects first leg → second leg to supply. 'Debatable second leg' model. Adds A+ potential.",
      check:i=>i.secondLeg?"pass":i.bosStatus==="yes"?"warn":"pending",
      failOut:"FORMING — no second leg yet (can still enter at BOS origin)" },
    { id:"ltf", q:"LTF confirmation — engulf candle or M1 CHoCH at supply/RIFC?",
      detail:"M1 CHoCH or engulf at supply zone confirms entry. Both = highest conviction.",
      check:i=>["engulf_candle","m1_choch","both"].includes(i.ltfConfirm)?"pass":i.ltfConfirm==="unclear"?"warn":"pending",
      failOut:"FORMING — wait for engulf candle or M1 CHoCH" },
    { id:"rifc", q:"Entry at ORIGIN of BOS move? Stop 1.5–5p? RR ≥ 1:5?",
      detail:"At OB/FVG at origin of BOS move. Tight stop beyond sweep. Minimum 1:5 RR.",
      check:i=>{const s=parseFloat(i.stopPips),r=parseFloat(i.estRR);
        return i.entryAtOrigin==="yes"&&s>=1.5&&s<=5&&r>=5?"pass":i.entryAtOrigin==="no"?"fail":i.entryIdea?"warn":"pending"},
      failOut:"NO TRADE — entry location or risk invalid" },
  ],

  cont_bull: [
    { id:"ctx", q:"Price in DISCOUNT with Bullish HTF bias? Internal BOS already created?",
      detail:"Continuation requires an existing structural shift. The push has already occurred and price is retracing into discount.",
      check:i=>i.htfBias==="bullish"&&i.rangeLoc==="discount"?"pass":i.htfBias||i.rangeLoc?"fail":"pending",
      failOut:"NO TRADE — wrong location or bias for bullish continuation" },
    { id:"sess", q:"London Open, London Lunch (12:30–14:00), or NY 1PM window?",
      detail:"Continuation setups often trigger at London Lunch or NY 1PM. These are valid expansion windows.",
      check:i=>["london","ny2","london_lunch","ny1pm"].includes(i.session)?"pass":i.session?"fail":"pending",
      failOut:"NO TRADE — outside valid continuation window" },
    { id:"poi", q:"Valid demand zone below 50% of the push (in discount)?",
      detail:"CRITICAL: Demand must be BELOW 50% of the push. Discount zone only. Above 50% = premium = not valid for longs.",
      check:i=>{const m5=[i.m5Build,i.m5Ind,i.m5Push].every(Boolean);
        return m5&&i.demandBelow50?"pass":i.poiLocation&&!i.demandBelow50?"fail":i.poiLocation?"warn":"pending"},
      failOut:"NO TRADE — demand not below 50% of push. Location invalid for continuation." },
    { id:"liq", q:"SMC traps taken above the entry zone (weak demand/supply swept)?",
      detail:"Before continuation, SMC traps above should be taken. This confirms distribution is done and momentum is ready.",
      check:i=>i.liquidityType&&i.liquidityType!=="unclear"?"pass":i.liquidityType==="unclear"?"warn":"pending",
      failOut:"WAIT — identify liquidity sweeps above entry" },
    { id:"induce", q:"Clear inducement at the demand zone — who was induced?",
      detail:"Buyers trapped at wrong levels, sellers lured into early shorts that get stopped. Demand must trap someone.",
      check:i=>i.trapClarity==="clear"?"pass":i.trapClarity==="forming"?"warn":i.trapClarity==="unclear"?"fail":"pending",
      failOut:"WAIT — inducement at demand not confirmed" },
    { id:"disp", q:"Strong bullish displacement from demand with FVG?",
      detail:"Displacement from the demand zone must be impulsive. FVG left = structural intent confirmed.",
      check:i=>i.dispQuality==="strong"&&i.fvgPresent==="yes"?"pass":
               i.dispQuality==="strong"?"warn":i.dispQuality==="weak"?"fail":"pending",
      failOut:"WAIT — displacement weak or no FVG at demand" },
    { id:"fail", q:"No Lower Low confirmed — failure of bearish continuation?",
      detail:"During retracement to demand, price must fail to make a new LL. This is the failure model for continuation.",
      check:i=>i.failType==="no_ll"&&i.firstLeg?"pass":i.failType==="no_ll"?"warn":
               i.failType==="unclear"?"warn":i.failType==="neither"?"fail":"pending",
      failOut:"WAIT — no failure of LL. Price may still be retracing." },
    { id:"bos", q:"Internal BOS confirming bullish continuation?",
      detail:"After failure at demand, internal BOS confirms the continuation direction. This unlocks the expansion phase.",
      check:i=>i.bosStatus==="yes"?"pass":i.bosStatus==="wait"?"warn":i.bosStatus==="no"?"fail":"pending",
      failOut:"WAIT — internal BOS not confirmed" },
    { id:"ltf", q:"LTF confirmation — engulf candle or M1 CHoCH at demand?",
      detail:"Engulf candle at demand zone or M1 CHoCH = entry confirmation. Required for full confidence.",
      check:i=>["engulf_candle","m1_choch","both"].includes(i.ltfConfirm)?"pass":i.ltfConfirm==="unclear"?"warn":"pending",
      failOut:"FORMING — awaiting LTF confirmation at demand zone" },
    { id:"rifc", q:"Entry at RIFC origin? Demand below 50%? Stop 1.5–5p? RR ≥ 1:5?",
      detail:"Entry at OB/FVG at origin. Demand must be in discount (below 50%). 1:5+ RR with tight stop.",
      check:i=>{const s=parseFloat(i.stopPips),r=parseFloat(i.estRR);
        return i.entryAtOrigin==="yes"&&i.demandBelow50&&s>=1.5&&s<=5&&r>=5?"pass":
               i.entryAtOrigin==="no"||!i.demandBelow50?"fail":i.entryIdea?"warn":"pending"},
      failOut:"NO TRADE — demand above 50%, entry off origin, or R/R invalid" },
  ],

  cont_bear: [
    { id:"ctx", q:"Price in PREMIUM with Bearish HTF bias? Internal BOS already created?",
      detail:"Continuation requires structural shift already in place. Price retracing into premium supply.",
      check:i=>i.htfBias==="bearish"&&i.rangeLoc==="premium"?"pass":i.htfBias||i.rangeLoc?"fail":"pending",
      failOut:"NO TRADE — wrong location for bearish continuation" },
    { id:"sess", q:"London Open, London Lunch, or NY 1PM window?",
      detail:"Valid continuation windows. Displacement + mitigation to supply should form here.",
      check:i=>["london","ny2","london_lunch","ny1pm"].includes(i.session)?"pass":i.session?"fail":"pending",
      failOut:"NO TRADE — outside valid window" },
    { id:"poi", q:"Valid supply zone ABOVE 50% of the push (in premium)?",
      detail:"CRITICAL: Supply must be ABOVE 50% of push. Premium zone only. Below 50% = discount = not valid for shorts.",
      check:i=>{const m5=[i.m5Build,i.m5Ind,i.m5Push].every(Boolean);
        return m5&&i.demandBelow50?"pass":i.poiLocation&&!i.demandBelow50?"fail":i.poiLocation?"warn":"pending"},
      failOut:"NO TRADE — supply not above 50% of push. Location invalid." },
    { id:"liq", q:"SMC traps taken below entry zone?",
      detail:"Lows swept below, weak demands run. Confirms distribution and bearish momentum.",
      check:i=>i.liquidityType&&i.liquidityType!=="unclear"?"pass":i.liquidityType==="unclear"?"warn":"pending",
      failOut:"WAIT — identify liquidity below entry" },
    { id:"induce", q:"Clear inducement at supply zone?",
      detail:"Sellers trapped at wrong levels or buyers induced into supply. Trap must be believable.",
      check:i=>i.trapClarity==="clear"?"pass":i.trapClarity==="forming"?"warn":i.trapClarity==="unclear"?"fail":"pending",
      failOut:"WAIT — inducement not confirmed at supply" },
    { id:"disp", q:"Strong bearish displacement from supply with FVG?",
      detail:"Impulsive move from supply with FVG left behind. No slow drift.",
      check:i=>i.dispQuality==="strong"&&i.fvgPresent==="yes"?"pass":
               i.dispQuality==="strong"?"warn":i.dispQuality==="weak"?"fail":"pending",
      failOut:"WAIT — displacement weak or no FVG" },
    { id:"fail", q:"No Higher High confirmed — failure of bullish continuation?",
      detail:"During retracement to supply, price fails to make new HH. Failure model for bearish continuation.",
      check:i=>i.failType==="no_hh"&&i.firstLeg?"pass":i.failType==="no_hh"?"warn":
               i.failType==="unclear"?"warn":i.failType==="neither"?"fail":"pending",
      failOut:"WAIT — no HH failure. Price may still be retracing up." },
    { id:"bos", q:"Internal BOS confirming bearish continuation?",
      detail:"After HH failure at supply, internal BOS downward confirms continuation direction.",
      check:i=>i.bosStatus==="yes"?"pass":i.bosStatus==="wait"?"warn":i.bosStatus==="no"?"fail":"pending",
      failOut:"WAIT — internal BOS not confirmed" },
    { id:"ltf", q:"LTF confirmation — engulf candle or M1 CHoCH at supply?",
      detail:"Bearish engulf or M1 bearish CHoCH at supply zone = entry confirmation.",
      check:i=>["engulf_candle","m1_choch","both"].includes(i.ltfConfirm)?"pass":i.ltfConfirm==="unclear"?"warn":"pending",
      failOut:"FORMING — await LTF confirmation" },
    { id:"rifc", q:"Entry at RIFC origin? Supply above 50%? Stop 1.5–5p? RR ≥ 1:5?",
      detail:"At OB/FVG origin. Supply in premium (above 50%). Tight stop. Minimum 1:5 RR.",
      check:i=>{const s=parseFloat(i.stopPips),r=parseFloat(i.estRR);
        return i.entryAtOrigin==="yes"&&i.demandBelow50&&s>=1.5&&s<=5&&r>=5?"pass":
               i.entryAtOrigin==="no"||!i.demandBelow50?"fail":i.entryIdea?"warn":"pending"},
      failOut:"NO TRADE — entry/location/risk invalid" },
  ],
});

const TREES = makeTrees();

// ═══════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════

const SB = ({s}) => s===S.PASS?<span>✅</span>:s===S.FORMING?<span>⚠️</span>:s===S.FAIL?<span>❌</span>:<span className="text-gray-700">○</span>;
const FL = ({children}) => <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">{children}</label>;
const SH = ({children}) => <div className="text-xs text-gray-600 uppercase tracking-widest border-b border-gray-800 pb-1.5 mb-3">{children}</div>;
const Panel = ({children,className=""}) => <div className={`bg-gray-950 border border-gray-800 rounded-sm p-4 ${className}`}>{children}</div>;

const Sel = ({value,onChange,options,placeholder}) => (
  <select value={value} onChange={e=>onChange(e.target.value)}
    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none focus:border-gray-600 appearance-none cursor-pointer">
    {placeholder&&<option value="">{placeholder}</option>}
    {options.map(([v,l])=><option key={v} value={v}>{l}</option>)}
  </select>
);

const Inp = ({value,onChange,placeholder,type="text"}) => (
  <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none focus:border-gray-600 placeholder-gray-700"/>
);

const Chk = ({checked,onChange,label}) => (
  <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-400 select-none">
    <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} className="w-3.5 h-3.5 accent-green-500 cursor-pointer"/>
    <span>{label}</span>
  </label>
);

const MultiSel = ({value=[],onChange,options}) => (
  <div className="space-y-1 bg-gray-900 border border-gray-700 rounded p-2">
    {options.map(([v,l])=>(
      <label key={v} className="flex items-center gap-2 cursor-pointer text-xs select-none">
        <input type="checkbox" checked={value.includes(v)}
          onChange={e=>{ if(e.target.checked) onChange([...value,v]); else onChange(value.filter(x=>x!==v)); }}
          className="w-3.5 h-3.5 accent-green-500 cursor-pointer"/>
        <span className={value.includes(v)?"text-green-400":"text-gray-400"}>{l}</span>
      </label>
    ))}
  </div>
);

const MTag = ({label,ok}) => (
  <div className={`flex-1 py-2 rounded text-center text-xs border ${ok?"border-green-800 text-green-400 bg-green-950/30":"border-gray-800 text-gray-700 bg-gray-900/30"}`}>
    <div>{ok?"✅":"❌"}</div><div className="uppercase tracking-wider mt-0.5">{label}</div>
  </div>
);

// ─── INFOTIP — ⓘ icon with CSS-only hover tooltip (desktop only) ──────
const InfoTip = ({ content, position = "right" }) => {
  if (!content) return null;
  const posClass = position === "left"
    ? "right-full mr-2 top-0"
    : "left-full ml-2 top-0";
  return (
    <span className="relative group inline-flex items-center cursor-default ml-1 flex-shrink-0">
      <span className="text-gray-700 hover:text-gray-400 text-xs leading-none select-none">ⓘ</span>
      <span className={`pointer-events-none invisible group-hover:visible absolute ${posClass} z-50 w-64 bg-gray-900 border border-gray-700 text-gray-300 text-xs rounded p-2.5 shadow-2xl leading-relaxed whitespace-normal`}>
        {content}
      </span>
    </span>
  );
};

// ─── COMPACT MULTI-SELECT — tags field + collapsible dropdown ──────────
const CompactMultiSel = ({ value = [], onChange, options }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = (v) => {
    if (value.includes(v)) onChange(value.filter(x => x !== v));
    else onChange([...value, v]);
  };

  const labelMap = Object.fromEntries(options.map(([v, l]) => [v, l]));
  const selected = value.filter(v => labelMap[v]);

  return (
    <div className="relative" ref={ref}>
      {/* Field display */}
      <div
        onClick={() => setOpen(o => !o)}
        className="min-h-[2rem] w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 flex flex-wrap gap-1 items-center cursor-pointer hover:border-gray-600"
      >
        {selected.length === 0 && (
          <span className="text-gray-600 text-xs">— Select pools —</span>
        )}
        {selected.map(v => (
          <span key={v} className="inline-flex items-center gap-1 bg-gray-800 border border-gray-700 text-green-400 text-xs rounded px-1.5 py-0.5">
            {labelMap[v]}
            <button
              onClick={e => { e.stopPropagation(); toggle(v); }}
              className="text-gray-500 hover:text-red-400 leading-none cursor-pointer ml-0.5"
            >×</button>
          </span>
        ))}
        <span className="ml-auto text-gray-700 text-xs pl-1">{open ? "▲" : "▼"}</span>
      </div>
      {/* Dropdown */}
      {open && (
        <div className="absolute z-40 w-full mt-1 bg-gray-900 border border-gray-700 rounded shadow-xl max-h-56 overflow-y-auto">
          {options.map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-gray-800 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={value.includes(v)}
                onChange={() => toggle(v)}
                className="w-3.5 h-3.5 accent-green-500 cursor-pointer flex-shrink-0"
              />
              <span className={`text-xs ${value.includes(v) ? "text-green-400" : "text-gray-400"}`}>{l}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// TAB: EVALUATE (left = inputs, right = pipeline + decision + extras)
// ═══════════════════════════════════════════════════════════════════════

function EvaluateTab({ inp, set, ev, disc, discEval, mgmt, addTrade, journal }) {
  const isCont = inp.setupType?.startsWith("cont");
  const isRev  = inp.setupType?.startsWith("reversal");
  const [showSave, setShowSave] = useState(false);
  const [saveForm, setSaveForm] = useState({ outcome:"win", rAchieved:"", notes:"", images:[], whyNotTaken:"" });

  // ── Precision-validation gating ─────────────────────────────────────
  // Fields 1–5 are mandatory whenever visible.
  // Field 6 (DXY Structure Detail) is mandatory for EURUSD / GBPUSD.
  // Field 7 (Why Not Taken) is mandatory when outcome = Valid -- Not Taken.
  const missingRequired = useMemo(() => {
    const miss = [];
    const pipSize = parseFloat(inp.rifcPipSize);
    if (inp.rifcPipSize === "" || isNaN(pipSize))       miss.push("RIFC Pip Size");
    else if (pipSize < 0.1 || pipSize > 5.0)            miss.push("RIFC Pip Size (must be 0.1–5.0)");
    if (!inp.rifcTimeframe)                             miss.push("RIFC Timeframe");
    else if (!["M1","M2","M3","M5"].includes(inp.rifcTimeframe))
                                                        miss.push("RIFC Timeframe (M1–M5 only)");
    if (inp.eqlSweepDistance === "" || isNaN(parseFloat(inp.eqlSweepDistance)))
                                                        miss.push("EQL Sweep Distance");
    if (inp.eqhSweepDistance === "" || isNaN(parseFloat(inp.eqhSweepDistance)))
                                                        miss.push("EQH Sweep Distance");
    if (inp.opposingZoneExists && !inp.opposingZoneStatus)
                                                        miss.push("Opposing Zone Status");
    if (DXY_REQUIRED_PAIRS.includes((inp.pair||"").toUpperCase()) && !inp.dxyStructureDetail?.trim())
                                                        miss.push("DXY Structure Detail");
    if (saveForm.outcome === "valid_not_taken" && !saveForm.whyNotTaken?.trim())
                                                        miss.push("Why Not Taken");
    return miss;
  }, [inp, saveForm.outcome, saveForm.whyNotTaken]);
  const [lightbox, setLightbox] = useState(null);
  const [evalLogging, setEvalLogging] = useState(false);
  const [evalLogged,  setEvalLogged]  = useState(false);

  const insertEvaluation = async () => {
    setEvalLogging(true);
    setEvalLogged(false);
    const failedStep = ["POI","TIME","LIQ","INDUCE","DISP","FAIL","BOS","RIFC"].find(s => ev.results[s]?.s === S.FAIL) || null;
    const tradeDate  = inp.backtestMode && inp.backtestDate
      ? inp.backtestDate
      : new Date().toISOString().split('T')[0];
    const { error } = await supabase.from("evaluations").insert({
      evaluation_result: "NO TRADE",
      failed_at:         failedStep,
      pair:              inp.pair        || null,
      direction:         inp.direction   || null,
      model:             inp.setupType   || null,
      setup_type:        inp.setupType   || null,
      session:           inp.session     || null,
      htf_bias:          inp.htfBias     || null,
      grade:             ev.grade        || null,
      reason:            ev.decReason    || null,
      trade_date:        tradeDate,
      evaluated_at:      new Date().toISOString(),
      // ── Precision-validation fields (human-readable labels) ──
      rifc_pip_size:        (inp.rifcPipSize === "" || inp.rifcPipSize == null)
                              ? null : parseFloat(inp.rifcPipSize),
      rifc_timeframe:       RIFC_TF_LABELS[inp.rifcTimeframe] || inp.rifcTimeframe || null,
      eql_sweep_distance:   (inp.eqlSweepDistance === "" || inp.eqlSweepDistance == null)
                              ? null : parseFloat(inp.eqlSweepDistance),
      eqh_sweep_distance:   (inp.eqhSweepDistance === "" || inp.eqhSweepDistance == null)
                              ? null : parseFloat(inp.eqhSweepDistance),
      opposing_zone_status: inp.opposingZoneExists
                              ? (OPPOSING_ZONE_LABELS[inp.opposingZoneStatus] || inp.opposingZoneStatus || null)
                              : null,
      dxy_structure_detail: (inp.dxyStructureDetail || '').trim() || null,
    });
    setEvalLogging(false);
    if (!error) setEvalLogged(true);
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files).slice(0,2);
    files.forEach(file=>{
      const reader = new FileReader();
      reader.onload = (ev) => setSaveForm(p=>({ ...p, images:[...p.images, ev.target.result].slice(0,2) }));
      reader.readAsDataURL(file);
    });
  };

  const similar  = useMemo(()=>findSimilarTrades(inp,journal,3),[inp,journal]);
  const stats    = useMemo(()=>computeStats(journal),[journal]);
  const weaknesses = useMemo(()=>journal.length>=5?detectWeaknesses(stats):[],[stats,journal]);
  const activeWeaknesses = weaknesses.filter(w=>inp[w.field]===w.value||inp[w.field]===String(w.value));

  const dc={VALID_TRADE:{ring:"border-green-700",bg:"bg-green-950/20",text:"text-green-400",label:"🟢 VALID TRADE"},
            WAIT:{ring:"border-yellow-700",bg:"bg-yellow-950/20",text:"text-yellow-400",label:"🟡 WAIT"},
            NO_TRADE:{ring:"border-red-800",bg:"bg-red-950/20",text:"text-red-400",label:"🔴 NO TRADE"}};
  const d=dc[ev.decision]||dc.NO_TRADE;
  const pc={ACTIVE:{bg:"bg-green-950/20 border-green-800",text:"text-green-400"},
            FORMING:{bg:"bg-yellow-950/20 border-yellow-800",text:"text-yellow-400"},
            BLOCKED:{bg:"bg-red-950/20 border-red-800",text:"text-red-400"},
            IDLE:{bg:"bg-gray-950 border-gray-800",text:"text-gray-500"}}[ev.dynState.phase]||{bg:"bg-gray-950 border-gray-800",text:"text-gray-500"};
  const gc={"A+":"text-green-300","A":"text-green-500","B":"text-yellow-400","FORMING":"text-yellow-600","REJECTED":"text-red-500"};

  return (
    <div className="flex gap-3">
      {/* ── INPUTS ── */}
      <div className="w-72 flex-shrink-0 space-y-3">
        <Panel>
          <SH>Setup Classification</SH>
          <div className="space-y-2.5">
            <div><FL>Setup Type</FL>
              <Sel value={inp.setupType} onChange={v=>set("setupType",v)} placeholder="— Select Setup Type —"
                options={[["reversal_bull","Bullish Reversal"],["reversal_bear","Bearish Reversal"],["cont_bull","Bullish Continuation"],["cont_bear","Bearish Continuation"]]}/>
            </div>
            {inp.setupType==="reversal_bull"&&<div className="text-xs text-green-800 bg-green-950/30 border border-green-900 rounded px-2 py-1.5 leading-relaxed">Build up → bull tap → inducement → bearish disp → No LL → BOS → engulf/CHoCH</div>}
            {inp.setupType==="reversal_bear"&&<div className="text-xs text-red-900 bg-red-950/30 border border-red-900 rounded px-2 py-1.5 leading-relaxed">Complex push → supply tap → violent rejection → No HH → BOS → RIFC</div>}
            {inp.setupType==="cont_bull"&&<div className="text-xs text-blue-900 bg-blue-950/30 border border-blue-900 rounded px-2 py-1.5 leading-relaxed">Displacement → demand BELOW 50% → SMC traps above → BOS → expansion</div>}
            {inp.setupType==="cont_bear"&&<div className="text-xs text-orange-900 bg-orange-950/30 border border-orange-900 rounded px-2 py-1.5 leading-relaxed">Displacement → supply ABOVE 50% → SMC traps below → BOS → expansion</div>}
            <div><FL>Direction</FL>
              <Sel value={inp.direction} onChange={v=>set("direction",v)} placeholder="— Long / Short —"
                options={[["Long","↑ Long"],["Short","↓ Short"]]}/>
            </div>
            <div><FL>Pair</FL><Inp value={inp.pair} onChange={v=>set("pair",v)} placeholder="EURUSD"/></div>
          </div>
        </Panel>

        <Panel>
          <SH>Context</SH>
          <div className="space-y-2.5">
            <div><FL>Session</FL>
              <Sel value={inp.session} onChange={v=>set("session",v)} placeholder="— Session —"
                options={[["frankfurt","Frankfurt Open (07:00–08:00 / 08:00–09:00 BST)"],["london","London Open (08:30–10:00 / 08:30–10:00 BST)"],["ny2","NY Second Hour (10:00–11:00 NY / 15:00–16:00 BST)"],["london_lunch","London Lunch (12:30–14:00 / 12:30–14:00 BST)"],["ny1pm","NY After Lunch (13:00–14:00 NY / 18:00–19:00 BST)"],["outside","Outside Valid Window — No Trade"]]}/>
              <div className="mt-2 bg-gray-900 border border-gray-800 rounded px-2.5 py-2 space-y-1">
                {[
                  { color:"text-yellow-400", name:"Frankfurt Open", time:"07:00–08:00 BST", desc:"Early liquidity grab. Frankfurt sets a high or low that London frequently sweeps. Good for engineered traps." },
                  { color:"text-green-400",  name:"London Open",    time:"08:30–10:00 BST", desc:"Highest probability window. The main institutional session. Most inducement and reversal setups happen here. Prime time." },
                  { color:"text-blue-400",   name:"NY Second Hour", time:"15:00–16:00 BST", desc:"After the NY open noise settles. Second hour often delivers the true directional move. Strong for continuations." },
                  { color:"text-gray-300",   name:"London Lunch",   time:"12:30–14:00 BST", desc:"Lower liquidity, slower price action. Continuation setups can work but treat with caution — less institutional involvement." },
                  { color:"text-orange-400", name:"NY After Lunch", time:"18:00–19:00 BST", desc:"Post-lunch NY expansion window. Price often resumes the daily direction after the lunch lull. Valid for continuation setups." },
                  { color:"text-red-500",    name:"Outside Window", time:"No valid session",  desc:"You are not in any valid session. DO NOT TRADE. This is not a discretionary decision — outside these windows the model does not apply." },
                ].map(s=>(
                  <div key={s.name} className="flex items-center gap-1 text-xs">
                    <span className={`font-bold ${s.color} flex-shrink-0`}>{s.name}</span>
                    <span className="text-gray-700">—</span>
                    <span className="text-gray-600">{s.time}</span>
                    <InfoTip content={s.desc} />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              <button onClick={()=>set("backtestMode",!inp.backtestMode)}
                className={`text-xs px-3 py-1 rounded border cursor-pointer ${inp.backtestMode?"bg-yellow-950 border-yellow-700 text-yellow-400":"bg-gray-900 border-gray-700 text-gray-500"}`}>
                {inp.backtestMode?"● BACKTESTING MODE":"○ Backtesting Mode"}
              </button>
              {inp.backtestMode&&<span className="text-yellow-600 text-xs">Date will be saved to journal</span>}
            </div>
            {inp.backtestMode&&(
              <div><FL>Backtest Date</FL>
                <Inp type="date" value={inp.backtestDate} onChange={v=>set("backtestDate",v)} placeholder=""/>
              </div>
            )}
            <div><FL>HTF Bias (H1)</FL>
              <Sel value={inp.htfBias} onChange={v=>set("htfBias",v)} placeholder="— Bias —"
                options={[["bullish","Bullish"],["bearish","Bearish"],["unclear","Unclear / Ranging"]]}/>
            </div>
            <div><FL>Price Location in Range</FL>
              <Sel value={inp.rangeLoc} onChange={v=>set("rangeLoc",v)} placeholder="— Location —"
                options={[["premium","Premium"],["equilibrium","Equilibrium"],["discount","Discount"],["unclear","Unclear"]]}/>
            </div>
          </div>
        </Panel>

        <Panel>
          <SH>Point of Interest</SH>
          <div className="space-y-2.5">
            <div><FL>POI Type</FL>
              <Sel value={inp.poiType} onChange={v=>set("poiType",v)} placeholder=""
                options={[["htf","HTF POI (6–30p)"],["ltf","LTF POI (4–10p)"]]}/>
            </div>
            <div><FL>POI Description</FL><Inp value={inp.poiLocation} onChange={v=>set("poiLocation",v)} placeholder="e.g. 1.0850 demand / RIFC"/></div>
            <div><FL>POI Size (pips)</FL><Inp type="number" value={inp.poiSizePips} onChange={v=>set("poiSizePips",v)} placeholder={inp.poiType==="htf"?"6–30":inp.poiType==="ltf"?"4–10":"size in pips"}/></div>
            <div><FL>M5 Internal Structure</FL>
              <div className="space-y-1 mt-1">
                <Chk checked={inp.m5Build} onChange={v=>set("m5Build",v)} label="Buildup"/>
                <Chk checked={inp.m5Ind}   onChange={v=>set("m5Ind",v)}   label="Inducement"/>
                <Chk checked={inp.m5Push}  onChange={v=>set("m5Push",v)}  label="Push-out"/>
              </div>
            </div>
          </div>
        </Panel>

        <Panel>
          <div className="flex items-center mb-3 border-b border-gray-800 pb-1.5">
            <span className="text-xs text-gray-600 uppercase tracking-widest">Liquidity</span>
            <InfoTip position="right" content={
              <span>
                <span className="text-green-400 font-bold">Equal Highs/Lows:</span> Stops above/below matched levels — classic engineered target.<br/>
                <span className="text-yellow-400 font-bold">Session High/Low:</span> Price sweeps Frankfurt or London session extremes before continuing.<br/>
                <span className="text-blue-400 font-bold">HOPD/HOPW:</span> Stops from previous day/week traders sitting above key levels.<br/>
                <span className="text-purple-400 font-bold">Trendline:</span> Stops clustered along a retail trendline — price grabs them before reversing.<br/>
                <span className="text-gray-300 font-bold">Internal:</span> FVGs/imbalances within range — stepping stone or partial target.<br/>
                <span className="text-cyan-400 font-bold">Swing H&L:</span> Prior swing stops swept before expansion.<br/>
                <span className="text-orange-400 font-bold">Frankfurt/London High/Low ✦:</span> High-probability session levels frequently swept by the next session.<br/>
                <span className="text-red-400 font-bold">SMC Trap Zone ✦:</span> Weak retail demand/supply areas — price runs them to trap SMC traders.<br/>
                <span className="text-gray-500 font-bold">Unclear:</span> Flag and return — do not force a label.
              </span>
            }/>
          </div>
          <div className="mb-1">
            <FL>Pool Type — select all that apply</FL>
          </div>
          <CompactMultiSel value={inp.liquidityType} onChange={v=>set("liquidityType",v)}
            options={[["eq_high","Equal Highs"],["eq_low","Equal Lows"],["sess_high","Session High"],["sess_low","Session Low"],["hopd","HOPD"],["hopw","HOPW"],["trendline","Trendline Liquidity"],["internal","Internal Liquidity"],["swing_hl","Swing Highs & Lows"],["frankfurt_h","Frankfurt High ✦"],["frankfurt_l","Frankfurt Low ✦"],["london_h","London Open High ✦"],["london_l","London Open Low ✦"],["smc_trap","SMC Trap Zone ✦"],["unclear","Unclear"]]}/>
          {Array.isArray(inp.liquidityType)&&inp.liquidityType.filter(v=>v!=="unclear").length>1&&(
            <div className="mt-1.5 text-xs text-green-500">✦ Multi-layer trap detected — stronger setup</div>
          )}
        </Panel>

        <Panel>
          <SH>Inducement (Trap)</SH>
          <div className="space-y-2.5">
            <div><FL>Who is Trapped? — Explain the Story</FL>
              <textarea value={inp.trapWho} onChange={e=>set("trapWho",e.target.value)}
                placeholder={isRev?"e.g. Early longs above equal highs trapped — believed breakout was real. Asia buyers and London sellers also lured in...":"e.g. SMC buyers trapped at weak demand — price uses it as liquidity run..."}
                rows={3} className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none placeholder-gray-700 resize-none"/>
            </div>
            <div>
              <div className="flex items-center mb-1">
                <FL>Trap Clarity</FL>
                <InfoTip content={
                  <span>
                    <span className="text-green-400 font-bold">Clear — Confirmed:</span> You can see exactly who got trapped, how, and why. The story is complete and believable. This is the only state where you can proceed.<br/><br/>
                    <span className="text-yellow-400 font-bold">Forming — Wait:</span> Trap is developing but not yet complete. Wait for full inducement to play out.<br/><br/>
                    <span className="text-red-400 font-bold">Unclear — Cannot Confirm:</span> Cannot identify who is trapped or why. Do not force a read — NO TRADE.
                  </span>
                }/>
              </div>
              <Sel value={inp.trapClarity} onChange={v=>set("trapClarity",v)} placeholder="— Assess Trap —"
                options={[["clear","Clear — Confirmed"],["forming","Forming — Wait"],["unclear","Unclear — Cannot Confirm"]]}/>
            </div>
            <Chk checked={inp.multiLayerTrap} onChange={v=>set("multiLayerTrap",v)} label="Multi-layer trap — multiple participant groups ✦"/>
          </div>
        </Panel>

        <Panel>
          <SH>Displacement</SH>
          <div className="space-y-2.5">
            <div>
              <div className="flex items-center mb-1">
                <FL>Quality</FL>
                <InfoTip content={
                  <span>
                    <span className="text-green-400 font-bold">Strong + Impulsive:</span> Fast, decisive, one-directional. Multiple large candles, no hesitation. Required for a valid setup.<br/><br/>
                    <span className="text-yellow-400 font-bold">Moderate:</span> Some direction but not convincing. Needs FVG confirmation before proceeding.<br/><br/>
                    <span className="text-red-400 font-bold">Weak / Drift:</span> No momentum, overlapping candles. No institutional footprint — NO TRADE.<br/><br/>
                    <span className="text-gray-400 font-bold">Unclear:</span> Wait for the move to develop further.
                  </span>
                }/>
              </div>
              <Sel value={inp.dispQuality} onChange={v=>set("dispQuality",v)} placeholder="— Assess Impulse —"
                options={[["strong","Strong + Impulsive"],["moderate","Moderate"],["weak","Weak / Drift"],["unclear","Unclear"]]}/>
            </div>
            <div>
              <div className="flex items-center mb-1">
                <FL>FVG / Imbalance?</FL>
                <InfoTip content={
                  <span>
                    <span className="text-green-400 font-bold">Yes — Confirmed:</span> A Fair Value Gap is clearly visible — 3-candle pattern leaving a gap between candle 1's wick and candle 3's wick. Confirms institutional intent.<br/><br/>
                    <span className="text-red-400 font-bold">No — Not Present:</span> Candles fully overlapping. Displacement lacks structural evidence — NO TRADE.<br/><br/>
                    <span className="text-gray-400 font-bold">Unclear:</span> Zoom in and look for the three-candle gap. If still unsure, wait.
                  </span>
                }/>
              </div>
              <Sel value={inp.fvgPresent} onChange={v=>set("fvgPresent",v)} placeholder="— FVG Status —"
                options={[["yes","Yes — Confirmed"],["no","No — Not Present"],["unclear","Unclear"]]}/>
            </div>
          </div>
        </Panel>

        <Panel>
          <SH>Failure Model + BOS</SH>
          <div className="space-y-2.5">
            <div>
              <div className="flex items-center mb-1">
                <FL>Failure Type</FL>
                <InfoTip content={
                  <span>
                    <span className="text-red-400 font-bold">No HH:</span> Price pushed up, retraced, failed to make a new higher high. Bearish failure — used for shorts.<br/><br/>
                    <span className="text-green-400 font-bold">No LL:</span> Price pushed down, retraced, failed to make a new lower low. Bullish failure — used for longs.<br/><br/>
                    <span className="text-yellow-400 font-bold">Forming:</span> Move developing. Wait for retracement to complete and failure to confirm.<br/><br/>
                    <span className="text-gray-400 font-bold">Neither:</span> Price still in impulse. No failure yet — wait for the model to develop.
                  </span>
                }/>
              </div>
              <Sel value={inp.failType} onChange={v=>set("failType",v)} placeholder="— Failure Status —"
                options={[["no_hh","No Higher High — Bearish failure"],["no_ll","No Lower Low — Bullish failure"],["unclear","Forming / Unclear"],["neither","Neither — No failure"]]}/>
            </div>
            <div className="space-y-1">
              <Chk checked={inp.firstLeg}  onChange={v=>set("firstLeg",v)}  label="First leg confirmed"/>
              {isRev&&<Chk checked={inp.secondLeg} onChange={v=>set("secondLeg",v)} label="Second leg confirmed ✦"/>}
            </div>
            <div>
              <div className="flex items-center mb-1">
                <FL>BOS / CHoCH</FL>
                <InfoTip content={
                  <span>
                    <span className="text-green-400 font-bold">Confirmed:</span> Price has broken a key structure level in your trade direction. Structure has shifted — you can now look for the RIFC entry.<br/><br/>
                    <span className="text-yellow-400 font-bold">Not Yet — Forming:</span> Failure confirmed but structure not broken yet. Stay patient.<br/><br/>
                    <span className="text-red-400 font-bold">No — Not Present:</span> No structural break confirmed. Without BOS there is no directional confirmation — NO TRADE.
                  </span>
                }/>
              </div>
              <Sel value={inp.bosStatus} onChange={v=>set("bosStatus",v)} placeholder="— BOS Status —"
                options={[["yes","Confirmed"],["wait","Not Yet — Forming"],["no","No — Not Present"]]}/>
            </div>
          </div>
        </Panel>

        <Panel>
          <SH>RIFC Entry</SH>
          <div className="space-y-2.5">
            <div><FL>Entry Idea / RIFC Zone</FL><Inp value={inp.entryIdea} onChange={v=>set("entryIdea",v)} placeholder="e.g. OB at origin of BOS at 1.0847"/></div>
            <div><FL>Entry at BOS Origin?</FL>
              <Sel value={inp.entryAtOrigin} onChange={v=>set("entryAtOrigin",v)} placeholder="— Confirm Location —"
                options={[["yes","Yes — At Origin"],["no","No — Mid/Late Move"],["unclear","Unclear"]]}/>
            </div>
            {isCont&&<Chk checked={inp.demandBelow50} onChange={v=>set("demandBelow50",v)} label="Demand/Supply beyond 50% of push ✦ (required for continuation)"/>}
            <div>
              <div className="flex items-center mb-1">
                <FL>LTF Confirmation</FL>
                <InfoTip content={
                  <span>
                    <span className="text-green-400 font-bold">Engulf Candle ✦:</span> Single candle fully engulfs the previous candle body at or near the RIFC zone. "Just this candle alone is confirmation." Your entry trigger.<br/><br/>
                    <span className="text-green-400 font-bold">M1 CHoCH ✦:</span> Change of Character on M1 at the RIFC zone — micro-structure has shifted in your favour.<br/><br/>
                    <span className="text-green-300 font-bold">Both ✦✦:</span> Highest conviction — engulf candle AND M1 CHoCH aligning at RIFC simultaneously. A+ signal.<br/><br/>
                    <span className="text-gray-400 font-bold">Unclear / Not Yet:</span> At the zone but trigger has not fired. Wait — touching the zone is not confirmation.
                  </span>
                }/>
              </div>
              <Sel value={inp.ltfConfirm} onChange={v=>set("ltfConfirm",v)} placeholder="— LTF Confirm —"
                options={[["engulf_candle","Engulf Candle at RIFC ✦"],["m1_choch","M1 CHoCH ✦"],["both","Both — Engulf + M1 CHoCH ✦✦"],["unclear","Unclear / Not Yet"]]}/>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <div><FL>Stop</FL><Inp type="number" value={inp.stopPips} onChange={v=>set("stopPips",v)} placeholder="1.5–5p"/></div>
              <div><FL>Risk %</FL><Inp type="number" value={inp.riskPct} onChange={v=>set("riskPct",v)} placeholder="1.0"/></div>
              <div><FL>Est. RR</FL><Inp type="number" value={inp.estRR} onChange={v=>set("estRR",v)} placeholder="5+"/></div>
            </div>
          </div>
        </Panel>

        {/* ───────── PRECISION VALIDATION (7 mandatory fields) ───────── */}
        <Panel>
          <SH>Precision Validation</SH>
          <div className="space-y-2.5">
            {/* 1 — RIFC Pip Size */}
            <div>
              <FL>RIFC Pip Size (pips)</FL>
              <Inp
                type="number"
                value={inp.rifcPipSize}
                onChange={v=>set("rifcPipSize",v)}
                placeholder="0.1 – 5.0"
              />
              {inp.rifcPipSize!=="" && !isNaN(parseFloat(inp.rifcPipSize)) && parseFloat(inp.rifcPipSize) > 5.0 && (
                <div className="mt-1 text-xs text-red-400 bg-red-950/30 border border-red-900 rounded px-2 py-1">
                  ⚠ RIFC too large -- maximum 5 pips
                </div>
              )}
              {inp.rifcPipSize!=="" && !isNaN(parseFloat(inp.rifcPipSize)) && parseFloat(inp.rifcPipSize) < 0.1 && (
                <div className="mt-1 text-xs text-yellow-400 bg-yellow-950/30 border border-yellow-900 rounded px-2 py-1">
                  ⚠ RIFC too small -- minimum 0.1 pips
                </div>
              )}
            </div>

            {/* 2 — RIFC Timeframe */}
            <div>
              <FL>RIFC Timeframe</FL>
              <Sel
                value={inp.rifcTimeframe}
                onChange={v=>set("rifcTimeframe",v)}
                placeholder="— Timeframe —"
                options={[["M1","M1"],["M2","M2"],["M3","M3"],["M5","M5"]]}
              />
              {inp.rifcTimeframe && !["M1","M2","M3","M5"].includes(inp.rifcTimeframe) && (
                <div className="mt-1 text-xs text-red-400 bg-red-950/30 border border-red-900 rounded px-2 py-1">
                  ⚠ RIFC must be drawn on M1-M5 only
                </div>
              )}
            </div>

            {/* 3 — EQL Sweep Distance */}
            <div>
              <FL>EQL Sweep Distance (pips)</FL>
              <Inp
                type="number"
                value={inp.eqlSweepDistance}
                onChange={v=>set("eqlSweepDistance",v)}
                placeholder="pips from EQL to wick extreme"
              />
              <div className="mt-1 text-xs text-gray-600 leading-relaxed">
                Measured from the liquidity level to the extreme of the wick on the timeframe the level was identified.
              </div>
            </div>

            {/* 4 — EQH Sweep Distance */}
            <div>
              <FL>EQH Sweep Distance (pips)</FL>
              <Inp
                type="number"
                value={inp.eqhSweepDistance}
                onChange={v=>set("eqhSweepDistance",v)}
                placeholder="pips from EQH to wick extreme"
              />
              <div className="mt-1 text-xs text-gray-600 leading-relaxed">
                Same measurement rule as EQL — logged separately, never combined with the EQL field.
              </div>
            </div>

            {/* 5 — Opposing Zone Status (only shown when opposing zone exists) */}
            <div>
              <Chk
                checked={inp.opposingZoneExists}
                onChange={v=>{ set("opposingZoneExists",v); if(!v) set("opposingZoneStatus",""); }}
                label="Opposing zone exists in target path"
              />
              {inp.opposingZoneExists && (
                <div className="mt-2">
                  <FL>Opposing Zone Status</FL>
                  <Sel
                    value={inp.opposingZoneStatus}
                    onChange={v=>set("opposingZoneStatus",v)}
                    placeholder="— Zone Status —"
                    options={[["fresh","Fresh"],["spent","Spent"]]}
                  />
                  {inp.opposingZoneStatus==="spent" && (
                    <div className="mt-1 text-xs text-orange-400 bg-orange-950/30 border border-orange-900 rounded px-2 py-1 leading-relaxed">
                      Spent zone -- acting as liquidity trap, not genuine demand/supply
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 6 — DXY Structure Detail */}
            <div>
              <FL>DXY Structure Detail{DXY_REQUIRED_PAIRS.includes((inp.pair||"").toUpperCase()) && <span className="text-red-500"> *</span>}</FL>
              <Inp
                value={inp.dxyStructureDetail}
                onChange={v=>set("dxyStructureDetail",v)}
                placeholder="e.g. Swept Asia High, engineered HH, displaced down -- inverse confirms bearish EU"
              />
              {DXY_REQUIRED_PAIRS.includes((inp.pair||"").toUpperCase()) && !inp.dxyStructureDetail?.trim() && (
                <div className="mt-1 text-xs text-red-400">Mandatory for {(inp.pair||"").toUpperCase()} trades.</div>
              )}
            </div>
          </div>
        </Panel>

        <button onClick={()=>set("setupType","")&&setShowSave(false)&&Object.entries(EMPTY).forEach(([k,v])=>set(k,v))||setInp&&setInp(EMPTY)}
          className="w-full bg-transparent hover:bg-gray-900 border border-gray-800 text-gray-600 py-2 rounded uppercase tracking-widest text-xs cursor-pointer"
          onClick={()=>{Object.entries(EMPTY).forEach(([k,v])=>set(k,v));}}>
          ↺ Reset Setup
        </button>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 min-w-0 space-y-3">

        {/* Weakness Flags */}
        {activeWeaknesses.length>0&&(
          <div className="bg-red-950/20 border border-red-900 rounded-sm p-3">
            <div className="text-xs text-red-500 font-bold uppercase tracking-wider mb-2">⚠️ Personal Weakness Detected</div>
            {activeWeaknesses.map((w,i)=>(
              <div key={i} className="text-xs text-red-600 mt-1">• {w.msg} — add extra friction before proceeding</div>
            ))}
          </div>
        )}

        {/* Pipeline */}
        <Panel>
          <SH>Evaluation Pipeline — POI → TIME → LIQ → INDUCE → DISP → FAIL → BOS → RIFC</SH>
          <div className="space-y-1">
            {PIPELINE.map(step=>{
              const res=ev.results[step]; const s=res?.s||S.PENDING;
              return (
                <div key={step} className={`flex items-center gap-2.5 px-3 py-1.5 rounded border ${s===S.PASS?"border-green-900 bg-green-950/20":s===S.FORMING?"border-yellow-900 bg-yellow-950/10":s===S.FAIL?"border-red-900 bg-red-950/15":"border-gray-800/50"}`}>
                  <div className="flex-shrink-0 w-5"><SB s={s}/></div>
                  <div className={`font-bold uppercase tracking-wider text-xs flex items-center ${s===S.PASS?"text-green-400":s===S.FORMING?"text-yellow-400":s===S.FAIL?"text-red-400":"text-gray-700"}`}>
                    {step} <span className="font-normal text-gray-600 normal-case tracking-normal ml-1">— {STEP_NAME[step]}</span>
                    {res?.r && <InfoTip content={res.r} />}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* Dynamic State */}
        <div className={`border rounded-sm p-3 ${pc.bg}`}>
          <div className="text-xs text-gray-600 uppercase tracking-widest mb-1">System State</div>
          <div className={`font-bold text-sm ${pc.text}`}>{ev.dynState.msg}</div>
          {ev.dynState.next&&<div className="text-xs text-gray-600 mt-1">→ {ev.dynState.next}</div>}
        </div>

        {/* Decision */}
        <div className={`border rounded-sm p-4 ${d.ring} ${d.bg}`}>
          <div className="text-xs text-gray-600 uppercase tracking-widest mb-2">Final Decision</div>
          <div className={`text-2xl font-bold ${d.text}`}>{d.label}</div>
          <div className="text-xs text-gray-500 mt-2">Reason:</div>
          <div className="text-sm text-gray-300 mt-0.5 leading-relaxed">{ev.decReason}</div>
          <div className="flex gap-5 mt-3 pt-3 border-t border-gray-800/60">
            <div>
              <div className="text-xs text-gray-600">GRADE</div>
              <div className={`font-bold text-sm mt-0.5 ${gc[ev.grade]||"text-gray-500"}`}>{ev.grade}</div>
            </div>
            <div>
              <div className="text-xs text-gray-600">TRADE ALLOWED</div>
              <div className={`font-bold text-sm mt-0.5 ${ev.tradeAllowed?"text-green-400":"text-red-500"}`}>{ev.tradeAllowed?"YES":"NO"}</div>
            </div>
            {journal.length>=5&&(
              <div>
                <div className="text-xs text-gray-600">PERSONAL HISTORY</div>
                <div className="text-gray-400 text-xs mt-0.5">
                  {(()=>{const st=computeStats(journal).bySetupType[inp.setupType];return st&&st.n>=2?`${Math.round((st.winRate||0)*100)}% WR (${st.n} trades)`:journal.length+" trades logged"})()}
                </div>
              </div>
            )}
          </div>
          {/* Buttons — conditional on decision */}
          {ev.decision === "VALID_TRADE" && (
            <button onClick={()=>setShowSave(true)}
              className="mt-3 w-full bg-gray-900 hover:bg-gray-800 border border-gray-700 text-gray-400 py-1.5 rounded text-xs uppercase tracking-wider cursor-pointer">
              + Save to Trade Journal
            </button>
          )}
          {ev.decision === "NO_TRADE" && (
            <div className="mt-3 space-y-1.5">
              {!evalLogged ? (
                <button
                  onClick={insertEvaluation}
                  disabled={evalLogging}
                  className={`w-full border py-1.5 rounded text-xs uppercase tracking-wider cursor-pointer transition-colors ${
                    evalLogging
                      ? "bg-gray-900 border-gray-800 text-gray-600 cursor-not-allowed"
                      : "bg-red-950/20 hover:bg-red-950/40 border-red-900 text-red-400"
                  }`}>
                  {evalLogging ? "Logging…" : "📋 Log No Trade Evaluation"}
                </button>
              ) : (
                <div className="w-full border border-green-900 bg-green-950/20 text-green-500 py-1.5 rounded text-xs text-center uppercase tracking-wider">
                  ✓ Evaluation logged
                </div>
              )}
            </div>
          )}
        </div>

        {/* Save modal */}
        {showSave&&(
          <Panel>
            <SH>Save Trade to Journal</SH>
            <div className="space-y-2.5">
              <div><FL>Outcome</FL>
                <Sel value={saveForm.outcome} onChange={v=>setSaveForm(p=>({...p,outcome:v}))} placeholder=""
                  options={[["win","Win"],["loss","Loss"],["be","Break Even"],["valid_not_taken","Valid -- Not Taken"]]}/>
              </div>
              {/* 7 — Why Not Taken (only when outcome = Valid -- Not Taken) */}
              {saveForm.outcome === "valid_not_taken" && (
                <div>
                  <FL>Why Not Taken <span className="text-red-500">*</span></FL>
                  <Inp
                    value={saveForm.whyNotTaken}
                    onChange={v=>setSaveForm(p=>({...p,whyNotTaken:v}))}
                    placeholder="e.g. Missed entry window, risk already allocated, conflicting HTF bias…"
                  />
                  {!saveForm.whyNotTaken?.trim() && (
                    <div className="mt-1 text-xs text-red-400">Mandatory when outcome is Valid -- Not Taken.</div>
                  )}
                </div>
              )}
              <div><FL>R Achieved</FL>
                <Inp type="number" value={saveForm.rAchieved} onChange={v=>setSaveForm(p=>({...p,rAchieved:v}))} placeholder="e.g. 6.5"/>
              </div>
              <div><FL>Notes</FL>
                <textarea value={saveForm.notes} onChange={e=>setSaveForm(p=>({...p,notes:e.target.value}))}
                  rows={2} placeholder="What did this trade teach you?" className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none placeholder-gray-700 resize-none"/>
              </div>
              <div>
                <FL>Screenshots (optional, max 2)</FL>
                <label className="flex items-center gap-2 cursor-pointer bg-gray-900 border border-gray-700 border-dashed rounded px-3 py-2 text-gray-500 hover:border-gray-500 text-xs">
                  <span>📎 Attach image(s)</span>
                  <input type="file" accept="image/png,image/jpeg,image/jpg" multiple className="hidden" onChange={handleImageUpload}/>
                </label>
                {saveForm.images.length>0&&(
                  <div className="flex gap-2 mt-2">
                    {saveForm.images.map((img,i)=>(
                      <div key={i} className="relative group">
                        <img src={img} alt="" className="w-16 h-16 object-cover rounded border border-gray-700 cursor-pointer" onClick={()=>setLightbox(img)}/>
                        <button onClick={()=>setSaveForm(p=>({...p,images:p.images.filter((_,j)=>j!==i)}))}
                          className="absolute -top-1 -right-1 bg-red-900 text-red-300 rounded-full w-4 h-4 text-xs flex items-center justify-center cursor-pointer hidden group-hover:flex">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Missing-required-fields gate */}
              {missingRequired.length > 0 && (
                <div className="text-xs text-red-400 bg-red-950/30 border border-red-900 rounded px-2.5 py-2 leading-relaxed">
                  <div className="font-bold uppercase tracking-wider mb-1">Cannot save — missing mandatory fields:</div>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {missingRequired.map(f => <li key={f}>{f}</li>)}
                  </ul>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  disabled={missingRequired.length > 0}
                  onClick={()=>{
                    if (missingRequired.length > 0) return;
                    const savedAt=inp.backtestMode&&inp.backtestDate?new Date(inp.backtestDate).toISOString():new Date().toISOString();
                    const pipelineSnapshot=Object.fromEntries(Object.entries(ev.results||{}).map(([k,v])=>([k,{s:v.s,r:v.r}])));
                    addTrade({
                      ...inp,
                      outcome:saveForm.outcome,
                      rAchieved:parseFloat(saveForm.rAchieved)||0,
                      notes:saveForm.notes,
                      whyNotTaken:saveForm.whyNotTaken,
                      grade:ev.grade,
                      savedAt,
                      isBacktest:inp.backtestMode,
                      images:saveForm.images,
                      pipelineSnapshot,
                    });
                    setShowSave(false);
                    setSaveForm({outcome:"win",rAchieved:"",notes:"",images:[],whyNotTaken:""});
                  }}
                  className={`flex-1 border py-1.5 rounded text-xs ${
                    missingRequired.length > 0
                      ? "bg-gray-950 border-gray-800 text-gray-600 cursor-not-allowed"
                      : "bg-green-950 hover:bg-green-900 border-green-800 text-green-400 cursor-pointer"
                  }`}>
                  Save Trade
                </button>
                <button onClick={()=>setShowSave(false)} className="px-4 bg-gray-900 border border-gray-700 text-gray-500 py-1.5 rounded text-xs cursor-pointer">Cancel</button>
              </div>
            </div>
          </Panel>
        )}

        {/* Lightbox */}
        {lightbox&&(
          <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" onClick={()=>setLightbox(null)}>
            <img src={lightbox} alt="" className="max-w-full max-h-full rounded shadow-2xl"/>
            <button className="absolute top-4 right-4 text-white text-lg cursor-pointer">✕</button>
          </div>
        )}

        {/* Similar Trades */}
        {similar.length>0&&(
          <Panel>
            <SH>Similar Past Trades ({similar.length} match{similar.length!==1?"es":""})</SH>
            <div className="space-y-2">
              {similar.map((t,i)=>(
                <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded border ${t.outcome==="Win"?"border-green-900 bg-green-950/10":t.outcome==="Loss"?"border-red-900 bg-red-950/10":"border-gray-800"}`}>
                  <div className={`font-bold text-sm ${t.outcome==="Win"?"text-green-400":t.outcome==="Loss"?"text-red-400":"text-gray-500"}`}>
                    {t.outcome==="Win"?"W":t.outcome==="Loss"?"L":"BE"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-300 text-xs">{t.setupType?.replace("_"," ")} | {t.session} | {t.trapClarity} trap | {t.ltfConfirm||"no LTF"}</div>
                    <div className="text-gray-600 text-xs">{t.notes||"No notes"}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`text-xs font-bold ${t.rAchieved>=0?"text-green-600":"text-red-600"}`}>{t.rAchieved>0?"+":""}{t.rAchieved}R</div>
                    <div className="text-gray-700 text-xs">{Math.round(t.score)}% match</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {/* Trade Management */}
        {ev.tradeAllowed&&(
          <Panel>
            <SH>Trade Management</SH>
            <div className="space-y-3">
              {/* Mode A / Mode B selector with gate */}
              {(()=>{
                const grade      = computeAdaptiveGrade(inp, journal);
                const modeAOk    = grade === 'A+' || inp.secondLeg === true;
                const [mgmtMode, setMgmtMode] = [inp.mgmtMode || '', v => set('mgmtMode', v)];
                return (
                  <div>
                    <FL>Management Mode</FL>
                    <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                      <button
                        onClick={() => { if (modeAOk) setMgmtMode('A'); }}
                        disabled={!modeAOk}
                        className={`py-2.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                          !modeAOk           ? 'border-gray-800 text-gray-700 cursor-not-allowed bg-gray-950'   :
                          mgmtMode === 'A'   ? 'border-green-600 bg-green-950/30 text-green-300'               :
                                              'border-gray-700 text-gray-400 hover:border-green-900'
                        }`}>Mode A — Full Runner</button>
                      <button
                        onClick={() => setMgmtMode('B')}
                        className={`py-2.5 rounded border text-xs font-bold cursor-pointer transition-colors ${
                          mgmtMode === 'B' ? 'border-blue-600 bg-blue-950/30 text-blue-300' :
                                            'border-gray-700 text-gray-400 hover:border-blue-900'
                        }`}>Mode B — Partials</button>
                    </div>
                    {!modeAOk && (
                      <div className="text-xs border border-yellow-900 bg-yellow-950/20 text-yellow-600 rounded px-2 py-1.5">
                        Mode A requires A+ grade or confirmed second leg. Select Mode B.
                      </div>
                    )}
                  </div>
                );
              })()}
              <div><FL>Active State</FL>
                <Sel value={inp.mgmtState} onChange={v=>set("mgmtState",v)} placeholder="— Select State —"
                  options={[["ENTRY","Entry — Initial"],["CONFIRMATION","Confirmation — Awaiting Structure"],["CONTINUATION","Continuation — Protected"]]}/>
              </div>
              {inp.mgmtState==="CONFIRMATION"&&(
                <div className="space-y-1.5 pl-1">
                  <Chk checked={inp.m1Shift} onChange={v=>set("m1Shift",v)} label="M1 structure shift confirmed"/>
                  <Chk checked={inp.intBOS}  onChange={v=>set("intBOS",v)}  label="Internal BOS confirmed"/>
                </div>
              )}
              <div className={`p-2.5 rounded border text-xs leading-relaxed ${mgmt.state==="CONTINUATION"?"border-green-900 text-green-500":mgmt.beOk?"border-green-900 text-green-500":mgmt.state==="CONFIRMATION"?"border-yellow-900 text-yellow-500":"border-gray-800 text-gray-500"}`}>{mgmt.comment}</div>
              <div className="flex gap-2"><MTag label="BE" ok={mgmt.beOk}/><MTag label="Trailing" ok={mgmt.trailOk}/><MTag label="Partials" ok={mgmt.partOk}/></div>
              <div className="grid grid-cols-3 gap-1.5 pt-1 border-t border-gray-800/60">
                {[{l:"TP1",d:"Internal liq.",c:"border-blue-900 text-blue-500"},{l:"TP2",d:"External liq.",c:"border-purple-900 text-purple-500"},{l:"TP3",d:"Runner",c:"border-indigo-900 text-indigo-500"}].map(t=>(
                  <div key={t.l} className={`rounded border p-2 text-center ${t.c} bg-gray-900/30`}><div className="font-bold">{t.l}</div><div className="text-gray-600 mt-0.5">{t.d}</div></div>
                ))}
              </div>
            </div>
          </Panel>
        )}

        <div className="border border-gray-900 rounded-sm p-3 text-center text-xs text-gray-700 bg-gray-950">
          "We do not trade setups. We trade <span className="text-red-600">failed moves</span>. They enter at the trap. We enter after the failure."
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: DECISION TREES
// ═══════════════════════════════════════════════════════════════════════

function DecisionTreeTab({ inp }) {
  const [selectedModel, setSelectedModel] = useState(inp.setupType||"reversal_bull");
  const steps = TREES[selectedModel]||[];
  const stepStatuses = steps.map(st=>st.check(inp));

  const statusStyle = { pass:"border-green-900 bg-green-950/20 text-green-400",
    warn:"border-yellow-900 bg-yellow-950/10 text-yellow-400",
    fail:"border-red-900 bg-red-950/15 text-red-400",
    pending:"border-gray-800/50 text-gray-600" };
  const statusIcon = { pass:"✅", warn:"⚠️", fail:"❌", pending:"○" };

  let stoppedAt = null;
  const displayStatuses = stepStatuses.map((s,i)=>{
    if (stoppedAt!==null) return "pending";
    if (s==="fail"){ stoppedAt=i; return "fail"; }
    return s;
  });

  const modelLabels = { reversal_bull:"Bullish Reversal", reversal_bear:"Bearish Reversal",
    cont_bull:"Bullish Continuation", cont_bear:"Bearish Continuation" };

  return (
    <div className="space-y-3">
      <Panel>
        <SH>Decision Tree — Step-by-Step Model Checklist</SH>
        <div className="flex gap-2 flex-wrap mb-4">
          {Object.entries(modelLabels).map(([k,l])=>(
            <button key={k} onClick={()=>setSelectedModel(k)}
              className={`px-3 py-1.5 rounded text-xs border cursor-pointer transition-colors ${selectedModel===k?"border-green-700 bg-green-950/30 text-green-400":"border-gray-700 text-gray-500 hover:border-gray-600"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="text-xs text-gray-600 mb-3">Inputs from Evaluate tab are reflected live below. Status updates as you fill in fields.</div>

        <div className="space-y-2">
          {steps.map((step, i) => {
            const st = displayStatuses[i];
            const sty = statusStyle[st];
            const isPassed = st==="pass";
            const isFail = st==="fail";
            const isNext = !isPassed && !isFail && (i===0 || displayStatuses[i-1]==="pass");

            return (
              <div key={step.id}>
                <div className={`border rounded-sm p-3 ${sty} ${isNext?"ring-1 ring-yellow-800":""}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-6 text-center font-bold text-xs pt-0.5">
                      {st==="pending"?<span className="text-gray-700">{i+1}</span>:<span>{statusIcon[st]}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-xs leading-relaxed">{step.q}</div>
                      <div className="text-gray-600 text-xs mt-0.5 leading-relaxed">{step.detail}</div>
                      {isFail&&(
                        <div className="mt-1.5 px-2 py-1 bg-red-950/40 border border-red-900/50 rounded text-xs text-red-400">
                          → {step.failOut}
                        </div>
                      )}
                      {isNext&&(
                        <div className="mt-1.5 px-2 py-1 bg-yellow-950/20 border border-yellow-900/30 rounded text-xs text-yellow-700">
                          ← Current step — check your inputs
                        </div>
                      )}
                    </div>
                    {i<steps.length-1&&isPassed&&(
                      <div className="flex-shrink-0 text-green-800 text-xs">↓</div>
                    )}
                  </div>
                </div>
                {/* Arrow connector */}
                {i<steps.length-1&&st==="pass"&&(
                  <div className="flex justify-center py-0.5">
                    <div className="w-px h-3 bg-green-900"></div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Final output */}
          {displayStatuses.every(s=>s==="pass")&&(
            <div className="border border-green-700 bg-green-950/30 rounded-sm p-3 text-center">
              <div className="text-green-400 font-bold text-sm">🟢 VALID ENTRY</div>
              <div className="text-green-700 text-xs mt-1">Full sequence confirmed — execute at RIFC zone</div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: LIVE MODE
// ═══════════════════════════════════════════════════════════════════════

const PREP_STEPS = [
  { n:"01", label:"H4 Bias",                  tf:"H4",        hasBias:true,
    instr:"Identify the H4 bias before doing anything else.",
    detail:"Mark your premium/discount range on H4. Establish whether price is bullish, bearish, or neutral/ranging. This is your compass for the entire session — every decision below flows from this read." },
  { n:"02", label:"H1 Structure",             tf:"H1",
    instr:"Map the H1 structure — swing highs, swing lows, and BOS points.",
    detail:"Identify the most recent internal and external structure on H1. Confirm the direction of the last structural move and any CHoCH that has already formed. This tells you whether you are trading with or against the recent order flow." },
  { n:"03", label:"Previous Day High & Low",  tf:"H1 → H4",
    instr:"Mark the previous day's high and low on your chart.",
    detail:"These are key liquidity levels. HTF players use them as targets. Price often returns to sweep PDH or PDL before committing to a directional move. Note which is unswept — it is the more likely target today." },
  { n:"04", label:"Session Highs & Lows",     tf:"H1",
    instr:"Mark the current and previous session highs and lows.",
    detail:"Frankfurt high/low, London high/low if mid-session. These are engineered liquidity pools. Note which ones are still unswept — these are live targets for inducement sweeps during the coming session." },
  { n:"05", label:"Asia Range",               tf:"M15",
    instr:"Box out the Asia session range on M15.",
    detail:"The Asia range defines the initial consolidation zone. London typically sweeps one side (sometimes both) to grab stops before committing to the daily direction. Mark both extremes clearly before the session opens." },
  { n:"06", label:"Frankfurt High & Low",     tf:"M15",
    instr:"Mark the Frankfurt session high and low on M15.",
    detail:"Frankfurt often sets a directional trap. London frequently sweeps the Frankfurt high or low as its first move of the session. This is your first clue for the London inducement setup and tells you where the initial stop hunt will target." },
  { n:"07", label:"Supply & Demand Zones",    tf:"H1 → M15",
    instr:"Mark all active supply and demand zones. HTF (H4/H1): 6–30p. LTF (M15/M5): 4–10p.",
    detail:"H1 and M15 zones only. Ignore M5 zones at this stage. Mark the origin of each zone and note whether it is fresh or has already been mitigated. Only fresh, untested zones qualify as valid POIs for today." },
  { n:"08", label:"Equal Highs & Lows",       tf:"H1 → M15",
    instr:"Identify any double tops, double bottoms or equal price levels.",
    detail:"Two or more touches at the same level signal resting stop orders. These are engineered liquidity targets. Mark them all — they are the specific sweep targets the session is likely to engineer before committing to direction." },
  { n:"09", label:"Open Imbalances & FVGs",   tf:"M15 → M5",
    instr:"Mark all unfilled FVGs and open imbalances on M15 and M5.",
    detail:"These are areas price left behind in impulsive moves. They act as magnets — price often returns to fill them. Note whether they are above or below current price and whether they align with your H4 bias. Unmitigated FVGs above = bearish magnets. Below = bullish." },
  { n:"10", label:"Trendline Liquidity",      tf:"H1 → M15",
    instr:"Draw any visible trendlines that retail traders would be leaning on.",
    detail:"Ascending or descending trendlines that are obvious on the chart attract stop orders from breakout and breakdown traders. Mark these as potential trap zones for today. The more obvious the trendline, the more stops are resting just beyond it." },
  { n:"11", label:"Internal BOS",             tf:"M15 → M5",
    instr:"Confirm whether an internal BOS has already occurred on M15 or M5.",
    detail:"If a BOS already exists, continuation setups are in play. If no BOS has occurred, you are waiting for a reversal model to develop. This determines which setup type you look for today and sets your entry model expectation." },
  { n:"12", label:"DXY Pre-Check",            tf:"H1",
    instr:"Check DXY structure and bias before the session opens.",
    detail:"DXY and EURUSD/GBPUSD move in inverse correlation. Confirm DXY direction aligns with your trade pair bias. If DXY is bullish and you are looking for EURUSD longs, there is a structural conflict. Note it now — it becomes a factor in stage 03 of the pipeline." },
];

function LiveModeTab({ onSaveToJournal }) {

  // ── Session clock ──────────────────────────────────────────────────
  const [ukTime, setUkTime]       = useState("");
  const [sessionInfo, setSessionInfo] = useState({ name:"Calculating…", valid:false, caution:false });

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const s = now.toLocaleTimeString("en-GB", { timeZone:"Europe/London", hour:"2-digit", minute:"2-digit" });
      setUkTime(s);
      const [h, mn] = s.split(":").map(Number);
      const t = h * 60 + mn;
      // NY PM: detect via America/New_York to handle DST automatically
      const nyHour = parseInt(now.toLocaleString("en-US", { timeZone:"America/New_York", hour:"numeric", hour12:false }), 10);
      const nyPM = nyHour >= 13 && nyHour < 15;

      if      (t >= 7*60    && t < 7*60+45) setSessionInfo({ name:"Frankfurt 07:00 BST — prep, not yet valid", valid:false, caution:true  });
      else if (t >= 7*60+45 && t < 8*60)    setSessionInfo({ name:"Frankfurt 07:45+ BST",                      valid:true,  caution:false });
      else if (t >= 8*60    && t < 12*60)   setSessionInfo({ name:"London Open 08:00–12:00 BST",               valid:true,  caution:false });
      else if (t >= 12*60   && t < 13*60)   setSessionInfo({ name:"London Lunch 12:00–13:00 BST",              valid:false, caution:true  });
      else if (t >= 13*60   && t < 14*60)   setSessionInfo({ name:"NY 1PM 13:00–14:00 BST",                    valid:true,  caution:false });
      else if (t >= 14*60   && t < 16*60)   setSessionInfo({ name:"NY 2nd Hour 14:00–16:00 BST",               valid:true,  caution:false });
      else if (t >= 16*60   && t < 18*60)   setSessionInfo({ name:"No Session 16:00–18:00 BST",                valid:false, caution:false });
      else if (t >= 18*60   && t < 20*60 && nyPM) setSessionInfo({ name:"NY PM 18:00–20:00 BST",              valid:true,  caution:false });
      else                                   setSessionInfo({ name:"No Active Session",                         valid:false, caution:false });
    };
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, []);

  // ── Phase ──────────────────────────────────────────────────────────
  const [phase, setPhase] = useState("prep");

  // ── Prep state ────────────────────────────────────────────────────
  const [prepDone, setPrepDone] = useState(Array(12).fill(false));
  const [h4Bias,   setH4Bias]   = useState("");
  const allPrepDone = prepDone.every(Boolean);

  const confirmPrep = (i) => {
    if (i === 0 && !h4Bias) return;
    const next = [...prepDone]; next[i] = true;
    setPrepDone(next);
    if (next.every(Boolean)) setTimeout(() => setPhase("pipeline"), 400);
  };

  // ── Pipeline state ────────────────────────────────────────────────
  const [pipeStage, setPipeStage] = useState(0);
  const [blocked,   setBlocked]   = useState(null);

  const [pairs,       setPairs]       = useState([]);
  const [dxyCorr,     setDxyCorr]     = useState({});
  const [poiTF,       setPoiTF]       = useState("");
  const [poiPips,     setPoiPips]     = useState("");
  const [poiDir,      setPoiDir]      = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [liqChecked,  setLiqChecked]  = useState([]);

  // ── Reset ─────────────────────────────────────────────────────────
  const reset = () => {
    setPhase("prep");
    setPrepDone(Array(12).fill(false));
    setH4Bias("");
    setPipeStage(0);
    setBlocked(null);
    setPairs([]); setDxyCorr({});
    setPoiTF(""); setPoiPips(""); setPoiDir(""); setModelOverride("");
    setLiqChecked([]);
  };

  // ── POI derived values ─────────────────────────────────────────────
  const poiPipsNum  = parseFloat(poiPips);
  const poiIsHTF    = ["H4","H1"].includes(poiTF);
  const poiValid    = poiTF && poiDir && !isNaN(poiPipsNum) && (
    poiIsHTF ? poiPipsNum >= 6 && poiPipsNum <= 30
             : poiPipsNum >= 4 && poiPipsNum <= 10
  );
  const poiError    = poiTF && poiDir && !isNaN(poiPipsNum) && !poiValid
    ? poiIsHTF
      ? poiPipsNum > 30 ? `HTF POI ${poiPipsNum}p — oversized (>30p). Look to refine and make it smaller`
                        : `HTF POI ${poiPipsNum}p — too tight (min 6p)`
      : poiPipsNum > 30 ? `LTF POI ${poiPipsNum}p — too wide (>30p). Refine and make it smaller`
      : poiPipsNum > 10 ? `LTF POI ${poiPipsNum}p — falls in HTF range (>10p). Switch to H1 or H4 and reclassify as HTF POI`
      : `LTF POI ${poiPipsNum}p — too tight (min 4p)`
    : null;
  const poiBiasConflict = poiDir && h4Bias && ((poiDir==="bearish"&&h4Bias==="bullish")||(poiDir==="bullish"&&h4Bias==="bearish"));
  const suggestedModel  = poiDir==="bearish"
    ? "Bearish Reversal — complex push to supply, multi-layer trap"
    : poiDir==="bullish" ? "Bullish Reversal — push to demand, inducement swept" : "";

  // ── DXY check ─────────────────────────────────────────────────────
  const tradePairs       = pairs.filter(p => p !== "DXY");
  // Hard gate: ANY assessed pair that is NOT aligned blocks progression
  const dxyAnyConflict   = tradePairs.some(p => dxyCorr[p] === false);
  const dxyAllUnaligned  = tradePairs.length > 0 && tradePairs.every(p => dxyCorr[p] === false);
  const dxyAllAssessed   = tradePairs.length === 0 || tradePairs.every(p => dxyCorr[p] !== undefined);

  // ── Pipeline helpers ───────────────────────────────────────────────
  const advancePipe = () => { if (!blocked) setPipeStage(s => s + 1); };
  const blockPipe   = (reason) => setBlocked({ reason });
  const goBack      = () => setBlocked(null);

  // ── Styling helpers ────────────────────────────────────────────────
  const pillCls = sessionInfo.valid
    ? "bg-green-950 border-green-700 text-green-400"
    : sessionInfo.caution
    ? "bg-yellow-950 border-yellow-700 text-yellow-500"
    : "bg-gray-900 border-gray-700 text-gray-600";

  const stageHeader = (n, label, tf) => (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-blue-500 font-bold text-xs">{n}</span>
      <span className="text-blue-300 font-bold text-xs">{label}</span>
      <span className="text-xs border border-blue-900 text-blue-800 rounded px-1.5 py-px ml-1">{tf}</span>
    </div>
  );

  const yesNoButtons = (onYes, onNo, yesLabel="✓ Confirmed", noLabel="✗ Not yet") => (
    <div className="flex gap-2">
      <button onClick={onYes} className="flex-1 py-1.5 text-xs border border-green-700 bg-green-950/30 text-green-400 rounded cursor-pointer hover:bg-green-950/50">{yesLabel}</button>
      <button onClick={onNo}  className="flex-1 py-1.5 text-xs border border-red-800 bg-red-950/20 text-red-400 rounded cursor-pointer hover:bg-red-950/30">{noLabel}</button>
    </div>
  );

  // ── Completed pipeline summary entries ────────────────────────────
  const pipelineSummaryRows = [
    pipeStage > 0 && { n:"01", label:"Session Window",    done:"Valid window confirmed" },
    pipeStage > 1 && { n:"02", label:"Pairs",             done:pairs.join(", ")||"—" },
    pipeStage > 2 && { n:"03", label:"DXY Correlation",   done:tradePairs.filter(p=>dxyCorr[p]).join(", ")||"Assessed" },
    pipeStage > 3 && { n:"04", label:"POI",               done:`${poiTF} · ${poiPips}p · ${poiDir}` },
    pipeStage > 4 && { n:"05", label:"Liquidity",         done:`${liqChecked.length} pool${liqChecked.length!==1?"s":""} confirmed` },
    pipeStage > 5 && { n:"06", label:"Inducement",        done:"Confirmed" },
    pipeStage > 6 && { n:"07", label:"Displacement",      done:"Impulsive + FVG confirmed" },
    pipeStage > 7 && { n:"08", label:"Failure Model",     done:poiDir==="bearish"?"No HH confirmed":"No LL confirmed" },
    pipeStage > 8 && { n:"09", label:"BOS / CHoCH",       done:"Structure shifted" },
  ].filter(Boolean);

  // ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 max-w-2xl mx-auto">

      {/* ── Header bar ── */}
      <div className="flex items-center justify-between bg-gray-950 border border-gray-800 rounded-sm px-4 py-2.5">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-green-400 font-bold text-xs uppercase tracking-widest">● Live Mode</span>
          <span className="text-gray-700">|</span>
          <span className={`text-xs px-2 py-0.5 rounded border ${pillCls}`}>{sessionInfo.name}</span>
          {ukTime && <span className="text-gray-600 text-xs">UK {ukTime}</span>}
        </div>
        <button onClick={reset} className="text-xs text-gray-600 hover:text-red-500 border border-gray-800 hover:border-red-900 px-3 py-1 rounded cursor-pointer transition-colors ml-2 shrink-0">
          ↺ Reset
        </button>
      </div>

      {/* ── Phase indicator ── */}
      <div className="flex gap-1.5">
        {[["prep","01  Pre-Session Prep"],["pipeline","02  Session Pipeline"]].map(([id,label])=>(
          <div key={id} className={`flex-1 text-center text-xs py-1.5 rounded border font-mono ${
            phase===id                    ? "border-blue-700 bg-blue-950/30 text-blue-400"
            : id==="pipeline"&&allPrepDone? "border-gray-600 text-gray-500"
            :                               "border-gray-800 text-gray-700"
          }`}>{label}</div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════
          PHASE 1 — PRE-SESSION PREP
      ══════════════════════════════════════════════════════════════ */}
      {phase==="prep" && (
        <div className="space-y-1.5">
          <SH>Pre-Session Prep — complete all 12 steps before the session opens</SH>

          {PREP_STEPS.map((step, i) => {
            const done   = prepDone[i];
            const locked = i > 0 && !prepDone[i-1];
            return (
              <div key={step.n} className={`border rounded-sm transition-all duration-150 ${
                done   ? "border-green-900 bg-green-950/10"
                : locked? "border-gray-800/40 opacity-40 pointer-events-none"
                :         "border-blue-900/60 bg-blue-950/10"
              }`}>

                {/* ── Collapsed (done) ── */}
                {done && (
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <span className="text-green-600 text-xs">✓</span>
                    <span className="text-gray-600 text-xs w-5 shrink-0">{step.n}</span>
                    <span className="text-green-700 text-xs">{step.label}</span>
                    {step.hasBias && h4Bias && (
                      <span className={`text-xs px-1.5 rounded border ml-1 ${
                        h4Bias==="bearish"?"border-red-900 text-red-500 bg-red-950/20"
                        :h4Bias==="bullish"?"border-green-900 text-green-500 bg-green-950/20"
                        :"border-gray-700 text-gray-500"}`}>
                        {h4Bias.charAt(0).toUpperCase()+h4Bias.slice(1)}
                      </span>
                    )}
                    <span className="text-gray-700 text-xs ml-auto">{step.tf}</span>
                  </div>
                )}

                {/* ── Locked ── */}
                {!done && locked && (
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <span className="text-gray-700 text-xs">○</span>
                    <span className="text-gray-700 text-xs w-5 shrink-0">{step.n}</span>
                    <span className="text-gray-700 text-xs">{step.label}</span>
                    <span className="text-gray-800 text-xs ml-auto">{step.tf}</span>
                  </div>
                )}

                {/* ── Active ── */}
                {!done && !locked && (
                  <div className="px-3 py-3">
                    <div className="flex items-start gap-2.5 mb-2.5">
                      <span className="text-blue-500 font-bold text-xs w-5 shrink-0 mt-px">{step.n}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-blue-300 font-bold text-xs">{step.label}</span>
                          <span className="text-xs border border-blue-900 text-blue-800 rounded px-1.5 py-px">{step.tf}</span>
                        </div>
                        <div className="text-gray-200 text-xs leading-relaxed mb-1">{step.instr}</div>
                        <div className="text-gray-600 text-xs leading-relaxed">{step.detail}</div>
                      </div>
                    </div>

                    {step.hasBias && (
                      <div className="mb-2.5 pl-7">
                        <FL>Select H4 Bias</FL>
                        <div className="flex gap-2">
                          {[["bearish","Bearish"],["bullish","Bullish"],["neutral","Neutral"]].map(([v,l])=>(
                            <button key={v} onClick={()=>setH4Bias(v)}
                              className={`flex-1 py-1.5 text-xs rounded border cursor-pointer transition-colors ${
                                h4Bias===v
                                  ? v==="bearish"?"border-red-700 bg-red-950/30 text-red-400"
                                  : v==="bullish"?"border-green-700 bg-green-950/30 text-green-400"
                                  : "border-gray-600 bg-gray-800 text-gray-300"
                                  : "border-gray-700 text-gray-600 hover:border-gray-500"
                              }`}>{l}</button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pl-7">
                      <button onClick={()=>confirmPrep(i)} disabled={step.hasBias && !h4Bias}
                        className={`px-4 py-1.5 text-xs rounded border transition-colors cursor-pointer ${
                          step.hasBias && !h4Bias
                            ? "border-gray-800 text-gray-700 cursor-not-allowed"
                            : "border-blue-700 bg-blue-950/30 text-blue-400 hover:bg-blue-950/60"
                        }`}>
                        Confirm {step.n} ✓
                      </button>
                    </div>
                  </div>
                )}

              </div>
            );
          })}

          {allPrepDone && (
            <div className="border border-green-700 bg-green-950/20 rounded-sm p-3 text-center mt-2">
              <div className="text-green-400 font-bold text-sm">✓ Prep complete — pipeline unlocked</div>
              <div className="text-green-800 text-xs mt-0.5">All 12 steps confirmed. Session Pipeline is now active.</div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          PHASE 2 — SESSION PIPELINE
      ══════════════════════════════════════════════════════════════ */}
      {phase==="pipeline" && (
        <div className="space-y-3">

          <div className="flex items-center justify-between">
            <SH>Session Pipeline — work through each stage in order</SH>
            <button onClick={()=>setPhase("prep")} className="text-xs text-gray-600 hover:text-gray-400 cursor-pointer ml-3 shrink-0 pb-1.5">← Prep</button>
          </div>

          {/* Progress bar */}
          <div className="flex gap-0.5">
            {Array(9).fill(0).map((_,i)=>(
              <div key={i} className={`flex-1 h-1 rounded-sm transition-colors ${
                i < pipeStage  ? "bg-green-800"
                : i===pipeStage&&!blocked ? "bg-blue-600"
                : "bg-gray-800"
              }`}/>
            ))}
          </div>

          {/* Stand-down banner */}
          {blocked && (
            <div className="border border-red-800 bg-red-950/20 rounded-sm p-3">
              <div className="text-red-500 font-bold text-xs uppercase tracking-wider mb-1.5">🔴 Stand Down</div>
              <div className="text-red-400 text-xs leading-relaxed">{blocked.reason}</div>
              <button onClick={goBack} className="mt-2.5 text-xs border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600 px-3 py-1 rounded cursor-pointer transition-colors">
                ← Go back and reassess
              </button>
            </div>
          )}

          {/* Completed stages summary */}
          {pipelineSummaryRows.length > 0 && (
            <div className="border border-gray-800 rounded-sm overflow-hidden">
              {pipelineSummaryRows.map(row=>(
                <div key={row.n} className="flex items-center gap-2.5 px-3 py-1.5 border-b border-gray-800/50 last:border-b-0">
                  <span className="text-green-600 text-xs">✓</span>
                  <span className="text-gray-600 text-xs w-5 shrink-0">{row.n}</span>
                  <span className="text-green-700 text-xs">{row.label}</span>
                  <span className="text-gray-600 text-xs ml-auto truncate max-w-xs">{row.done}</span>
                </div>
              ))}
            </div>
          )}

          {/* ── Stage 01: Session Window ── */}
          {pipeStage===0 && !blocked && (
            <Panel>
              {stageHeader("01","Session Window","Any")}
              <div className="text-gray-200 text-xs mb-1 leading-relaxed">Are you in a valid execution window right now?</div>
              <div className="text-gray-600 text-xs mb-3 leading-relaxed">Frankfurt 07:45+ BST · London Open 08:00–12:00 BST · NY 1PM 13:00–14:00 BST · NY 2nd Hour 14:00–16:00 BST · NY PM 18:00–20:00 BST</div>
              {sessionInfo.valid && (
                <div className="mb-3 text-xs text-green-600 border border-green-900 bg-green-950/20 rounded px-3 py-2">
                  ● Clock detects: <span className="text-green-400 font-bold">{sessionInfo.name}</span>
                </div>
              )}
              {!sessionInfo.valid && ukTime && (
                <div className="mb-3 text-xs text-yellow-700 border border-yellow-900 bg-yellow-950/10 rounded px-3 py-2">
                  ⚠ Clock shows {ukTime} UK — no valid window detected automatically. Only confirm if you have checked manually.
                </div>
              )}
              {yesNoButtons(
                ()=>advancePipe(),
                ()=>blockPipe("You are outside a valid execution window. Close the charts. Come back during Frankfurt (07:45+ BST), London Open (08:00–12:00 BST), NY 1PM (13:00–14:00 BST), NY 2nd Hour (14:00–16:00 BST), or NY PM (18:00–20:00 BST). Outside these windows the model does not apply."),
                "Yes — I am in a valid window",
                "No — outside window"
              )}
            </Panel>
          )}

          {/* ── Stage 02: Pairs ── */}
          {pipeStage===1 && !blocked && (
            <Panel>
              {stageHeader("02","Pairs","Any")}
              <div className="text-gray-200 text-xs mb-1">Which pairs are you watching this session?</div>
              <div className="text-gray-600 text-xs mb-3">Select all that apply. DXY is for correlation reference — not a trade pair.</div>
              <div className="space-y-1.5 mb-3">
                {["EURUSD","GBPUSD","DXY"].map(p=>(
                  <label key={p} className="flex items-center gap-2 cursor-pointer text-xs select-none">
                    <input type="checkbox" checked={pairs.includes(p)}
                      onChange={e=>{ if(e.target.checked) setPairs(prev=>[...prev,p]); else setPairs(prev=>prev.filter(x=>x!==p)); }}
                      className="w-3.5 h-3.5 accent-green-500 cursor-pointer"/>
                    <span className={pairs.includes(p)?"text-green-400":"text-gray-400"}>{p}</span>
                  </label>
                ))}
              </div>
              <button onClick={()=>{ if(pairs.length>0) advancePipe(); }} disabled={pairs.length===0}
                className={`w-full py-1.5 text-xs rounded border cursor-pointer ${
                  pairs.length>0 ? "border-green-700 bg-green-950/30 text-green-400 hover:bg-green-950/50" : "border-gray-800 text-gray-700 cursor-not-allowed"
                }`}>Confirm Pairs →</button>
            </Panel>
          )}

          {/* ── Stage 03: DXY Correlation ── */}
          {pipeStage===2 && !blocked && (
            <Panel>
              {stageHeader("03","DXY Live Correlation","H1")}
              <div className="text-gray-200 text-xs mb-1">For each pair, is DXY moving in inverse correlation?</div>
              <div className="text-gray-600 text-xs mb-3">EURUSD and GBPUSD move inversely to DXY. Bearish DXY = bullish pairs. If correlation is absent, the setup lacks directional confirmation from DXY.</div>
              {tradePairs.length === 0 && (
                <div className="text-yellow-700 text-xs mb-3 border border-yellow-900 bg-yellow-950/10 rounded px-3 py-2">
                  No trade pairs selected (DXY only). Skipping correlation check.
                </div>
              )}
              {tradePairs.length > 0 && (
                <div className="space-y-2 mb-3">
                  {tradePairs.map(p=>(
                    <div key={p} className="flex items-center gap-3">
                      <span className="text-gray-400 text-xs w-20 shrink-0 font-mono">{p}</span>
                      <div className="flex gap-2 flex-1">
                        <button onClick={()=>setDxyCorr(prev=>({...prev,[p]:true}))}
                          className={`flex-1 py-1 text-xs rounded border cursor-pointer transition-colors ${dxyCorr[p]===true?"border-green-700 bg-green-950/30 text-green-400":"border-gray-700 text-gray-500 hover:border-green-900"}`}>
                          ✓ Aligned</button>
                        <button onClick={()=>setDxyCorr(prev=>({...prev,[p]:false}))}
                          className={`flex-1 py-1 text-xs rounded border cursor-pointer transition-colors ${dxyCorr[p]===false?"border-red-800 bg-red-950/20 text-red-400":"border-gray-700 text-gray-500 hover:border-red-900"}`}>
                          ✗ Not aligned</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {dxyAnyConflict
                ? (
                  <div className="space-y-2">
                    <div className="border border-red-800 bg-red-950/20 rounded px-3 py-2 text-xs text-red-400 leading-relaxed">
                      🔴 DXY conflict detected. Bias not aligned. Do not proceed.
                    </div>
                    <button onClick={()=>blockPipe("DXY conflict detected. Bias not aligned. Do not proceed.")}
                      className="w-full py-1.5 text-xs border border-red-800 bg-red-950/20 text-red-400 rounded cursor-pointer">
                      ✗ Confirm block — stand down
                    </button>
                  </div>
                ) : (
                  <button onClick={()=>{ if(dxyAllAssessed) advancePipe(); }} disabled={!dxyAllAssessed}
                    className={`w-full py-1.5 text-xs rounded border cursor-pointer ${
                      dxyAllAssessed ? "border-green-700 bg-green-950/30 text-green-400 hover:bg-green-950/50" : "border-gray-800 text-gray-700 cursor-not-allowed"
                    }`}>Confirm DXY Correlation →</button>
                )
              }
            </Panel>
          )}

          {/* ── Stage 04: POI ── */}
          {pipeStage===3 && !blocked && (
            <Panel>
              {stageHeader("04","Point of Interest","H4 / H1 / M15 / M5")}
              <div className="text-gray-200 text-xs mb-1">Identify your active POI — confirm timeframe, pip range, and direction.</div>
              <div className="text-gray-600 text-xs mb-3">HTF (H4/H1): 6–30p. LTF (M15/M5): 4–10p. Direction should align with H4 bias unless trading counter-bias.</div>
              <div className="space-y-2.5 mb-3">
                <div>
                  <FL>Timeframe</FL>
                  <div className="flex gap-1.5">
                    {["H4","H1","M15","M5"].map(tf=>(
                      <button key={tf} onClick={()=>setPoiTF(tf)}
                        className={`flex-1 py-1.5 text-xs rounded border cursor-pointer transition-colors ${poiTF===tf?"border-blue-700 bg-blue-950/30 text-blue-400":"border-gray-700 text-gray-600 hover:border-gray-500"}`}>{tf}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <FL>Pip Range {poiTF && <span className="text-gray-700 normal-case tracking-normal">({poiIsHTF?"6–30p":"4–10p"})</span>}</FL>
                  <Inp type="number" value={poiPips} onChange={setPoiPips} placeholder={poiIsHTF?"e.g. 15":"e.g. 7"}/>
                  {poiError && <div className="mt-1 text-red-500 text-xs">⚠ {poiError}</div>}
                </div>
                <div>
                  <FL>Direction</FL>
                  <div className="flex gap-2">
                    {[["bearish","↓ Bearish"],["bullish","↑ Bullish"]].map(([v,l])=>(
                      <button key={v} onClick={()=>setPoiDir(v)}
                        className={`flex-1 py-1.5 text-xs rounded border cursor-pointer transition-colors ${
                          poiDir===v
                            ? v==="bearish"?"border-red-700 bg-red-950/30 text-red-400":"border-green-700 bg-green-950/30 text-green-400"
                            : "border-gray-700 text-gray-600 hover:border-gray-500"
                        }`}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
              {poiBiasConflict && (
                <div className="mb-3 text-xs border border-yellow-800 bg-yellow-950/10 text-yellow-500 rounded px-3 py-2">
                  ⚠ Direction conflict — POI is {poiDir} but H4 bias is {h4Bias}. You can proceed but this is a counter-bias trade. Apply extra scrutiny before confirming.
                </div>
              )}
              {poiValid && suggestedModel && (
                <div className="mb-3 border border-gray-700 bg-gray-900 rounded p-2.5">
                  <div className="text-gray-500 text-xs uppercase tracking-wider mb-1.5">Suggested Model</div>
                  <div className="text-gray-200 text-xs font-bold leading-relaxed">{suggestedModel}</div>
                  <div className="mt-2.5">
                    <FL>Override model label (optional)</FL>
                    <Inp value={modelOverride} onChange={setModelOverride} placeholder="Leave blank to accept suggested model"/>
                  </div>
                </div>
              )}
              <button onClick={()=>{ if(poiValid) advancePipe(); }} disabled={!poiValid}
                className={`w-full py-1.5 text-xs rounded border cursor-pointer ${
                  poiValid ? "border-green-700 bg-green-950/30 text-green-400 hover:bg-green-950/50" : "border-gray-800 text-gray-700 cursor-not-allowed"
                }`}>Confirm POI →</button>
            </Panel>
          )}

          {/* ── Stage 05: Liquidity ── */}
          {pipeStage===4 && !blocked && (
            <Panel>
              {stageHeader("05","Liquidity","H1 → M15")}
              <div className="text-gray-200 text-xs mb-1">Which liquidity pools have been swept or are being actively targeted?</div>
              <div className="text-gray-600 text-xs mb-3">Tick all that apply. At least one confirmed pool is required before proceeding.</div>
              <div className="space-y-1.5 mb-3">
                {[
                  "Equal highs/lows swept",
                  "Session high/low taken",
                  "Asia range swept by London",
                  "Frankfurt high/low taken",
                  "Swing high/low cleared",
                  "Stops above/below structure taken",
                  "Trendline liquidity swept",
                  "Previous day high/low taken",
                ].map(item=>(
                  <label key={item} className="flex items-center gap-2 cursor-pointer text-xs select-none">
                    <input type="checkbox" checked={liqChecked.includes(item)}
                      onChange={e=>{ if(e.target.checked) setLiqChecked(p=>[...p,item]); else setLiqChecked(p=>p.filter(x=>x!==item)); }}
                      className="w-3.5 h-3.5 accent-green-500 cursor-pointer"/>
                    <span className={liqChecked.includes(item)?"text-green-400":"text-gray-400"}>{item}</span>
                  </label>
                ))}
              </div>
              {liqChecked.length > 1 && (
                <div className="mb-3 text-xs text-green-700 font-mono">✦ Multi-layer liquidity — stronger probability setup</div>
              )}
              <button onClick={()=>{ if(liqChecked.length>0) advancePipe(); }} disabled={liqChecked.length===0}
                className={`w-full py-1.5 text-xs rounded border cursor-pointer ${
                  liqChecked.length>0 ? "border-green-700 bg-green-950/30 text-green-400 hover:bg-green-950/50" : "border-gray-800 text-gray-700 cursor-not-allowed"
                }`}>Confirm Liquidity →</button>
            </Panel>
          )}

          {/* ── Stage 06: Inducement ── */}
          {pipeStage===5 && !blocked && (
            <Panel>
              {stageHeader("06","Inducement","M15 → M5")}
              <div className="text-gray-200 text-xs mb-2 leading-relaxed">
                {poiDir==="bearish"
                  ? "Has price made a complex push into your supply zone? Asia sellers, London buyers and SMC buyers should all be trapped in the engineered move up into supply."
                  : "Has price made a complex push into your demand zone? Asia buyers, London sellers and SMC sellers should all be trapped in the engineered move down into demand."}
              </div>
              <div className="text-gray-600 text-xs mb-3 leading-relaxed">
                {poiDir==="bearish"
                  ? "The push into supply must look deliberate — multiple legs, sustained pressure, or false breakouts that convince retail it is a real move. If it looks too fast and clean, the trap may not be fully set yet."
                  : "The push into demand must show clear engineering. Multiple participant groups need to be on the wrong side of the market for this to qualify as a high-probability inducement."}
              </div>
              {yesNoButtons(
                ()=>advancePipe(),
                ()=>blockPipe("Inducement not confirmed. The complex push into the zone has not completed. The trap is not fully set. Wait — do not enter before all participant groups have been drawn in."),
                "✓ Inducement confirmed", "✗ Not yet — wait"
              )}
            </Panel>
          )}

          {/* ── Stage 07: Displacement ── */}
          {pipeStage===6 && !blocked && (
            <Panel>
              {stageHeader("07","Displacement","M5")}
              <div className="text-gray-200 text-xs mb-2 leading-relaxed">
                {poiDir==="bearish"
                  ? "Has there been an impulsive bearish move away from supply, leaving a visible FVG or imbalance?"
                  : "Has there been an impulsive bullish move away from demand, leaving a visible FVG or imbalance?"}
              </div>
              <div className="text-gray-600 text-xs mb-3 leading-relaxed">
                The displacement must be aggressive, multi-candle, and one-directional. Slow drift does not count.
                A Fair Value Gap must be visible — a three-candle pattern where the middle candle leaves a gap between candle 1 and candle 3.
                If no FVG is present, the displacement lacks structural evidence of institutional intent.
              </div>
              {yesNoButtons(
                ()=>advancePipe(),
                ()=>blockPipe("Displacement not confirmed. The move lacks impulse or no FVG is visible. A slow grind does not qualify — wait for an impulsive, one-directional break that leaves a clear imbalance on the chart."),
                "✓ Impulsive + FVG confirmed", "✗ Weak or no FVG"
              )}
            </Panel>
          )}

          {/* ── Stage 08: Failure Model ── */}
          {pipeStage===7 && !blocked && (
            <Panel>
              {stageHeader("08","Failure Model","M5 → M1")}
              <div className="text-gray-200 text-xs mb-2 leading-relaxed">
                {poiDir==="bearish"
                  ? "After the first leg down — has price retraced and failed to make a new higher high?"
                  : "After the first leg up — has price retraced and failed to make a new lower low?"}
              </div>
              <div className="text-gray-600 text-xs mb-3 leading-relaxed">
                {poiDir==="bearish"
                  ? "Model: first leg down → retracement → push back up → fails to exceed previous high → No Higher High confirmed. If price makes a new HH, the failure model has not occurred — stand down."
                  : "Model: first leg up → retracement → pulls back down → fails to exceed previous low → No Lower Low confirmed. If price makes a new LL, the failure model has not occurred — stand down."}
              </div>
              {yesNoButtons(
                ()=>advancePipe(),
                ()=>blockPipe(poiDir==="bearish"
                  ? "Failure model not confirmed — price has made a new higher high. The bearish failure has not occurred. The model is not valid at this point. Wait or stand down."
                  : "Failure model not confirmed — price has made a new lower low. The bullish failure has not occurred. The model is not valid at this point. Wait or stand down."),
                poiDir==="bearish" ? "✓ No HH — failure confirmed" : "✓ No LL — failure confirmed",
                poiDir==="bearish" ? "✗ New HH made" : "✗ New LL made"
              )}
            </Panel>
          )}

          {/* ── Stage 09: BOS / CHoCH ── */}
          {pipeStage===8 && !blocked && (
            <Panel>
              {stageHeader("09","BOS / CHoCH","M5 → M1")}
              <div className="text-gray-200 text-xs mb-2 leading-relaxed">
                {poiDir==="bearish"
                  ? "Has there been an internal BOS or CHoCH to the downside after the failed swing high?"
                  : "Has there been an internal BOS or CHoCH to the upside after the failed swing low?"}
              </div>
              <div className="text-gray-600 text-xs mb-3 leading-relaxed">
                {poiDir==="bearish"
                  ? "After the No HH, price must break the most recent internal swing low. This structural break confirms market intent has shifted to bearish and unlocks the RIFC entry phase. Without a BOS you cannot enter — waiting at the zone is not confirmation."
                  : "After the No LL, price must break the most recent internal swing high. This structural break confirms market intent has shifted to bullish. Without a BOS the model is incomplete — do not enter."}
              </div>
              {yesNoButtons(
                ()=>advancePipe(),
                ()=>blockPipe("No BOS or CHoCH confirmed. Structure has not shifted yet. The failure is there but the follow-through is not. Do not enter — wait for the structural break before moving to the entry phase."),
                "✓ BOS / CHoCH confirmed", "✗ Not yet"
              )}
            </Panel>
          )}

          {/* ══ ENTRY PHASE ══ */}
          {pipeStage>=9 && !blocked && (
            <div className="space-y-3">
              <Panel>
                <SH>Entry Phase — RIFC Zone Active</SH>
                <div className="space-y-1.5 mb-4">
                  {[
                    { l:"Zone",      v:"Origin of BOS move — OB or FVG" },
                    { l:"Timeframe", v:"M1 for trigger entry" },
                    { l:"Trigger",   v:"M1 CHoCH or Engulf candle — whichever comes first" },
                    { l:"Stop",      v:"1.5–5p beyond the liquidity sweep" },
                    { l:"Min RR",    v:"1:5 minimum — no exceptions" },
                    { l:"Direction", v:poiDir==="bearish"?"SHORT ↓":"LONG ↑",
                      cls:poiDir==="bearish"?"text-red-400 font-bold":"text-green-400 font-bold" },
                    { l:"H4 Bias",   v:h4Bias.charAt(0).toUpperCase()+h4Bias.slice(1),
                      cls:h4Bias==="bearish"?"text-red-400":h4Bias==="bullish"?"text-green-400":"text-gray-400" },
                    { l:"Model",     v:modelOverride||suggestedModel, cls:"text-gray-300" },
                  ].map(row=>(
                    <div key={row.l} className="flex items-start gap-3 px-2.5 py-1.5 rounded border border-gray-800 bg-gray-900/40">
                      <span className="text-gray-600 text-xs w-24 shrink-0">{row.l}</span>
                      <span className={`text-xs font-mono leading-relaxed ${row.cls||"text-gray-400"}`}>{row.v}</span>
                    </div>
                  ))}
                </div>
                <div className="border border-gray-800/50 rounded p-2 text-center text-xs text-gray-700 bg-gray-900/30">
                  "We do not trade setups. We trade <span className="text-red-600">failed moves</span>. They enter at the trap. We enter after the failure."
                </div>
              </Panel>

              <div className="border border-green-700 bg-green-950/30 rounded-sm p-4 text-center">
                <div className="text-green-400 font-bold text-lg tracking-widest">🟢 VALID TRADE</div>
                <div className="text-green-700 text-xs mt-1">Full pipeline confirmed — execute at RIFC zone on M1 trigger</div>
                <div className={`mt-3 text-sm font-bold font-mono ${poiDir==="bearish"?"text-red-400":"text-green-400"}`}>
                  {poiDir==="bearish"?"↓ SHORT":"↑ LONG"} · Stop 1.5–5p · Min RR 1:5
                </div>
              </div>

              {onSaveToJournal && (
                <button onClick={()=>{
                  const liqDisplayToKey = {
                    "Equal highs/lows swept":          "eq_high",
                    "Session high/low taken":           "sess_high",
                    "Asia range swept by London":       "internal",
                    "Frankfurt high/low taken":         "frankfurt_h",
                    "Swing high/low cleared":           "swing_hl",
                    "Stops above/below structure taken":"eq_low",
                    "Trendline liquidity swept":        "trendline",
                    "Previous day high/low taken":      "hopd",
                  };
                  const sessKey =
                    sessionInfo.name.includes("Frankfurt")    ? "frankfurt"    :
                    sessionInfo.name.includes("London Open")  ? "london"       :
                    sessionInfo.name.includes("NY 1PM")       ? "ny1pm"        :
                    sessionInfo.name.includes("NY 2nd Hour")  ? "ny2"          :
                    sessionInfo.name.includes("NY PM")        ? "ny1pm"        :
                    sessionInfo.name.includes("Lunch")        ? "london_lunch" : "";
                  const liqKeys = liqChecked.map(i=>liqDisplayToKey[i]).filter(Boolean);
                  const liqLabel = liqChecked.slice(0,2).join(" + ")+(liqChecked.length>2?` +${liqChecked.length-2} more`:"");
                  onSaveToJournal({
                    pair:            tradePairs[0] || pairs.filter(p=>p!=="DXY")[0] || "EURUSD",
                    setupType:       poiDir==="bearish" ? "reversal_bear" : "reversal_bull",
                    session:         sessKey,
                    htfBias:         h4Bias,
                    rangeLoc:        poiDir==="bearish" ? "premium" : "discount",
                    poiType:         poiIsHTF ? "htf" : "ltf",
                    poiSizePips:     poiPips,
                    poiLocation:     `${poiTF} POI · ${poiPips}p · ${poiDir}`,
                    liquidityType:   liqKeys,
                    trapClarity:     "clear",
                    dispQuality:     "strong",
                    fvgPresent:      "yes",
                    failType:        poiDir==="bearish" ? "no_hh" : "no_ll",
                    firstLeg:        true,
                    bosStatus:       "yes",
                    entryAtOrigin:   "yes",
                    ltfConfirm:      "m1_choch",
                    notes:           `Live Mode — ${modelOverride||suggestedModel}`,
                    grade:           "A",
                    pipelineSnapshot:{
                      POI:    { s:"PASS", r:`${poiTF} POI · ${poiPips}p · ${poiDir} — confirmed` },
                      TIME:   { s:"PASS", r:`Session confirmed — ${sessionInfo.name}` },
                      LIQ:    { s:"PASS", r:`Liquidity — ${liqLabel||"confirmed"}` },
                      INDUCE: { s:"PASS", r:"Inducement confirmed — complex push into zone" },
                      DISP:   { s:"PASS", r:"Displacement confirmed — impulsive move, FVG present" },
                      FAIL:   { s:"PASS", r:`Failure confirmed — ${poiDir==="bearish"?"No Higher High":"No Lower Low"}` },
                      BOS:    { s:"PASS", r:"BOS / CHoCH confirmed — structure shifted" },
                      RIFC:   { s:"PASS", r:"Live Mode pipeline complete — entry phase active" },
                    },
                  });
                }}
                  className="w-full py-2 text-xs border border-gray-700 bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-gray-200 rounded cursor-pointer transition-colors uppercase tracking-wider">
                  + Save to Trade Journal
                </button>
              )}
            </div>
          )}

        </div>
      )}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: TRADE JOURNAL
// ═══════════════════════════════════════════════════════════════════════

function JournalTab({ journal, setJournal, journalLoading, journalError, livePreFill, clearLivePreFill, addTrade }) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState({});
  const [lightbox, setLightbox] = useState(null);

  // Live Mode pre-fill form state
  const [liveForm, setLiveForm]     = useState({ outcome:"win", rAchieved:"", notes:"", images:[] });
  const [liveImages, setLiveImages] = useState([]);
  const handleLiveImage = (e) => {
    Array.from(e.target.files).slice(0,2).forEach(f=>{
      const r = new FileReader();
      r.onload = ev => setLiveImages(p=>[...p, ev.target.result].slice(0,2));
      r.readAsDataURL(f);
    });
  };
  const modelLabel = { reversal_bull:"Bull Rev", reversal_bear:"Bear Rev", cont_bull:"Bull Cont", cont_bear:"Bear Cont" };
  const STEP_LABEL = { POI:"POI", TIME:"Time", LIQ:"Liquidity", INDUCE:"Inducement", DISP:"Displacement", FAIL:"Failure", BOS:"BOS/CHoCH", RIFC:"Entry" };
  const sIcon = s => s==="PASS"?"✅":s==="FORMING"?"⚠️":s==="FAIL"?"❌":"○";
  const toggleExpand = (id) => setExpanded(p=>({...p,[id]:!p[id]}));

  const filtered = journal.filter(t=>
    !filter||t.setupType===filter||t.outcome===filter||t.session===filter
  ).slice().reverse();

  const del = async (id) => {
    const { error } = await supabase
      .from('trades')
      .delete()
      .eq('id', id);
    if (error) {
      alert('Failed to delete trade: ' + error.message);
    } else {
      setJournal(prev => prev.filter(t => t.id !== id));
    }
  };

  if (journalLoading) {
    return (
      <div className="text-gray-600 text-xs py-6 text-center font-mono">Loading trades…</div>
    );
  }

  if (journalError) {
    return (
      <div className="text-red-500 text-xs py-6 text-center font-mono border border-red-900 rounded bg-red-950/20 px-4">
        ⚠ Could not load trades — {journalError}<br/>
        <span className="text-gray-600">Check your connection and reload the page.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">

      {/* ── Live Mode pre-fill form ── */}
      {livePreFill && (
        <Panel>
          <SH>Live Mode Entry — Review &amp; Save</SH>
          <div className="mb-3 text-xs text-blue-400 border border-blue-900 bg-blue-950/20 rounded px-3 py-2">
            ● Pre-filled from Live Mode pipeline. Review all fields, add your outcome and notes, then save.
          </div>

          {/* Pre-filled summary */}
          <div className="space-y-1 mb-3 border border-gray-800 rounded p-2.5">
            {[
              { l:"Pair",       v:livePreFill.pair },
              { l:"Setup",      v:{reversal_bear:"Bearish Reversal",reversal_bull:"Bullish Reversal",cont_bull:"Bullish Continuation",cont_bear:"Bearish Continuation"}[livePreFill.setupType]||livePreFill.setupType },
              { l:"Session",    v:livePreFill.session },
              { l:"HTF Bias",   v:livePreFill.htfBias },
              { l:"Direction",  v:livePreFill.rangeLoc==="premium"?"SHORT ↓":"LONG ↑" },
              { l:"POI",        v:`${livePreFill.poiLocation} (${livePreFill.poiType?.toUpperCase()})` },
              { l:"Liquidity",  v:livePreFill.liquidityType?.join(", ")||"—" },
              { l:"Model",      v:livePreFill.notes?.replace("Live Mode — ","")||"—" },
            ].map(row=>(
              <div key={row.l} className="flex gap-3 text-xs">
                <span className="text-gray-600 w-20 shrink-0">{row.l}</span>
                <span className="text-gray-400">{row.v}</span>
              </div>
            ))}
          </div>

          {/* Pipeline snapshot preview */}
          {livePreFill.pipelineSnapshot && (
            <div className="mb-3 border border-gray-800 rounded p-2 space-y-0.5">
              <div className="text-gray-600 text-xs uppercase tracking-wider mb-1.5">Pipeline — all stages passed</div>
              {Object.entries(livePreFill.pipelineSnapshot).map(([step,r])=>(
                <div key={step} className="flex items-start gap-1.5 text-xs">
                  <span>✅</span>
                  <span className="text-gray-600 w-16 shrink-0">{{POI:"POI",TIME:"Time",LIQ:"Liquidity",INDUCE:"Inducement",DISP:"Displacement",FAIL:"Failure",BOS:"BOS/CHoCH",RIFC:"Entry"}[step]}</span>
                  <span className="text-green-700">{r.r}</span>
                </div>
              ))}
            </div>
          )}

          {/* Outcome + R */}
          <div className="space-y-2.5">
            <div><FL>Outcome</FL>
              <Sel value={liveForm.outcome} onChange={v=>setLiveForm(p=>({...p,outcome:v}))} placeholder=""
                options={[["win","Win"],["loss","Loss"],["be","Break Even"]]}/>
            </div>
            <div><FL>R Achieved</FL>
              <Inp type="number" value={liveForm.rAchieved} onChange={v=>setLiveForm(p=>({...p,rAchieved:v}))} placeholder="e.g. 6.5"/>
            </div>
            <div><FL>Notes — add your own observations</FL>
              <textarea value={liveForm.notes} onChange={e=>setLiveForm(p=>({...p,notes:e.target.value}))}
                rows={3} placeholder="What did this trade teach you?"
                className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none placeholder-gray-700 resize-none"/>
            </div>
            <div>
              <FL>Screenshots (optional, max 2)</FL>
              <label className="flex items-center gap-2 cursor-pointer bg-gray-900 border border-gray-700 border-dashed rounded px-3 py-2 text-gray-500 hover:border-gray-500 text-xs">
                <span>📎 Attach image(s)</span>
                <input type="file" accept="image/png,image/jpeg,image/jpg" multiple className="hidden" onChange={handleLiveImage}/>
              </label>
              {liveImages.length>0&&(
                <div className="flex gap-2 mt-2">
                  {liveImages.map((img,i)=>(
                    <div key={i} className="relative group">
                      <img src={img} alt="" className="w-16 h-16 object-cover rounded border border-gray-700"/>
                      <button onClick={()=>setLiveImages(p=>p.filter((_,j)=>j!==i))}
                        className="absolute -top-1 -right-1 bg-red-900 text-red-300 rounded-full w-4 h-4 text-xs flex items-center justify-center cursor-pointer hidden group-hover:flex">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={()=>{
                if(addTrade) addTrade({
                  ...livePreFill,
                  outcome:    liveForm.outcome,
                  rAchieved:  parseFloat(liveForm.rAchieved)||0,
                  notes:      liveForm.notes || livePreFill.notes || "",
                  images:     liveImages,
                  savedAt:    new Date().toISOString(),
                  isBacktest: false,
                });
                clearLivePreFill();
                setLiveForm({ outcome:"win", rAchieved:"", notes:"", images:[] });
                setLiveImages([]);
              }} className="flex-1 bg-green-950 hover:bg-green-900 border border-green-800 text-green-400 py-1.5 rounded text-xs cursor-pointer">
                Save Trade
              </button>
              <button onClick={()=>{ clearLivePreFill(); setLiveForm({ outcome:"win", rAchieved:"", notes:"", images:[] }); setLiveImages([]); }}
                className="px-4 bg-gray-900 border border-gray-700 text-gray-500 py-1.5 rounded text-xs cursor-pointer">
                Cancel
              </button>
            </div>
          </div>
        </Panel>
      )}

      <Panel>
        <SH>Trade Journal ({journal.length} trade{journal.length!==1?"s":""})</SH>
        <div className="flex gap-2 mb-3 flex-wrap">
          {[["","All"],["reversal_bull","Bull Rev"],["reversal_bear","Bear Rev"],["cont_bull","Bull Cont"],["cont_bear","Bear Cont"],["Win","Wins"],["Loss","Losses"],["Break Even","BE"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)}
              className={`px-2.5 py-1 rounded text-xs border cursor-pointer transition-colors ${filter===v?"border-green-700 text-green-400":"border-gray-700 text-gray-500 hover:border-gray-600"}`}>
              {l}
            </button>
          ))}
        </div>

        {filtered.length===0&&(
          <div className="text-center py-6 text-gray-600 text-xs">
            No trades logged yet. Complete a setup evaluation and click "Save to Trade Journal".
          </div>
        )}

        {lightbox&&(
          <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" onClick={()=>setLightbox(null)}>
            <img src={lightbox} alt="" className="max-w-full max-h-full rounded shadow-2xl"/>
            <button className="absolute top-4 right-4 text-white text-lg cursor-pointer">✕</button>
          </div>
        )}

        <div className="space-y-2">
          {filtered.map(t=>(
            <div key={t.id} className={`border rounded-sm p-3 ${t.outcome==="Win"?"border-green-900":t.outcome==="Loss"?"border-red-900":"border-gray-800"}`}>
              {/* Header row */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-bold text-sm ${t.outcome==="Win"?"text-green-400":t.outcome==="Loss"?"text-red-400":"text-gray-500"}`}>
                    {t.outcome==="Win"?"W":t.outcome==="Loss"?"L":"BE"}
                  </span>
                  <span className={`font-bold text-xs ${parseFloat(t.rAchieved)>0?"text-green-500":parseFloat(t.rAchieved)<0?"text-red-500":"text-gray-500"}`}>
                    {parseFloat(t.rAchieved)>0?"+":""}{t.rAchieved}R
                  </span>
                  <span className="text-gray-600 text-xs">{modelLabel[t.setupType]||t.setupType}</span>
                  <span className="text-gray-700 text-xs">|</span>
                  <span className="text-gray-600 text-xs">{t.session}</span>
                  <span className="text-gray-700 text-xs">|</span>
                  <span className={`text-xs ${{"A+":"text-green-300","A":"text-green-500","B":"text-yellow-400"}[t.grade]||"text-red-500"}`}>{t.grade}</span>
                  {t.isBacktest&&<span className="text-yellow-700 text-xs border border-yellow-900 rounded px-1">BACKTEST</span>}
                </div>
                <button onClick={()=>del(t.id)} className="text-gray-700 hover:text-red-600 text-xs cursor-pointer">✕</button>
              </div>

              {/* Sub-header */}
              <div className="mt-1 text-xs text-gray-600">
                {t.pair}
                {t.htfBias ? ` | ${t.htfBias}` : ''}
                {t.direction ? ` ${t.direction}` : ''}
                {t.trapClarity ? ` | ${t.trapClarity} trap` : ''}
                {' | '}{t.date
                  ? new Date(t.date + 'T00:00:00').toLocaleDateString()
                  : t.savedAt
                    ? new Date(t.savedAt).toLocaleDateString()
                    : '—'}
              </div>

              {/* Notes */}
              {t.notes&&<div className="mt-1.5 text-xs text-gray-500 italic">"{t.notes}"</div>}

              {/* Pipeline Snapshot + Full Trade Details */}
              {t.pipelineSnapshot&&Object.keys(t.pipelineSnapshot).length>0&&(
                <div className="mt-2 space-y-1.5">
                  {/* Pipeline expand */}
                  <button onClick={()=>toggleExpand(t.id+"_pipe")}
                    className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-400 cursor-pointer">
                    <span>{expanded[t.id+"_pipe"]?"▾":"▸"}</span>
                    <span>Pipeline Snapshot</span>
                    <span className="text-gray-700">({Object.values(t.pipelineSnapshot).filter(v=>v.s==="PASS").length}/8 passed)</span>
                  </button>
                  {expanded[t.id+"_pipe"]&&(
                    <div className="mt-1 space-y-0.5 border border-gray-800 rounded p-2">
                      {["POI","TIME","LIQ","INDUCE","DISP","FAIL","BOS","RIFC"].map(step=>{
                        const r=t.pipelineSnapshot[step];
                        if(!r) return null;
                        return (
                          <div key={step} className="flex items-start gap-1.5 text-xs">
                            <span>{sIcon(r.s)}</span>
                            <span className="text-gray-600 w-16 shrink-0">{STEP_LABEL[step]}</span>
                            <span className={`${r.s==="PASS"?"text-green-700":r.s==="FORMING"?"text-yellow-700":r.s==="FAIL"?"text-red-600":"text-gray-600"}`}>{r.r}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Full trade details expand */}
                  <button onClick={()=>toggleExpand(t.id+"_detail")}
                    className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-400 cursor-pointer">
                    <span>{expanded[t.id+"_detail"]?"▾":"▸"}</span>
                    <span>Full Trade Details</span>
                  </button>
                  {expanded[t.id+"_detail"]&&(
                    <div className="mt-1 border border-gray-800 rounded p-3 space-y-2 text-xs">
                      {/* Setup */}
                      <div className="border-b border-gray-800/60 pb-2">
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Setup</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                          <div><span className="text-gray-600">Pair: </span>{t.pair||"—"}</div>
                          <div><span className="text-gray-600">Setup: </span>{modelLabel[t.setupType]||t.setupType||"—"}</div>
                          <div><span className="text-gray-600">HTF Bias: </span>{t.htfBias||"—"}</div>
                          <div><span className="text-gray-600">Range Loc: </span>{t.rangeLoc||"—"}</div>
                        </div>
                      </div>
                      {/* POI */}
                      <div className="border-b border-gray-800/60 pb-2">
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Point of Interest</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                          <div className="col-span-2"><span className="text-gray-600">POI: </span>{t.poiLocation||"—"}</div>
                          <div><span className="text-gray-600">Size: </span>{t.poiSizePips?`${t.poiSizePips}p`:"—"}</div>
                          <div><span className="text-gray-600">Type: </span>{t.poiType==="htf"?"HTF":t.poiType==="ltf"?"LTF":"—"}</div>
                          <div className="col-span-2 text-gray-600">M5: {[t.m5Build&&"Buildup",t.m5Ind&&"Inducement",t.m5Push&&"Push-out"].filter(Boolean).join(" + ")||"None confirmed"}</div>
                        </div>
                      </div>
                      {/* Liquidity */}
                      <div className="border-b border-gray-800/60 pb-2">
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Liquidity</div>
                        <div className="text-gray-400">{t.liquidity||"—"}</div>
                        {t.multiLayerTrap&&<div className="text-green-700 mt-0.5">✦ Multi-layer trap</div>}
                      </div>
                      {/* Trap Story */}
                      <div className="border-b border-gray-800/60 pb-2">
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Trap Story</div>
                        <div className="text-gray-400 leading-relaxed">{t.trapWho||"—"}</div>
                        <div className="mt-1"><span className="text-gray-600">Clarity: </span><span className={t.trapClarity==="clear"?"text-green-500":t.trapClarity==="forming"?"text-yellow-500":"text-red-500"}>{t.trapClarity||"—"}</span></div>
                      </div>
                      {/* Displacement */}
                      <div className="border-b border-gray-800/60 pb-2">
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Displacement</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                          <div><span className="text-gray-600">Quality: </span>{t.dispQuality||"—"}</div>
                          <div><span className="text-gray-600">FVG: </span>{t.fvgPresent||"—"}</div>
                        </div>
                      </div>
                      {/* Failure + BOS */}
                      <div className="border-b border-gray-800/60 pb-2">
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Failure Model + BOS</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                          <div><span className="text-gray-600">Type: </span>{t.failType||"—"}</div>
                          <div><span className="text-gray-600">BOS: </span>{t.bosStatus||"—"}</div>
                          <div><span className="text-gray-600">1st Leg: </span>{t.firstLeg?"✓":"✗"}</div>
                          <div><span className="text-gray-600">2nd Leg: </span>{t.secondLeg?"✓":"✗"}</div>
                        </div>
                      </div>
                      {/* Entry */}
                      <div>
                        <div className="text-gray-500 uppercase tracking-widest mb-1.5">Entry</div>
                        <div className="text-gray-400 mb-1">{t.entryIdea||"—"}</div>
                        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-gray-400">
                          <div><span className="text-gray-600">Stop: </span>{t.stopPips?`${t.stopPips}p`:"—"}</div>
                          <div><span className="text-gray-600">Risk: </span>{t.riskPct?`${t.riskPct}%`:"—"}</div>
                          <div><span className="text-gray-600">RR: </span>{t.estRR?`1:${t.estRR}`:"—"}</div>
                          <div className="col-span-3"><span className="text-gray-600">LTF Confirm: </span>{t.ltfConfirm||"—"}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Screenshots */}
              {Array.isArray(t.screenshots)&&t.screenshots.length>0&&(
                <div className="mt-2 flex gap-2">
                  {t.screenshots.map((img,i)=>(
                    <img key={i} src={img} alt="" className="w-16 h-16 object-cover rounded border border-gray-700 cursor-pointer hover:border-gray-500"
                      onClick={()=>setLightbox(img)}/>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {journal.length>0&&(
          <button onClick={async ()=>{
            if (!window.confirm("Clear all journal entries? This cannot be undone.")) return;
            const { error } = await supabase.from('trades').delete().neq('id', '00000000-0000-0000-0000-000000000000');
            if (error) { alert('Failed to clear trades: ' + error.message); }
            else { setJournal([]); }
          }} className="mt-3 text-xs text-red-800 hover:text-red-600 cursor-pointer">
            Clear all journal entries
          </button>
        )}
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: ANALYTICS
// ═══════════════════════════════════════════════════════════════════════

function AnalyticsTab({ journal }) {
  const stats = useMemo(()=>computeStats(journal),[journal]);
  const weaknesses = useMemo(()=>detectWeaknesses(stats),[stats]);

  const [evalCount, setEvalCount] = useState(null);
  const [failData,  setFailData]  = useState([]);

  useEffect(()=>{
    supabase.from('evaluations').select('*', { count:'exact', head:true })
      .then(({ count }) => setEvalCount(count ?? 0));
    supabase.from('evaluations').select('failed_at').eq('evaluation_result','NO TRADE')
      .then(({ data }) => {
        if (!data) return;
        const tally = {};
        data.forEach(r => { if (r.failed_at) tally[r.failed_at] = (tally[r.failed_at]||0)+1; });
        const ORDER  = ['POI','TIME','LIQ','INDUCE','DISP','FAIL','BOS','RIFC'];
        const LABELS = { POI:'POI', TIME:'Time', LIQ:'Liquidity', INDUCE:'Inducement', DISP:'Displacement', FAIL:'Failure', BOS:'BOS/CHoCH', RIFC:'Entry' };
        setFailData(ORDER.filter(s=>tally[s]!=null).map(s=>({ step:LABELS[s]||s, count:tally[s] })));
      });
  }, []);

  const total = journal.length;
  const wins  = journal.filter(t=>t.outcome==="Win").length;
  const losses= journal.filter(t=>t.outcome==="Loss").length;
  const be    = journal.filter(t=>t.outcome==="Break Even").length;
  const decided = wins+losses;
  const wr = decided>0 ? Math.round(wins/decided*100) : null;
  const totalR = journal.reduce((s,t)=>s+(parseFloat(t.rAchieved)||0),0);

  const MIN_RELIABLE_N = 30;
  const StatsTable = ({title, data, showSampleWarning=false}) => {
    const entries = Object.entries(data).sort((a,b)=>b[1].n-a[1].n);
    if (!entries.length) return null;
    return (
      <div className="mb-4">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">{title}</div>
        <div className="space-y-1">
          {entries.map(([key, s])=>{
            const wr = s.winRate!==null ? Math.round(s.winRate*100) : null;
            const isWeak = wr!==null && s.n>=3 && wr<45;
            const isStrong = wr!==null && s.n>=3 && wr>75;
            const smallSample = showSampleWarning && s.n < MIN_RELIABLE_N;
            return (
              <div key={key} className={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs ${isWeak?"border-red-900 bg-red-950/10":isStrong?"border-green-900 bg-green-950/10":"border-gray-800"}`}>
                <div className={`flex-shrink-0 w-2 h-2 rounded-full ${isWeak?"bg-red-500":isStrong?"bg-green-500":"bg-gray-600"}`}></div>
                <div className="flex-1 text-gray-400">{key}</div>
                <div className="text-gray-600">{s.n}T</div>
                <div className={`font-bold ${wr===null?"text-gray-600":wr>=60?"text-green-400":wr>=45?"text-yellow-400":"text-red-400"}`}>
                  {wr!==null?`${wr}% WR`:"—"}
                </div>
                <div className={`${s.avgR!==null&&s.avgR>0?"text-green-600":"text-red-600"}`}>
                  {s.avgR!==null?`${s.avgR>0?"+":""}${s.avgR.toFixed(1)}R avg`:""}
                </div>
                {smallSample && <div className="text-xs text-yellow-800 border border-yellow-900 rounded px-1 shrink-0">⚠ &lt;30</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  if (total<1) return (
    <Panel>
      <SH>Analytics</SH>
      <div className="text-center py-6 text-gray-600 text-xs">No trades in journal yet. Start logging trades to see analytics.</div>
    </Panel>
  );

  return (
    <div className="space-y-3">
      <Panel>
        <SH>Overall Performance ({total} trades)</SH>
        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            {l:"Win Rate", v:wr!==null?`${wr}%`:"—", c:wr!==null&&wr>=60?"text-green-400":wr!==null&&wr>=45?"text-yellow-400":"text-red-400"},
            {l:"Wins / Losses", v:`${wins} / ${losses}`, c:"text-gray-200"},
            {l:"Total R", v:`${totalR>0?"+":""}${totalR.toFixed(1)}R`, c:totalR>0?"text-green-400":"text-red-400"},
            {l:"BE", v:be, c:"text-gray-400"},
          ].map(item=>(
            <div key={item.l} className="bg-gray-900 border border-gray-800 rounded p-2.5 text-center">
              <div className="text-xs text-gray-600 uppercase">{item.l}</div>
              <div className={`font-bold text-sm mt-0.5 ${item.c}`}>{item.v}</div>
            </div>
          ))}
        </div>

        {evalCount!==null&&(
          <div className="mb-4 flex items-center gap-3 flex-wrap text-xs border border-gray-800 rounded px-3 py-2.5">
            <span className="text-gray-500 uppercase tracking-wider">Evaluations</span>
            <span className="text-gray-200 font-bold">{evalCount}</span>
            <span className="text-gray-700">·</span>
            <span className="text-gray-500 uppercase tracking-wider">Trades Taken</span>
            <span className="text-gray-200 font-bold">{total}</span>
            <span className="text-gray-700">·</span>
            <span className="text-gray-500 uppercase tracking-wider">Conversion</span>
            <span className={`font-bold ${evalCount>0&&Math.round(total/evalCount*100)>=25?"text-green-400":"text-yellow-500"}`}>
              {evalCount>0?`${Math.round(total/evalCount*100)}%`:"—"}
            </span>
          </div>
        )}

        {weaknesses.length>0&&(
          <div className="mb-4 border border-red-900 bg-red-950/10 rounded p-3">
            <div className="text-xs text-red-500 font-bold uppercase tracking-wider mb-2">Personal Weaknesses (auto-detected)</div>
            {weaknesses.map((w,i)=>(
              <div key={i} className="text-xs text-red-600 mt-1">⚠️ {w.msg}</div>
            ))}
          </div>
        )}

        <StatsTable title="By Setup Type"  data={stats.bySetupType} showSampleWarning={true}/>
        <StatsTable title="By Session"     data={stats.bySession}/>
        <StatsTable title="By Trap Clarity" data={stats.byTrapClarity}/>
        <StatsTable title="By LTF Confirm" data={stats.byLtfConfirm}/>
        <StatsTable title="By Grade"       data={stats.byGrade}/>
        <StatsTable title="By Displacement" data={stats.byDispQuality}/>
        <StatsTable title="By Trap Layers" data={stats.byMultiLayer}/>

        <div className="text-xs text-gray-700 mt-2">
          🟢 Strong (≥3 trades, {">"}75% WR) &nbsp;|&nbsp; 🔴 Weak (≥3 trades, {"<"}45% WR) &nbsp;|&nbsp; Adaptive grading adjusts based on these stats.
        </div>
      </Panel>

      {failData.length>0&&(
        <Panel>
          <SH>Pipeline Failure Frequency</SH>
          <div className="text-xs text-gray-600 mb-3">Steps where evaluations ended as NO TRADE</div>
          {(()=>{
            const maxC = Math.max(...failData.map(d=>d.count));
            return (
              <div className="space-y-2">
                {failData.map(d=>(
                  <div key={d.step} className="flex items-center gap-3 text-xs">
                    <div className="w-24 text-right text-gray-500 shrink-0">{d.step}</div>
                    <div className="flex-1 bg-gray-900 rounded overflow-hidden h-6 border border-gray-800">
                      <div
                        className="h-full bg-red-900/60 flex items-center justify-end pr-2 rounded"
                        style={{width:`${Math.round(d.count/maxC*100)}%`, minWidth:'2rem'}}
                      >
                        <span className="text-red-400 font-bold">{d.count}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Panel>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// DISCIPLINE PANEL (always visible at bottom)
// ═══════════════════════════════════════════════════════════════════════

function DisciplinePanel({ disc, setDisc, tradeLog, setTradeLog }) {
  const discEval = checkDiscipline(disc);
  const addResult = (r)=>{
    if (discEval.locked) return;
    const next = { trades:disc.trades+1, pnl:+(disc.pnl+r).toFixed(1) };
    setDisc(next);
    setTradeLog(prev=>[...prev,{ n:next.trades, r, time:new Date().toLocaleTimeString() }]);
  };
  return (
    <div className="mx-3 mb-3 bg-gray-950 border border-gray-800 rounded-sm p-4">
      <SH>Discipline Engine — "One clean trade is enough."</SH>
      <div className="flex items-center gap-5 flex-wrap">
        <div><div className="text-xs text-gray-600 uppercase">Trades</div>
          <div className={`text-xl font-bold mt-0.5 ${disc.trades>=2?"text-red-400":"text-gray-200"}`}>{disc.trades}/2</div></div>
        <div><div className="text-xs text-gray-600 uppercase">PnL</div>
          <div className={`text-xl font-bold mt-0.5 ${disc.pnl>=3?"text-green-400":disc.pnl<0?"text-red-400":"text-gray-200"}`}>{disc.pnl>0?"+":""}{disc.pnl.toFixed(1)}R</div></div>
        <div><div className="text-xs text-gray-600 uppercase">Status</div>
          <div className={`font-bold text-sm mt-0.5 ${discEval.locked?"text-red-400":"text-green-400"}`}>{discEval.locked?"🔴 LOCKED":"🟢 ACTIVE"}</div></div>
        {discEval.reason&&<div className="flex-1"><div className={`text-xs px-3 py-2 rounded border leading-relaxed ${discEval.locked?"border-red-900 text-red-400 bg-red-950/20":"border-yellow-900 text-yellow-500 bg-yellow-950/10"}`}>{discEval.reason}</div></div>}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-gray-600 mr-1">Log:</span>
          {[-1,0,1,2,3,5,7].map(r=>(
            <button key={r} onClick={()=>addResult(r)} disabled={discEval.locked}
              className={`px-2.5 py-1 rounded border text-xs font-mono transition-colors ${discEval.locked?"border-gray-800 text-gray-700 cursor-not-allowed":r>0?"border-green-800 text-green-500 hover:bg-green-950/30 cursor-pointer":r<0?"border-red-800 text-red-500 hover:bg-red-950/30 cursor-pointer":"border-gray-700 text-gray-500 hover:bg-gray-800 cursor-pointer"}`}>
              {r>0?"+":""}{r}R
            </button>
          ))}
          <button onClick={()=>{setDisc({trades:0,pnl:0});setTradeLog([]);}} className="px-2.5 py-1 rounded border border-gray-800 text-gray-600 hover:bg-gray-900 text-xs ml-1 cursor-pointer">Reset Day</button>
        </div>
      </div>
      {tradeLog.length>0&&(
        <div className="mt-3 pt-3 border-t border-gray-900/60">
          <div className="flex gap-1.5 flex-wrap">
            {tradeLog.map((t,i)=>(
              <div key={i} className={`text-xs px-2 py-1 rounded border ${t.r>0?"border-green-900 text-green-700":t.r<0?"border-red-900 text-red-700":"border-gray-800 text-gray-600"}`}>
                T{t.n}: {t.r>0?"+":""}{t.r}R <span className="text-gray-700">@ {t.time}</span>
              </div>
            ))}
            <div className="text-xs text-gray-600 self-center ml-1">Net: <span className={disc.pnl>=0?"text-green-700":"text-red-700"}>{disc.pnl>0?"+":""}{disc.pnl.toFixed(1)}R</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SQS ENGINE + BACKTEST LOG TAB  (Phase 0A.1)
// ═══════════════════════════════════════════════════════════════════════

// ─── Tier / Quality rank maps (used for gate logic) ───────────────────
const BL_TIER_RANK = { 'Tier 1': 3, 'Tier 2': 2, 'Tier 3': 1 };
const BL_DISP_RANK = { 'Strong': 3, 'Moderate': 2, 'Weak': 1 };

// ─── SQS Calculation ──────────────────────────────────────────────────
function calculateSQS(e) {
  let s = 0;
  // Base weights
  s += ({ 'Tier 1': 28, 'Tier 2': 20, 'Tier 3': 10 }[e.liquidity_tier] || 0);
  s += ({ 'Strong': 25, 'Moderate': 14, 'Weak': 6   }[e.displacement_quality] || 0);
  s += ({ 'Clean': 10, 'Induced': 7, 'Partial': 3   }[e.sweep_quality] || 0);
  s += ({ 'CHoCH': 10, 'BOS': 7, 'Unconfirmed': 0   }[e.structure_confirmation] || 0);
  const indW = { 'Structural': 10, 'EQH/EQL Buildup': 9, 'Trendline Tap': 8, 'Stop Hunt': 8, 'Session Open': 7 };
  const indArr = Array.isArray(e.inducement_type) ? e.inducement_type : [];
  if (indArr.length) s += Math.max(...indArr.map(t => indW[t] || 0));
  s += e.bias_aligned ? 8 : 0;
  s += ({ 'M1 CHoCH': 7, 'M1 BOS': 6, 'Engulf': 4, 'None': 0 }[e.ltf_confirmation] || 0);
  s += e.full_sequence_complete ? 7 : 0;
  // Bonuses
  if (e.sequence_type === 'Double Sweep'   && e.secondary_displacement_quality === 'Strong' && !e.second_sweep_override) s += 5;
  if (e.sequence_type === 'Complex Pullback' && e.secondary_displacement_quality === 'Strong' && !e.second_sweep_override) s += 5;
  if (e.sequence_type === 'Multi-Stage Engineered Reversal' && indArr.length >= 2 && e.ltf_confirmation && e.ltf_confirmation !== 'None') s += 3;
  // Penalty
  if (e.second_sweep_override) s -= 8;
  return Math.min(100, Math.max(0, s));
}

function sqsBand(score) {
  if (score >= 85) return { grade:'A+', label:'All major confluence. Take it.',             color:'text-green-300',  ring:'border-green-700'  };
  if (score >= 70) return { grade:'A',  label:'Strong confluence. Valid entry.',             color:'text-green-500',  ring:'border-green-800'  };
  if (score >= 55) return { grade:'B',  label:'Incomplete confluence. Reduced size or skip.',color:'text-yellow-400', ring:'border-yellow-700' };
  if (score >= 40) return { grade:'C',  label:'Significant gaps. Log as NO TRADE.',          color:'text-orange-400', ring:'border-orange-700' };
  return               { grade:'F',  label:'Auto NO TRADE.',                                color:'text-red-500',    ring:'border-red-700'    };
}

// ─── 5-PHASE EVALUATION ENGINE ───────────────────────────────────────
// Returns { p1, p2, p3, p4, p5, total, autoGrade, phaseDetails }
function calculatePhaseScores(e) {
  const isCont = e.model_type === 'Bullish Continuation' || e.model_type === 'Bearish Continuation';
  const isRev  = e.model_type === 'Bullish Reversal'     || e.model_type === 'Bearish Reversal';

  // ── Phase 1: HTF Structure Confirmation (0–20 pts) ──────────────
  let p1 = 0;
  const p1Details = [];
  if (isCont) {
    // 4 checkpoints × 5 pts each = 20
    if (e.p1_hh_ll_breaks_key)     { p1 += 5;  p1Details.push({ label:'HH/LL breaks key level', pass:true }); }
    else                             p1Details.push({ label:'HH/LL breaks key level', pass:false });
    if (e.p1_buildup_created)       { p1 += 5;  p1Details.push({ label:'Buildup / inducement after break', pass:true }); }
    else                             p1Details.push({ label:'Buildup / inducement after break', pass:false });
    if (e.p1_engineered_pullback)   { p1 += 5;  p1Details.push({ label:'Engineered pullback to demand/supply', pass:true }); }
    else                             p1Details.push({ label:'Engineered pullback to demand/supply', pass:false });
    if (e.p1_micro_poi_confirm)     { p1 += 5;  p1Details.push({ label:'Micro-POI tap + strong displacement', pass:true }); }
    else                             p1Details.push({ label:'Micro-POI tap + strong displacement', pass:false });
  } else if (isRev) {
    // 3 checkpoints × ~6.67 pts → rounded: 7+7+6 = 20
    if (e.p1_ll_hh_into_htf)       { p1 += 7;  p1Details.push({ label:'LL/HH confirmed into HTF demand/supply', pass:true }); }
    else                             p1Details.push({ label:'LL/HH confirmed into HTF demand/supply', pass:false });
    if (e.p1_macro_liq_sweep)       { p1 += 7;  p1Details.push({ label:'Macro liquidity sweep (Tier 1)', pass:true }); }
    else                             p1Details.push({ label:'Macro liquidity sweep (Tier 1)', pass:false });
    if (e.p1_displacement_into_poi) { p1 += 6;  p1Details.push({ label:'Displacement into HTF POI', pass:true }); }
    else                             p1Details.push({ label:'Displacement into HTF POI', pass:false });
  } else {
    // Unknown model — partial credit from existing data
    if (e.displacement_quality === 'Strong') p1 += 10;
    else if (e.displacement_quality === 'Moderate') p1 += 5;
    p1Details.push({ label:'Model type needed for full Phase 1 eval', pass: false });
  }

  // ── Phase 2: Inducement + Sweep (0–20 pts) ───────────────────────
  let p2 = 0;
  const p2Details = [];
  // Checkpoint 1 — internal liquidity created (via inducement_type)
  const hasInducement = Array.isArray(e.inducement_type) && e.inducement_type.length > 0;
  if (hasInducement) { p2 += 7; p2Details.push({ label:'Internal liquidity identified', pass:true }); }
  else                 p2Details.push({ label:'Internal liquidity identified', pass:false });
  // Checkpoint 2 — sweep quality (induced = 7pts, partial = 4pts, clean = 0pts continuation, clean = 6pts reversal)
  const sweepDist = parseFloat(e.sweep_distance_pips) || 0;
  const inducedSweep   = sweepDist >= 0.5 && sweepDist <= 2;
  const trapSweep      = sweepDist >= 3   && sweepDist <= 15;
  const contSweepOk    = isCont && inducedSweep;
  const revSweepOk     = isRev  && trapSweep;
  const sweepOk        = contSweepOk || revSweepOk || (!isCont && !isRev && e.sweep_quality === 'Induced');
  if (sweepOk)         { p2 += 7; p2Details.push({ label:`Sweep distance valid (${sweepDist}p)`, pass:true }); }
  else if (e.sweep_quality === 'Induced' || e.sweep_quality === 'Partial')
                       { p2 += 3; p2Details.push({ label:`Sweep distance marginal (${sweepDist}p)`, pass:false }); }
  else                   p2Details.push({ label:`Sweep quality/distance insufficient (${sweepDist}p)`, pass:false });
  // Checkpoint 3 — sweep within 30 min of entry killzone
  const killzoneSess = ['London','NY 1st Hour','NY 2nd Hour'].includes(e.session);
  if (killzoneSess)    { p2 += 6; p2Details.push({ label:'Sweep in killzone session', pass:true }); }
  else                   p2Details.push({ label:'Killzone session not confirmed', pass:false });

  // ── Phase 3: Entry Trigger Confirmation (0–30 pts) ───────────────
  let p3 = 0;
  const p3Details = [];
  // Checkpoint 1 — LTF confirmation present (Engulf, M1 CHoCH, M1 BOS) (10pts)
  const ltfVal = (e.ltf_confirmation || '').toLowerCase();
  const hasLtfConfirm = ltfVal === 'm1 choch' || ltfVal === 'm1 bos' || ltfVal === 'engulf';
  if (hasLtfConfirm)   { p3 += 10; p3Details.push({ label:'LTF confirmation confirmed', pass:true }); }
  else                   p3Details.push({ label:'LTF confirmation not present', pass:false });
  // Checkpoint 2 — Entry inside fresh POI or HTF retest (10pts)
  // Normalise to uppercase for comparison — data may be stored as 'HTF', 'htf', etc.
  const poiTypeNorm = (e.poi_type || '').toUpperCase();
  if (poiTypeNorm === 'HTF')
                       { p3 += 10; p3Details.push({ label:`${isRev?'HTF retest':'Formation'} entry confirmed`, pass:true }); }
  else if (poiTypeNorm === 'LTF')
                       { p3 += 5;  p3Details.push({ label:'LTF POI entry (partial)', pass:false }); }
  else                   p3Details.push({ label:'POI entry type needed', pass:false });
  // Checkpoint 3 — Entry timing = killzone open (10pts)
  const nyKZ       = e.session === 'NY 1st Hour' || e.session === 'NY 2nd Hour';
  const londonKZ   = e.session === 'London';
  if (nyKZ || londonKZ)
                       { p3 += 10; p3Details.push({ label:`Killzone entry (${e.session})`, pass:true }); }
  else                   p3Details.push({ label:'Entry outside killzone window', pass:false });

  // ── Phase 4: Pre-Entry Strength Signal / A+ Upgrade (0–10 pts) ───
  let p4 = 0;
  const p4Details = [];
  if (e.p4_micro_poi_present) { p4 = 10; p4Details.push({ label:'Micro-POI tap + displacement pre-entry', pass:true }); }
  else                          p4Details.push({ label:'Pre-entry signal absent (optional)', pass:false });

  // ── Phase 5: Exit Discipline (0–20 pts) ──────────────────────────
  let p5 = 0;
  const p5Details = [];
  const rAch = parseFloat(e.r_achieved) || 0;
  const rTgt = parseFloat(e.target_rr)  || 0;
  const contMinR   = 10;
  const revMinR    = 5;
  const exitOk     = (isCont && rAch >= contMinR) ||
                     (isRev  && rAch >= revMinR)  ||
                     (e.exit_reason === 'Target Hit');
  if (exitOk)       { p5 += 10; p5Details.push({ label:`Exit at target (${rAch}R achieved)`, pass:true }); }
  else if (rAch > 0){ p5 += 5;  p5Details.push({ label:`Early exit — ${rAch}R (partial)`, pass:false }); }
  else                p5Details.push({ label:'Exit result not yet logged', pass:false });
  // Counterfactual logged
  if (e.counterfactual_notes && e.counterfactual_notes.trim().length > 10)
                     { p5 += 10; p5Details.push({ label:'Counterfactual logged', pass:true }); }
  else               p5Details.push({ label:'Counterfactual not yet logged', pass:false });

  const total = p1 + p2 + p3 + p4 + p5;

  // ── Auto-grade assignment ─────────────────────────────────────────
  let autoGrade = 'No Trade';
  if (total >= 95 && p4 === 10) autoGrade = 'A+';
  else if (total >= 85)         autoGrade = 'A+';
  else if (total >= 70)         autoGrade = 'A';
  else if (total >= 55)         autoGrade = 'B';
  else                          autoGrade = 'No Trade';

  // Phase PASS/FAIL gates override grade
  const p1Pass = p1 >= 15; // ≥75% of 20
  const p2Pass = p2 >= 14; // ≥70% of 20
  const p3Pass = p3 >= 20; // ≥67% of 30
  const p5Pass = p5 >= 10; // ≥50% of 20

  if (!p1Pass || !p2Pass) autoGrade = 'No Trade';
  else if (!p3Pass)        autoGrade = 'No Trade';
  else if (!p5Pass && autoGrade === 'A+') autoGrade = 'A';

  return {
    p1, p2, p3, p4, p5, total, autoGrade,
    p1Pass, p2Pass, p3Pass, p5Pass,
    p1Details, p2Details, p3Details, p4Details, p5Details,
  };
}

function phaseBand(grade) {
  if (grade === 'A+')       return { color:'text-green-300',  ring:'border-green-700',  bg:'bg-green-950/20'  };
  if (grade === 'A')        return { color:'text-green-500',  ring:'border-green-800',  bg:'bg-green-950/20'  };
  if (grade === 'B')        return { color:'text-yellow-400', ring:'border-yellow-700', bg:'bg-yellow-950/20' };
  return                           { color:'text-red-400',    ring:'border-red-800',    bg:'bg-red-950/20'    };
}

// ─── Blank entry template ─────────────────────────────────────────────
const BL_EMPTY = {
  date: '',
  pair: 'EURUSD', direction: '', session: '', htf_bias: '', bias_aligned: null,
  model_type: '', model_status: '', sequence_type: '',
  liquidity_tier: '', liquidity_type: [], sweep_quality: '', sweep_distance_pips: '',
  failed_continuation: null, secondary_liquidity_tier: '', secondary_liquidity_type: [],
  secondary_sweep_quality: '', secondary_displacement_quality: '', second_sweep_override: false,
  displacement_confirmed: null, displacement_quality: '', displacement_body_ratio: '',
  candle_close_position: '', choch_or_bos: '', structure_confirmation: '',
  poi_type: '', poi_size_pips: '', inducement_confirmed: null, inducement_type: [],
  ltf_confirmation: '', full_sequence_complete: null,
  entry_price: '', stop_price: '', stop_distance_pips: '', target_rr: '', target_description: '',
  result: '', r_achieved: '', exit_reason: '', trade_grade: '',
  rule_triggered: [], warning_signal_present: null, warning_signal_acted_on: null, failed_at_stage: [],
  price_context: '', execution_notes: '', key_takeaway: '', chart_screenshot_url: '',
  counterfactual_notes: '',
  // ── 5-Phase checkpoint fields ──────────────────────────────────────
  // Phase 1 — HTF Structure (Continuation model)
  p1_hh_ll_breaks_key:     false,
  p1_buildup_created:       false,
  p1_engineered_pullback:   false,
  p1_micro_poi_confirm:     false,
  // Phase 1 — HTF Structure (Reversal model)
  p1_ll_hh_into_htf:        false,
  p1_macro_liq_sweep:        false,
  p1_displacement_into_poi:  false,
  // Phase 4 — Pre-Entry Signal
  p4_micro_poi_present:     false,
  // Phase override reason
  phase_override_reason: '',
};

// ─── BacktestLogTab ───────────────────────────────────────────────────
function BacktestLogTab() {
  const [entry, setEntryRaw]   = useState({ ...BL_EMPTY });
  const [step,  setStep]       = useState(0);
  const [saveState, setSaveState]         = useState('idle'); // idle | saving | saved | error
  const [sqsScore,  setSqsScore]          = useState(null);
  const [confirmIncomplete, setConfirmIncomplete] = useState(false);
  const [overridePrompt,    setOverridePrompt]    = useState(null); // pending disp value
  const [overrideApplied,   setOverrideApplied]   = useState(false);
  const [recentLogs,  setRecentLogs]      = useState([]);
  const [showLogs,    setShowLogs]        = useState(false);
  const [cfTarget,    setCfTarget]        = useState(null);
  const [cfForm,      setCfForm]          = useState({ setup_played_out: null, counterfactual_r: '', decision_correct: null });
  const [cfSaving,    setCfSaving]        = useState(false);
  const [imgUploading, setImgUploading]  = useState(false);
  const [imgError,     setImgError]      = useState('');
  const [validationErrors, setValidationErrors] = useState({});
  // ── Paste-to-pre-fill (Phase 0A) ─────────────────────────────────
  const [pasteOpen,    setPasteOpen]   = useState(false);
  const [pasteText,    setPasteText]   = useState('');
  const [parseResult,  setParseResult] = useState(null); // { filled:[], blank:[], count:n, error?:string }
  const [parseLoading, setParseLoading] = useState(false);

  const set       = (k, v) => setEntryRaw(p => ({ ...p, [k]: v }));
  const toggleArr = (k, v) => setEntryRaw(p => {
    const a = Array.isArray(p[k]) ? p[k] : [];
    return { ...p, [k]: a.includes(v) ? a.filter(x => x !== v) : [...a, v] };
  });

  // BUG-004: Auto-populate R Achieved when Result=Win and Exit Reason=Target Hit
  useEffect(() => {
    if (entry.result === 'Win' && entry.exit_reason === 'Target Hit' && entry.target_rr && !entry.r_achieved) {
      setEntryRaw(p => ({ ...p, r_achieved: String(p.target_rr) }));
    }
  }, [entry.result, entry.exit_reason]); // eslint-disable-line react-hooks/exhaustive-deps

  // FIX 2: Validation function
  const validateStep = (id) => {
    const errs = {};
    switch(id) {
      case 'context':
        if (!entry.direction) errs.direction = 'Required';
        if (!entry.session) errs.session = 'Required';
        if (!entry.htf_bias) errs.htf_bias = 'Required';
        if (entry.bias_aligned === null) errs.bias_aligned = 'Required';
        break;
      case 'sequence':
        if (!entry.model_type) errs.model_type = 'Required';
        if (!entry.sequence_type) errs.sequence_type = 'Required';
        break;
      case 'primary_sweep':
        if (!Array.isArray(entry.liquidity_type) || entry.liquidity_type.length === 0) errs.liquidity_type = 'Required';
        if (!entry.sweep_quality) errs.sweep_quality = 'Required';
        break;
      case 'second_sweep':
        // No required fields for second_sweep
        break;
      case 'displacement':
        if (entry.displacement_confirmed === null) errs.displacement_confirmed = 'Required';
        if (!entry.displacement_quality) errs.displacement_quality = 'Required';
        if (!entry.choch_or_bos) errs.choch_or_bos = 'Required';
        if (!entry.structure_confirmation) errs.structure_confirmation = 'Required';
        break;
      case 'poi':
        if (!entry.poi_type) errs.poi_type = 'Required';
        if (entry.inducement_confirmed === null) errs.inducement_confirmed = 'Required';
        if (!entry.ltf_confirmation) errs.ltf_confirmation = 'Required';
        if (entry.full_sequence_complete === null) errs.full_sequence_complete = 'Required';
        break;
      case 'outcome':
        if (!entry.result) errs.result = 'Required';
        if (!entry.trade_grade) errs.trade_grade = 'Required';
        break;
    }
    return errs;
  };

  // Chart screenshot upload to Supabase Storage
  const handleImgUpload = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgUploading(true); setImgError('');
    const ext  = file.name.split('.').pop();
    const path = `charts/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: upErr } = await supabase.storage.from('chart-screenshots').upload(path, file, { upsert: false });
    if (upErr) { setImgError('Upload failed: ' + upErr.message); setImgUploading(false); return; }
    const { data } = supabase.storage.from('chart-screenshots').getPublicUrl(path);
    set('chart_screenshot_url', data.publicUrl);
    setImgUploading(false);
  };

  // Auto-calc stop distance pips
  useEffect(() => {
    const ep = parseFloat(entry.entry_price);
    const sp = parseFloat(entry.stop_price);
    if (!isNaN(ep) && !isNaN(sp) && ep > 0 && sp > 0) {
      set('stop_distance_pips', (Math.abs(ep - sp) * 10000).toFixed(1));
    }
  }, [entry.entry_price, entry.stop_price]);

  // Auto-populate Target Description from EP + SL + RR
  // Format: "TP at [price]" — only sets when all 3 inputs are valid numbers
  useEffect(() => {
    const ep = parseFloat(entry.entry_price);
    const sp = parseFloat(entry.stop_price);
    const rr = parseFloat(entry.target_rr);
    if (!isNaN(ep) && !isNaN(sp) && !isNaN(rr) && ep > 0 && sp > 0 && rr > 0) {
      // Works for both longs (ep > sp → positive offset) and shorts (ep < sp → negative offset)
      const tp = ep + rr * (ep - sp);
      set('target_description', `TP at ${tp.toFixed(5)}`);
    }
  }, [entry.entry_price, entry.stop_price, entry.target_rr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived gate flags
  const showS4       = ['Double Sweep', 'Complex Pullback', 'Multi-Stage Engineered Reversal'].includes(entry.sequence_type);
  const s4Unlocked   = showS4 && entry.failed_continuation === true;
  const primTierRank = BL_TIER_RANK[entry.liquidity_tier]       || 0;
  const primDispRank = BL_DISP_RANK[entry.displacement_quality] || 0;

  // Gate 3 — secondary displacement override handler
  const handleSecDisp = v => {
    const secRank = BL_DISP_RANK[v] || 0;
    if (secRank < primDispRank) { setOverridePrompt(v); }
    else { set('secondary_displacement_quality', v); set('second_sweep_override', false); setOverrideApplied(false); }
  };
  const confirmOverride = () => {
    set('secondary_displacement_quality', overridePrompt);
    set('second_sweep_override', true);
    setOverridePrompt(null);
    setOverrideApplied(true);
  };

  // Live SQS
  const liveSQS  = useMemo(() => calculateSQS(entry), [entry]);
  const liveBand = sqsBand(liveSQS);

  // Live 5-Phase scores
  const livePhase = useMemo(() => calculatePhaseScores(entry), [entry]);

  // ── Live completion tracker — updates on every entry change ──────────
  const KEY_FIELDS_LIVE = [
    { key: 'date',                  label: 'Date'        , check: e => !!e.date },
    { key: 'pair',                  label: 'Pair'        , check: e => !!e.pair },
    { key: 'direction',             label: 'Direction'   , check: e => !!e.direction },
    { key: 'session',               label: 'Session'     , check: e => !!e.session },
    { key: 'htf_bias',              label: 'HTF Bias'    , check: e => !!e.htf_bias },
    { key: 'model_type',            label: 'Model'       , check: e => !!e.model_type },
    { key: 'sequence_type',         label: 'Sequence'    , check: e => !!e.sequence_type },
    { key: 'liquidity_type',        label: 'Liquidity'   , check: e => Array.isArray(e.liquidity_type) && e.liquidity_type.length > 0 },
    { key: 'sweep_quality',         label: 'Sweep'       , check: e => !!e.sweep_quality },
    { key: 'displacement_quality',  label: 'Displacement', check: e => !!e.displacement_quality },
    { key: 'structure_confirmation',label: 'Structure'   , check: e => !!e.structure_confirmation },
    { key: 'ltf_confirmation',      label: 'LTF'         , check: e => !!e.ltf_confirmation },
    { key: 'entry_price',           label: 'Entry'       , check: e => !!e.entry_price },
    { key: 'stop_price',            label: 'Stop'        , check: e => !!e.stop_price },
    { key: 'result',                label: 'Result'      , check: e => !!e.result },
    { key: 'trade_grade',           label: 'Grade'       , check: e => !!e.trade_grade },
  ];

  const liveCompletion = useMemo(() => {
    const parsedKeys = new Set(parseResult ? parseResult.filled : []);
    const done  = KEY_FIELDS_LIVE.filter(f =>  f.check(entry)).map(f => ({ ...f, source: parsedKeys.has(f.key) ? 'parsed' : 'manual' }));
    const blank = KEY_FIELDS_LIVE.filter(f => !f.check(entry));
    return { done, blank };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, parseResult]);

  // Dynamic steps (S4 only when sequence needs it)
  const steps = useMemo(() => [
    { id:'context',      label:'Context' },
    { id:'sequence',     label:'Model / Sequence' },
    { id:'primary_sweep',label:'Primary Sweep' },
    ...(showS4 ? [{ id:'second_sweep', label:'Second Sweep' }] : []),
    { id:'displacement', label:'Displacement' },
    { id:'poi',          label:'POI / Inducement' },
    { id:'entry',        label:'Entry Details' },
    { id:'outcome',      label:'Outcome' },
    { id:'rules',        label:'Rules / Warnings' },
    { id:'notes',        label:'Notes' },
    { id:'summary',      label:'Summary' },
  ], [showS4]);

  const totalSteps  = steps.length;
  const currentStep = Math.min(step, totalSteps - 1);
  const currentId   = steps[currentStep]?.id;

  // One-line summary per completed step
  const stepSummary = id => {
    switch(id) {
      case 'context':
        return `${entry.pair||'—'} ${entry.direction||'—'} · ${entry.session||'—'} · HTF: ${entry.htf_bias||'—'}${entry.bias_aligned===true?' ✓ aligned':entry.bias_aligned===false?' ⚠ NOT aligned':''}`;
      case 'sequence':
        return `${entry.sequence_type||'—'} · ${entry.model_type||'—'} · ${entry.model_status||'—'}`;
      case 'primary_sweep':
        return `${entry.liquidity_tier||'—'} · ${entry.sweep_quality||'—'} sweep · ${entry.sweep_distance_pips||'—'}p`;
      case 'second_sweep':
        return `${entry.secondary_sweep_quality||'—'} sweep · ${entry.secondary_displacement_quality||'—'} disp${entry.second_sweep_override?' · ⚠ Override':''}`;
      case 'displacement':
        return `${entry.displacement_quality||'—'} · ${entry.structure_confirmation||'—'} · Body ${entry.displacement_body_ratio||'—'}%`;
      case 'poi':
        return `${entry.poi_type||'—'} POI · ${(entry.inducement_type||[]).join(', ')||'—'} · LTF: ${entry.ltf_confirmation||'—'} · Seq: ${entry.full_sequence_complete===true?'✓':entry.full_sequence_complete===false?'✗ incomplete':'—'}`;
      case 'entry':
        return `EP ${entry.entry_price||'—'} · SL ${entry.stop_price||'—'} (${entry.stop_distance_pips||'—'}p) · ${entry.target_rr||'—'}R`;
      case 'outcome':
        return `${entry.result||'—'} · ${entry.r_achieved||'—'}R · ${entry.exit_reason||'—'} · Grade: ${entry.trade_grade||'—'}`;
      case 'rules':
        return `Rules: ${entry.rule_triggered === 'NONE' ? 'None' : (entry.rule_triggered||[]).length?(entry.rule_triggered||[]).join(', '):'None'} · Warning: ${entry.warning_signal_present===true?'Yes':entry.warning_signal_present===false?'No':entry.warning_signal_present==='none'?'No Warning':'—'}`;
      case 'notes':
        return entry.key_takeaway ? (entry.key_takeaway.length>55?entry.key_takeaway.slice(0,55)+'…':entry.key_takeaway) : '—';
      default: return '—';
    }
  };

  // Save flow
  const handleSave = () => {
    if (entry.full_sequence_complete === false) { setConfirmIncomplete(true); return; }
    doSave();
  };

  const doSave = async () => {
    setSaveState('saving'); setConfirmIncomplete(false);
    const score     = liveSQS;
    const phases    = calculatePhaseScores(entry);
    setSqsScore(score);
    const band  = sqsBand(score);
    const NUM   = ['sweep_distance_pips','poi_size_pips','entry_price','stop_price','stop_distance_pips','target_rr','r_achieved','displacement_body_ratio'];
    // Bool checkpoint fields — must stay as booleans, not be nulled
    const BOOL_PHASE = [
      'p1_hh_ll_breaks_key','p1_buildup_created','p1_engineered_pullback','p1_micro_poi_confirm',
      'p1_ll_hh_into_htf','p1_macro_liq_sweep','p1_displacement_into_poi','p4_micro_poi_present',
    ];
    const payload = { ...entry };
    NUM.forEach(k => { const v = parseFloat(payload[k]); payload[k] = isNaN(v) ? null : v; });
    Object.keys(payload).forEach(k => {
      if (BOOL_PHASE.includes(k)) return; // keep booleans
      if (payload[k] === '') payload[k] = null;
    });
    delete payload.setup_played_out; delete payload.counterfactual_r; delete payload.decision_correct;
    payload.sqs_score           = score;
    payload.grade               = band.grade;
    // ── 5-Phase scores ──────────────────────────────────────────────
    payload.phase_1_score       = phases.p1;
    payload.phase_2_score       = phases.p2;
    payload.phase_3_score       = phases.p3;
    payload.phase_4_score       = phases.p4;
    payload.phase_5_score       = phases.p5;
    payload.phase_total_score   = phases.total;
    payload.auto_grade          = phases.autoGrade;
    payload.grade_conflict      = entry.trade_grade && entry.trade_grade !== phases.autoGrade;
    payload.evaluated_at        = new Date().toISOString();
    payload.enrichment_complete = true;
    const { error } = await supabase.from('backtest_logs').insert(payload);
    if (error) { setSaveState('error'); console.error('backtest_logs:', error); }
    else       { setSaveState('saved'); setEntryRaw({ ...BL_EMPTY }); setOverrideApplied(false); setStep(0); loadRecentLogs(); }
  };

  const loadRecentLogs = async () => {
    const { data } = await supabase
      .from('backtest_logs')
      .select('id,date,pair,direction,sequence_type,sqs_score,grade,auto_grade,phase_total_score,grade_conflict,result,setup_played_out,enrichment_complete,bias_aligned,second_sweep_override,chart_screenshot_url')
      .order('evaluated_at', { ascending: false }).limit(20);
    if (data) setRecentLogs(data);
  };

  useEffect(() => { loadRecentLogs(); }, []);

  const saveCF = async () => {
    if (!cfTarget) return;
    setCfSaving(true);
    const { error } = await supabase.from('backtest_logs').update({
      setup_played_out:  cfForm.setup_played_out,
      counterfactual_r:  parseFloat(cfForm.counterfactual_r) || null,
      decision_correct:  cfForm.decision_correct,
    }).eq('id', cfTarget);
    setCfSaving(false);
    if (!error) { setCfTarget(null); loadRecentLogs(); }
  };

  // ── Paste-to-pre-fill parser (Claude API) ────────────────────────
  const PARSER_SYSTEM_PROMPT = `You are a trading journal parser for WTA-1. Extract the following fields from the Discord recap text and return ONLY a valid JSON object with no preamble or markdown. If a field cannot be determined return null for that field. Fields to extract: { date: string (DD/MM/YYYY format), pair: string (EURUSD or GBPUSD only), direction: string (Buy or Sell only), session: string (Frankfurt | London Open | NY 1st Hr | NY 2nd Hr | LDN Lunch | NY PM | Outside), htf_bias: string (Bullish | Bearish | Neutral), bias_aligned: boolean, model_type: string (Bull Rev | Bear Rev | Bull Cont | Bear Cont | Eng Rev | Eng Cont), model_status: string (Active | Pending | Invalid), sequence_type: string (Single Sweep | Double Sweep | Eng. Cont. | Complex PB | Multi-Stage), entry_price: number, stop_price: number, target_rr: number, target_description: string, result: string (Win | Loss | BE | No Trade), r_achieved: number, exit_reason: string (Target Hit | Stop Hit | Manual | BE), trade_grade: string (A+ | A | B | No Trade), execution_notes: string, key_takeaway: string, price_context: string }`;

  const parsePaste = async () => {
    const rawText = pasteText;
    if (!rawText.trim()) return;
    setParseLoading(true);

    try {
      if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set. Add VITE_ANTHROPIC_KEY to your .env file.');

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: PARSER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: rawText }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const apiData = await res.json();
      const jsonText = apiData.content?.[0]?.text || '';

      let parsed;
      try {
        const clean = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        throw new Error('Claude returned non-JSON. Check API key and model name.');
      }

      // ── Map API response → form fields ───────────────────────────
      const merged = {};
      const filled = [];
      const trySet = (key, val) => {
        if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
          merged[key] = val;
          if (!filled.includes(key)) filled.push(key);
        }
      };

      // date: DD/MM/YYYY → YYYY-MM-DD
      if (parsed.date) {
        const parts = String(parsed.date).split('/');
        if (parts.length === 3) {
          const [dd, mm, yyyy] = parts;
          trySet('date', `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`);
        }
      }

      // pair: EURUSD | GBPUSD — direct, single value only
      if (parsed.pair === 'EURUSD' || parsed.pair === 'GBPUSD') trySet('pair', parsed.pair);

      // direction: Buy → Long, Sell → Short
      if      (parsed.direction === 'Buy')  trySet('direction', 'Long');
      else if (parsed.direction === 'Sell') trySet('direction', 'Short');

      // session
      const SESSION_MAP = {
        'Frankfurt':   'Frankfurt',
        'London Open': 'London',
        'NY 1st Hr':   'NY 1st Hour',
        'NY 2nd Hr':   'NY 2nd Hour',
        'LDN Lunch':   'London Lunch',
        'NY PM':       'NY After Lunch',
        'Outside':     'Outside',
      };
      if (parsed.session && SESSION_MAP[parsed.session]) trySet('session', SESSION_MAP[parsed.session]);

      // htf_bias: Bullish | Bearish | Neutral
      if (['Bullish','Bearish','Neutral'].includes(parsed.htf_bias)) trySet('htf_bias', parsed.htf_bias);

      // bias_aligned: boolean — only set when explicitly returned
      if (parsed.bias_aligned === true || parsed.bias_aligned === false) trySet('bias_aligned', parsed.bias_aligned);

      // model_type: abbreviated → full form (single selection)
      const MODEL_MAP = {
        'Bull Rev':  'Bullish Reversal',
        'Bear Rev':  'Bearish Reversal',
        'Bull Cont': 'Bullish Continuation',
        'Bear Cont': 'Bearish Continuation',
        'Eng Rev':   'Engineered Reversal',
        'Eng Cont':  'Engineered Continuation',
      };
      if (parsed.model_type && MODEL_MAP[parsed.model_type]) trySet('model_type', MODEL_MAP[parsed.model_type]);

      // model_status: Active | Pending | Invalid
      if (['Active','Pending','Invalid'].includes(parsed.model_status)) trySet('model_status', parsed.model_status);

      // sequence_type
      const SEQ_MAP = {
        'Single Sweep': 'Single Sweep',
        'Double Sweep': 'Double Sweep',
        'Eng. Cont.':   'Engineered Continuation',
        'Complex PB':   'Complex Pullback',
        'Multi-Stage':  'Multi-Stage Engineered Reversal',
      };
      if (parsed.sequence_type && SEQ_MAP[parsed.sequence_type]) trySet('sequence_type', SEQ_MAP[parsed.sequence_type]);

      // numeric fields → strings for form inputs
      if (parsed.entry_price != null) trySet('entry_price', String(parsed.entry_price));
      if (parsed.stop_price  != null) trySet('stop_price',  String(parsed.stop_price));
      if (parsed.target_rr   != null) trySet('target_rr',   String(parsed.target_rr));

      // target_description: direct
      if (parsed.target_description) trySet('target_description', parsed.target_description);

      // result: Win | Loss | BE → Break Even | No Trade
      const RESULT_MAP = { 'Win':'Win', 'Loss':'Loss', 'BE':'Break Even', 'No Trade':'No Trade' };
      if (parsed.result && RESULT_MAP[parsed.result]) trySet('result', RESULT_MAP[parsed.result]);

      // r_achieved: number → string
      if (parsed.r_achieved != null) trySet('r_achieved', String(parsed.r_achieved));

      // exit_reason: Manual → Manual Close, BE → Break Even
      const EXIT_MAP = { 'Target Hit':'Target Hit', 'Stop Hit':'Stop Hit', 'Manual':'Manual Close', 'BE':'Break Even' };
      if (parsed.exit_reason && EXIT_MAP[parsed.exit_reason]) trySet('exit_reason', EXIT_MAP[parsed.exit_reason]);

      // trade_grade: A+ | A | B | No Trade — direct
      if (parsed.trade_grade) trySet('trade_grade', parsed.trade_grade);

      // text fields: direct
      if (parsed.execution_notes) trySet('execution_notes', parsed.execution_notes);
      if (parsed.key_takeaway)    trySet('key_takeaway',    parsed.key_takeaway);
      if (parsed.price_context)   trySet('price_context',   parsed.price_context);

      // ── Finalise ─────────────────────────────────────────────────
      const KEY_FIELDS_CHK = ['date','pair','direction','session','htf_bias','model_type',
        'sequence_type','entry_price','stop_price','result','trade_grade',
        'execution_notes','key_takeaway','price_context'];
      const blank = KEY_FIELDS_CHK.filter(f => !filled.includes(f));

      setParseResult({ filled, blank, count: filled.length });
      setEntryRaw(prev => ({ ...prev, ...merged }));
      setPasteOpen(false);
      // pasteText intentionally NOT cleared — text persists for reference
      setStep(0);

    } catch (err) {
      console.error('parsePaste error:', err);
      setParseResult({ filled: [], blank: [], count: 0, error: err.message });
    } finally {
      setParseLoading(false);
    }
  };

  // ── Micro UI (scoped) ───────────────────────────────────────────────
  const TG = ({ opts, val, onSel, multi = false, disabled: disabledFn, cols = 3 }) => (
    <div className="grid gap-1.5" style={{ gridTemplateColumns:`repeat(${cols},minmax(0,1fr))` }}>
      {opts.map(([v, l]) => {
        const dis    = disabledFn ? disabledFn(v) : false;
        const active = multi ? (Array.isArray(val) && val.includes(v)) : val === v;
        return (
          <button key={v} disabled={dis}
            onClick={() => { if(dis) return; multi ? onSel(v) : onSel(v === val ? '' : v); }}
            className={`py-3 px-2 rounded border text-xs cursor-pointer text-center leading-tight transition-colors ${
              dis    ? 'border-gray-800 text-gray-800 bg-gray-950 cursor-not-allowed' :
              active ? 'border-blue-500 bg-blue-900/60 text-blue-100 font-bold ring-1 ring-blue-500 ring-inset' :
                       'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950 hover:bg-gray-900'
            }`}>{l || v}</button>
        );
      })}
    </div>
  );

  const YN = ({ val, onChg, yes = 'Yes', no = 'No' }) => (
    <div className="flex gap-2">
      {[[true, yes],[false, no]].map(([b, lbl]) => (
        <button key={String(b)} onClick={() => onChg(val === b ? null : b)}
          className={`flex-1 py-3 rounded border text-xs cursor-pointer transition-colors ${
            val === b
              ? b ? 'border-green-500 bg-green-900/50 text-green-100 font-bold ring-1 ring-green-600 ring-inset'
                  : 'border-red-600 bg-red-900/40 text-red-100 font-bold ring-1 ring-red-700 ring-inset'
              : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950'
          }`}>{lbl}</button>
      ))}
    </div>
  );

  // FIX 1: Change type="number" to type="text"
  const NI = ({ val, onChg, ph }) => (
    <input type="text" inputMode="decimal" value={val} onChange={e => onChg(e.target.value)} placeholder={ph}
      className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2.5 rounded focus:outline-none focus:border-gray-500 placeholder-gray-700"/>
  );

  const TxtIn = ({ val, onChg, ph }) => (
    <input type="text" value={val} onChange={e => onChg(e.target.value)} placeholder={ph}
      className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2.5 rounded focus:outline-none focus:border-gray-500 placeholder-gray-700"/>
  );

  const TA2 = ({ val, onChg, ph, rows = 2 }) => (
    <textarea value={val} onChange={e => onChg(e.target.value)} placeholder={ph} rows={rows}
      className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none focus:border-gray-500 placeholder-gray-700 resize-none"/>
  );

  const SumRow = ({ label, val }) => val ? (
    <div className="flex gap-2 text-xs py-0.5">
      <span className="text-gray-700 w-36 flex-shrink-0">{label}</span>
      <span className="text-gray-300">{String(val)}</span>
    </div>
  ) : null;

  // FIX 5: Define tooltip maps
  const MODEL_TIPS = {
    'Bullish Reversal': 'Bearish market reverses to bullish. Price sweeps sell-side liquidity then displaces up',
    'Bearish Reversal': 'Bullish market reverses to bearish. Price sweeps buy-side liquidity then displaces down',
    'Bullish Continuation': 'Existing bullish trend continues. Pullback into demand then continuation higher',
    'Bearish Continuation': 'Existing bearish trend continues. Pullback into supply then continuation lower',
    'Engineered Reversal': 'Engineered Reversal. Smart money engineers multiple liquidity events to build conditions for a reversal',
    'Engineered Continuation': 'Engineered Continuation. No prior trend. Smart money builds conditions for a move through engineered sweeps',
  };

  const SEQ_TIPS = {
    'Single Sweep': 'One liquidity sweep, one displacement, standard entry. Most common setup',
    'Double Sweep': 'Two sweeps of different levels before entry. Second sweep structurally related to first',
    'Complex Pullback': 'Trend already established. Price engineers liquidity during the pullback before continuing the original move',
    'Engineered Continuation': 'No prior trend. Engineering builds conditions for a move that has not happened yet',
    'Multi-Stage Engineered Reversal': 'Minimum two distinct engineered liquidity events. RIFC entry mandatory. Real CHoCH required',
  };

  const RULE_TIPS = {
    'Daily Loss Limit': 'You have already hit your maximum trades for the day and took this trade anyway',
    'Over-Trading': 'You took more trades than your plan allows in one session',
    'Revenge Trade': 'You took this trade to recover losses from a previous trade',
    'FOMO Entry': 'You entered because you feared missing the move not because the setup was valid',
    'Wrong Session': 'You traded outside your designated trading window',
    'Bias Ignored': 'You traded against your HTF bias without a valid reason',
    'No Inducement': 'You entered without a confirmed inducement event',
    'Premature Entry': 'You entered before the full sequence was complete',
  };

  // FIX 3: Liquidity tier grid data
  const TIER_COLS = [
    {
      tier: 'Tier 1',
      header: 'TIER 1 — MACRO',
      items: ['Weekly High','Weekly Low','PDH','PDL','PDC','Daily Open'],
      tip: 'Highest significance levels. Visible on Daily and Weekly charts. PDH, PDL, Weekly highs and lows',
    },
    {
      tier: 'Tier 2',
      header: 'TIER 2 — SESSION',
      items: ['Asia High','Asia Low','Asia Open','London Open High','London Open Low','London Open Price','London Lunch High','London Lunch Low','NY Open High','NY Open Low','NY Open Price','Frankfurt High','Frankfurt Low','Kill Zone High','Kill Zone Low'],
      tip: 'Session-based levels created during specific trading sessions. Asia, London, NY highs and lows',
    },
    {
      tier: 'Tier 3',
      header: 'TIER 3 — INTERNAL',
      items: ['EQ Highs','EQ Lows','Trendline Liquidity','Internal Range','Swing High','Swing Low','Induced OB'],
      tip: 'Internal range levels. Lower significance. EQ highs and lows, swing points, trendlines, induced OB sweeps',
    },
  ];

  // Option lists
  const O = {
    pairs:    [['EURUSD','EUR/USD'],['GBPUSD','GBP/USD'],['USDJPY','USD/JPY'],['XAUUSD','XAU/USD'],['US30','US30'],['NAS100','NAS100']],
    dir:      [['Long','↑ Long'],['Short','↓ Short']],
    sess:     [['Frankfurt','Frankfurt'],['London','London Open'],['NY 1st Hour','NY 1st Hr'],['NY 2nd Hour','NY 2nd Hr'],['London Lunch','LDN Lunch'],['NY After Lunch','NY PM'],['Outside','Outside']],
    bias:     [['Bullish','Bullish'],['Bearish','Bearish'],['Neutral','Neutral']],
    seqTypes: [['Single Sweep','Single Sweep'],['Double Sweep','Double Sweep'],['Engineered Continuation','Eng. Cont.'],['Complex Pullback','Complex PB'],['Multi-Stage Engineered Reversal','Multi-Stage']],
    models:   [['Bullish Reversal','Bull Rev'],['Bearish Reversal','Bear Rev'],['Bullish Continuation','Bull Cont'],['Bearish Continuation','Bear Cont'],['Engineered Reversal','Eng Rev'],['Engineered Continuation','Eng Cont']],
    mstatus:  [['Active','Active'],['Pending','Pending'],['Invalid','Invalid']],
    tiers:    [['Tier 1','Tier 1'],['Tier 2','Tier 2'],['Tier 3','Tier 3']],
    liqType:  [['Equal Highs','EQ Highs'],['Equal Lows','EQ Lows'],['Session High','Sess H'],['Session Low','Sess L'],['HOPD','HOPD'],['HOPW','HOPW'],['Trendline Liquidity','Trendline'],['Internal Liquidity','Internal'],['Swing High','Swing H'],['Swing Low','Swing L'],['Frankfurt High','FKT H'],['Frankfurt Low','FKT L'],['London Open High','LON H'],['London Open Low','LON L'],['SMC Trap Zone','SMC Trap']],
    sweepQ:   [['Clean','Clean'],['Induced','Induced'],['Partial','Partial']],
    dispQ:    [['Strong','Strong'],['Moderate','Moderate'],['Weak','Weak']],
    struct:   [['CHoCH','CHoCH'],['BOS','BOS'],['Unconfirmed','Unconfirmed']],
    candleP:  [['Above 50%','Above 50%'],['Below 50%','Below 50%'],['At High/Low','At H/L']],
    chochBos: [['CHoCH','CHoCH'],['BOS','BOS'],['Neither','Neither']],
    indType:  [['Structural','Structural'],['EQH/EQL Buildup','EQH/EQL'],['Trendline Tap','TL Tap'],['Stop Hunt','Stop Hunt'],['Session Open','Sess Open']],
    ltf:      [['M1 CHoCH','M1 CHoCH'],['M1 BOS','M1 BOS'],['Engulf','Engulf'],['None','None']],
    poiT:     [['HTF','HTF'],['LTF','LTF']],
    result:   [['Win','Win'],['Loss','Loss'],['Break Even','BE'],['No Trade','No Trade']],
    exit:     [['Target Hit','Target Hit'],['Stop Hit','Stop Hit'],['Manual Close','Manual'],['Break Even','BE']],
    grades:   [['A+','A+'],['A','A'],['B','B'],['No Trade','No Trade']],
    rules:    [['Daily Loss Limit','Daily Limit'],['Over-Trading','Over-Trade'],['Revenge Trade','Revenge'],['FOMO Entry','FOMO'],['Wrong Session','Bad Session'],['Bias Ignored','Bias Ignored'],['No Inducement','No Induce'],['Premature Entry','Premature']],
    failSt:   [['POI','POI'],['Time','Time'],['Liquidity','Liquidity'],['Inducement','Induce'],['Displacement','Disp'],['Failure Model','Fail Model'],['BOS','BOS'],['RIFC','RIFC']],
  };

  return (
    <div className="max-w-2xl mx-auto pb-16">

      {/* ── Pinned SQS bar ─────────────────────────────────────────── */}
      <div className={`sticky top-0 z-30 flex items-center justify-between bg-gray-950/95 backdrop-blur border-b ${liveBand.ring} px-4 py-2.5`}>
        <div className="flex items-center gap-2.5">
          <span className="text-gray-600 text-xs uppercase tracking-widest">SQS</span>
          {!entry.liquidity_tier || !entry.displacement_quality ? (
            <span className="text-gray-600 text-xs">— Fill in fields to calculate</span>
          ) : (
            <>
              <span className={`font-bold text-xl ${liveBand.color}`}>{liveSQS}</span>
              <span className={`text-xs font-bold ${liveBand.color}`}>{liveBand.grade}</span>
              <span className="text-gray-700 mx-0.5">—</span>
              <span className={`text-xs ${liveBand.color}`}>{liveBand.label}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {overrideApplied && <span className="text-xs border border-orange-700 bg-orange-950/20 text-orange-400 rounded px-2 py-0.5">⚠ Override −8</span>}
          {entry.bias_aligned === false && <span className="text-xs border border-yellow-700 bg-yellow-950/20 text-yellow-400 rounded px-2 py-0.5">⚠ Bias Unaligned</span>}
          {entry.liquidity_tier && entry.displacement_quality && liveSQS < 40 && liveSQS > 0 &&
           (currentStep >= totalSteps - 1 || liveCompletion.done.length >= Math.ceil(KEY_FIELDS_LIVE.length * 0.9)) &&
           <span className="text-xs border border-red-700 bg-red-950/20 text-red-400 rounded px-2 py-0.5">🔴 Auto NO TRADE</span>}
        </div>
      </div>

      {/* ── Paste-to-pre-fill panel ───────────────────────────────── */}
      <div className="px-4 pt-3">

        {/* Toggle button */}
        <button
          onClick={() => setPasteOpen(o => !o)}
          className="w-full flex items-center justify-between px-3 py-2 bg-gray-950 border border-gray-700 hover:border-gray-600 rounded text-xs text-gray-500 hover:text-gray-300 cursor-pointer transition-colors"
        >
          <span className="flex items-center gap-2">
            <span>📋</span>
            <span className="uppercase tracking-widest">
              Paste Discord Recap — Auto Pre-fill
              {pasteText && !pasteOpen && <span className="text-blue-700 ml-1">· recap loaded</span>}
            </span>
          </span>
          <span className="text-gray-700 text-xs">{pasteOpen ? '▲ close' : '▼ open'}</span>
        </button>

        {/* ── Live completion tracker — visible when panel closed and recap parsed ── */}
        {parseResult && !pasteOpen && (
          <div className="mt-1.5 border border-gray-800 rounded p-2.5 space-y-2">

            {/* Summary header */}
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-3">
                <span className="text-green-600 font-bold">
                  {liveCompletion.done.length}/{KEY_FIELDS_LIVE.length} fields done
                </span>
                {liveCompletion.blank.length > 0 && (
                  <span className="text-yellow-700">
                    {liveCompletion.blank.length} still needed
                  </span>
                )}
              </div>
              <button
                onClick={() => { setParseResult(null); setEntryRaw({ ...BL_EMPTY }); setPasteText(''); setStep(0); }}
                className="text-gray-700 hover:text-red-500 cursor-pointer text-xs transition-colors"
              >✕ clear all</button>
            </div>

            {/* Done fields — parsed (green) vs manual (gray) */}
            {liveCompletion.done.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {liveCompletion.done.map(f => (
                  <span key={f.key} className={`text-xs px-1.5 py-0.5 rounded border ${
                    f.source === 'parsed'
                      ? 'border-green-900 bg-green-950/20 text-green-700'
                      : 'border-gray-700 bg-gray-900/60 text-gray-500'
                  }`}>
                    {f.label}{f.source === 'parsed' ? ' ·p' : ''}
                  </span>
                ))}
              </div>
            )}

            {/* Still needed fields */}
            {liveCompletion.blank.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {liveCompletion.blank.map(f => (
                  <span key={f.key} className="text-xs px-1.5 py-0.5 rounded border border-yellow-900/60 text-yellow-800">
                    {f.label}
                  </span>
                ))}
              </div>
            )}

            {/* Legend */}
            <div className="flex gap-4 text-xs pt-0.5 border-t border-gray-800/50">
              <span className="text-green-800">■ ·p parsed</span>
              <span className="text-gray-600">■ manual</span>
              <span className="text-yellow-900">■ needed</span>
            </div>
          </div>
        )}

        {/* ── Paste input panel ── */}
        {pasteOpen && (
          <div className="mt-1.5 border border-gray-700 rounded p-3 space-y-3 bg-gray-950">

            {/* Inline mini tracker when panel is open */}
            {parseResult && (
              <div className="flex items-center gap-3 text-xs border border-gray-800 rounded px-2.5 py-1.5">
                <span className="text-green-700 font-bold">{liveCompletion.done.length}/{KEY_FIELDS_LIVE.length} done</span>
                {liveCompletion.blank.length > 0 && (
                  <span className="text-yellow-800">{liveCompletion.blank.length} needed: {liveCompletion.blank.map(f => f.label).join(' · ')}</span>
                )}
              </div>
            )}

            <div className="text-xs text-gray-600 leading-relaxed">
              Paste a Discord recap below. Recognised fields pre-fill the form — text stays here for reference. Review each step before saving.
            </div>

            <textarea
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder={"Paste Discord recap text here…\n\nRecognised: Pair · Direction · Session · HTF Bias · Model\nSequence · Sweep Quality · Displacement · CHoCH/BOS\nLTF Confirm · Entry · Stop · RR · Result · Grade · Liquidity"}
              rows={9}
              className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded focus:outline-none focus:border-gray-500 placeholder-gray-800 resize-none font-mono leading-relaxed"
            />

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={parsePaste}
                disabled={!pasteText.trim() || parseLoading}
                className={`flex-1 py-2.5 text-xs rounded border font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                  parseLoading
                    ? 'border-blue-900 bg-blue-950/20 text-blue-600 cursor-not-allowed'
                    : pasteText.trim()
                      ? 'border-blue-700 bg-blue-950/30 text-blue-300 hover:bg-blue-950/60'
                      : 'border-gray-800 text-gray-700 cursor-not-allowed'
                }`}
              >
                {parseLoading ? '⏳ Parsing with Claude…' : parseResult ? 'Re-parse & Update →' : '✦ Parse with Claude →'}
              </button>
              {pasteText && !parseLoading && (
                <button
                  onClick={() => setPasteText('')}
                  className="px-3 py-2.5 text-xs border border-gray-700 text-gray-600 rounded cursor-pointer hover:border-red-900 hover:text-red-500 transition-colors"
                >
                  Clear recap
                </button>
              )}
              <button
                onClick={() => setPasteOpen(false)}
                disabled={parseLoading}
                className="px-3 py-2.5 text-xs border border-gray-700 text-gray-500 rounded cursor-pointer hover:border-gray-500 transition-colors"
              >
                Close
              </button>
            </div>

            {parseResult?.error && (
              <div className="text-xs text-red-400 border border-red-900 bg-red-950/20 rounded px-3 py-2">
                ❌ Parse error: {parseResult.error}
              </div>
            )}

            <div className="text-xs text-gray-800">
              Fields left blank are intentional — do not guess. Fill them in the steps below.
            </div>
          </div>
        )}
      </div>

      {/* ── Progress bar ───────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-1">
        {steps.map((s, i) => (
          <div key={s.id} className={`h-1.5 rounded-full transition-all duration-300 ${
            i < currentStep  ? 'flex-1 bg-green-700' :
            i === currentStep ? 'flex-[2] bg-blue-500' :
                                'flex-1 bg-gray-800'
          }`}/>
        ))}
        <span className="text-xs text-gray-600 ml-2 flex-shrink-0">{currentStep + 1} / {totalSteps}</span>
      </div>
      <div className="px-4 pb-2">
        <span className="text-xs text-gray-500">{steps[currentStep]?.label}</span>
      </div>

      {/* ── Completed step summaries (clickable to edit) ────────────── */}
      {currentStep > 0 && (
        <div className="px-4 mb-3 space-y-1">
          {steps.slice(0, currentStep).map((s, i) => (
            <button key={s.id} onClick={() => setStep(i)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-gray-950 border border-gray-800 rounded text-xs hover:border-gray-700 cursor-pointer text-left group">
              <span className="text-green-700 flex-shrink-0">✓</span>
              <span className="text-gray-700 font-bold flex-shrink-0 w-4 text-center">{i+1}</span>
              <span className="text-gray-600 flex-shrink-0">{s.label}</span>
              <span className="text-gray-700 mx-1">·</span>
              <span className="text-gray-400 truncate">{stepSummary(s.id)}</span>
              <span className="ml-auto text-gray-800 text-xs group-hover:text-gray-600 flex-shrink-0">edit</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Active step panel ──────────────────────────────────────── */}
      <div className="px-4">
        <Panel>
          <div className="flex items-center justify-between text-xs text-gray-600 uppercase tracking-widest border-b border-gray-800 pb-2 mb-4">
            <span>{currentStep + 1} — {steps[currentStep]?.label}</span>
            <span className="text-gray-800 normal-case tracking-normal">step {currentStep + 1} of {totalSteps}</span>
          </div>

          {/* S1 — Context */}
          {currentId === 'context' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FL>Date</FL>
                  <input type="date" value={entry.date} onChange={e=>set('date',e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs px-3 py-2.5 rounded focus:outline-none focus:border-gray-500"/>
                </div>
                <div><FL>Pair</FL><TG opts={O.pairs} val={entry.pair} onSel={v=>set('pair',v)} cols={2}/></div>
              </div>
              <div>
                <div className={validationErrors.direction ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Direction</FL>
                  <TG opts={O.dir} val={entry.direction} onSel={v=>set('direction',v)} cols={2}/>
                </div>
                {validationErrors.direction && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div>
                <div className={validationErrors.session ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Session</FL>
                  <TG opts={O.sess} val={entry.session} onSel={v=>set('session',v)} cols={4}/>
                </div>
                {validationErrors.session && <div className="mt-1 text-xs text-red-500">Required</div>}
                {/* Session time validation warning */}
                {(()=>{
                  if (!entry.date || !entry.session || entry.session === 'Outside') return null;
                  const SESSION_WINDOWS_BST = {
                    'Frankfurt':     { start: 7*60+45,  end: 9*60 },
                    'London':        { start: 8*60,      end: 12*60 },
                    'NY 1st Hour':   { start: 13*60,     end: 14*60 },
                    'NY 2nd Hour':   { start: 14*60,     end: 16*60 },
                    'London Lunch':  { start: 12*60,     end: 14*60 },
                    'NY After Lunch':{ start: 18*60,     end: 20*60 },
                  };
                  const win = SESSION_WINDOWS_BST[entry.session];
                  if (!win) return null;
                  const now    = new Date();
                  const bstOff = 60; // BST = UTC+1 (approximate — DST adjustments ignored)
                  const bstMin = now.getUTCHours() * 60 + now.getUTCMinutes() + bstOff;
                  const inWindow = bstMin >= win.start && bstMin < win.end;
                  if (inWindow) return null;
                  const fmt = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')} BST`;
                  return (
                    <div className="mt-1 text-xs border border-yellow-900 bg-yellow-950/20 text-yellow-600 rounded px-2 py-1.5">
                      ⚠ Current time appears outside the {entry.session} window ({fmt(win.start)}–{fmt(win.end)}). Verify the trade date and session before logging.
                    </div>
                  );
                })()}
              </div>
              <div>
                <div className={validationErrors.htf_bias ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>HTF Bias</FL>
                  <TG opts={O.bias} val={entry.htf_bias} onSel={v=>set('htf_bias',v)} cols={3}/>
                </div>
                {validationErrors.htf_bias && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div>
                <div className={validationErrors.bias_aligned ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Bias Aligned?</FL>
                  <YN val={entry.bias_aligned} onChg={v=>set('bias_aligned',v)}/>
                </div>
                {validationErrors.bias_aligned && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
            </div>
          )}

          {/* S2 — Model / Sequence */}
          {currentId === 'sequence' && (
            <div className="space-y-4">
              <div>
                <FL>Model Type <InfoTip content="Select the model type for this setup — single select only"/></FL>
                <div className={`grid gap-1.5 grid-cols-3 ${validationErrors.model_type ? 'ring-1 ring-red-500 rounded' : ''}`}>
                  {O.models.map(([v, l]) => {
                    const active = entry.model_type === v;
                    return (
                      <button key={v} onClick={() => set('model_type', active ? '' : v)}
                        className={`relative py-3 px-2 rounded border text-xs cursor-pointer text-center leading-tight transition-colors ${
                          active ? 'border-blue-500 bg-blue-900/60 text-blue-100 font-bold ring-1 ring-blue-500 ring-inset' :
                                   'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950 hover:bg-gray-900'
                        }`}>
                        <span>{l}</span>
                        <span className="absolute top-1 right-1"><InfoTip content={MODEL_TIPS[v]} position="left"/></span>
                      </button>
                    );
                  })}
                </div>
                {validationErrors.model_type && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div><FL>Model Status</FL><TG opts={O.mstatus} val={entry.model_status} onSel={v=>set('model_status',v)} cols={3}/></div>
              <div>
                <FL>Sequence Type</FL>
                <div>
                  <div className={validationErrors.sequence_type ? 'ring-1 ring-red-500 rounded' : ''}>
                    <div className="grid gap-1.5 grid-cols-2">
                      {O.seqTypes.map(([v, l]) => {
                        const active = entry.sequence_type === v;
                        return (
                          <button key={v} onClick={() => set('sequence_type', active ? '' : v)}
                            className={`relative py-3 px-2 rounded border text-xs cursor-pointer text-center leading-tight transition-colors ${
                              active ? 'border-blue-500 bg-blue-900/60 text-blue-100 font-bold ring-1 ring-blue-500 ring-inset' :
                                       'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950 hover:bg-gray-900'
                            }`}>
                            <span>{l}</span>
                            <span className="absolute top-1 right-1"><InfoTip content={SEQ_TIPS[v]} position="left"/></span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {validationErrors.sequence_type && <div className="mt-1 text-xs text-red-500">Required</div>}
                </div>
              </div>

              {/* ── Phase 1 Checkpoints — appear once model is selected ── */}
              {(entry.model_type === 'Bullish Continuation' || entry.model_type === 'Bearish Continuation') && (
                <div className="border border-gray-800 rounded p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 uppercase tracking-widest">Phase 1 — HTF Structure</span>
                    <span className={`text-xs font-bold ${livePhase.p1 >= 15 ? 'text-green-400' : livePhase.p1 >= 10 ? 'text-yellow-400' : 'text-red-400'}`}>{livePhase.p1}/20</span>
                  </div>
                  {[
                    ['p1_hh_ll_breaks_key',   'HH/LL breaks key level (Asia/Session High/Low)'],
                    ['p1_buildup_created',     'Buildup / inducement created after break'],
                    ['p1_engineered_pullback', 'Engineered pullback to prior demand/supply (timestamp POI)'],
                    ['p1_micro_poi_confirm',   'Demand/supply tap with strong displacement (micro-POI)'],
                  ].map(([k, label]) => (
                    <label key={k} className="flex items-start gap-2 cursor-pointer group">
                      <input type="checkbox" checked={!!entry[k]} onChange={ev => set(k, ev.target.checked)}
                        className="mt-0.5 accent-blue-500 shrink-0"/>
                      <span className={`text-xs ${entry[k] ? 'text-gray-200' : 'text-gray-600'} group-hover:text-gray-400 transition-colors`}>{label}</span>
                    </label>
                  ))}
                </div>
              )}
              {(entry.model_type === 'Bullish Reversal' || entry.model_type === 'Bearish Reversal') && (
                <div className="border border-gray-800 rounded p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 uppercase tracking-widest">Phase 1 — HTF Structure</span>
                    <span className={`text-xs font-bold ${livePhase.p1 >= 15 ? 'text-green-400' : livePhase.p1 >= 10 ? 'text-yellow-400' : 'text-red-400'}`}>{livePhase.p1}/20</span>
                  </div>
                  {[
                    ['p1_ll_hh_into_htf',        'LL/HH confirmed into HTF demand/supply zone'],
                    ['p1_macro_liq_sweep',        'Macro liquidity sweep (Tier 1: PDH/PDL, Weekly, Asia)'],
                    ['p1_displacement_into_poi',  'Displacement candle into HTF POI confirmed'],
                  ].map(([k, label]) => (
                    <label key={k} className="flex items-start gap-2 cursor-pointer group">
                      <input type="checkbox" checked={!!entry[k]} onChange={ev => set(k, ev.target.checked)}
                        className="mt-0.5 accent-blue-500 shrink-0"/>
                      <span className={`text-xs ${entry[k] ? 'text-gray-200' : 'text-gray-600'} group-hover:text-gray-400 transition-colors`}>{label}</span>
                    </label>
                  ))}
                </div>
              )}
              {/* Phase 1 live feedback */}
              {entry.model_type && (
                <div className={`text-xs rounded px-3 py-2 border ${livePhase.p1Pass ? 'border-green-800 bg-green-950/20 text-green-400' : 'border-gray-800 text-gray-600'}`}>
                  {livePhase.p1Pass ? `✓ Phase 1: ${livePhase.p1}/20 PASS — HTF structure confirmed` : `Phase 1: ${livePhase.p1}/20 — Complete checkpoints above`}
                </div>
              )}
            </div>
          )}

          {/* S3 — Primary Sweep */}
          {currentId === 'primary_sweep' && (
            <div className="space-y-4">
              <div>
                <FL>Liquidity Pool <InfoTip content="Select liquidity levels that will be swept by this trade"/></FL>
                <div className={`grid grid-cols-3 gap-2 ${validationErrors.liquidity_type ? 'ring-1 ring-red-500 rounded p-2' : ''}`}>
                  {TIER_COLS.map(col => (
                    <div key={col.tier}>
                      <div className="flex items-center gap-1 mb-2 pb-1 border-b border-gray-800">
                        <span className="text-gray-600 text-xs uppercase tracking-widest leading-tight">{col.header}</span>
                        <InfoTip content={col.tip}/>
                      </div>
                      <div className="space-y-1">
                        {col.items.map(item => {
                          const active = entry.liquidity_type.includes(item);
                          return (
                            <button key={item} onClick={() => {
                              // BUG-006: derive tier from all remaining selections,
                              // always using highest significance (lowest tier number)
                              const newTypes = entry.liquidity_type.includes(item)
                                ? entry.liquidity_type.filter(x => x !== item)
                                : [...entry.liquidity_type, item];
                              const _t1 = TIER_COLS[0].items, _t2 = TIER_COLS[1].items;
                              const derivedTier = newTypes.some(l => _t1.includes(l)) ? 'Tier 1'
                                : newTypes.some(l => _t2.includes(l)) ? 'Tier 2'
                                : newTypes.length > 0 ? 'Tier 3' : '';
                              setEntryRaw(p => ({ ...p, liquidity_type: newTypes, liquidity_tier: derivedTier }));
                            }}
                              className={`w-full text-left px-2 py-1.5 rounded border text-xs cursor-pointer transition-colors leading-tight ${
                                active ? 'border-blue-500 bg-blue-900/60 text-blue-100 ring-1 ring-blue-500 ring-inset' :
                                         'border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-300 bg-gray-950'
                              }`}>{item}</button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {validationErrors.liquidity_type && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div><FL>Sweep Quality</FL><TG opts={O.sweepQ} val={entry.sweep_quality} onSel={v=>set('sweep_quality',v)} cols={3}/></div>
              <div>
                <FL>Sweep Distance (pips) <InfoTip content="Measure from the liquidity level to the extreme of the wick that swept it in pips. Measure on the same timeframe you identified the liquidity on"/></FL>
                <NI val={entry.sweep_distance_pips} onChg={v=>set('sweep_distance_pips',v)} ph="e.g. 8.5"/>
              </div>
              {/* Phase 2 live feedback */}
              {(entry.sweep_quality || entry.sweep_distance_pips) && (
                <div className={`text-xs rounded px-3 py-2 border ${livePhase.p2Pass ? 'border-green-800 bg-green-950/20 text-green-400' : livePhase.p2 >= 10 ? 'border-yellow-800 bg-yellow-950/20 text-yellow-400' : 'border-gray-800 text-gray-600'}`}>
                  {livePhase.p2Pass
                    ? `✓ Phase 2: ${livePhase.p2}/20 PASS — Inducement + sweep confirmed`
                    : `Phase 2: ${livePhase.p2}/20 — ${livePhase.p2Details.filter(d=>!d.pass).map(d=>d.label).join(' · ')}`
                  }
                </div>
              )}
            </div>
          )}

          {/* S4 — Second Sweep (conditional, gates apply) */}
          {currentId === 'second_sweep' && (
            <div className="space-y-4">
              <div>
                <FL>Failed Continuation? <InfoTip content="After the first sweep did price attempt to continue in the original direction and fail? A failed continuation means price made a move toward the original target but could not sustain it. This gives the second sweep structural significance"/></FL>
                <YN val={entry.failed_continuation} onChg={v=>set('failed_continuation',v)}/>
              </div>
              {entry.failed_continuation === false && (
                <div className="text-xs text-gray-700 border border-gray-800 rounded px-3 py-2.5">
                  Gate 1 not met — second sweep fields hidden (failed_continuation = No).
                </div>
              )}
              {s4Unlocked && (
                <div className="space-y-4 border-l-2 border-gray-800 pl-3 ml-1">
                  <div>
                    <FL>Secondary Liquidity Tier</FL>
                    <div className="text-xs text-gray-700 mb-2">Second sweep must match or exceed primary tier. Lower tiers are greyed out.</div>
                    <TG opts={O.tiers} val={entry.secondary_liquidity_tier} onSel={v=>set('secondary_liquidity_tier',v)}
                      disabled={v => (BL_TIER_RANK[v]||0) < primTierRank} cols={3}/>
                  </div>
                  <div><FL>Secondary Liquidity Type (multi)</FL><TG opts={O.liqType} val={entry.secondary_liquidity_type} onSel={v=>toggleArr('secondary_liquidity_type',v)} multi cols={3}/></div>
                  <div><FL>Secondary Sweep Quality</FL><TG opts={O.sweepQ} val={entry.secondary_sweep_quality} onSel={v=>set('secondary_sweep_quality',v)} cols={3}/></div>
                  <div>
                    <FL>Secondary Displacement Quality</FL>
                    <TG opts={O.dispQ} val={entry.secondary_displacement_quality} onSel={handleSecDisp} cols={3}/>
                    {overrideApplied && (
                      <div className="mt-2 text-xs border border-orange-700 bg-orange-950/20 text-orange-400 rounded px-2.5 py-2">
                        ⚠ Override Applied — secondary weaker than primary. SQS −8 penalty active. Cannot be waived.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* S5 — Displacement / Structure */}
          {currentId === 'displacement' && (
            <div className="space-y-4">
              <div>
                <div className={validationErrors.displacement_confirmed ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Displacement Confirmed?</FL>
                  <YN val={entry.displacement_confirmed} onChg={v=>set('displacement_confirmed',v)}/>
                </div>
                {validationErrors.displacement_confirmed && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div>
                <div className={validationErrors.displacement_quality ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Displacement Quality</FL>
                  <TG opts={O.dispQ} val={entry.displacement_quality} onSel={v=>set('displacement_quality',v)} cols={3}/>
                </div>
                {validationErrors.displacement_quality && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div>
                <FL>Candle Close Position <InfoTip content="Where did the displacement candle close within its own range? Above 50% means it closed in the upper half. At H/L means it closed at the extreme which is maximum strength. Measure on M1"/></FL>
                <TG opts={O.candleP} val={entry.candle_close_position} onSel={v=>set('candle_close_position',v)} cols={3}/>
              </div>
              <div>
                <div className={validationErrors.choch_or_bos ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>CHoCH or BOS Present?</FL>
                  <TG opts={O.chochBos} val={entry.choch_or_bos} onSel={v=>set('choch_or_bos',v)} cols={3}/>
                </div>
                {validationErrors.choch_or_bos && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div>
                <div className={validationErrors.structure_confirmation ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Structure Confirmation</FL>
                  <TG opts={O.struct} val={entry.structure_confirmation} onSel={v=>set('structure_confirmation',v)} cols={3}/>
                </div>
                {validationErrors.structure_confirmation && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
            </div>
          )}

          {/* S6 — POI / Inducement */}
          {currentId === 'poi' && (
            <div className="space-y-4">
              <div>
                <div className={validationErrors.poi_type ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>POI Type</FL>
                  <TG opts={O.poiT} val={entry.poi_type} onSel={v=>set('poi_type',v)} cols={2}/>
                </div>
                {validationErrors.poi_type && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div><FL>POI Size (pips)</FL><NI val={entry.poi_size_pips} onChg={v=>set('poi_size_pips',v)} ph="e.g. 15"/></div>
              <div>
                <div className={validationErrors.inducement_confirmed ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Inducement Confirmed?</FL>
                  <YN val={entry.inducement_confirmed} onChg={v=>set('inducement_confirmed',v)}/>
                </div>
                {validationErrors.inducement_confirmed && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div><FL>Inducement Type (multi)</FL><TG opts={O.indType} val={entry.inducement_type} onSel={v=>toggleArr('inducement_type',v)} multi cols={2}/></div>
              <div>
                <div className={validationErrors.ltf_confirmation ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>LTF Confirmation</FL>
                  <TG opts={O.ltf} val={entry.ltf_confirmation} onSel={v=>set('ltf_confirmation',v)} cols={2}/>
                </div>
                {validationErrors.ltf_confirmation && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div>
                <div className={validationErrors.full_sequence_complete ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Full Sequence Complete?</FL>
                  <YN val={entry.full_sequence_complete} onChg={v=>set('full_sequence_complete',v)}/>
                </div>
                {validationErrors.full_sequence_complete && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>

              {/* ── Phase 4: Pre-Entry Strength Signal ── */}
              <div className="border border-gray-800 rounded p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 uppercase tracking-widest">Phase 4 — Pre-Entry Signal <span className="text-gray-700 normal-case">(optional · A+ booster)</span></span>
                  <span className={`text-xs font-bold ${entry.p4_micro_poi_present ? 'text-green-400' : 'text-gray-600'}`}>{livePhase.p4}/10</span>
                </div>
                <label className="flex items-start gap-2 cursor-pointer group">
                  <input type="checkbox" checked={!!entry.p4_micro_poi_present} onChange={ev => set('p4_micro_poi_present', ev.target.checked)}
                    className="mt-0.5 accent-blue-500 shrink-0"/>
                  <span className={`text-xs ${entry.p4_micro_poi_present ? 'text-gray-200' : 'text-gray-600'} group-hover:text-gray-400 transition-colors`}>
                    Micro-POI tap (1–3 pips) with massive displacement (5+ pips) occurred 30–90 min before entry
                  </span>
                </label>
                {entry.p4_micro_poi_present && (
                  <div className="text-xs text-green-400 border border-green-800 bg-green-950/20 rounded px-2 py-1.5">
                    +10/10 — Pre-entry strength signal confirmed. A+ upgrade eligible.
                  </div>
                )}
              </div>

              {/* Phase 3 live feedback */}
              {entry.ltf_confirmation && (
                <div className={`text-xs rounded px-3 py-2 border ${livePhase.p3Pass ? 'border-green-800 bg-green-950/20 text-green-400' : livePhase.p3 >= 15 ? 'border-yellow-800 bg-yellow-950/20 text-yellow-400' : 'border-gray-800 text-gray-600'}`}>
                  {livePhase.p3Pass
                    ? `✓ Phase 3: ${livePhase.p3}/30 PASS — Entry trigger confirmed`
                    : `Phase 3: ${livePhase.p3}/30 — ${livePhase.p3Details.filter(d=>!d.pass).map(d=>d.label).join(' · ')}`
                  }
                </div>
              )}
            </div>
          )}

          {/* S7 — Entry Details */}
          {currentId === 'entry' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div><FL>Entry Price</FL><NI val={entry.entry_price} onChg={v=>set('entry_price',v)} ph="1.08450"/></div>
                <div><FL>Stop Price</FL><NI val={entry.stop_price} onChg={v=>set('stop_price',v)} ph="1.08320"/></div>
              </div>
              {entry.stop_distance_pips && (
                <div className="text-xs text-blue-400 border border-blue-900 bg-blue-950/20 rounded px-3 py-2">
                  Stop Distance: <span className="font-bold">{entry.stop_distance_pips}p</span> <span className="text-gray-600">(auto-calculated)</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><FL>Target RR</FL><NI val={entry.target_rr} onChg={v=>set('target_rr',v)} ph="e.g. 5"/></div>
                <div><FL>Target Description</FL><TxtIn val={entry.target_description} onChg={v=>set('target_description',v)} ph="e.g. LDL at 1.09"/></div>
              </div>
            </div>
          )}

          {/* S8 — Outcome */}
          {currentId === 'outcome' && (
            <div className="space-y-4">
              <div>
                <div className={validationErrors.result ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Result</FL>
                  <TG opts={O.result} val={entry.result} onSel={v=>set('result',v)} cols={4}/>
                </div>
                {validationErrors.result && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              <div><FL>R Achieved</FL><NI val={entry.r_achieved} onChg={v=>set('r_achieved',v)} ph="e.g. 6.5"/></div>
              <div><FL>Exit Reason</FL><TG opts={O.exit} val={entry.exit_reason} onSel={v=>set('exit_reason',v)} cols={4}/></div>
              <div>
                <div className={validationErrors.trade_grade ? 'ring-1 ring-red-500 rounded' : ''}>
                  <FL>Trade Grade (manual)</FL>
                  <TG opts={O.grades} val={entry.trade_grade} onSel={v=>set('trade_grade',v)} cols={4}/>
                </div>
                {validationErrors.trade_grade && <div className="mt-1 text-xs text-red-500">Required</div>}
              </div>
              {/* Phase 5 live feedback */}
              {(entry.result || entry.r_achieved) && (
                <div className={`text-xs rounded px-3 py-2 border ${livePhase.p5Pass ? 'border-green-800 bg-green-950/20 text-green-400' : livePhase.p5 >= 5 ? 'border-yellow-800 bg-yellow-950/20 text-yellow-400' : 'border-gray-800 text-gray-600'}`}>
                  {livePhase.p5Pass
                    ? `✓ Phase 5: ${livePhase.p5}/20 PASS — Exit discipline confirmed`
                    : `Phase 5: ${livePhase.p5}/20 — ${livePhase.p5Details.filter(d=>!d.pass).map(d=>d.label).join(' · ')}`
                  }
                </div>
              )}
              {/* Conflict warning: user grade vs auto-grade */}
              {entry.trade_grade && livePhase.autoGrade && entry.trade_grade !== livePhase.autoGrade && (
                <div className="text-xs rounded px-3 py-2 border border-orange-700 bg-orange-950/20 text-orange-300">
                  ⚠ Grade mismatch — You selected <span className="font-bold">{entry.trade_grade}</span> but auto-eval scores this as <span className="font-bold">{livePhase.autoGrade}</span> ({livePhase.total}/100).
                  If you proceed, a reason will be required at the Summary step.
                </div>
              )}
            </div>
          )}

          {/* S9 — Rules / Warnings */}
          {currentId === 'rules' && (
            <div className="space-y-4">
              {/* Rule Triggered */}
              <div>
                <FL>Rule Triggered</FL>
                {/* No Rules Triggered button */}
                <div className="mb-2">
                  <button
                    onClick={() => set('rule_triggered', entry.rule_triggered === 'NONE' ? [] : 'NONE')}
                    className={`w-full py-2.5 rounded border text-xs cursor-pointer transition-colors font-bold ${
                      entry.rule_triggered === 'NONE'
                        ? 'border-green-600 bg-green-900/40 text-green-200 ring-1 ring-green-600 ring-inset'
                        : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950'
                    }`}>
                    ✓ No Rules Triggered
                  </button>
                </div>
                {/* Rule buttons grid */}
                <div className="grid gap-1.5 grid-cols-3">
                  {O.rules.map(([v, l]) => {
                    const noRules = entry.rule_triggered === 'NONE';
                    const active = Array.isArray(entry.rule_triggered) && entry.rule_triggered.includes(v);
                    return (
                      <button key={v}
                        disabled={noRules}
                        onClick={() => { if (noRules) return; toggleArr('rule_triggered', v); }}
                        className={`relative py-3 px-2 rounded border text-xs cursor-pointer text-center leading-tight transition-colors ${
                          noRules ? 'border-gray-800 text-gray-800 bg-gray-950 cursor-not-allowed' :
                          active  ? 'border-blue-500 bg-blue-900/60 text-blue-100 font-bold ring-1 ring-blue-500 ring-inset' :
                                    'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950 hover:bg-gray-900'
                        }`}>
                        <span>{l}</span>
                        <span className="absolute top-1 right-1"><InfoTip content={RULE_TIPS[v]} position="left"/></span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Warning Signal Present — 3 options: Yes / No / No Warning */}
              <div>
                <FL>Warning Signal Present?</FL>
                <div className="flex gap-2">
                  {[[true,'Yes'],[false,'No'],['none','No Warning']].map(([b, lbl]) => (
                    <button key={String(b)} onClick={() => set('warning_signal_present', entry.warning_signal_present === b ? null : b)}
                      className={`flex-1 py-3 rounded border text-xs cursor-pointer transition-colors ${
                        entry.warning_signal_present === b
                          ? b === true  ? 'border-green-500 bg-green-900/50 text-green-100 font-bold ring-1 ring-green-600 ring-inset'
                          : b === false ? 'border-red-600 bg-red-900/40 text-red-100 font-bold ring-1 ring-red-700 ring-inset'
                                        : 'border-gray-500 bg-gray-800 text-gray-200 font-bold ring-1 ring-gray-500 ring-inset'
                          : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 bg-gray-950'
                      }`}>{lbl}</button>
                  ))}
                </div>
              </div>

              {/* Warning Signal Acted On — only if warning_signal_present === true */}
              {entry.warning_signal_present === true && (
                <div>
                  <FL>Warning Signal Acted On?</FL>
                  <YN val={entry.warning_signal_acted_on} onChg={v=>set('warning_signal_acted_on',v)}/>
                </div>
              )}

              {/* Failed At Stage — only if result is not Win */}
              {entry.result && entry.result !== 'Win' && (
                <div>
                  <FL>Failed At Stage (multi)</FL>
                  <TG opts={O.failSt} val={entry.failed_at_stage} onSel={v=>toggleArr('failed_at_stage',v)} multi cols={4}/>
                </div>
              )}
            </div>
          )}

          {/* S10 — Notes (S10 counterfactual added second-pass) */}
          {currentId === 'notes' && (
            <div className="space-y-4">
              <div className="text-xs text-gray-700 border border-gray-800 rounded px-3 py-2">Section 10 — Counterfactual is added after the trade plays out from the logs panel below.</div>
              <div><FL>Price Context</FL><TA2 val={entry.price_context} onChg={v=>set('price_context',v)} ph="Where was price? What was the macro context?"/></div>
              <div><FL>Execution Notes</FL><TA2 val={entry.execution_notes} onChg={v=>set('execution_notes',v)} ph="How did you enter? Any hesitation?"/></div>
              <div><FL>Key Takeaway</FL><TA2 val={entry.key_takeaway} onChg={v=>set('key_takeaway',v)} ph="What did this trade teach you?"/></div>
              <div><FL>Counterfactual</FL><TA2 val={entry.counterfactual_notes} onChg={v=>set('counterfactual_notes',v)} ph="What did price do after your exit? Did the original target get hit? What would the outcome have been if you had held?"/></div>
              <div>
                <FL>Chart Screenshot</FL>
                {entry.chart_screenshot_url ? (
                  <div className="space-y-2">
                    <img src={entry.chart_screenshot_url} alt="chart screenshot"
                      className="rounded border border-gray-800 max-h-48 object-contain w-full bg-gray-950 cursor-pointer"
                      onClick={() => window.open(entry.chart_screenshot_url, '_blank')}/>
                    <button onClick={() => { set('chart_screenshot_url', ''); setImgError(''); }}
                      className="text-xs text-gray-600 hover:text-red-400 border border-gray-800 rounded px-2 py-1 cursor-pointer transition-colors">
                      ✕ Remove
                    </button>
                  </div>
                ) : (
                  <label className={`flex flex-col items-center justify-center w-full border border-dashed rounded py-6 cursor-pointer transition-colors ${
                    imgUploading ? 'border-gray-700 bg-gray-950' : 'border-gray-700 bg-gray-950 hover:border-gray-500 hover:bg-gray-900'
                  }`}>
                    <input type="file" accept="image/*" className="hidden" onChange={handleImgUpload} disabled={imgUploading}/>
                    {imgUploading
                      ? <span className="text-xs text-gray-500">Uploading…</span>
                      : <>
                          <span className="text-2xl mb-1">📷</span>
                          <span className="text-xs text-gray-500">Tap to upload chart screenshot</span>
                          <span className="text-xs text-gray-700 mt-0.5">PNG, JPG, WEBP</span>
                        </>
                    }
                  </label>
                )}
                {imgError && <div className="mt-1 text-xs text-red-400">{imgError}</div>}
              </div>
            </div>
          )}

          {/* Summary — full review before logging */}
          {currentId === 'summary' && (() => {
            const pgb = phaseBand(livePhase.autoGrade);
            const gradeConflict = entry.trade_grade && livePhase.autoGrade && entry.trade_grade !== livePhase.autoGrade;
            const phaseRows = [
              { label:'Phase 1', sub:'HTF Structure',       score:livePhase.p1,  max:20, pass:livePhase.p1Pass,  details:livePhase.p1Details },
              { label:'Phase 2', sub:'Inducement + Sweep',  score:livePhase.p2,  max:20, pass:livePhase.p2Pass,  details:livePhase.p2Details },
              { label:'Phase 3', sub:'Entry Trigger',       score:livePhase.p3,  max:30, pass:livePhase.p3Pass,  details:livePhase.p3Details },
              { label:'Phase 4', sub:'Pre-Entry Signal',    score:livePhase.p4,  max:10, pass:livePhase.p4 > 0,  details:livePhase.p4Details },
              { label:'Phase 5', sub:'Exit Discipline',     score:livePhase.p5,  max:20, pass:livePhase.p5Pass,  details:livePhase.p5Details },
            ];
            return (
            <div className="space-y-4">
              {/* ── Dual grade header: SQS + Auto-Phase ── */}
              <div className="grid grid-cols-2 gap-2">
                <div className={`flex items-center gap-2 border rounded p-3 ${liveBand.ring} bg-gray-950`}>
                  <span className={`font-bold text-2xl leading-none ${liveBand.color}`}>{entry.liquidity_tier && entry.displacement_quality ? liveSQS : '—'}</span>
                  <div>
                    <div className={`font-bold text-xs ${liveBand.color}`}>SQS {entry.liquidity_tier && entry.displacement_quality ? liveBand.grade : ''}</div>
                    <div className="text-xs text-gray-700">Sweep quality score</div>
                  </div>
                </div>
                <div className={`flex items-center gap-2 border rounded p-3 ${pgb.ring} ${pgb.bg}`}>
                  <span className={`font-bold text-2xl leading-none ${pgb.color}`}>{livePhase.total}</span>
                  <div>
                    <div className={`font-bold text-xs ${pgb.color}`}>Auto Grade: {livePhase.autoGrade}</div>
                    <div className="text-xs text-gray-700">5-phase eval score</div>
                  </div>
                </div>
              </div>

              {/* ── Phase breakdown ── */}
              <div className="border border-gray-800 rounded overflow-hidden">
                <div className="px-3 py-2 bg-gray-900/60 border-b border-gray-800 flex items-center justify-between">
                  <span className="text-xs text-gray-500 uppercase tracking-widest">5-Phase Evaluation</span>
                  <span className={`text-xs font-bold ${pgb.color}`}>{livePhase.total}/100 → {livePhase.autoGrade}</span>
                </div>
                {phaseRows.map((ph, i) => (
                  <div key={i} className="border-b border-gray-800/60 last:border-b-0">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className={`text-xs font-bold w-4 ${ph.pass ? 'text-green-400' : 'text-gray-600'}`}>{ph.pass ? '✓' : '✗'}</span>
                      <span className="text-xs text-gray-400 font-bold w-16 shrink-0">{ph.label}</span>
                      <span className="text-xs text-gray-700 flex-1">{ph.sub}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <div className="w-20 bg-gray-800 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full transition-all ${ph.pass ? 'bg-green-600' : ph.score > 0 ? 'bg-yellow-600' : 'bg-gray-700'}`}
                            style={{ width: `${Math.round((ph.score / ph.max) * 100)}%` }}/>
                        </div>
                        <span className={`text-xs font-bold w-10 text-right ${ph.pass ? 'text-green-400' : ph.score > 0 ? 'text-yellow-400' : 'text-gray-600'}`}>
                          {ph.score}/{ph.max}
                        </span>
                      </div>
                    </div>
                    {/* Failed checkpoints */}
                    {!ph.pass && ph.details.filter(d=>!d.pass).length > 0 && (
                      <div className="px-8 pb-2 space-y-0.5">
                        {ph.details.filter(d=>!d.pass).map((d, j) => (
                          <div key={j} className="text-xs text-gray-700">✗ {d.label}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* ── Grade conflict warning + override reason ── */}
              {gradeConflict && (
                <div className="border border-orange-700 bg-orange-950/20 rounded p-3 space-y-2">
                  <div className="text-xs text-orange-300 font-bold">
                    ⚠ Grade Conflict — You selected <span className="text-white">{entry.trade_grade}</span> but auto-eval scored <span className="text-white">{livePhase.autoGrade}</span> ({livePhase.total}/100 pts)
                  </div>
                  <div className="text-xs text-gray-500">
                    {livePhase.p1Pass && livePhase.p2Pass && livePhase.p3Pass
                      ? 'Phases 1–3 passed. Review Phase 4/5 for upgrade/downgrade reason.'
                      : !livePhase.p1Pass ? 'Phase 1 failed — HTF structure not fully confirmed.'
                      : !livePhase.p2Pass ? 'Phase 2 failed — Inducement or sweep incomplete.'
                      : 'Phase 3 failed — Entry trigger not fully confirmed.'}
                  </div>
                  <div>
                    <FL>Override Reason (required)</FL>
                    <TA2 val={entry.phase_override_reason} onChg={v=>set('phase_override_reason',v)} ph={`Why is your ${entry.trade_grade} grade correct vs auto-eval ${livePhase.autoGrade}?`}/>
                  </div>
                </div>
              )}

              {/* ── Trade data summary rows ── */}
              <div className="border border-gray-800 rounded p-3 space-y-0.5">
                <SumRow label="Pair / Direction" val={`${entry.pair} ${entry.direction}`}/>
                <SumRow label="Date / Session" val={`${entry.date} · ${entry.session}`}/>
                <SumRow label="Sequence" val={entry.sequence_type}/>
                <SumRow label="Model" val={entry.model_type||null}/>
                <SumRow label="Liquidity Tier" val={entry.liquidity_tier ? ({'Tier 1':'Tier 1 (Macro)','Tier 2':'Tier 2 (Intra-day)','Tier 3':'Tier 3 (Internal)'}[entry.liquidity_tier] || entry.liquidity_tier) : null}/>
                <SumRow label="Sweep Quality" val={entry.sweep_quality}/>
                <SumRow label="Displacement" val={entry.displacement_quality ? `${entry.displacement_quality} · ${entry.structure_confirmation}` : null}/>
                <SumRow label="Inducement" val={(entry.inducement_type||[]).join(', ')||null}/>
                <SumRow label="LTF Confirm" val={entry.ltf_confirmation}/>
                <SumRow label="Seq Complete" val={entry.full_sequence_complete===true?'✓ Yes':entry.full_sequence_complete===false?'✗ No':null}/>
                <SumRow label="Entry / Stop" val={entry.entry_price?`${entry.entry_price} → ${entry.stop_price} (${entry.stop_distance_pips}p)`:null}/>
                <SumRow label="Target RR" val={entry.target_rr?`${entry.target_rr}R`:null}/>
                <SumRow label="Result" val={entry.result?`${entry.result}${entry.r_achieved?` · ${entry.r_achieved}R`:''}`:null}/>
                <SumRow label="User Grade" val={entry.trade_grade}/>
                <SumRow label="Auto Grade" val={`${livePhase.autoGrade} (${livePhase.total}/100)`}/>
                <SumRow label="Pre-Entry Signal" val={entry.p4_micro_poi_present ? '✓ Present (+10)' : 'Absent'}/>
                <SumRow label="Rules Triggered" val={entry.rule_triggered === 'NONE' ? 'None' : (entry.rule_triggered||[]).length?(entry.rule_triggered||[]).join(', '):null}/>
                <SumRow label="Warning Signal" val={
                  entry.warning_signal_present === true ? `Yes · Acted on: ${entry.warning_signal_acted_on===true?'Yes':entry.warning_signal_acted_on===false?'No':'—'}` :
                  entry.warning_signal_present === false ? 'No' :
                  entry.warning_signal_present === 'none' ? 'No Warning' : null
                }/>
              </div>
              <div className="flex items-center gap-2">
                {overrideApplied && <span className="text-xs border border-orange-700 bg-orange-950/20 text-orange-400 rounded px-2 py-0.5">⚠ SQS Override −8</span>}
                {entry.bias_aligned === false && <span className="text-xs border border-yellow-700 bg-yellow-950/20 text-yellow-400 rounded px-2 py-0.5">⚠ Bias Unaligned</span>}
                {entry.liquidity_tier && entry.displacement_quality && liveSQS < 40 && liveSQS > 0 && <span className="text-xs border border-red-700 bg-red-950/20 text-red-400 rounded px-2 py-0.5">🔴 SQS Auto NO TRADE</span>}
                {(!livePhase.p1Pass || !livePhase.p2Pass) && <span className="text-xs border border-red-700 bg-red-950/20 text-red-400 rounded px-2 py-0.5">🔴 Phase Auto NO TRADE</span>}
              </div>
              {saveState === 'error' && (
                <div className="text-xs text-red-400 border border-red-800 bg-red-950/20 rounded px-3 py-2">❌ Save failed — check browser console.</div>
              )}
              {saveState === 'saved' && (
                <div className="text-xs text-green-400 border border-green-800 bg-green-950/20 rounded px-3 py-2">
                  ✓ Logged — SQS {sqsScore} ({sqsScore != null ? sqsBand(sqsScore).grade : '—'}) · Auto Grade: {livePhase.autoGrade} ({livePhase.total}/100). Add counterfactual below once the trade plays out.
                </div>
              )}
              <button onClick={handleSave} disabled={saveState === 'saving'}
                className={`w-full py-3 rounded border text-xs font-bold uppercase tracking-widest cursor-pointer transition-colors ${
                  saveState === 'saving' ? 'bg-gray-900 border-gray-700 text-gray-600 cursor-not-allowed' :
                  'bg-blue-950/30 hover:bg-blue-950/60 border-blue-600 text-blue-300'
                }`}>
                {saveState === 'saving' ? 'Saving…' : '📓 LOG BACKTEST ENTRY'}
              </button>
            </div>
            );
          })()}

          {/* ── Navigation ─────────────────────────────────────────── */}
          <div className="flex gap-2 mt-6 pt-4 border-t border-gray-800">
            {currentStep > 0 && (
              <button onClick={() => setStep(s => Math.max(0, s - 1))}
                className="px-5 py-2.5 rounded border border-gray-700 text-gray-400 text-xs cursor-pointer hover:border-gray-500 hover:text-gray-200 transition-colors">
                ← Back
              </button>
            )}
            {currentId !== 'summary' && (
              <button onClick={() => {
                const errs = validateStep(currentId);
                if (Object.keys(errs).length > 0) {
                  setValidationErrors(errs);
                } else {
                  setValidationErrors({});
                  setStep(s => Math.min(totalSteps - 1, s + 1));
                }
              }}
                className="flex-1 py-2.5 rounded border border-gray-600 bg-gray-900 hover:bg-gray-800 text-gray-200 text-xs font-bold cursor-pointer transition-colors">
                Next →
              </button>
            )}
          </div>
        </Panel>
      </div>

      {/* ── Override prompt modal ──────────────────────────────────── */}
      {overridePrompt !== null && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-950 border border-orange-700 rounded-sm p-5 max-w-sm w-full shadow-2xl">
            <div className="text-orange-400 font-bold text-sm mb-2">⚠ Override Required</div>
            <div className="text-xs text-gray-300 leading-relaxed mb-4">
              Secondary displacement (<span className="text-orange-300 font-bold">{overridePrompt}</span>) is weaker
              than primary displacement (<span className="font-bold">{entry.displacement_quality}</span>).<br/><br/>
              Proceeding applies a <span className="text-red-400 font-bold">−8 SQS penalty</span> and flags this
              entry with <span className="text-orange-400">Override Applied</span>. This cannot be waived.
            </div>
            <div className="flex gap-2">
              <button onClick={confirmOverride} className="flex-1 py-2 text-xs border border-orange-700 bg-orange-950/20 text-orange-400 rounded cursor-pointer hover:bg-orange-950/40">
                Accept Override + −8 SQS
              </button>
              <button onClick={()=>setOverridePrompt(null)} className="flex-1 py-2 text-xs border border-gray-700 text-gray-500 rounded cursor-pointer hover:border-gray-500">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm incomplete modal ───────────────────────────────── */}
      {confirmIncomplete && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-950 border border-yellow-700 rounded-sm p-5 max-w-sm w-full shadow-2xl">
            <div className="text-yellow-400 font-bold text-sm mb-2">⚠ Sequence Incomplete</div>
            <div className="text-xs text-gray-300 leading-relaxed mb-4">
              Full sequence is not marked complete. Are you sure you want to log this entry?
            </div>
            <div className="flex gap-2">
              <button onClick={doSave} className="flex-1 py-2 text-xs border border-yellow-700 bg-yellow-950/20 text-yellow-400 rounded cursor-pointer">Log Anyway</button>
              <button onClick={()=>setConfirmIncomplete(false)} className="flex-1 py-2 text-xs border border-gray-700 text-gray-500 rounded cursor-pointer">Go Back</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Recent logs + Section 10 counterfactual ───────────────── */}
      <div className="mt-4 px-4">
        <div className="bg-gray-950 border border-gray-800 rounded-sm">
          <button onClick={()=>{ setShowLogs(l=>!l); if(!showLogs) loadRecentLogs(); }}
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer">
            <span className="uppercase tracking-widest">📓 Recent Backtest Logs ({recentLogs.length})</span>
            <span>{showLogs ? '▲' : '▼'}</span>
          </button>
          {showLogs && (
            <div className="border-t border-gray-800">
              {recentLogs.length === 0 && <div className="px-4 py-3 text-xs text-gray-700">No entries yet.</div>}
              {recentLogs.map(log => {
                const b      = log.sqs_score != null ? sqsBand(log.sqs_score) : { grade:'—', color:'text-gray-600', ring:'border-gray-800' };
                const agb    = log.auto_grade ? phaseBand(log.auto_grade) : null;
                const needCF = log.setup_played_out == null;
                return (
                  <div key={log.id} className="border-b border-gray-800/50 last:border-b-0 px-4 py-3">
                    {/* Primary row: pair, dir, date, seq, sqs, result */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-gray-200 text-xs">{log.pair||'—'}</span>
                      <span className={`text-xs font-medium ${log.direction==='Long'?'text-green-500':'text-red-500'}`}>{log.direction||'—'}</span>
                      <span className="text-gray-600 text-xs">{log.date||'—'}</span>
                      <span className="text-gray-600 text-xs truncate max-w-[100px]">{log.sequence_type||'—'}</span>
                      <div className="flex items-center gap-1.5 ml-auto flex-wrap justify-end">
                        {log.sqs_score != null && (
                          <span className={`text-xs font-bold border rounded px-1.5 py-0.5 ${b.color} ${b.ring}`}>
                            {log.sqs_score} {b.grade}
                          </span>
                        )}
                        {log.auto_grade && agb && (
                          <span className={`text-xs font-bold border rounded px-1.5 py-0.5 ${agb.color} ${agb.ring}`}>
                            {log.phase_total_score}p {log.auto_grade}
                          </span>
                        )}
                        {log.grade_conflict && (
                          <span className="text-xs border border-orange-700 bg-orange-950/20 text-orange-400 rounded px-1.5 py-0.5">⚠ Grade Conflict</span>
                        )}
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${
                          log.result==='Win'  ? 'text-green-400 border-green-900 bg-green-950/20' :
                          log.result==='Loss' ? 'text-red-400 border-red-900 bg-red-950/20' :
                                               'text-gray-500 border-gray-800'
                        }`}>{log.result||'—'}</span>
                      </div>
                    </div>
                    {/* Persistent badge row */}
                    {(log.bias_aligned === false || log.second_sweep_override) && (
                      <div className="flex gap-1.5 mt-1.5 flex-wrap">
                        {log.bias_aligned === false && (
                          <span className="text-xs border border-yellow-700 bg-yellow-950/20 text-yellow-500 rounded px-1.5 py-0.5">⚠ Bias Unaligned</span>
                        )}
                        {log.second_sweep_override && (
                          <span className="text-xs border border-orange-700 bg-orange-950/20 text-orange-400 rounded px-1.5 py-0.5">⚠ Override Applied −8</span>
                        )}
                      </div>
                    )}
                    {/* Screenshot thumbnail */}
                    {log.chart_screenshot_url && (
                      <div className="mt-2">
                        <img src={log.chart_screenshot_url} alt="chart" className="h-16 rounded border border-gray-800 object-contain bg-gray-950 cursor-pointer"
                          onClick={() => window.open(log.chart_screenshot_url, '_blank')}/>
                      </div>
                    )}
                    {/* Counterfactual */}
                    {needCF && cfTarget !== log.id && (
                      <button onClick={()=>{ setCfTarget(log.id); setCfForm({ setup_played_out:null, counterfactual_r:'', decision_correct:null }); }}
                        className="mt-2 text-xs text-blue-400 border border-blue-900 hover:bg-blue-950/20 rounded px-2 py-1 cursor-pointer">
                        + Add Counterfactual (S10)
                      </button>
                    )}
                    {log.setup_played_out != null && (
                      <div className="mt-1.5 text-xs text-gray-600">
                        ✓ CF: {log.setup_played_out ? 'Played out' : 'Did not play'} · R {log.counterfactual_r ?? '—'} · {log.decision_correct ? 'Correct' : 'Decision incorrect'}
                      </div>
                    )}
                    {cfTarget === log.id && (
                      <div className="mt-2 border border-blue-900 bg-blue-950/10 rounded p-3 space-y-3">
                        <div className="text-xs text-blue-400 font-bold uppercase tracking-wider">Section 10 — Counterfactual</div>
                        <div>
                          <FL>Did the setup play out after you closed / passed?</FL>
                          <YN val={cfForm.setup_played_out} onChg={v=>setCfForm(p=>({...p,setup_played_out:v}))} yes="Yes — Played out" no="No — Did not play"/>
                        </div>
                        <div>
                          <FL>Counterfactual R (what it would have achieved)</FL>
                          <NI val={cfForm.counterfactual_r} onChg={v=>setCfForm(p=>({...p,counterfactual_r:v}))} ph="e.g. 8.0"/>
                        </div>
                        <div>
                          <FL>Was the original decision correct?</FL>
                          <YN val={cfForm.decision_correct} onChg={v=>setCfForm(p=>({...p,decision_correct:v}))} yes="Yes — Correct" no="No — Should have acted differently"/>
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button onClick={saveCF} disabled={cfSaving}
                            className={`flex-1 py-2 text-xs rounded border cursor-pointer transition-colors ${cfSaving?'border-gray-700 text-gray-600':'border-blue-700 bg-blue-950/30 text-blue-400 hover:bg-blue-950/50'}`}>
                            {cfSaving ? 'Saving…' : 'Save Counterfactual'}
                          </button>
                          <button onClick={()=>setCfTarget(null)} className="px-3 py-2 text-xs border border-gray-700 text-gray-500 rounded cursor-pointer">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// ROOT COMPONENT
// ═══════════════════════════════════════════════════════════════════════

export default function WTA1() {
  const [tab, setTab]           = useState("evaluate");
  const [inp, setInp]           = useState({ ...EMPTY });
  const [disc, setDisc]         = useState({ trades:0, pnl:0 });
  const [tradeLog, setTradeLog] = useState([]);
  const [journal, setJournal]           = useState([]);
  const [journalLoading, setJournalLoading] = useState(true);
  const [journalError, setJournalError] = useState(null);

  // Load trades from Supabase on mount
  useEffect(() => {
    async function loadTrades() {
      setJournalLoading(true);
      setJournalError(null);
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        console.error('Failed to load trades:', error.message);
        setJournalError(error.message);
      } else {
        setJournal((data || []).map(normaliseTrade));
      }
      setJournalLoading(false);
    }
    loadTrades();
  }, []);

  const set = useCallback((k,v)=>setInp(p=>({...p,[k]:v})),[]);
  const ev  = useMemo(()=>runPipeline(inp, journal),[inp, journal]);
  const discEval = useMemo(()=>checkDiscipline(disc),[disc]);
  const mgmt     = useMemo(()=>evalMgmt(inp),[inp]);

  const addToJournal = useCallback(async (trade) => {
    const rawScreenshots = Array.isArray(trade.screenshots)
      ? trade.screenshots
      : (Array.isArray(trade.images) ? trade.images : []);
    const compressed = await Promise.all(rawScreenshots.map(s => compressImage(s)));

    // Use explicitly entered direction (Long / Short).
    // Only fall back to htfBias derivation when direction is genuinely absent
    // (e.g. old Live Mode saves that predate the direction field).
    const direction = trade.direction ||
      (trade.htfBias === 'bearish' ? 'Short' :
       trade.htfBias === 'bullish' ? 'Long' : '');

    // Robust trade_date: use backtestDate for backtests, else today
    const tradeDate = (() => {
      if (trade.isBacktest && trade.backtestDate) {
        const d = new Date(trade.backtestDate);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
      }
      return new Date().toISOString().split('T')[0];
    })();

    // Store all granular inp fields alongside the pipeline snapshot
    // so they can be restored when loading from Supabase
    const pipelineBlob = JSON.stringify({
      snapshot: trade.pipelineSnapshot || {},
      inp: {
        poiLocation:    trade.poiLocation    || '',
        poiSizePips:    trade.poiSizePips    || '',
        poiType:        trade.poiType        || '',
        m5Build:        trade.m5Build        || false,
        m5Ind:          trade.m5Ind          || false,
        m5Push:         trade.m5Push         || false,
        liquidityType:  Array.isArray(trade.liquidityType) ? trade.liquidityType : [],
        multiLayerTrap: trade.multiLayerTrap || false,
        trapWho:        trade.trapWho        || '',
        trapClarity:    trade.trapClarity    || '',
        dispQuality:    trade.dispQuality    || '',
        fvgPresent:     trade.fvgPresent     || '',
        failType:       trade.failType       || '',
        firstLeg:       trade.firstLeg       || false,
        secondLeg:      trade.secondLeg      || false,
        bosStatus:      trade.bosStatus      || '',
        entryIdea:      trade.entryIdea      || '',
        ltfConfirm:     trade.ltfConfirm     || '',
        stopPips:       trade.stopPips       || '',
        riskPct:        trade.riskPct        || '',
        estRR:          trade.estRR          || '',
        rangeLoc:       trade.rangeLoc       || '',
        htfBias:        trade.htfBias        || '',
        isBacktest:     trade.isBacktest     || false,
      },
    });

    const payload = {
      pair:        trade.pair        || '',
      setup:       (LABEL_MAP[trade.setupType || trade.setup || ''] || trade.setupType || trade.setup || ''),
      session:     (LABEL_MAP[trade.session || ''] || trade.session || ''),
      htf_bias:    (LABEL_MAP[trade.htfBias || ''] || trade.htfBias || ''),
      direction,
      poi:         trade.poiLocation || trade.poi    || '',
      liquidity:   (() => {
        if (Array.isArray(trade.liquidityType) && trade.liquidityType.length > 0)
          return trade.liquidityType.map(k => LABEL_MAP[k] || k).join(', ');
        return trade.liquidity || '';
      })(),
      model:       (() => {
        const raw = trade.model || trade.setupType || trade.selectedModel || trade.setup || '';
        return LABEL_MAP[raw] || raw;
      })(),
      grade:       trade.grade       || '',
      outcome:     OUTCOME_LABELS[trade.outcome] || trade.outcome || '',
      r_achieved:  parseFloat(trade.rAchieved) || 0,
      notes:       trade.notes       || '',
      pipeline:    pipelineBlob,
      screenshots: compressed,
      trade_date:  tradeDate,
      // ── 7 precision-validation fields, saved as human-readable labels ──
      rifc_pip_size:        (trade.rifcPipSize === "" || trade.rifcPipSize == null)
                              ? null : parseFloat(trade.rifcPipSize),
      rifc_timeframe:       RIFC_TF_LABELS[trade.rifcTimeframe] || trade.rifcTimeframe || null,
      eql_sweep_distance:   (trade.eqlSweepDistance === "" || trade.eqlSweepDistance == null)
                              ? null : parseFloat(trade.eqlSweepDistance),
      eqh_sweep_distance:   (trade.eqhSweepDistance === "" || trade.eqhSweepDistance == null)
                              ? null : parseFloat(trade.eqhSweepDistance),
      opposing_zone_status: trade.opposingZoneExists
                              ? (OPPOSING_ZONE_LABELS[trade.opposingZoneStatus] || trade.opposingZoneStatus || null)
                              : null,
      dxy_structure_detail: (trade.dxyStructureDetail || '').trim() || null,
      why_not_taken:        (trade.outcome === 'valid_not_taken')
                              ? ((trade.whyNotTaken || '').trim() || null)
                              : null,
    };
    console.log('[trades insert payload]', payload);
    const { data, error } = await supabase
      .from('trades')
      .insert([payload])
      .select();
    if (error) {
      alert('Failed to save trade: ' + error.message);
    } else {
      setJournal(prev => [normaliseTrade(data[0]), ...prev]);
    }
  }, []);

  const [livePreFill, setLivePreFill] = useState(null);
  const clearLivePreFill = useCallback(()=>setLivePreFill(null),[]);

  const tabs = [
    { id:"evaluate",  label:"⚡ Evaluate" },
    { id:"live",      label:"● Live Mode" },
    { id:"trees",     label:"🌳 Decision Trees" },
    { id:"journal",   label:`📋 Journal (${journal.length})` },
    { id:"analytics", label:"📊 Analytics" },
    { id:"backtest",  label:"📓 Backtest Log" },
  ];

  return (
    <div className="min-h-screen bg-black text-gray-200 font-mono text-xs">
      {/* HEADER */}
      <div className="border-b border-gray-800 px-5 py-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-green-400 font-bold text-base">⚡ WTA-1</span>
            <span className="text-gray-700">|</span>
            <span className="text-gray-500 uppercase tracking-widest">Wisdom Trading Architecture v3</span>
          </div>
          <div className="text-red-500 text-xs font-bold mt-0.5">"No trap. No failure. No trade."</div>
        </div>
        <div className="text-right text-xs text-gray-600">
          <div>VALID WINDOWS</div>
          <div className="text-yellow-600">Frankfurt 07:00 BST / London 08:00 BST / NY 1PM 13:00 BST / NY 2nd Hour 14:00 BST / NY PM 18:00 BST</div>
        </div>
      </div>

      {/* MASTER FILTER */}
      <div className="bg-gray-950 border-b border-gray-900 px-5 py-2 text-xs text-gray-600">
        <span className="text-red-600 font-bold">MASTER FILTER:</span>{" "}
        Did price trap participants, fail to continue, and confirm structure in the right place at the right time?{" "}
        <span className="text-red-600">If NOT a clear YES → NO TRADE</span>
      </div>

      {/* TABS */}
      <div className="border-b border-gray-800 px-3 flex gap-1 pt-2">
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            className={`px-4 py-2 text-xs rounded-t transition-colors cursor-pointer ${tab===t.id?"bg-gray-900 text-green-400 border border-b-0 border-gray-700":"text-gray-500 hover:text-gray-400"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* TAB CONTENT */}
      <div className="p-3">
        {tab==="evaluate"&&<EvaluateTab inp={inp} set={set} ev={ev} disc={disc} discEval={discEval} mgmt={mgmt} addTrade={addToJournal} journal={journal}/>}
        {tab==="live"&&<LiveModeTab onSaveToJournal={(data)=>{ setLivePreFill(data); setTab("journal"); }}/>}
        {tab==="trees"&&<DecisionTreeTab inp={inp}/>}
        {tab==="journal"&&<JournalTab journal={journal} setJournal={setJournal} journalLoading={journalLoading} journalError={journalError} livePreFill={livePreFill} clearLivePreFill={clearLivePreFill} addTrade={addToJournal}/>}
        {tab==="analytics"&&<AnalyticsTab journal={journal}/>}
        {tab==="backtest"&&<BacktestLogTab/>}
      </div>

      {/* DISCIPLINE — always at bottom */}
      <DisciplinePanel disc={disc} setDisc={setDisc} tradeLog={tradeLog} setTradeLog={setTradeLog}/>
    </div>
  );
}
