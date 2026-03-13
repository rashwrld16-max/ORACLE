// ══════════════════════════════════════════════
// ORACLE BRAIN LEARNER — runs hourly on GitHub Actions
// Fetches live ticks from Deriv, updates brain.json
// ══════════════════════════════════════════════

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const APP_ID = '1089';
const WS_URL = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOLS = ['R_100','R_75','R_50','R_25','R_10','1HZ100V','1HZ25V','1HZ10V'];
const SYM_LBL = {R_100:'Vol 100',R_75:'Vol 75',R_50:'Vol 50',R_25:'Vol 25',R_10:'Vol 10','1HZ100V':'V100 Idx','1HZ25V':'V25 Idx','1HZ10V':'V10 Idx'};
const BRAIN_FILE = path.join(__dirname, 'brain.json');
const TICKS_PER_SYM = 5000; // fetch 5000 fresh ticks per market per hour

// ── Load existing brain ──
let brain = {};
if(fs.existsSync(BRAIN_FILE)){
  try {
    brain = JSON.parse(fs.readFileSync(BRAIN_FILE,'utf8'));
    console.log(`Loaded existing brain · last update: ${brain._meta&&brain._meta.updated||'unknown'}`);
  } catch(e){ brain = {}; }
}

// ── Fetch ticks and learn ──
const symData = {};
SYMBOLS.forEach(s=>{ symData[s]={digits:[],done:false}; });

let reqId = 1;
let pending = SYMBOLS.length;

function inferPip(price){
  const s = String(price), dot = s.indexOf('.');
  if(dot===-1) return 1;
  return Math.pow(10,-(s.length-dot-1));
}
function extractDigit(price, pip){
  return Math.round(price/pip)%10;
}

function computeSignals(sample){
  const total = sample.length;
  if(total < 50) return null;
  const cnt = new Array(10).fill(0);
  sample.forEach(d=>cnt[d]++);
  const exp = total*0.1;
  const def = cnt.map(c=>exp-c);
  const o3D = [4,5,6,7,8,9].reduce((a,i)=>a+Math.max(0,def[i]),0);
  const u6D = [0,1,2,3,4,5].reduce((a,i)=>a+Math.max(0,def[i]),0);
  const ovlp = (cnt[4]+cnt[5])/total;
  const loQ = [0,1,2,3].reduce((a,i)=>a+cnt[i],0)/total;
  const hiQ = [6,7,8,9].reduce((a,i)=>a+cnt[i],0)/total;
  const evR = [0,2,4,6,8].reduce((a,i)=>a+cnt[i],0)/total;
  const tail = sample.slice(-10);
  let sH=0,sL=0;
  for(let i=tail.length-1;i>=0;i--){if(tail[i]>3)sH++;else break;}
  for(let i=tail.length-1;i>=0;i--){if(tail[i]<6)sL++;else break;}
  const r7 = sample.slice(-7);
  const r7a = r7.reduce((a,b)=>a+b,0)/7;
  const bestDir = o3D>=u6D?'over3':'under6';
  return {deficit:Math.min(10,Math.round(Math.max(o3D,u6D)/exp*5)),overlap:ovlp<=0.18?2:ovlp<=0.22?1:0,quad:Math.round(Math.abs(hiQ-loQ)*10),eo:Math.round(Math.abs(evR-0.5)*20),streak:Math.max(sH,sL),momentum:r7a>5.5?-2:r7a<3.5?2:0,bestDir,o3D,u6D,exp};
}

function fingerprintSig(sig){
  return `${Math.min(sig.deficit,9)}_${sig.overlap}_${Math.min(sig.quad,9)}_${Math.min(sig.eo,9)}_${Math.min(sig.streak,9)}_${sig.momentum+2}`;
}

function learnFromDigits(sym, newDigits){
  console.log(`  Training ${SYM_LBL[sym]} on ${newDigits.length} new ticks...`);

  // Merge with existing patterns
  const existing = brain[sym] || {weights:{deficit:0.22,overlap:0.15,quad:0.18,eo:0.12,streak:0.15,momentum:0.10,correction:0.08},patterns:{},avgRunLen:5,contractStats:{over3:{w:0,l:0},under6:{w:0,l:0}},totalAnalyzed:0};
  const patterns = existing.patterns || {};

  // Mine patterns from new ticks
  const SCAN_STEP = 5;
  const LOOK_AHEAD = 5;
  let newPatterns = 0;

  for(let i=200; i<newDigits.length-LOOK_AHEAD; i+=SCAN_STEP){
    const window = newDigits.slice(Math.max(0,i-500),i);
    if(window.length < 100) continue;
    const sig = computeSignals(window);
    if(!sig) continue;
    const ahead = newDigits.slice(i, i+LOOK_AHEAD);
    const highC = ahead.filter(d=>d>=5).length;
    const actualOver = highC/ahead.length > 0.6;
    const actualUnder = ahead.filter(d=>d<=4).length/ahead.length > 0.6;
    const fp = fingerprintSig(sig);
    if(!patterns[fp]){ patterns[fp]={over3w:0,over3l:0,under6w:0,under6l:0,total:0}; newPatterns++; }
    patterns[fp].total++;
    if(sig.bestDir==='over3'){ if(actualOver) patterns[fp].over3w++; else patterns[fp].over3l++; }
    if(sig.bestDir==='under6'){ if(actualUnder) patterns[fp].under6w++; else patterns[fp].under6l++; }
  }

  // Calculate avg run length
  let runs=[], runLen=1, runDir=newDigits[0]>=5?'h':'l';
  for(let i=1;i<newDigits.length;i++){
    const d=newDigits[i]>=5?'h':'l';
    if(d===runDir) runLen++;
    else{ runs.push(runLen); runDir=d; runLen=1; }
  }
  runs.push(runLen);
  const avgRunLen = runs.reduce((a,b)=>a+b,0)/runs.length;

  // Derive best weights from pattern history
  const weights = deriveWeightsFromPatterns(patterns);

  brain[sym] = {
    weights,
    patterns,
    avgRunLen,
    contractStats: existing.contractStats,
    totalAnalyzed: (existing.totalAnalyzed||0) + newDigits.length,
  };

  console.log(`  ✓ ${SYM_LBL[sym]}: ${Object.keys(patterns).length} patterns · ${newPatterns} new · avgRun:${avgRunLen.toFixed(1)}`);
}

