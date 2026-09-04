const socket=io();
const params=new URLSearchParams(location.search),active=JSON.parse(localStorage.getItem('bingoActiveGame')||'{}');
const stake=Number(params.get('stake')||active.stake),username=active.username||localStorage.getItem('bingoUser')||'';
let cards=[],drawn=new Set(),autoMark=true,showBlink=true,ended=false,locked=new Set(),room={},winnerTimer=null,manualMarks=new Map();
let voicePack='john',soundEnabled=true;
let audioCtx=null,audioBuffers={},currentSource=null,audioCutTimer=null,audioUnlocked=false;
let selectedColor = localStorage.getItem('bingoHighlightColor') || '#00d26a';
const availableColors = [
  '#FF6B6B', // Red
  '#FF9F43', // Orange
  '#FECA57', // Yellow
  '#54A0FF', // Blue
  '#5F27CD', // Purple
  '#1DD1A1', // Teal
  '#FF6B81', // Pink
  '#0ABDE3', // Cyan
  '#10AC84', // Green
  '#EE5A24', // Dark Orange
];

const P=(...x)=>x,ROWS=Array.from({length:5},(_,r)=>P(...Array.from({length:5},(_,c)=>[r,c]))),COLS=Array.from({length:5},(_,c)=>P(...Array.from({length:5},(_,r)=>[r,c]))),DIAGS=[P([0,0],[1,1],[2,2],[3,3],[4,4]),P([0,4],[1,3],[2,2],[3,1],[4,0])];
const ONE=[...ROWS,...COLS,...DIAGS,[[0,0],[4,0],[0,4],[4,4]],[[1,1],[3,1],[1,3],[3,3]],[[2,1],[1,2],[2,2],[3,2],[2,3]]],TWO=[...ROWS,...COLS,...DIAGS,[[0,0],[4,0],[0,4],[4,4]],[[1,1],[3,1],[1,3],[3,3]]];
const FIXED={
'N':[[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[2,2],[3,3],[4,4],[0,4],[1,4],[2,4],[3,4]],'H':[[0,0],[1,0],[2,0],[3,0],[4,0],[2,1],[2,2],[2,3],[0,4],[1,4],[2,4],[3,4],[4,4]],'Reverse H':[[0,0],[0,1],[0,2],[0,3],[0,4],[1,2],[2,2],[3,2],[4,0],[4,1],[4,2],[4,3],[4,4]],'Z':[[0,0],[0,1],[0,2],[0,3],[0,4],[1,3],[2,2],[3,1],[4,0],[4,1],[4,2],[4,3],[4,4]],'K':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,3],[1,2],[2,1],[3,2],[4,3]],'E':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
'Three Horizontal Lines':[[0,0],[2,0],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],'Three Vertical Lines':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,2],[1,2],[2,2],[3,2],[4,2],[0,4],[1,4],[2,4],[3,4],[4,4]],'5':[[0,0],[1,0],[2,0],[3,4],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],'M':[[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[2,2],[1,3],[0,4],[1,4],[2,4],[3,4],[4,4]],'cross':[[2,0],[2,1],[3,2],[2,4],[2,2],[0,2],[1,2],[2,3],[4,2]],'vertical_line':COLS[2],'Five Dots':[[0,0],[0,4],[2,2],[4,0],[4,4]],'horizontal_line':ROWS[2],full:P(...Array.from({length:25},(_,i)=>[Math.floor(i/5),i%5]).filter(([r,c])=>!(r===2&&c===2))),x:P([0,0],[1,1],[2,2],[3,3],[4,4],[0,4],[1,3],[3,1],[4,0]),t:P([0,0],[0,1],[0,2],[0,3],[0,4],[1,2],[2,2],[3,2],[4,2]),reverse_t:P([4,0],[4,1],[4,2],[4,3],[4,4],[0,2],[1,2],[2,2],[3,2]),big_l:P([0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4]),reverse_l:P([0,0],[0,1],[0,2],[0,3],[0,4],[1,4],[2,4],[3,4],[4,4]),'Top Triangle':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,1],[1,1],[2,1],[3,1],[2,1],[0,2],[1,2],[2,2],[0,3],[1,3],[0,4]],'Bottom Triangle':[[4,0],[4,1],[4,2],[4,3],[4,4],[3,1],[3,2],[3,3],[3,4],[2,2],[2,3],[2,4],[1,3],[1,4],[0,4]],half_above:Array.from({length:15},(_,i)=>[Math.floor(i/5),i%5]),half_below:Array.from({length:15},(_,i)=>[Math.floor(i/5)+2,i%5])};
function patterns(t){if(t==='any_one_line')return ONE;if(t==='any_two_lines')return TWO;if(t==='any_square'){const a=[];for(let r=0;r<4;r++)for(let c=0;c<4;c++)a.push([[r,c],[r,c+1],[r+1,c],[r+1,c+1]]);return a}return FIXED[t]?[FIXED[t]]:[]}
function hit(g,r,c){const v=g[r][c];return v==='FREE'||v===0||(r===2&&c===2)||drawn.has(Number(v))}
function near(g){const out=new Set(),type=room.winningPattern;if(type==='any_two_lines'){const complete=TWO.filter(p=>p.every(([r,c])=>hit(g,r,c))).length;if(complete>=2)return out;TWO.forEach(p=>{const m=p.filter(([r,c])=>!hit(g,r,c));if(m.length===1)out.add(m[0].join(','))});return out}patterns(type).forEach(p=>{const m=p.filter(([r,c])=>!hit(g,r,c));if(m.length===1)out.add(m[0].join(','))});return out}
function letter(n){return n<=15?'B':n<=30?'I':n<=45?'N':n<=60?'G':'O'}
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),3500)}

