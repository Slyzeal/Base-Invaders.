import { useState, useEffect, useRef, useCallback } from "react";

// ── Contract config ───────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = "0x2280212AdfB7848Ca42C08c478505Cd948A65fd3";
const BASE_RPC = "https://mainnet.base.org";

// ── RPC helper ────────────────────────────────────────────────────────────────
async function rpcCall(method, params) {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ── Onchain functions ─────────────────────────────────────────────────────────
async function getOnchainLeaderboard() {
  try {
    const data = await rpcCall("eth_call", [{
      to: CONTRACT_ADDRESS,
      data: "0xee5c4e5d"
    }, "latest"]);
    const entries = decodeLeaderboard(data);
    const resolved = await Promise.all(
      entries.map(async (entry) => {
        const basename = await resolveBasename(entry.wallet);
        return { ...entry, basename };
      })
    );
    return resolved;
  } catch (e) { console.error(e); return []; }
}

async function getOnchainBest(wallet) {
  try {
    const addr = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
    const data = await rpcCall("eth_call", [{
      to: CONTRACT_ADDRESS,
      data: "0xd47875d0" + addr
    }, "latest"]);
    if (!data || data === "0x") return 0;
    const score = parseInt(data.slice(66, 130), 16);
    return isNaN(score) ? 0 : score;
  } catch { return 0; }
}

function decodeLeaderboard(hex) {
  try {
    if (!hex || hex === "0x" || hex.length < 10) return [];
    const data = hex.slice(2);
    const offset = parseInt(data.slice(0, 64), 16) * 2;
    const count = parseInt(data.slice(offset, offset + 64), 16);
    if (!count || count > 50) return [];
    const entries = [];
    for (let i = 0; i < count; i++) {
      const base = offset + 64 + i * 192;
      const wallet = "0x" + data.slice(base + 24, base + 64);
      const score = parseInt(data.slice(base + 64, base + 128), 16);
      const timestamp = parseInt(data.slice(base + 128, base + 192), 16);
      if (score > 0 && wallet !== "0x0000000000000000000000000000000000000000") {
        entries.push({ wallet, score, basename: null, timestamp });
      }
    }
    return entries.sort((a, b) => b.score - a.score);
  } catch (e) { console.error("decode error", e); return []; }
}

async function submitScoreOnchain(score, basename) {
  if (!window.ethereum) throw new Error("No wallet found");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts[0]) throw new Error("Wallet not connected");
  const scoreHex = Math.floor(score).toString(16).padStart(64, "0");
  const calldata = "0xaff0b297" + scoreHex;
  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{
      from: accounts[0],
      to: CONTRACT_ADDRESS,
      data: calldata,
      chainId: "0x2105",
      gas: "0x30D40",
    }],
  });
  return txHash;
}

function getLocalBest(w) {
  try { return parseInt(localStorage.getItem(`bb2:${w}`) || "0"); } catch { return 0; }
}
function setLocalBest(w, s) {
  try { if (s > getLocalBest(w)) localStorage.setItem(`bb2:${w}`, String(s)); } catch {}
}

/* ═══════════════════════════════════════════════════════════
   BASENAME LOOKUP
═══════════════════════════════════════════════════════════ */
const domainCache = {};
async function resolveBasename(address) {
  if (!address) return null;
  const key = address.toLowerCase();
  if (domainCache[key] !== undefined) return domainCache[key];
  try {
    const res = await fetch(`https://api.basename.app/v1/names?address=${key}`, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const json = await res.json();
      const name = json?.name || json?.basename || json?.[0]?.name || null;
      domainCache[key] = name; return name;
    }
  } catch {}
  domainCache[key] = null; return null;
}

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════ */
const W = 430, H = 700;
const SHIP_W = 46, SHIP_H = 56;
const FIRE_RATE = 200;
const KILLS_PER_WAVE = 10;
const LASER_DURATION = 10000;

function rRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
function rand(a, b) { return a + Math.random() * (b - a); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function shortAddr(a) { return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : ""; }

/* ═══════════════════════════════════════════════════════════
   AUDIO ENGINE
═══════════════════════════════════════════════════════════ */
class AudioEngine {
  constructor() {
    this.ctx = null; this.masterGain = null; this.musicGain = null;
    this.sfxGain = null; this.oscillators = []; this.musicPlaying = false;
    this.musicEnabled = true; this._mt = null; this._at = null; this._dt = null; this._laserOsc = null;
  }
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain(); this.masterGain.gain.value = 0.65; this.masterGain.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.24; this.musicGain.connect(this.masterGain);
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.55; this.sfxGain.connect(this.masterGain);
  }
  resume() { if (this.ctx?.state === "suspended") this.ctx.resume(); }
  startMusic() { if (!this.ctx || this.musicPlaying) return; this.musicPlaying = true; this._bass(); this._arp(); this._drum(); }
  stopMusic() {
    this.musicPlaying = false;
    [this._mt, this._at, this._dt].forEach(t => t && clearTimeout(t));
    this.oscillators.forEach(o => { try { o.stop(); } catch {} }); this.oscillators = [];
  }
  _note(freq, start, dur, gain, type) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator(), e = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 2200; o.type = type; o.frequency.value = freq;
    e.gain.setValueAtTime(0, start); e.gain.linearRampToValueAtTime(gain, start + 0.02); e.gain.exponentialRampToValueAtTime(0.001, start + dur);
    o.connect(f); f.connect(e); e.connect(this.musicGain); o.start(start); o.stop(start + dur + 0.05); this.oscillators.push(o);
  }
  _bass() {
    if (!this.musicPlaying || !this.ctx) return;
    const now = this.ctx.currentTime, b = 60 / 128;
    [65.4, 65.4, 77.8, 65.4, 55.0, 65.4, 82.4, 73.4].forEach((f, i) => this._note(f, now + i * b, b * .85, 0.3, "square"));
    this._mt = setTimeout(() => { if (this.musicPlaying) this._bass(); }, 8 * b * 1000 - 50);
  }
  _arp() {
    if (!this.musicPlaying || !this.ctx) return;
    const now = this.ctx.currentTime, b = 60 / 128;
    [261.6, 311.1, 392, 466.2, 523.3, 466.2, 392, 311.1, 349.2, 415.3, 523.3, 622.3, 261.6, 329.6, 392, 493.9].forEach((f, i) => this._note(f, now + i * b * .5, b * .4, 0.1, "triangle"));
    this._at = setTimeout(() => { if (this.musicPlaying) this._arp(); }, 16 * b * .5 * 1000 - 50);
  }
  _drum() {
    if (!this.musicPlaying || !this.ctx) return;
    const now = this.ctx.currentTime, b = 60 / 128;
    for (let i = 0; i < 8; i += 2) {
      const o = this.ctx.createOscillator(), e = this.ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(150, now + i * b); o.frequency.exponentialRampToValueAtTime(40, now + i * b + 0.15);
      e.gain.setValueAtTime(0.42, now + i * b); e.gain.exponentialRampToValueAtTime(0.001, now + i * b + 0.2);
      o.connect(e); e.connect(this.musicGain); o.start(now + i * b); o.stop(now + i * b + 0.25); this.oscillators.push(o);
    }
    for (let i = 1; i < 8; i += 2) {
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * .1, this.ctx.sampleRate);
      const d = buf.getChannelData(0); for (let j = 0; j < d.length; j++) d[j] = Math.random() * 2 - 1;
      const s = this.ctx.createBufferSource(), e = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
      f.type = "highpass"; f.frequency.value = 2000; s.buffer = buf;
      e.gain.setValueAtTime(0.14, now + i * b); e.gain.exponentialRampToValueAtTime(0.001, now + i * b + 0.12);
      s.connect(f); f.connect(e); e.connect(this.musicGain); s.start(now + i * b); s.stop(now + i * b + 0.15); this.oscillators.push(s);
    }
    this._dt = setTimeout(() => { if (this.musicPlaying) this._drum(); }, 8 * b * 1000 - 50);
  }
  _sfx(fs, fe, start, gain, dur, type) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator(), e = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(fs, start); o.frequency.linearRampToValueAtTime(fe, start + dur);
    e.gain.setValueAtTime(gain, start); e.gain.exponentialRampToValueAtTime(0.001, start + dur);
    o.connect(e); e.connect(this.sfxGain); o.start(start); o.stop(start + dur + 0.02);
  }
  shoot() { if (!this.ctx) return; this._sfx(880, 440, this.ctx.currentTime, 0.07, 0.1, "square"); }
  explode() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, buf = this.ctx.createBuffer(1, this.ctx.sampleRate * .18, this.ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = this.ctx.createBufferSource(), e = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 350; f.Q.value = 0.6;
    e.gain.setValueAtTime(0.38, now); e.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    s.buffer = buf; s.connect(f); f.connect(e); e.connect(this.sfxGain); s.start(now); s.stop(now + 0.22);
  }
  laserStart() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), e = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 1200; f.Q.value = 2;
    o.type = "sawtooth"; o.frequency.value = 440;
    e.gain.setValueAtTime(0, now); e.gain.linearRampToValueAtTime(0.4, now + 0.05);
    e.gain.linearRampToValueAtTime(0.2, now + 1); e.gain.linearRampToValueAtTime(0.001, now + 10);
    o.connect(f); f.connect(e); e.connect(this.sfxGain); o.start(now); o.stop(now + 10.1); this._laserOsc = o;
  }
  laserStop() { if (this._laserOsc) { try { this._laserOsc.stop(); } catch {} this._laserOsc = null; } }
  powerup(freeze = false) {
    if (!this.ctx) return; const now = this.ctx.currentTime;
    (freeze ? [400, 600, 800, 1000] : [523, 659, 784, 1047]).forEach((f, i) => this._sfx(f, f * 1.02, now + i * .06, 0.13, 0.12, "triangle"));
  }
  laserPickup() {
    if (!this.ctx) return; const now = this.ctx.currentTime;
    [300, 500, 800, 1200, 1800].forEach((f, i) => this._sfx(f, f * 1.5, now + i * .05, 0.15, 0.1, "sawtooth"));
  }
  loseLife() { if (!this.ctx) return; this._sfx(220, 80, this.ctx.currentTime, 0.4, .38, "sawtooth"); }
  waveUp() { if (!this.ctx) return; const now = this.ctx.currentTime; [523, 659, 784, 1047, 1319].forEach((f, i) => this._sfx(f, f, now + i * .08, 0.18, .1, "sine")); }
  toggleMusic() { this.musicEnabled = !this.musicEnabled; if (!this.musicEnabled) this.stopMusic(); else if (this.ctx) this.startMusic(); return this.musicEnabled; }
}
const audio = new AudioEngine();

