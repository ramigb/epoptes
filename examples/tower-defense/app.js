import { Game, PATH, TOWER_TYPES } from './game.js';

const game = new Game(), canvas = document.querySelector('#game'), ctx = canvas.getContext('2d');
const $ = s => document.querySelector(s); let buildType = 'scout', selectedId = null, hover = null, last = performance.now(), speed = 1;

function notify(text){ const el=$('#toast'); el.textContent=text; el.classList.add('show'); clearTimeout(notify.t); notify.t=setTimeout(()=>el.classList.remove('show'),1400); }
function updateUI(){
  $('#money').textContent=game.money; $('#lives').textContent=game.lives; $('#wave').textContent=`${game.wave} / ${game.finalWave}`; $('#score').textContent=String(game.score).padStart(4,'0');
  const wb=$('#waveBtn'); wb.disabled=game.running||!!game.outcome; wb.textContent=game.wave===game.finalWave?'All waves launched':`Start wave ${game.wave+1}`;
  $('#pauseBtn').textContent=game.paused?'Resume':'Pause'; $('#status').textContent=game.paused?'Defense paused':game.running?`${game.spawnLeft+game.enemies.length} hostiles remaining`:'Build your defense';
  const t=game.towers.find(t=>t.id===selectedId), panel=$('#selection');
  if(t){ const spec=TOWER_TYPES[t.type], cost=game.upgradeCost(t); panel.querySelector('p:nth-child(2)').innerHTML=`<b>${spec.name} · Level ${t.level}</b><br>Damage ${Math.round(spec.damage*(1+(t.level-1)*.55))} · Range ${spec.range+(t.level-1)*14}`; $('#upgrade').disabled=t.level>=3||game.money<cost; $('#upgrade').textContent=t.level>=3?'Max level':`Upgrade · ${cost}`; }
  else { panel.querySelector('p:nth-child(2)').textContent='Click a tower to inspect and upgrade it.'; $('#upgrade').disabled=true; $('#upgrade').textContent='Upgrade'; }
  if(game.outcome && $('#modal').hidden){ $('#modal').hidden=false; const win=game.outcome==='victory'; $('#modalTag').textContent=win?'SECTOR SECURED':'CORE BREACHED'; $('#modalTitle').textContent=win?'Victory!':'Defeat'; $('#modalText').textContent=win?`All waves stopped. Final score: ${game.score}.`:`You reached wave ${game.wave}. Rebuild and try again.`; }
}
function draw(){
  ctx.fillStyle='#081423';ctx.fillRect(0,0,800,560);
  ctx.strokeStyle='#10263a';ctx.lineWidth=1;for(let x=0;x<800;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,560);ctx.stroke()}for(let y=0;y<560;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(800,y);ctx.stroke()}
  ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#25384f';ctx.lineWidth=70;ctx.beginPath();PATH.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.strokeStyle='#41536a';ctx.lineWidth=3;ctx.setLineDash([10,14]);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#5eead422';ctx.fillRect(740,180,60,100);ctx.strokeStyle='#5eead4';ctx.strokeRect(747,188,52,84);ctx.fillStyle='#5eead4';ctx.font='bold 10px system-ui';ctx.fillText('CORE',758,218);
  if(hover&&!game.outcome){const spec=TOWER_TYPES[buildType];ctx.beginPath();ctx.arc(hover.x,hover.y,spec.range,0,7);ctx.fillStyle=game.canPlace(hover.x,hover.y)?'#5eead418':'#fb71851a';ctx.fill();ctx.strokeStyle=game.canPlace(hover.x,hover.y)?'#5eead488':'#fb718588';ctx.lineWidth=1;ctx.stroke()}
  for(const t of game.towers){const spec=TOWER_TYPES[t.type];if(t.id===selectedId){ctx.beginPath();ctx.arc(t.x,t.y,spec.range+(t.level-1)*14,0,7);ctx.fillStyle='#5eead40c';ctx.fill();ctx.strokeStyle='#5eead455';ctx.stroke()}ctx.beginPath();ctx.arc(t.x,t.y,20,0,7);ctx.fillStyle='#091522';ctx.fill();ctx.lineWidth=5;ctx.strokeStyle=spec.color;ctx.stroke();ctx.fillStyle=spec.color;ctx.fillRect(t.x-4,t.y-18,8,20);ctx.fillStyle='#06101b';ctx.font='bold 10px system-ui';ctx.fillText(t.level,t.x-3,t.y+4)}
  for(const e of game.enemies){ctx.beginPath();ctx.arc(e.x,e.y,13,0,7);ctx.fillStyle='#f7a8b8';ctx.fill();ctx.strokeStyle='#fb7185';ctx.lineWidth=3;ctx.stroke();ctx.fillStyle='#06101b';ctx.fillRect(e.x-15,e.y-23,30,5);ctx.fillStyle='#34d399';ctx.fillRect(e.x-15,e.y-23,30*Math.max(0,e.hp/e.maxHp),5)}
  for(const s of game.shots){ctx.strokeStyle=s.color;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(s.x1,s.y1);ctx.lineTo(s.x2,s.y2);ctx.stroke()}
}
function reset(){game.reset();selectedId=null;$('#modal').hidden=true;updateUI();notify('Fresh sector ready');}
document.querySelectorAll('.tower').forEach(b=>b.addEventListener('click',()=>{buildType=b.dataset.type;document.querySelectorAll('.tower').forEach(x=>x.classList.toggle('active',x===b));notify(`${TOWER_TYPES[buildType].name} selected`)}));
canvas.addEventListener('mousemove',e=>{const r=canvas.getBoundingClientRect();hover={x:(e.clientX-r.left)*800/r.width,y:(e.clientY-r.top)*560/r.height}});canvas.addEventListener('mouseleave',()=>hover=null);
canvas.addEventListener('click',e=>{const r=canvas.getBoundingClientRect(),p={x:(e.clientX-r.left)*800/r.width,y:(e.clientY-r.top)*560/r.height};const t=game.towers.find(t=>Math.hypot(t.x-p.x,t.y-p.y)<25);if(t){selectedId=t.id;notify(`${TOWER_TYPES[t.type].name} selected`)}else if(game.placeTower(buildType,p.x,p.y)){selectedId=game.towers.at(-1).id;notify('Tower online')}else notify(game.money<TOWER_TYPES[buildType].cost?'Not enough energy':'Build on open ground');updateUI()});
$('#waveBtn').onclick=()=>{if(game.startWave())notify(`Wave ${game.wave} incoming!`);updateUI()};$('#pauseBtn').onclick=()=>{if(!game.outcome){game.paused=!game.paused;updateUI()}};$('#restartBtn').onclick=reset;$('#playAgain').onclick=reset;$('#upgrade').onclick=()=>{if(game.upgradeTower(selectedId))notify('Tower upgraded');updateUI()};
addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();$('#waveBtn').click()}if(e.key.toLowerCase()==='p')$('#pauseBtn').click()});
function frame(now){const dt=(now-last)/1000;last=now;game.update(dt*speed);draw();updateUI();requestAnimationFrame(frame)}requestAnimationFrame(frame);
window.game=game; window.gameUI={reset,updateUI};
if(new URLSearchParams(location.search).has('test')) setTimeout(()=>{try{const start=game.money,r=canvas.getBoundingClientRect();canvas.dispatchEvent(new MouseEvent('click',{clientX:r.left+250*r.width/800,clientY:r.top+80*r.height/560,bubbles:true}));if(game.towers.length!==1||game.money>=start)throw Error('placement control');$('#waveBtn').click();if(!game.running)throw Error('wave control');$('#pauseBtn').click();if(!game.paused)throw Error('pause control');$('#pauseBtn').click();$('#restartBtn').click();if(game.wave!==0||game.towers.length)throw Error('restart control');$('#test-result').textContent='PASS'}catch(e){$('#test-result').textContent='FAIL: '+e.message}},250);