// Telegram's in-app browser blocks/misbehaves with native confirm() popups in
// many client versions, so a Leave button gated behind window.confirm() can
// silently do nothing when tapped from inside Telegram. But the
// telegram-web-app.js script defines Telegram.WebApp.showConfirm on ANY page
// that includes it — including this plain website — even with no real
// Telegram app on the other end to answer it, which made Leave hang forever
// on the website instead. `initData` is only ever non-empty when genuinely
// running inside Telegram, so gate on that rather than on the method existing.
function confirmAction(message){
    return new Promise(resolve=>{
        const tg=window.Telegram?.WebApp;
        if(tg?.initData) tg.showConfirm(message, ok=>resolve(!!ok));
        else resolve(window.confirm(message));
    });
}

async function state(){try{const r=await fetch(`/api/game-state?stake=${encodeURIComponent(stake)}&username=${encodeURIComponent(username)}`,{cache:'no-store'}),d=await r.json();if(!d.success){goBack();return}room=d.room||{};cards=d.cards||[];drawn=new Set(room.drawn||[]);locked=new Set(cards.filter(c=>c.locked).map(c=>Number(c.cardNumber)));header();render();if(d.winnerPayload){ended=true;showWinner(d.winnerPayload)}}catch{}}
function header(){patternName.textContent=room.patternName||'Any One Line';playersPlaying.textContent=`Players | ${room.totalCards||0}`;calledCount.textContent=`${drawn.size} / 75`;lastNumber.textContent=room.lastNumber?`${letter(room.lastNumber)} ${room.lastNumber}`:'--';prizePool.textContent=Number(room.prizePool||0).toFixed(2);renderLastCalled()}
function renderLastCalled(){
    const el=document.getElementById('lastCalledBalls');
    if(!el)return;
    // `drawn` is built from the server's Set in draw order, so the array's
    // insertion order already matches the order numbers were called.
    const order=Array.from(drawn).slice(-5);
    el.innerHTML=order.length?order.map(n=>`<span>${letter(n)}${n}</span>`).join(''):'<span class="empty">--</span>';
}
function board(){let h='<div class="board-head">B</div><div class="board-head">I</div><div class="board-head">N</div><div class="board-head">G</div><div class="board-head">O</div>';for(let r=1;r<=15;r++)for(let c=0;c<5;c++){const n=r+c*15;h+=`<div class="ball ${drawn.has(n)?'called':''}">${n}</div>`}numberBoard.innerHTML=h}
function render(){board();cardsEl.innerHTML=cards.map(card).join('')||'<p>No cards found.</p>'}
function card(c){const close=showBlink?near(c.grid):new Set(),marks=manualMarks.get(c.cardNumber)||new Set();return `<article class="bingo"><div class="ct"><b>CARD #${c.cardNumber}</b><small>${locked.has(c.cardNumber)?'LOCKED':autoMark?'AUTO':'MANUAL'}</small></div><table><thead><tr><th>B</th><th>I</th><th>N</th><th>G</th><th>O</th></tr></thead><tbody>${c.grid.map((row,r)=>'<tr>'+row.map((v,col)=>{const free=v==='FREE'||(r===2&&col===2),n=Number(v),called=drawn.has(n),marked=free||(autoMark&&called)||(!autoMark&&marks.has(n)),bl=!called&&close.has(`${r},${col}`);return `<td class="${free?'free ':''}${marked?'marked ':''}${bl?'blink ':''}" data-card="${c.cardNumber}" data-number="${free?'':n}" onclick="manualMark(${c.cardNumber},${n||0})" ${marked && !free ? `style="background:${getHighlightColor()};color:#fff;border-color:${getHighlightColor()};"` : ''}>${free?'FREE':v}</td>`}).join('')+'</tr>').join('')}</tbody></table><button ${ended||locked.has(c.cardNumber)?'disabled':''} onclick="claim(${c.cardNumber})">${locked.has(c.cardNumber)?'CARD LOCKED':'BINGO'}</button></article>`}