/* ═══════════════════════════════════════════════════════════
   STARS & PALETTES
═══════════════════════════════════════════════════════════ */
function genStars(n = 140) {
  return Array.from({ length: n }, (_, i) => ({
    x: rand(0, W), y: rand(0, H),
    r: rand(.2, i % 25 === 0 ? 2.8 : i % 7 === 0 ? 1.6 : .9),
    a: rand(.1, .95), speed: rand(.08, .55),
    color: i % 18 === 0 ? "#a8d8ff" : i % 9 === 0 ? "#ffeedd" : "#fff",
    tw: rand(0, Math.PI * 2)
  }));
}
function drawStars(ctx, stars, scroll, phase) {
  stars.forEach(s => {
    const y = ((s.y + scroll * s.speed) % H + H) % H;
    ctx.globalAlpha = s.a * (.65 + .35 * Math.sin(phase * 1.4 + s.tw));
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(s.x, y, s.r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;
}

const PALETTES = [
  ["#ff9955","#cc3300","#550000","#ffcc66","255,140,40","255,90,10"],
  ["#ff55cc","#aa0077","#380028","#ffaaee","255,80,200","220,0,160"],
  ["#aaff44","#44aa00","#143300","#ccff77","140,255,50","80,200,0"],
  ["#ffdd00","#ee8800","#4a2000","#ffee88","255,210,0","240,140,0"],
  ["#00eeff","#0077cc","#001844","#88ffff","0,220,255","0,150,220"],
  ["#ff2255","#990022","#2d0010","#ff77aa","255,40,90","200,0,50"],
  ["#cc88ff","#7700ee","#1a0040","#ddbbff","180,80,255","130,0,230"],
  ["#00ffaa","#009955","#002a18","#88ffdd","0,255,160","0,180,110"],
  ["#ff8844","#dd2255","#330015","#ffbb88","255,120,80","220,30,80"],
  ["#ffffff","#8899ff","#001055","#ccddff","200,210,255","120,150,255"],
];

/* ═══════════════════════════════════════════════════════════
   DRAW FUNCTIONS
═══════════════════════════════════════════════════════════ */
function drawAlien(ctx, x, y, phase, frozen, wave) {
  ctx.save(); ctx.translate(x + 18, y + 18);
  const palIdx = (wave - 1) % PALETTES.length;
  const [c0,c1,c2,cEye,glowRGB,accRGB] = frozen ? ["#aaffee","#33ccbb","#003344","#ffffff","160,255,240","100,255,220"] : PALETTES[palIdx];
  ctx.translate(0, Math.sin(phase * 2.2) * 2);
  ctx.save(); ctx.globalAlpha = .17 + Math.sin(phase * 3) * .06;
  const h = ctx.createRadialGradient(0,0,8,0,0,28); h.addColorStop(0,`rgba(${glowRGB},.9)`); h.addColorStop(1,"transparent");
  ctx.fillStyle = h; ctx.beginPath(); ctx.arc(0,0,28,0,Math.PI*2); ctx.fill(); ctx.restore();
  [[-10,14,-22,26,-18,36,0],[10,14,22,26,18,36,1],[0,16,0,28,0,38,2]].forEach(([sx,sy,cx2,cy2,ex2,ey2,idx]) => {
    ctx.strokeStyle = idx===2?c0:c1; ctx.lineWidth = idx===2?2.2:2.8; ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(sx,sy); ctx.quadraticCurveTo(cx2+Math.sin(phase+idx)*4,cy2,ex2+Math.sin(phase*(1.1+idx*.2))*3,ey2); ctx.stroke();
    ctx.fillStyle = idx===2?cEye:c0; ctx.beginPath(); ctx.arc(ex2+Math.sin(phase*(1.1+idx*.2))*3,ey2,idx===2?2.5:3.5,0,Math.PI*2); ctx.fill();
  });
  const bg = ctx.createRadialGradient(-4,-8,2,0,0,18); bg.addColorStop(0,c0); bg.addColorStop(.55,c1); bg.addColorStop(1,c2);
  ctx.beginPath(); ctx.moveTo(0,-18); ctx.bezierCurveTo(16,-18,20,-10,20,2); ctx.bezierCurveTo(20,12,14,18,0,18); ctx.bezierCurveTo(-14,18,-20,12,-20,2); ctx.bezierCurveTo(-20,-10,-16,-18,0,-18); ctx.closePath();
  ctx.fillStyle=bg; ctx.fill(); ctx.strokeStyle=`rgba(${accRGB},.6)`; ctx.lineWidth=1.4; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-18,4); ctx.bezierCurveTo(-18,9,-12,12,0,12); ctx.bezierCurveTo(12,12,18,9,18,4);
  ctx.strokeStyle=`rgba(${accRGB},.4)`; ctx.lineWidth=1.8; ctx.stroke();
  [[-9,-16,-16,-32,-4,-18],[9,-16,16,-32,4,-18]].forEach(([bx,by,tx,ty,rx,ry],i) => {
    ctx.fillStyle=c0; ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(tx+Math.sin(phase*.5+i),ty); ctx.lineTo(rx,ry); ctx.closePath(); ctx.fill();
    ctx.strokeStyle=`rgba(${accRGB},.4)`; ctx.lineWidth=.8; ctx.stroke();
    ctx.save(); ctx.shadowColor=cEye; ctx.shadowBlur=12; ctx.fillStyle=cEye; ctx.beginPath(); ctx.arc(tx+Math.sin(phase*.5+i),ty,3,0,Math.PI*2); ctx.fill(); ctx.restore();
  });
  [[-8,-4],[8,-4]].forEach(([ex,ey],i) => {
    ctx.beginPath(); ctx.ellipse(ex,ey,6,7,0,0,Math.PI*2); ctx.fillStyle="#0a0015"; ctx.fill();
    ctx.strokeStyle=`rgba(${accRGB},.4)`; ctx.lineWidth=.9; ctx.stroke();
    const iris=ctx.createRadialGradient(ex,ey,1,ex,ey,5); iris.addColorStop(0,cEye); iris.addColorStop(.7,c1); iris.addColorStop(1,"#000");
    ctx.beginPath(); ctx.ellipse(ex,ey,5,6,0,0,Math.PI*2); ctx.fillStyle=iris; ctx.fill();
    ctx.fillStyle="#000"; ctx.beginPath(); ctx.ellipse(ex,ey,2,3,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle="rgba(255,255,255,.82)"; ctx.beginPath(); ctx.arc(ex-1.4*(i===0?1:-1),ey-2,1.4,0,Math.PI*2); ctx.fill();
    ctx.save(); ctx.globalAlpha=.28+Math.sin(phase*4+i)*.15; ctx.shadowColor=cEye; ctx.shadowBlur=10; ctx.strokeStyle=cEye; ctx.lineWidth=.8;
    ctx.beginPath(); ctx.ellipse(ex,ey,5,6,0,0,Math.PI*2); ctx.stroke(); ctx.restore();
  });
  [-3,3].forEach(dx => { ctx.fillStyle=c1; ctx.beginPath(); ctx.arc(dx,2,1.5,0,Math.PI*2); ctx.fill(); });
  ctx.strokeStyle=`rgba(${accRGB},.7)`; ctx.lineWidth=1.6; ctx.lineCap="round";
  ctx.beginPath(); ctx.moveTo(-7,8); ctx.quadraticCurveTo(0,13+Math.sin(phase*3)*2,7,8); ctx.stroke();
  ctx.fillStyle="rgba(255,255,255,.6)"; [-4,0,4].forEach(dx => { ctx.beginPath(); ctx.rect(dx-1.5,9,3,3); ctx.fill(); });
  ctx.save(); ctx.globalAlpha=.18+Math.sin(phase*2)*.05;
  const belly=ctx.createRadialGradient(0,5,1,0,5,12); belly.addColorStop(0,`rgba(${glowRGB},.8)`); belly.addColorStop(1,"transparent");
  ctx.fillStyle=belly; ctx.beginPath(); ctx.arc(0,5,12,0,Math.PI*2); ctx.fill(); ctx.restore();
  if (frozen) {
    ctx.save(); ctx.globalAlpha=.32; ctx.fillStyle="#aaeeff"; ctx.beginPath(); ctx.arc(0,0,20,0,Math.PI*2); ctx.fill(); ctx.restore();
    ctx.save(); ctx.strokeStyle="rgba(200,255,255,.6)"; ctx.lineWidth=1;
    for(let i=0;i<4;i++){ctx.save();ctx.rotate((Math.PI/2)*i+phase*.3);ctx.beginPath();ctx.moveTo(0,-14);ctx.lineTo(0,-22);ctx.stroke();ctx.restore();}
    ctx.restore();
  }
  ctx.restore();
}

function drawShip(ctx,x,y,mult,frozen,laser,phase,tilt=0) {
  ctx.save(); ctx.translate(x+SHIP_W/2,y+SHIP_H/2); ctx.rotate(tilt*.055); ctx.translate(-SHIP_W/2,-SHIP_H/2);
  const fl=18+Math.sin(phase*3.2)*8,flk=.82+Math.sin(phase*9)*.18;
  const cf=ctx.createLinearGradient(SHIP_W*.5,SHIP_H*.83,SHIP_W*.5,SHIP_H*.83+fl*1.8);
  cf.addColorStop(0,laser?`rgba(255,80,0,${flk})`:frozen?`rgba(120,255,230,${flk})`:mult?`rgba(0,238,255,${flk})`:`rgba(255,220,80,${flk})`);
  cf.addColorStop(.4,laser?"rgba(200,0,0,.85)":frozen?"rgba(0,180,160,.85)":mult?"rgba(0,85,255,.85)":"rgba(255,100,10,.85)");
  cf.addColorStop(1,"rgba(0,0,0,0)");
  ctx.beginPath(); ctx.moveTo(SHIP_W*.36,SHIP_H*.83); ctx.bezierCurveTo(SHIP_W*.4,SHIP_H*.83+fl,SHIP_W*.6,SHIP_H*.83+fl,SHIP_W*.64,SHIP_H*.83); ctx.lineTo(SHIP_W*.5,SHIP_H*.83+fl*1.8); ctx.closePath(); ctx.fillStyle=cf; ctx.fill();
  [[.17,.78,.08],[.83,.78,.92]].forEach(([sx,sy,ex]) => {
    const sf=ctx.createLinearGradient(SHIP_W*sx,SHIP_H*sy,SHIP_W*ex,SHIP_H*sy+fl*.9);
    sf.addColorStop(0,laser?`rgba(255,100,20,${flk*.9})`:frozen?`rgba(80,255,210,${flk*.9})`:mult?`rgba(0,200,255,${flk*.9})`:`rgba(255,180,50,${flk*.9})`);
    sf.addColorStop(1,"rgba(0,0,0,0)");
    ctx.beginPath(); ctx.moveTo(SHIP_W*sx,SHIP_H*sy); ctx.lineTo(SHIP_W*ex,SHIP_H*sy+fl*.9); ctx.lineTo(SHIP_W*(sx>.5?sx-.12:sx+.12),SHIP_H*sy+fl*.4); ctx.closePath(); ctx.fillStyle=sf; ctx.fill();
  });
  const wc0=laser?"#dd2200":frozen?"#22ddcc":mult?"#1a6be8":"#1a5ab0";
  const wc1=laser?"#550000":frozen?"#006688":mult?"#00126e":"#091e4a";
  [[true],[false]].forEach(([isL]) => {
    ctx.beginPath();
    if(isL){ctx.moveTo(SHIP_W*.29,SHIP_H*.50);ctx.lineTo(-4,SHIP_H*.69);ctx.lineTo(SHIP_W*.03,SHIP_H*.83);ctx.lineTo(SHIP_W*.22,SHIP_H*.81);ctx.lineTo(SHIP_W*.27,SHIP_H*.70);}
    else{ctx.moveTo(SHIP_W*.71,SHIP_H*.50);ctx.lineTo(SHIP_W+4,SHIP_H*.69);ctx.lineTo(SHIP_W*.97,SHIP_H*.83);ctx.lineTo(SHIP_W*.78,SHIP_H*.81);ctx.lineTo(SHIP_W*.73,SHIP_H*.70);}
    ctx.closePath();
    const wg=ctx.createLinearGradient(isL?0:SHIP_W*.73,SHIP_H*.5,isL?SHIP_W*.27:SHIP_W,SHIP_H*.83);
    wg.addColorStop(0,wc0); wg.addColorStop(1,wc1); ctx.fillStyle=wg; ctx.fill();
    ctx.strokeStyle=laser?"rgba(255,80,0,.4)":frozen?"rgba(100,255,230,.4)":mult?"rgba(60,200,255,.4)":"rgba(100,160,255,.38)"; ctx.lineWidth=.9; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(SHIP_W*(isL?.14:.86),SHIP_H*.60); ctx.lineTo(SHIP_W*(isL?.03:.97),SHIP_H*.76);
    ctx.strokeStyle=laser?"rgba(255,120,0,.5)":frozen?"rgba(80,255,200,.5)":mult?"rgba(0,220,255,.5)":"rgba(130,190,255,.45)"; ctx.lineWidth=1.1; ctx.stroke();
  });
  ctx.beginPath(); ctx.moveTo(SHIP_W*.5,0); ctx.bezierCurveTo(SHIP_W*.70,SHIP_H*.09,SHIP_W*.76,SHIP_H*.31,SHIP_W*.71,SHIP_H*.52); ctx.lineTo(SHIP_W*.87,SHIP_H*.70); ctx.lineTo(SHIP_W*.79,SHIP_H*.83); ctx.lineTo(SHIP_W*.21,SHIP_H*.83); ctx.lineTo(SHIP_W*.13,SHIP_H*.70); ctx.lineTo(SHIP_W*.29,SHIP_H*.52); ctx.bezierCurveTo(SHIP_W*.24,SHIP_H*.31,SHIP_W*.30,SHIP_H*.09,SHIP_W*.5,0); ctx.closePath();
  const hg=ctx.createLinearGradient(SHIP_W*.1,0,SHIP_W*.9,SHIP_H);
  hg.addColorStop(0,laser?"#ffccaa":frozen?"#99ffee":mult?"#99eeff":"#c4dcff");
  hg.addColorStop(.28,laser?"#ee4400":frozen?"#22ccbb":mult?"#2288ee":"#4a86cc");
  hg.addColorStop(.72,laser?"#880000":frozen?"#006688":mult?"#0044cc":"#1a3e88");
  hg.addColorStop(1,laser?"#330000":frozen?"#004455":mult?"#001177":"#091e50");
  ctx.fillStyle=hg; ctx.fill();
  ctx.strokeStyle=laser?"rgba(255,80,0,.55)":frozen?"rgba(80,255,220,.55)":mult?"rgba(80,220,255,.55)":"rgba(130,180,255,.5)"; ctx.lineWidth=1.2; ctx.stroke();
  ctx.strokeStyle=laser?"rgba(255,100,0,.17)":frozen?"rgba(0,240,200,.17)":mult?"rgba(0,200,255,.17)":"rgba(160,210,255,.17)"; ctx.lineWidth=.7;
  [[.4,.28,.4,.74],[.6,.28,.6,.74],[.28,.54,.72,.54]].forEach(([x1,y1,x2,y2])=>{ctx.beginPath();ctx.moveTo(SHIP_W*x1,SHIP_H*y1);ctx.lineTo(SHIP_W*x2,SHIP_H*y2);ctx.stroke();});
  const cg=ctx.createLinearGradient(SHIP_W*.5-4,-10,SHIP_W*.5+4,2);
  cg.addColorStop(0,laser?"#ffaa88":frozen?"#aaffee":mult?"#aaeeff":"#99ccee"); cg.addColorStop(1,laser?"#880000":frozen?"#006688":mult?"#0066cc":"#223366");
  ctx.fillStyle=cg; ctx.beginPath(); ctx.rect(SHIP_W*.5-3.5,-11,7,12); ctx.fill();
  const ck=ctx.createRadialGradient(SHIP_W*.46,SHIP_H*.20,1,SHIP_W*.5,SHIP_H*.27,11);
  ck.addColorStop(0,"#eef8ff"); ck.addColorStop(.5,laser?"#ff8844":frozen?"#44ffdd":mult?"#44ccff":"#66aaee"); ck.addColorStop(1,"rgba(0,18,80,.9)");
  ctx.beginPath(); ctx.ellipse(SHIP_W*.5,SHIP_H*.27,9,12,0,0,Math.PI*2); ctx.fillStyle=ck; ctx.fill();
  ctx.strokeStyle="rgba(200,240,255,.5)"; ctx.lineWidth=.8; ctx.stroke();
  ctx.save(); ctx.globalAlpha=.38; ctx.fillStyle="#fff"; ctx.beginPath(); ctx.ellipse(SHIP_W*.46,SHIP_H*.22,4.5,6,-.3,0,Math.PI*2); ctx.fill(); ctx.restore();
  if(laser||mult||frozen){
    ctx.save(); ctx.globalAlpha=.09+Math.sin(phase*4)*.05;
    const au=ctx.createRadialGradient(SHIP_W*.5,SHIP_H*.5,0,SHIP_W*.5,SHIP_H*.5,SHIP_W*1.1);
    au.addColorStop(0,laser?"#ff4400":mult?"#00ccff":"#00ffdd"); au.addColorStop(1,"transparent");
    ctx.fillStyle=au; ctx.fillRect(-SHIP_W*.7,-12,SHIP_W*2.4,SHIP_H+24); ctx.restore();
  }
  ctx.restore();
}

function drawLaserBeam(ctx,shipX,shipY,phase) {
  const cx=shipX+SHIP_W/2; ctx.save();
  ctx.shadowColor="#ff2200"; ctx.shadowBlur=40;
  const gO=ctx.createLinearGradient(cx-10,0,cx+10,0);
  gO.addColorStop(0,"transparent"); gO.addColorStop(.3,"rgba(255,60,0,.3)"); gO.addColorStop(.5,"rgba(255,120,0,.5)"); gO.addColorStop(.7,"rgba(255,60,0,.3)"); gO.addColorStop(1,"transparent");
  ctx.fillStyle=gO; ctx.fillRect(cx-10,0,20,shipY); ctx.shadowBlur=0;
  const gC=ctx.createLinearGradient(cx-4,0,cx+4,0);
  gC.addColorStop(0,"rgba(255,200,100,.6)"); gC.addColorStop(.5,"rgba(255,255,200,1)"); gC.addColorStop(1,"rgba(255,200,100,.6)");
  ctx.fillStyle=gC; ctx.fillRect(cx-4,0,8,shipY);
  ctx.fillStyle=`rgba(255,255,255,${.7+Math.sin(phase*20)*.3})`; ctx.fillRect(cx-1.5,0,3,shipY);
  ctx.globalAlpha=.12+Math.sin(phase*15)*.06; ctx.fillStyle="#ff8800";
  for(let yy=0;yy<shipY;yy+=8) ctx.fillRect(cx-6,yy,12,2);
  ctx.restore();
}

function drawBaseFruit(ctx,x,y,phase) {
  ctx.save(); ctx.translate(x+20,y+20); const p=1+Math.sin(phase*2)*.055; ctx.scale(p,p);
  ctx.save(); ctx.globalAlpha=.16+Math.sin(phase)*.08;
  const og=ctx.createRadialGradient(0,0,6,0,0,28); og.addColorStop(0,"#0066ff"); og.addColorStop(1,"transparent");
  ctx.fillStyle=og; ctx.beginPath(); ctx.arc(0,0,28,0,Math.PI*2); ctx.fill(); ctx.restore();
  const bg=ctx.createRadialGradient(-5,-5,2,0,0,18); bg.addColorStop(0,"#5ab4ff"); bg.addColorStop(.5,"#0055ff"); bg.addColorStop(1,"#001880");
  ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.fillStyle=bg; ctx.fill();
  ctx.fillStyle="#fff"; ctx.font="bold 6.5px sans-serif"; ctx.textAlign="center"; ctx.fillText("BASE",0,-3);
  ctx.fillStyle="#88ccff"; ctx.font="bold 9px sans-serif"; ctx.fillText("$",0,8);
  ctx.strokeStyle=`rgba(80,180,255,${.5+Math.sin(phase)*.3})`; ctx.lineWidth=1.8;
  ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.stroke(); ctx.restore();
}

function drawFreezeFruit(ctx,x,y,phase) {
  ctx.save(); ctx.translate(x+20,y+20); const p=1+Math.sin(phase*2.5)*.07; ctx.scale(p,p);
  ctx.save(); ctx.globalAlpha=.2+Math.sin(phase)*.1;
  const og=ctx.createRadialGradient(0,0,5,0,0,30); og.addColorStop(0,"#00ffee"); og.addColorStop(1,"transparent");
  ctx.fillStyle=og; ctx.beginPath(); ctx.arc(0,0,30,0,Math.PI*2); ctx.fill(); ctx.restore();
  const bg=ctx.createRadialGradient(-4,-4,2,0,0,18); bg.addColorStop(0,"#aaffee"); bg.addColorStop(.45,"#00ccbb"); bg.addColorStop(1,"#003344");
  ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.fillStyle=bg; ctx.fill();
  ctx.strokeStyle="rgba(255,255,255,.85)"; ctx.lineWidth=1.8; ctx.lineCap="round";
  for(let i=0;i<6;i++){ctx.save();ctx.rotate((Math.PI/3)*i+phase*.5);ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-12);ctx.stroke();ctx.beginPath();ctx.moveTo(-3,-7);ctx.lineTo(0,-10);ctx.lineTo(3,-7);ctx.stroke();ctx.restore();}
  ctx.fillStyle="#fff"; ctx.beginPath(); ctx.arc(0,0,2.5,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle=`rgba(0,255,220,${.55+Math.sin(phase)*.3})`; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.stroke(); ctx.restore();
}

function drawLaserFruit(ctx,x,y,phase) {
  ctx.save(); ctx.translate(x+20,y+20); const p=1+Math.sin(phase*2.2)*.06; ctx.scale(p,p);
  ctx.save(); ctx.globalAlpha=.18+Math.sin(phase)*.09;
  const og=ctx.createRadialGradient(0,0,5,0,0,30); og.addColorStop(0,"#ff4400"); og.addColorStop(1,"transparent");
  ctx.fillStyle=og; ctx.beginPath(); ctx.arc(0,0,30,0,Math.PI*2); ctx.fill(); ctx.restore();
  const bg=ctx.createRadialGradient(-4,-4,2,0,0,18); bg.addColorStop(0,"#ff9955"); bg.addColorStop(.45,"#cc2200"); bg.addColorStop(1,"#440000");
  ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.fillStyle=bg; ctx.fill();
  ctx.fillStyle="#ffee44"; ctx.shadowColor="#ffaa00"; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.moveTo(4,-13); ctx.lineTo(-2,-2); ctx.lineTo(3,-2); ctx.lineTo(-4,13); ctx.lineTo(8,0); ctx.lineTo(2,0); ctx.closePath(); ctx.fill(); ctx.shadowBlur=0;
  ctx.strokeStyle=`rgba(255,120,0,${.55+Math.sin(phase)*.3})`; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.stroke(); ctx.restore();
}

function drawBullet(ctx,x,y,mult) {
  ctx.save(); const c=mult?"#00eeff":"#66aaff"; ctx.shadowColor=c; ctx.shadowBlur=18;
  const g=ctx.createLinearGradient(x,y,x,y+22); g.addColorStop(0,"#fff"); g.addColorStop(.3,c); g.addColorStop(1,"rgba(0,50,200,0)");
  ctx.fillStyle=g; ctx.beginPath(); ctx.rect(x-3,y,6,22); ctx.fill();
  ctx.fillStyle="#fff"; ctx.shadowBlur=24; ctx.shadowColor="#fff"; ctx.beginPath(); ctx.arc(x,y+2,2.8,0,Math.PI*2); ctx.fill(); ctx.restore();
}

function drawParticle(ctx,p) {
  ctx.save(); ctx.globalAlpha=Math.max(0,p.life); ctx.shadowColor=p.color; ctx.shadowBlur=12; ctx.fillStyle=p.color;
  ctx.beginPath(); ctx.arc(p.x,p.y,p.r*Math.max(0,p.life),0,Math.PI*2); ctx.fill(); ctx.restore();
}

function drawHUD(ctx,g,now) {
  ctx.fillStyle="rgba(0,3,18,.88)"; rRect(ctx,8,8,W-16,56,12); ctx.fill();
  ctx.strokeStyle="rgba(0,65,175,.25)"; ctx.lineWidth=1; rRect(ctx,8,8,W-16,56,12); ctx.stroke();
  for(let i=0;i<3;i++){
    const alive=i<g.lives; ctx.save(); ctx.globalAlpha=alive?1:0.14;
    const lr=ctx.createRadialGradient(26+i*26,36,1,26+i*26,36,9);
    lr.addColorStop(0,alive?"#55aaff":"#334"); lr.addColorStop(1,"transparent");
    ctx.fillStyle=lr; ctx.beginPath(); ctx.arc(26+i*26,36,9,0,Math.PI*2); ctx.fill();
    if(alive){ctx.shadowColor="#3399ff"; ctx.shadowBlur=10;}
    ctx.fillStyle="#fff"; ctx.font="bold 12px sans-serif"; ctx.textAlign="center"; ctx.fillText("^",26+i*26,40); ctx.restore();
  }
  ctx.font="700 8px sans-serif"; ctx.textAlign="left"; ctx.fillStyle="rgba(120,175,255,.55)"; ctx.fillText("SCORE",98,22);
  if(g.mult>1){ctx.shadowColor="#ffd700"; ctx.shadowBlur=20;}
  ctx.font="900 22px sans-serif"; ctx.textAlign="left"; ctx.fillStyle=g.mult>1?"#ffd700":"#ffffff";
  ctx.fillText(g.score.toLocaleString(),98,46); ctx.shadowBlur=0;
  ctx.fillStyle="rgba(0,70,210,.2)"; rRect(ctx,W/2-32,13,64,40,8); ctx.fill();
  ctx.strokeStyle="rgba(0,110,255,.22)"; ctx.lineWidth=1; rRect(ctx,W/2-32,13,64,40,8); ctx.stroke();
  ctx.font="600 8px sans-serif"; ctx.textAlign="center"; ctx.fillStyle="rgba(100,160,255,.55)"; ctx.fillText("WAVE",W/2,26);
  ctx.font="800 20px sans-serif"; ctx.fillStyle="#aaccff"; ctx.fillText(String(g.wave),W/2,46);
  if(g.laserStored){ctx.font="700 8px sans-serif"; ctx.textAlign="right"; ctx.fillStyle="rgba(255,120,40,.8)"; ctx.fillText("LASER READY",W-18,22);}
  const prog=(g.kills%KILLS_PER_WAVE)/KILLS_PER_WAVE;
  ctx.fillStyle="rgba(0,55,150,.3)"; rRect(ctx,8,68,W-16,7,3.5); ctx.fill();
  if(prog>0){const pg=ctx.createLinearGradient(8,0,8+(W-16)*prog,0); pg.addColorStop(0,"#0055ff"); pg.addColorStop(1,"#00ccff"); ctx.fillStyle=pg; rRect(ctx,8,68,(W-16)*prog,7,3.5); ctx.fill();}
  ctx.font="600 7px sans-serif"; ctx.textAlign="right"; ctx.fillStyle="rgba(100,160,255,.4)"; ctx.fillText(`${g.kills%KILLS_PER_WAVE}/${KILLS_PER_WAVE}`,W-12,75);
  let barY=79;
  if(g.mult>1){const rem=Math.max(0,(g.multEnd-now)/9000); ctx.fillStyle="rgba(0,120,255,.1)"; rRect(ctx,8,barY,W-16,15,5); ctx.fill(); const mg=ctx.createLinearGradient(8,0,8+(W-16)*rem,0); mg.addColorStop(0,"#0052ff"); mg.addColorStop(1,"#00ccff"); ctx.fillStyle=mg; rRect(ctx,8,barY,(W-16)*rem,15,5); ctx.fill(); ctx.font="bold 8px sans-serif"; ctx.textAlign="center"; ctx.fillStyle="#fff"; ctx.fillText("$BASE x2 MULTIPLIER",W/2,barY+10); barY+=18;}
  if(g.freezeEnd>now){const rem=Math.max(0,(g.freezeEnd-now)/5000); ctx.fillStyle="rgba(0,200,195,.1)"; rRect(ctx,8,barY,W-16,15,5); ctx.fill(); const fg=ctx.createLinearGradient(8,0,8+(W-16)*rem,0); fg.addColorStop(0,"#00ccbb"); fg.addColorStop(1,"#aaffee"); ctx.fillStyle=fg; rRect(ctx,8,barY,(W-16)*rem,15,5); ctx.fill(); ctx.font="bold 8px sans-serif"; ctx.textAlign="center"; ctx.fillStyle="#aaffee"; ctx.fillText("ENEMIES FROZEN",W/2,barY+10); barY+=18;}
  if(g.laserEnd>now){const rem=Math.max(0,(g.laserEnd-now)/LASER_DURATION); ctx.fillStyle="rgba(200,50,0,.12)"; rRect(ctx,8,barY,W-16,15,5); ctx.fill(); const lg=ctx.createLinearGradient(8,0,8+(W-16)*rem,0); lg.addColorStop(0,"#ff2200"); lg.addColorStop(1,"#ffaa00"); ctx.fillStyle=lg; rRect(ctx,8,barY,(W-16)*rem,15,5); ctx.fill(); ctx.font="bold 8px sans-serif"; ctx.textAlign="center"; ctx.fillStyle="#ffcc88"; ctx.fillText("LASER BEAM ACTIVE",W/2,barY+10);}
}

/* ═══════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════ */
export default function App() {
  const [screen, setScreen] = useState("home");
  const [wallet, setWallet] = useState("");
  const [basename, setBasename] = useState("");
  const [lb, setLb] = useState([]);
  const [finalScore, setFinalScore] = useState(0);
  const [best, setBest] = useState(0);
  const [musicOn, setMusicOn] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState("");

  const connect = async () => {
    setWalletError("");
    if (!window.ethereum) { setWalletError("No wallet found. Open in Coinbase Wallet."); return; }
    setConnecting(true);
    try {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }]
          });
        }
      }
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const addr = accounts[0];
      if (!addr) throw new Error("No account");
      const bn = await resolveBasename(addr);
      setWallet(addr); setBasename(bn || "");
      const onchainBest = await getOnchainBest(addr);
      const localBest = getLocalBest(addr);
      setBest(Math.max(onchainBest, localBest));
    } catch (err) {
      setWalletError(err?.message?.includes("rejected") ? "Connection cancelled." : "Could not connect. Try again.");
    }
    setConnecting(false);
  };

  useEffect(() => {
    if (!window.ethereum) return;
    const handler = (accounts) => {
      if (accounts[0]) { const addr = accounts[0]; resolveBasename(addr).then(bn => setBasename(bn || "")); setWallet(addr); }
      else { setWallet(""); setBasename(""); }
    };
    window.ethereum.on("accountsChanged", handler);
    return () => window.ethereum.removeListener?.("accountsChanged", handler);
  }, []);

  const handleOver = useCallback(async (score) => {
    setFinalScore(score); audio.stopMusic();
    if (wallet) setLocalBest(wallet, score);
    const onchainLb = await getOnchainLeaderboard();
    setLb(onchainLb);
    setScreen("over");
  }, [wallet]);

  const toggleMusic = () => { const on = audio.toggleMusic(); setMusicOn(on); };
  useEffect(() => { if (screen === "board") getOnchainLeaderboard().then(setLb); }, [screen]);

  return (
    <div style={{ minHeight:"100vh", background:"#010108", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Exo 2','Courier New',sans-serif", padding:8 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;600;700;800;900&family=Rajdhani:wght@500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        @keyframes shimmer{0%{background-position:-300% center}100%{background-position:300% center}}
        @keyframes scan{0%{transform:translateY(-100%)}100%{transform:translateY(200%)}}
        @keyframes breathe{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.02)}}
        @keyframes wave-in{0%{opacity:0;transform:scale(.9) translateY(14px)}100%{opacity:1;transform:scale(1) translateY(0)}}
        @keyframes glow-p{0%,100%{box-shadow:0 0 22px rgba(0,90,255,.38)}50%{box-shadow:0 0 48px rgba(0,145,255,.7)}}
        .sc{animation:fadeUp .42s cubic-bezier(.22,1,.36,1) both}
        .btn-p{background:linear-gradient(135deg,#0041d4,#0088ff 60%,#00aaff);border:none;border-radius:14px;color:#fff;font-family:'Exo 2',sans-serif;font-weight:800;font-size:15px;padding:16px 32px;cursor:pointer;letter-spacing:2px;text-transform:uppercase;width:100%;box-shadow:0 2px 32px rgba(0,100,255,.4),inset 0 1px 0 rgba(255,255,255,.18);transition:all .18s;position:relative;overflow:hidden}
        .btn-p::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.12),transparent);border-radius:14px}
        .btn-p:hover{transform:translateY(-2px);box-shadow:0 6px 48px rgba(0,130,255,.65)}
        .btn-p:active{transform:translateY(0)}
        .btn-p:disabled{opacity:.5;transform:none;cursor:not-allowed}
        .btn-g{background:rgba(0,30,80,.35);backdrop-filter:blur(8px);border:1px solid rgba(0,100,220,.28);border-radius:14px;color:rgba(130,195,255,.88);font-family:'Exo 2',sans-serif;font-size:13px;font-weight:700;padding:13px 24px;cursor:pointer;letter-spacing:1.5px;text-transform:uppercase;transition:all .18s;width:100%}
        .btn-g:hover{border-color:rgba(0,170,255,.65);background:rgba(0,80,200,.18);color:#fff;transform:translateY(-1px)}
        .btn-ic{background:rgba(0,20,65,.55);backdrop-filter:blur(6px);border:1px solid rgba(0,90,210,.25);border-radius:10px;color:rgba(130,195,255,.85);font-size:16px;padding:7px 11px;cursor:pointer;transition:all .18s;line-height:1}
        .btn-ic:hover{border-color:rgba(0,160,255,.55);background:rgba(0,70,180,.28);color:#fff}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#0044aa33;border-radius:2px}
      `}</style>
      {screen==="home"&&<HomeScreen wallet={wallet} basename={basename} connect={connect} connecting={connecting} walletError={walletError} best={best} setScreen={setScreen} musicOn={musicOn} toggleMusic={toggleMusic}/>}
      {screen==="game"&&<GameScreen wallet={wallet} basename={basename} onGameOver={handleOver} musicOn={musicOn} toggleMusic={toggleMusic} setScreen={setScreen}/>}
      {screen==="over"&&<GameOverScreen score={finalScore} best={best} wallet={wallet} basename={basename} setScreen={setScreen} musicOn={musicOn} toggleMusic={toggleMusic}/>}
      {screen==="board"&&<BoardScreen lb={lb} wallet={wallet} setScreen={setScreen}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HOME SCREEN
═══════════════════════════════════════════════════════════ */
function HomeScreen({wallet,basename,connect,connecting,walletError,best,setScreen,musicOn,toggleMusic}) {
  const cvs=useRef(),raf=useRef(),ph=useRef(0),sc=useRef(0),stars=useRef(genStars());
  useEffect(()=>{
    const c=cvs.current; if(!c)return;
    const ctx=c.getContext("2d");
    const loop=()=>{
      ph.current+=.014; sc.current+=.38;
      ctx.fillStyle="#010108"; ctx.fillRect(0,0,W,H);
      [[W*.75,H*.22,260,"rgba(0,32,110,.16)"],[W*.15,H*.72,200,"rgba(50,0,90,.1)"]].forEach(([nx,ny,nr,nc])=>{const ng=ctx.createRadialGradient(nx,ny,0,nx,ny,nr);ng.addColorStop(0,nc);ng.addColorStop(1,"transparent");ctx.fillStyle=ng;ctx.fillRect(0,0,W,H);});
      drawStars(ctx,stars.current,sc.current,ph.current);
      ctx.save(); ctx.globalAlpha=.88; drawShip(ctx,W/2-SHIP_W/2,200+Math.sin(ph.current*.75)*10,false,false,false,ph.current*2.6); ctx.restore();
      raf.current=requestAnimationFrame(loop);
    };
    raf.current=requestAnimationFrame(loop);
    return()=>cancelAnimationFrame(raf.current);
  },[]);

  return(
    <div className="sc" style={{position:"relative",width:W,borderRadius:22,overflow:"hidden",boxShadow:"0 0 100px rgba(0,50,190,.32),0 0 0 1px rgba(0,80,220,.15)"}}>
      <canvas ref={cvs} width={W} height={H} style={{display:"block"}}/>
      <div style={{position:"absolute",inset:0,pointerEvents:"none",overflow:"hidden",borderRadius:22}}>
        <div style={{position:"absolute",left:0,right:0,height:2,background:"linear-gradient(90deg,transparent,rgba(0,160,255,.06),transparent)",animation:"scan 7s linear infinite"}}/>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at center,transparent 55%,rgba(0,0,12,.7) 100%)"}}/>
      </div>
      <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",padding:"26px 26px"}}>
        <div style={{display:"flex",justifyContent:"flex-end",marginBottom:6}}>
          <button className="btn-ic" onClick={toggleMusic}>{musicOn?"🔊":"🔇"}</button>
        </div>
        <div style={{textAlign:"center",marginBottom:4}}>
          <div style={{fontSize:9,letterSpacing:8,color:"rgba(0,150,255,.5)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,marginBottom:8}}>BASE NETWORK</div>
          <div style={{fontSize:42,fontWeight:900,fontFamily:"'Rajdhani',sans-serif",letterSpacing:2,lineHeight:1,background:"linear-gradient(130deg,#fff 0%,#99d4ff 30%,#0099ff 60%,#0041dd 100%)",backgroundSize:"300% auto",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",animation:"shimmer 5s linear infinite"}}>BASE<br/>BUGS</div>
          <div style={{marginTop:10,display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
            <div style={{height:"1px",flex:1,background:"linear-gradient(90deg,transparent,rgba(0,130,255,.35))"}}/>
            <span style={{fontSize:8,color:"rgba(100,165,255,.4)",letterSpacing:5,fontFamily:"'Rajdhani',sans-serif",fontWeight:600,whiteSpace:"nowrap"}}>DEFENDER PROTOCOL v5.0</span>
            <div style={{height:"1px",flex:1,background:"linear-gradient(90deg,rgba(0,130,255,.35),transparent)"}}/>
          </div>
        </div>
        <div style={{flex:1}}/>
        <div style={{background:"rgba(0,10,40,.75)",backdropFilter:"blur(16px)",border:"1px solid rgba(0,80,200,.2)",borderRadius:16,padding:"14px 18px",marginBottom:14}}>
          <div style={{fontSize:9,letterSpacing:4,color:"rgba(0,140,255,.5)",marginBottom:10,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>HOW TO PLAY</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px 12px"}}>
            {[["DRAG","Move ship"],["AUTO-FIRE","Shoots automatically"],["BLUE","x2 score"],["CYAN","Freeze enemies"],["RED","Laser beam"],["x10 KILLS","Next wave"]].map(([k,v])=>(
              <div key={k} style={{display:"flex",gap:7,alignItems:"center"}}>
                <span style={{background:"rgba(0,60,190,.28)",border:"1px solid rgba(0,100,220,.25)",borderRadius:6,padding:"2px 6px",fontSize:8,color:"#7fc4ff",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,whiteSpace:"nowrap"}}>{k}</span>
                <span style={{color:"rgba(165,205,255,.75)",fontSize:11}}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        {!wallet?(
          <div style={{marginBottom:12}}>
            <div style={{fontSize:8,letterSpacing:2,color:"rgba(100,150,255,.45)",marginBottom:10,textAlign:"center",fontFamily:"'Rajdhani',sans-serif",lineHeight:1.8}}>
              CONNECT BASE WALLET TO SAVE SCORES ONCHAIN<br/>
              <span style={{color:"rgba(80,120,200,.35)",fontSize:7}}>GLOBAL LEADERBOARD · STORED ON BASE BLOCKCHAIN</span>
            </div>
            <button className="btn-p" onClick={connect} disabled={connecting} style={{animation:"glow-p 2.5s ease-in-out infinite"}}>
              {connecting?"CONNECTING...":"⚡  Connect Base Wallet"}
            </button>
            {walletError&&<div style={{marginTop:10,fontSize:11,color:"#ff7766",textAlign:"center",background:"rgba(255,50,30,.08)",border:"1px solid rgba(255,80,50,.15)",borderRadius:10,padding:"8px 12px"}}>{walletError}</div>}
            <div style={{marginTop:8,textAlign:"center",fontSize:8,color:"rgba(80,120,200,.35)",fontFamily:"'Exo 2',sans-serif",letterSpacing:1}}>Best used inside Coinbase Wallet app</div>
          </div>
        ):(
          <div style={{background:"rgba(0,22,65,.65)",border:"1px solid rgba(0,120,255,.2)",borderRadius:12,padding:"12px 15px",marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:"#00ff99",boxShadow:"0 0 10px #00ff99",animation:"breathe 2s ease-in-out infinite",flexShrink:0}}/>
                <div>
                  <div style={{color:"#00ff99",fontSize:14,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,letterSpacing:1}}>{basename||shortAddr(wallet)}</div>
                  {basename&&<div style={{color:"rgba(100,150,200,.5)",fontSize:9}}>{shortAddr(wallet)}</div>}
                </div>
              </div>
              {best>0&&<span style={{color:"#ffd700",fontSize:12,fontFamily:"'Rajdhani',sans-serif",fontWeight:700,letterSpacing:1}}>BEST {best.toLocaleString()}</span>}
            </div>
          </div>
        )}
        <button className="btn-p" style={{marginBottom:9,fontSize:17,padding:"18px",letterSpacing:4}} onClick={()=>setScreen("game")}>LAUNCH</button>
        <button className="btn-g" onClick={()=>setScreen("board")}>🏆  Leaderboard</button>
        <div style={{height:12}}/>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   GAME SCREEN
═══════════════════════════════════════════════════════════ */
function GameScreen({wallet,basename,onGameOver,musicOn,toggleMusic,setScreen}) {
  const cvs=useRef(),raf=useRef(),gs=useRef(null);
  const keys=useRef({}),drag=useRef({on:false,sx:0,ship0:0});
  const lastFire=useRef(0),lastEnemy=useRef(0),lastBase=useRef(0),lastFreeze=useRef(0),lastLaserFruit=useRef(0);
  const ft=useRef(null),stars=useRef(genStars()),scroll=useRef(0);
  const prevWave=useRef(1),tiltRef=useRef(0),pausedRef=useRef(false),lastTap=useRef(0);
  const [paused,setPaused]=useState(false);
  const [waveMsg,setWaveMsg]=useState(null);
  const [score,setScore]=useState(0);
  const waveMsgTimer=useRef(null);

  const burst=(g,x,y,col,n)=>{for(let i=0;i<n;i++){const a=rand(0,Math.PI*2),s=rand(70,260);g.particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,r:rand(1.5,5),color:col});}};
  const endGame=g=>{g.dead=true;cancelAnimationFrame(raf.current);onGameOver(g.score);};

  const goToMenu=useCallback(()=>{
    cancelAnimationFrame(raf.current);
    audio.stopMusic();
    audio.laserStop();
    setScreen("home");
  },[]);

  const togglePause=useCallback(()=>{
    pausedRef.current=!pausedRef.current; setPaused(pausedRef.current);
    if(!pausedRef.current){audio.resume();ft.current=null;raf.current=requestAnimationFrame(loop);}
    else cancelAnimationFrame(raf.current);
  },[]);

  const fireLaser=useCallback(()=>{
    const g=gs.current; if(!g||g.dead||pausedRef.current)return;
    if(g.laserStored&&g.laserEnd<=Date.now()){g.laserStored=false;g.laserEnd=Date.now()+LASER_DURATION;audio.laserStart();}
  },[]);

  useEffect(()=>{
    audio.init(); audio.resume(); if(musicOn)audio.startMusic();
    gs.current={px:W/2-SHIP_W/2,py:H-102,tx:W/2-SHIP_W/2,bullets:[],enemies:[],baseFruits:[],freezeFruits:[],laserFruits:[],particles:[],score:0,lives:3,mult:1,multEnd:0,wave:1,kills:0,freezeEnd:0,laserStored:false,laserEnd:0,phase:0,dead:false};
    lastFire.current=0; lastEnemy.current=0;
    lastBase.current=Date.now()+rand(8000,14000);
    lastFreeze.current=Date.now()+rand(16000,26000);
    lastLaserFruit.current=Date.now()+rand(20000,35000);
    ft.current=null; prevWave.current=1; pausedRef.current=false;
    const c=cvs.current;
    const gk=e=>{keys.current[e.code]=e.type==="keydown";if(["ArrowLeft","ArrowRight","Space"].includes(e.code))e.preventDefault();if(e.type==="keydown"&&e.code==="Escape")togglePause();};
    window.addEventListener("keydown",gk); window.addEventListener("keyup",gk);
    const getCX=e=>{const r=c.getBoundingClientRect();return((e.touches?.[0]?.clientX??e.clientX)-r.left)*(W/r.width);};
    const onS=e=>{if(pausedRef.current)return;const g=gs.current;if(!g)return;drag.current={on:true,sx:getCX(e),ship0:g.tx};const now=Date.now();if(now-lastTap.current<300)fireLaser();lastTap.current=now;};
    const onM=e=>{if(!drag.current.on||pausedRef.current)return;const g=gs.current;if(!g)return;const dx=getCX(e)-drag.current.sx;g.tx=clamp(drag.current.ship0+dx,0,W-SHIP_W);};
    const onE=()=>{drag.current.on=false;};
    c.addEventListener("mousedown",onS); window.addEventListener("mousemove",onM); window.addEventListener("mouseup",onE);
    c.addEventListener("touchstart",onS,{passive:true}); window.addEventListener("touchmove",onM,{passive:true}); window.addEventListener("touchend",onE);
    raf.current=requestAnimationFrame(loop);
    return()=>{
      cancelAnimationFrame(raf.current); audio.stopMusic(); audio.laserStop();
      window.removeEventListener("keydown",gk); window.removeEventListener("keyup",gk);
      window.removeEventListener("mousemove",onM); window.removeEventListener("mouseup",onE);
      window.removeEventListener("touchmove",onM); window.removeEventListener("touchend",onE);
      if(waveMsgTimer.current)clearTimeout(waveMsgTimer.current);
    };
  },[]);

  const loop=useCallback(ts=>{
    const g=gs.current; if(!g||g.dead||pausedRef.current)return;
    const c=cvs.current; if(!c)return;
    const ctx=c.getContext("2d");
    const now=Date.now();
    if(!ft.current)ft.current=ts;
    const dt=Math.min((ts-ft.current)/1000,.05); ft.current=ts;
    g.phase+=dt; scroll.current+=dt;
    const spd=310;
    if(keys.current["ArrowLeft"]||keys.current["KeyA"])g.tx=Math.max(0,g.tx-spd*dt);
    if(keys.current["ArrowRight"]||keys.current["KeyD"])g.tx=Math.min(W-SHIP_W,g.tx+spd*dt);
    const ddx=g.tx-g.px; tiltRef.current=lerp(tiltRef.current,clamp(ddx*.6,-8,8),dt*8);
    g.px=lerp(g.px,g.tx,Math.min(1,dt*13));
    if(g.mult>1&&now>g.multEnd)g.mult=1;
    const frozen=now<g.freezeEnd;
    const laserActive=now<g.laserEnd;
    if(!laserActive&&g.laserEnd>0&&g.laserEnd<=now){audio.laserStop();g.laserEnd=0;}
    if(!laserActive&&now-lastFire.current>FIRE_RATE){lastFire.current=now;g.bullets.push({x:g.px+SHIP_W/2,y:g.py,active:true});audio.shoot();}
    const expectedWave=Math.floor(g.kills/KILLS_PER_WAVE)+1;
    if(expectedWave!==g.wave){g.wave=expectedWave;audio.waveUp();setWaveMsg(`WAVE ${g.wave}`);if(waveMsgTimer.current)clearTimeout(waveMsgTimer.current);waveMsgTimer.current=setTimeout(()=>setWaveMsg(null),2200);}
    const eInt=Math.max(340,1700-g.wave*75);
    if(now-lastEnemy.current>eInt){lastEnemy.current=now;const cnt=g.wave>6?3:g.wave>3?2:1;for(let i=0;i<cnt;i++){const bs=50+g.wave*15;g.enemies.push({x:rand(12,W-50),y:-52,speed:bs+rand(0,bs*.3),type:0,active:true,phase:rand(0,Math.PI*2)});}}
    if(now>lastBase.current){lastBase.current=now+rand(9000,19000);g.baseFruits.push({x:rand(20,W-60),y:-52,speed:rand(48,64),active:true,phase:rand(0,Math.PI*2)});}
    if(now>lastFreeze.current){lastFreeze.current=now+rand(18000,36000);g.freezeFruits.push({x:rand(20,W-60),y:-52,speed:rand(44,58),active:true,phase:rand(0,Math.PI*2)});}
    if(now>lastLaserFruit.current){lastLaserFruit.current=now+rand(25000,40000);if(!g.laserStored&&!laserActive)g.laserFruits.push({x:rand(20,W-60),y:-52,speed:rand(44,56),active:true,phase:rand(0,Math.PI*2)});}
    g.bullets.forEach(b=>{if(b.active)b.y-=560*dt;}); g.bullets=g.bullets.filter(b=>b.active&&b.y>-26);
    g.enemies.forEach(e=>{if(!e.active)return;e.y+=(frozen?e.speed*.08:e.speed)*dt;e.phase+=dt*(frozen?.4:2);if(e.y>H+16){e.active=false;g.lives--;burst(g,e.x+18,H-20,"#ff2200",7);audio.loseLife();if(g.lives<=0)endGame(g);}});
    g.baseFruits.forEach(f=>{if(f.active){f.y+=(frozen?f.speed*.08:f.speed)*dt;f.phase+=dt*2.2;if(f.y>H+16)f.active=false;}});
    g.freezeFruits.forEach(f=>{if(f.active){f.y+=f.speed*dt;f.phase+=dt*2.5;if(f.y>H+16)f.active=false;}});
    g.laserFruits.forEach(f=>{if(f.active){f.y+=f.speed*dt;f.phase+=dt*2.8;if(f.y>H+16)f.active=false;}});
    if(laserActive){const cx=g.px+SHIP_W/2;g.enemies.forEach(e=>{if(!e.active)return;if(cx>e.x-4&&cx<e.x+40){e.active=false;const pal=PALETTES[(g.wave-1)%PALETTES.length];g.score+=20*g.mult*(frozen?2:1);g.kills++;burst(g,e.x+18,e.y+18,pal[0],16);audio.explode();}});}
    g.bullets.forEach(b=>{if(!b.active)return;g.enemies.forEach(e=>{if(!e.active)return;if(b.x>e.x-2&&b.x<e.x+40&&b.y>e.y-5&&b.y<e.y+42){b.active=false;e.active=false;const pal=PALETTES[(g.wave-1)%PALETTES.length];g.score+=10*g.mult*(frozen?2:1);g.kills++;burst(g,e.x+18,e.y+18,pal[0],14);audio.explode();}});});
    g.enemies.forEach(e=>{if(!e.active)return;if(e.x+32>g.px+6&&e.x+4<g.px+SHIP_W-6&&e.y+34>g.py+8&&e.y<g.py+SHIP_H-8){e.active=false;g.lives--;burst(g,g.px+SHIP_W/2,g.py+SHIP_H/2,"#ff1100",20);audio.loseLife();if(g.lives<=0)endGame(g);}});
    g.baseFruits.forEach(f=>{if(!f.active)return;if(f.x+40>g.px&&f.x<g.px+SHIP_W&&f.y+40>g.py&&f.y<g.py+SHIP_H){f.active=false;g.mult=2;g.multEnd=now+9000;g.score+=100;burst(g,f.x+20,f.y+20,"#0099ff",22);audio.powerup(false);}});
    g.freezeFruits.forEach(f=>{if(!f.active)return;if(f.x+40>g.px&&f.x<g.px+SHIP_W&&f.y+40>g.py&&f.y<g.py+SHIP_H){f.active=false;g.freezeEnd=now+5000;g.score+=200;burst(g,f.x+20,f.y+20,"#00ffdd",26);audio.powerup(true);}});
    g.laserFruits.forEach(f=>{if(!f.active)return;if(f.x+40>g.px&&f.x<g.px+SHIP_W&&f.y+40>g.py&&f.y<g.py+SHIP_H){f.active=false;if(!g.laserStored&&!laserActive){g.laserStored=true;g.score+=50;burst(g,f.x+20,f.y+20,"#ff6600",22);audio.laserPickup();}}});
    g.particles.forEach(p=>{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=95*dt;p.life-=dt*1.5;p.r*=.99;});
    g.particles=g.particles.filter(p=>p.life>0);
    g.enemies=g.enemies.filter(e=>e.active);
    g.baseFruits=g.baseFruits.filter(f=>f.active);
    g.freezeFruits=g.freezeFruits.filter(f=>f.active);
    g.laserFruits=g.laserFruits.filter(f=>f.active);
    setScore(g.score);
    ctx.fillStyle="#010108"; ctx.fillRect(0,0,W,H);
    [[W*.78,H*.20,260,"rgba(0,28,100,.15)"],[W*.12,H*.72,200,"rgba(55,0,88,.1)"],[W*.5,H*.5,180,"rgba(0,15,60,.08)"]].forEach(([nx,ny,nr,nc])=>{const ng=ctx.createRadialGradient(nx,ny,0,nx,ny,nr);ng.addColorStop(0,nc);ng.addColorStop(1,"transparent");ctx.fillStyle=ng;ctx.fillRect(0,0,W,H);});
    const vig=ctx.createRadialGradient(W*.5,H*.5,H*.2,W*.5,H*.5,H*.82); vig.addColorStop(0,"transparent"); vig.addColorStop(1,"rgba(0,0,12,.6)"); ctx.fillStyle=vig; ctx.fillRect(0,0,W,H);
    drawStars(ctx,stars.current,scroll.current*55,g.phase);
    if(frozen){ctx.save();ctx.globalAlpha=.06;ctx.fillStyle="#00ffdd";ctx.fillRect(0,0,W,H);ctx.restore();}
    if(laserActive)drawLaserBeam(ctx,g.px,g.py,g.phase);
    g.baseFruits.forEach(f=>drawBaseFruit(ctx,f.x,f.y,f.phase));
    g.freezeFruits.forEach(f=>drawFreezeFruit(ctx,f.x,f.y,f.phase));
    g.laserFruits.forEach(f=>drawLaserFruit(ctx,f.x,f.y,f.phase));
    g.bullets.forEach(b=>drawBullet(ctx,b.x,b.y,g.mult>1));
    g.enemies.forEach(e=>drawAlien(ctx,e.x,e.y,e.phase,frozen,g.wave));
    drawShip(ctx,g.px,g.py,g.mult>1,frozen,laserActive,g.phase*2.8,tiltRef.current);
    g.particles.forEach(p=>drawParticle(ctx,p));
    drawHUD(ctx,g,now);
    raf.current=requestAnimationFrame(loop);
  },[]);

  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,position:"relative"}}>
      {waveMsg&&(
        <div key={waveMsg} style={{position:"absolute",top:"38%",left:"50%",transform:"translate(-50%,-50%)",zIndex:10,textAlign:"center",pointerEvents:"none",animation:"wave-in .35s cubic-bezier(.22,1,.36,1) both"}}>
          <div style={{fontSize:9,letterSpacing:6,color:"rgba(0,180,255,.7)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,marginBottom:3}}>DIFFICULTY INCREASE</div>
          <div style={{fontSize:50,fontWeight:900,fontFamily:"'Rajdhani',sans-serif",letterSpacing:3,background:"linear-gradient(130deg,#fff 0%,#88ccff 40%,#0099ff 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",filter:"drop-shadow(0 0 24px rgba(0,150,255,.8))"}}>{waveMsg}</div>
        </div>
      )}
      <div style={{position:"relative"}}>
        <canvas ref={cvs} width={W} height={H} style={{borderRadius:18,cursor:"crosshair",display:"block",maxWidth:"100%",boxShadow:"0 0 80px rgba(0,45,180,.42),0 0 0 1px rgba(0,80,220,.14)"}}/>
        <div style={{position:"absolute",top:10,right:10,display:"flex",gap:6,zIndex:6}}>
          <button className="btn-ic" onClick={togglePause} style={{fontSize:14,padding:"7px 10px"}}>{paused?"▶":"⏸"}</button>
          <button className="btn-ic" onClick={toggleMusic} style={{fontSize:13,padding:"7px 9px"}}>{musicOn?"🔊":"🔇"}</button>
        </div>
        {paused&&(
          <div style={{position:"absolute",inset:0,background:"rgba(0,3,20,.78)",borderRadius:18,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:5,backdropFilter:"blur(4px)"}}>
            <div style={{background:"rgba(0,10,40,.96)",border:"1px solid rgba(0,100,220,.35)",borderRadius:18,padding:"36px 48px",textAlign:"center",minWidth:260}}>
              <div style={{fontSize:9,letterSpacing:6,color:"rgba(100,160,255,.55)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,marginBottom:8}}>GAME PAUSED</div>
              <div style={{fontSize:54,fontWeight:900,color:"#fff",fontFamily:"'Rajdhani',sans-serif",lineHeight:1,marginBottom:12,letterSpacing:6}}>II</div>
              <div style={{fontSize:24,fontWeight:900,fontFamily:"'Rajdhani',sans-serif",color:"#ffd700",marginBottom:24}}>{score.toLocaleString()}</div>
              <button className="btn-p" style={{fontSize:14,padding:"13px 36px",letterSpacing:3,width:"100%",marginBottom:10}} onClick={togglePause}>
                ▶  RESUME
              </button>
              <button className="btn-g" style={{fontSize:13,letterSpacing:2,width:"100%"}} onClick={goToMenu}>
                ← Main Menu
              </button>
            </div>
          </div>
        )}
      </div>
      <div style={{color:"rgba(70,110,200,.48)",fontSize:9,letterSpacing:3,fontFamily:"'Rajdhani',sans-serif",textAlign:"center"}}>
        DRAG TO MOVE · AUTO-FIRE · DOUBLE-TAP = LASER · ESC PAUSE
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   GAME OVER
═══════════════════════════════════════════════════════════ */
function GameOverScreen({score,best,wallet,basename,setScreen,musicOn,toggleMusic}) {
  const isNew=score>0&&score>=best;
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [saveError,setSaveError]=useState("");
  const [txHash,setTxHash]=useState("");

  const saveOnchain=async()=>{
    if(!wallet){setSaveError("Connect wallet first."); return;}
    setSaving(true); setSaveError("");
    try {
      const hash=await submitScoreOnchain(score,basename||"");
      setTxHash(hash); setSaved(true);
    } catch(err) {
      const msg=err?.message||"";
      if(msg.includes("Score not higher")||msg.includes("ScoreNotHigher"))
        setSaveError("Your score is not higher than your previous best onchain. No need to resubmit.");
      else if(msg.includes("rejected")||msg.includes("denied"))
        setSaveError("Transaction cancelled.");
      else if(msg.includes("Rate limited")||msg.includes("RateLimited"))
        setSaveError("Rate limited — please wait 5 minutes before submitting again.");
      else
        setSaveError("Transaction failed: " + (msg||"Unknown error"));
    }
    setSaving(false);
  };

  return(
    <div className="sc" style={{width:W,background:"rgba(1,1,16,.98)",border:"1px solid rgba(0,60,180,.2)",borderRadius:22,overflow:"hidden",boxShadow:"0 0 100px rgba(0,30,140,.42)"}}>
      <div style={{position:"relative",zIndex:1,padding:"48px 32px",textAlign:"center"}}>
        <div style={{fontSize:9,letterSpacing:6,color:"rgba(220,45,45,.6)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,marginBottom:5}}>MISSION FAILED</div>
        <div style={{fontSize:38,fontWeight:900,color:"#ff1a0a",fontFamily:"'Rajdhani',sans-serif",letterSpacing:3,marginBottom:isNew?10:26}}>GAME OVER</div>
        {isNew&&<div style={{display:"inline-block",fontSize:9,letterSpacing:5,color:"#ffd700",padding:"4px 16px",border:"1px solid rgba(255,215,0,.3)",borderRadius:20,background:"rgba(255,200,0,.08)",marginBottom:20,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>NEW PERSONAL RECORD</div>}
        <div style={{background:"rgba(0,12,48,.7)",border:"1px solid rgba(0,60,180,.2)",borderRadius:18,padding:"30px 24px",margin:"0 0 20px"}}>
          <div style={{fontSize:9,letterSpacing:5,color:"rgba(100,155,255,.45)",marginBottom:10,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>FINAL SCORE</div>
          <div style={{fontSize:58,fontWeight:900,fontFamily:"'Rajdhani',sans-serif",lineHeight:1,background:"linear-gradient(130deg,#fff 0%,#88ccff 45%,#0099ff 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{score.toLocaleString()}</div>
          {best>0&&<div style={{marginTop:12,fontSize:12,color:"rgba(255,215,0,.62)",fontFamily:"'Rajdhani',sans-serif",fontWeight:600,letterSpacing:2}}>PERSONAL BEST: {best.toLocaleString()}</div>}
          {wallet&&<div style={{marginTop:8,fontSize:10,color:"rgba(0,200,100,.5)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,letterSpacing:1}}>{basename||shortAddr(wallet)}</div>}
        </div>

        {/* Onchain save */}
        {wallet&&!saved&&(
          <div style={{marginBottom:12}}>
            <button className="btn-p" style={{background:"linear-gradient(135deg,#1a6600,#33aa00)",boxShadow:"0 2px 32px rgba(50,180,0,.4)",marginBottom:8,letterSpacing:2}} onClick={saveOnchain} disabled={saving}>
              {saving?"CONFIRMING...":"⛓  Commit Score to Base"}
            </button>
            <div style={{fontSize:8,color:"rgba(100,200,100,.5)",textAlign:"center",fontFamily:"'Exo 2',sans-serif",letterSpacing:1}}>
              ~$0.001 gas · Stored on Base forever · Visible to all
            </div>
            {saveError&&(
              <div style={{marginTop:10,background:"rgba(255,50,30,.08)",border:"1px solid rgba(255,80,50,.15)",borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
                <div style={{fontSize:12,color:"#ff7766",marginBottom:saveError.includes("not higher")||saveError.includes("Rate limited")?0:10,lineHeight:1.5}}>{saveError}</div>
                {!saveError.includes("not higher")&&!saveError.includes("Rate limited")&&(
                  <button className="btn-p" style={{fontSize:12,padding:"10px",letterSpacing:1,marginTop:8,background:"linear-gradient(135deg,#aa2200,#ff4400)"}} onClick={saveOnchain} disabled={saving}>
                    {saving?"RETRYING...":"↻  Try Again"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {saved&&(
          <div style={{marginBottom:12,background:"rgba(0,100,0,.2)",border:"1px solid rgba(0,200,0,.3)",borderRadius:12,padding:"12px 16px"}}>
            <div style={{fontSize:13,color:"#00ff88",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,marginBottom:4}}>✅ SCORE ON BASE BLOCKCHAIN</div>
            <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer"
              style={{fontSize:9,color:"rgba(0,200,255,.7)",fontFamily:"'Exo 2',sans-serif",letterSpacing:1,textDecoration:"none"}}>
              View on Basescan →
            </a>
          </div>
        )}

        {!wallet&&<div style={{marginBottom:12,fontSize:11,color:"rgba(100,150,255,.5)",textAlign:"center",fontFamily:"'Exo 2',sans-serif"}}>Connect wallet to save score onchain</div>}

        <button className="btn-p" style={{marginBottom:10,letterSpacing:3,fontSize:15}} onClick={()=>setScreen("game")}>RETRY MISSION</button>
        <button className="btn-g" style={{marginBottom:8}} onClick={()=>setScreen("board")}>🏆  Leaderboard</button>
        <div style={{display:"flex",gap:8}}>
          <button className="btn-g" style={{flex:1}} onClick={()=>setScreen("home")}>← Menu</button>
          <button className="btn-ic" style={{flexShrink:0,padding:"13px 16px"}} onClick={toggleMusic}>{musicOn?"🔊":"🔇"}</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LEADERBOARD
═══════════════════════════════════════════════════════════ */
function BoardScreen({lb,wallet,setScreen}) {
  const medals=["🥇","🥈","🥉"];
  const myAddr=wallet?.toLowerCase();
  const [entries,setEntries]=useState(lb);
  const [loading,setLoading]=useState(false);

  useEffect(()=>{
    setLoading(true);
    getOnchainLeaderboard().then(data=>{setEntries(data);setLoading(false);});
  },[]);

  return(
    <div className="sc" style={{width:W,background:"rgba(1,1,16,.98)",border:"1px solid rgba(0,60,180,.2)",borderRadius:22,overflow:"hidden",boxShadow:"0 0 100px rgba(0,30,140,.42)"}}>
      <div style={{padding:"36px 28px"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:9,letterSpacing:6,color:"rgba(255,195,0,.45)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,marginBottom:5}}>ONCHAIN RANKINGS</div>
          <div style={{fontSize:32,fontWeight:900,fontFamily:"'Rajdhani',sans-serif",letterSpacing:3,background:"linear-gradient(130deg,#ffd700,#ff9900)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>LEADERBOARD</div>
          <div style={{height:"1px",background:"linear-gradient(90deg,transparent,rgba(255,180,0,.25),transparent)",marginTop:10}}/>
          <div style={{marginTop:8,fontSize:8,color:"rgba(120,160,200,.4)",fontFamily:"'Exo 2',sans-serif",letterSpacing:2}}>Stored on Base · Top 50 · Basenames shown</div>
        </div>
        {loading?(
          <div style={{textAlign:"center",color:"rgba(80,120,180,.44)",padding:"48px 0",fontSize:12,fontFamily:"'Rajdhani',sans-serif",letterSpacing:3}}>LOADING FROM BASE...</div>
        ):entries.length===0?(
          <div style={{textAlign:"center",color:"rgba(80,120,180,.44)",padding:"48px 0",fontSize:12,fontFamily:"'Rajdhani',sans-serif",letterSpacing:3,lineHeight:2}}>NO SCORES YET<br/>BE THE FIRST</div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:7,maxHeight:460,overflowY:"auto",paddingRight:2}}>
            {entries.map((e,i)=>{
              const isMe=myAddr&&e.wallet?.toLowerCase()===myAddr;
              const name=e.basename||shortAddr(e.wallet);
              const rankBg=["rgba(255,200,0,.1)","rgba(200,200,200,.06)","rgba(180,120,50,.06)"];
              return(
                <div key={e.wallet} style={{display:"flex",alignItems:"center",gap:12,background:isMe?"rgba(0,50,165,.25)":(rankBg[i]||"rgba(0,14,45,.5)"),border:`1px solid ${isMe?"rgba(0,120,255,.42)":i===0?"rgba(255,200,0,.22)":i===1?"rgba(200,200,200,.12)":i===2?"rgba(180,120,50,.12)":"rgba(0,50,140,.15)"}`,borderRadius:12,padding:"13px 15px"}}>
                  <div style={{fontSize:18,width:28,textAlign:"center",lineHeight:1,flexShrink:0}}>
                    {medals[i]||<span style={{fontSize:11,color:"rgba(120,160,255,.55)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{i+1}</span>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{color:isMe?"#7fc4ff":i===0?"#ffd700":"rgba(175,215,255,.88)",fontSize:13,fontWeight:800,fontFamily:"'Rajdhani',sans-serif",letterSpacing:.8,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                      {name}{isMe&&<span style={{marginLeft:8,fontSize:8,color:"#0099ff",letterSpacing:2,background:"rgba(0,70,200,.3)",padding:"1px 7px",borderRadius:4}}>YOU</span>}
                    </div>
                    <a href={`https://basescan.org/address/${e.wallet}`} target="_blank" rel="noreferrer"
                      style={{fontSize:7,color:"rgba(0,180,255,.4)",fontFamily:"'Exo 2',sans-serif",textDecoration:"none",letterSpacing:.5}}>
                      basescan ↗
                    </a>
                  </div>
                  <div style={{color:i===0?"#ffd700":i===1?"#d0d0d0":i===2?"#cd8f4a":isMe?"#7fc4ff":"rgba(220,235,255,.88)",fontWeight:900,fontSize:19,fontFamily:"'Rajdhani',sans-serif",letterSpacing:.5,flexShrink:0}}>
                    {e.score.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{height:"1px",background:"linear-gradient(90deg,transparent,rgba(0,100,220,.2),transparent)",margin:"16px 0"}}/>
        <div style={{display:"flex",gap:9}}>
          <button className="btn-p" style={{fontSize:13,letterSpacing:2}} onClick={()=>setScreen("game")}>PLAY</button>
          <button className="btn-g" style={{maxWidth:110}} onClick={()=>setScreen("home")}>← Menu</button>
        </div>
      </div>
    </div>
  );
}