function deriveWeightsFromPatterns(patterns){
  // Find which signal features correlate with wins
  const keys = Object.keys(patterns);
  if(keys.length < 10) return {deficit:0.22,overlap:0.15,quad:0.18,eo:0.12,streak:0.15,momentum:0.10,correction:0.08};

  // Score each pattern by win rate
  let deficitWin=0,deficitTotal=0,streakWin=0,streakTotal=0,overallWin=0,overallTotal=0;
  keys.forEach(fp=>{
    const p = patterns[fp];
    const w = p.over3w+p.under6w;
    const l = p.over3l+p.under6l;
    const tot = w+l;
    if(tot<3) return;
    overallWin+=w; overallTotal+=tot;
    const parts = fp.split('_').map(Number);
    // parts: [deficit, overlap, quad, eo, streak, momentum+2]
    if(parts[0]>=5){ deficitWin+=w; deficitTotal+=tot; } // high deficit
    if(parts[4]>=5){ streakWin+=w; streakTotal+=tot; }   // high streak
  });

  const deficitWR = deficitTotal>0?deficitWin/deficitTotal:0.5;
  const streakWR  = streakTotal>0?streakWin/streakTotal:0.5;
  const overallWR = overallTotal>0?overallWin/overallTotal:0.5;

  // Adjust weights based on what's working
  const defW = Math.max(0.10, Math.min(0.40, 0.22 + (deficitWR-0.5)*0.5));
  const strW = Math.max(0.05, Math.min(0.30, 0.15 + (streakWR-0.5)*0.3));
  const remaining = 1 - defW - strW;

  return {
    deficit:    parseFloat(defW.toFixed(3)),
    overlap:    parseFloat((remaining*0.21).toFixed(3)),
    quad:       parseFloat((remaining*0.26).toFixed(3)),
    eo:         parseFloat((remaining*0.17).toFixed(3)),
    streak:     parseFloat(strW.toFixed(3)),
    momentum:   parseFloat((remaining*0.14).toFixed(3)),
    correction: parseFloat((remaining*0.11).toFixed(3)),
  };
}

// ── Main: connect, fetch, learn, save ──
console.log('Oracle Brain Learner starting...');
const ws = new WebSocket(WS_URL);

ws.on('open', ()=>{
  console.log('Connected to Deriv. Fetching ticks...');
  SYMBOLS.forEach((sym,i)=>{
    setTimeout(()=>{
      ws.send(JSON.stringify({
        ticks_history:sym, count:TICKS_PER_SYM, end:'latest', style:'ticks',
        req_id:reqId++, passthrough:{sym}
      }));
    }, i*400);
  });
});

ws.on('message', (raw)=>{
  const data = JSON.parse(raw);
  if(data.error||!data.msg_type) return;
  if(data.msg_type==='history'){
    const sym = data.passthrough&&data.passthrough.sym;
    if(!sym) return;
    const prices = data.history&&data.history.prices;
    if(!prices) return;
    let pip = null;
    const digits = prices.map(p=>{
      const pf = parseFloat(p);
      if(!pip) pip = inferPip(p);
      return extractDigit(pf,pip);
    }).filter(d=>d>=0&&d<=9);

    symData[sym].digits = digits;
    symData[sym].done = true;
    learnFromDigits(sym, digits);
    pending--;
    console.log(`  Remaining: ${pending} markets`);

    if(pending===0){
      // All done — save brain
      const totalTicks = Object.values(brain).filter(v=>v&&v.totalAnalyzed).reduce((a,v)=>a+(v.totalAnalyzed||0),0);
      const totalPatterns = Object.values(brain).filter(v=>v&&v.patterns).reduce((a,v)=>a+Object.keys(v.patterns||{}).length,0);
      brain._meta = {
        updated: new Date().toISOString(),
        totalTicks,
        totalPatterns,
        version: '4-ml',
      };
      fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
      console.log(`\n✅ Brain saved · ${totalTicks.toLocaleString()} total ticks · ${totalPatterns} patterns`);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (e)=>{ console.error('WS error:', e.message); process.exit(1); });

// Timeout after 3 minutes
setTimeout(()=>{ console.log('Timeout — saving what we have'); if(ws.readyState===1) ws.close(); process.exit(0); }, 180000);