// Manual mode: let the player mark ANY cell on their card, not only ones
// that have actually been called. This is purely a visual aid — the server
// independently validates every BINGO claim against the real drawn numbers,
// so letting a player freely tap cells here can never create a false win.
window.manualMark=(card,n)=>{if(autoMark||!n||locked.has(card))return;const set=manualMarks.get(card)||new Set();set.has(n)?set.delete(n):set.add(n);manualMarks.set(card,set);render()}

function claim(cardNumber){if(ended||locked.has(cardNumber))return;socket.emit('claim_bingo',{stake,username,cardNumber},res=>{if(!res?.success){if(res?.locked){locked.add(cardNumber);render()}toast(res?.message||'BINGO claim failed.')}})}

// ---- modern top-right toggles: Auto/Manual (label flips) + Blink (static label) ----
const autoMarkToggleEl=document.getElementById('autoMarkToggle');
const blinkToggleEl=document.getElementById('blinkToggle');
function syncToggleUI(){
    autoMarkToggleEl.setAttribute('aria-checked',autoMark?'true':'false');
    autoMarkToggleEl.querySelector('.switch-label').textContent=autoMark?'AUTO':'MANUAL';
    blinkToggleEl.setAttribute('aria-checked',showBlink?'true':'false');
}
autoMarkToggleEl.addEventListener('click',()=>{autoMark=!autoMark;syncToggleUI();render()});
blinkToggleEl.addEventListener('click',()=>{showBlink=!showBlink;syncToggleUI();render()});
syncToggleUI();

// ---- leave mid-game: warn (no refund), then send back to the stake list ----
async function leaveGame(){
    const ok=await confirmAction('Leaving now forfeits your stake for this round — you will NOT get a refund. Leave the game?');
    if(!ok)return;
    socket.emit('leave_room',{stake,username},res=>{
        if(!res?.success){toast(res?.message||'Could not leave the game.');return}
        localStorage.removeItem('bingoActiveGame');
        location.href='/index.html?view=rooms';
    });
}

function subscribe(){if(stake&&username)socket.emit('subscribe_room',{stake,username},()=>state())}
socket.on('connect',subscribe);socket.on('number_drawn',d=>{if(Number(d.stake)!==stake||ended)return;drawn.add(Number(d.number));room.lastNumber=Number(d.number);header();render();playNumberAudio(Number(d.number))});socket.on('room_state',d=>{if(Number(d.stake)===stake){room={...room,...d};header();}});socket.on('card_locked',d=>{if(Number(d.stake)===stake){locked.add(Number(d.cardNumber));render();toast(d.message)}});socket.on('game_won',d=>{if(Number(d.stake)===stake){ended=true;showWinner(d)}});socket.on('game_ended',d=>{if(Number(d.stake)===stake){ended=true;setTimeout(goBack,300)}});
function showWinner(d){
    if(winnerTimer)return;
    const winners=d.winners||[{winner:d.winner,winnerDisplay:d.winnerDisplay,prize:d.prize,cardNumber:d.cardNumber,grid:d.grid,winningCells:d.winningCells}];
    const iWon=winners.some(w=>w.winner===username);
    winnerTitle.textContent=iWon?'YOU WON!':'BINGO!';

    if(winners.length===1){
        const w=winners[0];
        winnerText.textContent=`${w.winnerDisplay||w.winner} won ${Number(w.prize).toFixed(2)} Birr · ${d.patternName}`;
        const set=new Set((w.winningCells||[]).map(x=>x.join(',')));
        winnerCard.innerHTML=`<div class="winner-grid">${w.grid.flatMap((row,r)=>row.map((v,c)=>`<span class="${set.has([r,c].join(','))?'win':''}">${v==='FREE'?'FREE':v}</span>`)).join('')}</div>`;
    } else {
        winnerText.textContent=`Split ${winners.length} ways · ${d.patternName}`;
        const blocks=winners.map(w=>{
            const set=new Set((w.winningCells||[]).map(x=>x.join(',')));
                        const cells=w.grid.flatMap((row,r)=>row.map((v,c)=>{
                const isFree=v==='FREE'||(r===2&&c===2);
                const isWin=set.has(`${r},${c}`);
                return `<span style="display:flex;align-items:center;justify-content:center;aspect-ratio:1;font-size:9px;border-radius:3px;background:${isWin?'#00d26a':'rgba(255,255,255,0.08)'};color:${isWin?'#04210f':'#fff'};font-weight:${isWin?'700':'400'};">${isFree?'★':v}</span>`;
            })).join('');
            return `<div style="width:110px;text-align:center;">
                <div style="font-size:11px;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${w.winnerDisplay||w.winner}</div>
                <div style="font-size:10px;opacity:.8;margin-bottom:4px;">${Number(w.prize).toFixed(2)} Birr</div>
                <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:2px;">${cells}</div>
                <div style="font-size:9px;opacity:.6;margin-top:3px;">Card #${w.cardNumber}</div>
            </div>`;
        }).join('');
        winnerCard.innerHTML=`<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;max-width:340px;margin:0 auto;">${blocks}</div>`;
    }
    winnerOverlay.classList.add('show');
    winnerTimer=setTimeout(goBack,5000);
}
function goBack(){localStorage.removeItem('bingoActiveGame');location.href=`/index.html?returnStake=${encodeURIComponent(stake)}`}

// ---- number-call audio: every player picks their own pack in Account
// Settings, so this is entirely client-side — the server just says which
// number was drawn, same as always. All 75 files for the chosen pack are
// preloaded up front (not fetched on demand) specifically so there is no
// network round trip, and therefore no lag, at the moment a number is
// actually called. ----


function ensureAudioCtx(){
    if(!audioCtx){
        const AC=window.AudioContext||window.webkitAudioContext;
        if(!AC)return null;
        audioCtx=new AC();
    }
    if(audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
    return audioCtx;
}
function unlockAudio(){
    if(audioUnlocked)return;
    const ctx=ensureAudioCtx();
    if(!ctx)return;
    try{
        const buf=ctx.createBuffer(1,1,22050);
        const src=ctx.createBufferSource();
        src.buffer=buf;
        src.connect(ctx.destination);
        src.start(0);
        audioUnlocked=true;
    }catch(e){}
}
async function preloadVoicePack(pack){
    const ctx=ensureAudioCtx();
    if(!ctx)return;
    audioBuffers={};
    const jobs=[];
    for(let n=1;n<=75;n++){
        jobs.push(fetch(`/audio/${pack}/${n}.m4a`)
            .then(r=>r.arrayBuffer())
            .then(ab=>ctx.decodeAudioData(ab.slice(0)))
            .then(buf=>{audioBuffers[n]=buf;})
            .catch(()=>{}));
    }
    await Promise.all(jobs);
}
function stopCurrentAudio(){
    if(audioCutTimer){clearTimeout(audioCutTimer);audioCutTimer=null;}
    if(currentSource){
        try{currentSource.stop(0);}catch(e){}
        try{currentSource.disconnect();}catch(e){}
        currentSource=null;
    }
}
function playNumberAudio(n){
    if(!soundEnabled)return;
    unlockAudio();
    const ctx=ensureAudioCtx();
    if(!ctx)return;
    const buf=audioBuffers[n];
    if(!buf)return;
    stopCurrentAudio();
    const src=ctx.createBufferSource();
    src.buffer=buf;
    src.connect(ctx.destination);
    currentSource=src;
    try{src.start(0);}catch(e){return;}
    const maxMs=Math.max(800,(Number(room.drawIntervalSeconds)||4)*1000-250);
    audioCutTimer=setTimeout(()=>{stopCurrentAudio();},maxMs);
    src.onended=()=>{if(currentSource===src)currentSource=null;};
}
async function loadVoicePack(){
    try{
        const r=await fetch(`/api/user-details?username=${encodeURIComponent(username)}`);
        const d=await r.json();
        if(d.success&&d.user){
            if(d.user.preferred_voice_pack) voicePack=d.user.preferred_voice_pack;
            soundEnabled=d.user.sound_enabled!==false;
            const theme=d.user.preferred_theme||localStorage.getItem('bingoTheme')||'dark';
            document.documentElement.setAttribute('data-theme',theme==='light'?'light':'dark');
        }
    }catch{}
    syncSoundToggleUI();
    unlockAudio();
    preloadVoicePack(voicePack);
    
    // Load saved color
    const savedColor = localStorage.getItem('bingoHighlightColor');
    if (savedColor) {
        selectedColor = savedColor;
        const dot = document.getElementById('currentColorDot');
        if (dot) dot.style.background = savedColor;
    }
}
['pointerdown','touchstart','click'].forEach(ev=>{
    document.addEventListener(ev,()=>unlockAudio(),{once:true,passive:true});
});

// Sound on/off is its own icon-only switch (no label, per request), and is
// saved server-side — so leaving it off carries into every future game and
// every future login, on any device, exactly like the voice pack choice.
const soundToggleEl=document.getElementById('soundToggle');
const soundToggleIconEl=document.getElementById('soundToggleIcon');
function syncSoundToggleUI(){
    soundToggleEl.setAttribute('aria-checked',soundEnabled?'true':'false');
    soundToggleIconEl.textContent=soundEnabled?'🔊':'🔇';
}
// Color Picker Functions
function toggleColorPicker() {
  const overlay = document.getElementById('colorPickerOverlay');
  if (!overlay) return;
  overlay.classList.toggle('show');
  if (overlay.classList.contains('show')) {
    renderColorOptions();
  }
}

function closeColorPicker() {
  const overlay = document.getElementById('colorPickerOverlay');
  if (overlay) overlay.classList.remove('show');
}

function renderColorOptions() {
  const grid = document.getElementById('colorGrid');
  if (!grid) return;
  
  grid.innerHTML = availableColors.map(color => `
    <div class="color-option ${color === selectedColor ? 'active' : ''}" 
         style="background:${color};" 
         onclick="selectColor('${color}')"
         title="${color}">
    </div>
  `).join('');
}

function selectColor(color) {
  selectedColor = color;
  localStorage.setItem('bingoHighlightColor', color);
  
  // Update the dot in the color picker button
  const dot = document.getElementById('currentColorDot');
  if (dot) dot.style.background = color;
  
  // Update active state in grid
  document.querySelectorAll('.color-option').forEach(el => {
    el.classList.toggle('active', el.style.background === color || el.style.backgroundColor === color);
  });
  
  // Re-render cards with new color
  render();
  
  // Close the picker
  closeColorPicker();
}

// Helper to get the current highlight color
function getHighlightColor() {
  return selectedColor;
}


soundToggleEl.addEventListener('click',()=>{
    unlockAudio();
    soundEnabled=!soundEnabled;
    syncSoundToggleUI();
    fetch('/api/user/sound-setting',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,soundEnabled})}).catch(()=>{});
});

document.addEventListener('visibilitychange',()=>{if(!document.hidden)state()});window.addEventListener('focus',state);loadVoicePack();state();