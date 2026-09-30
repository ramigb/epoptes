import assert from 'node:assert/strict';
import { Game, PATH } from './game.js';

const run = (game, seconds, step=.04) => { for (let t=0;t<seconds;t+=step) game.update(step); };

// Placement is legal only off-path, and costs are enforced.
const g = new Game({finalWave: 2});
assert.equal(g.canPlace(120, 330), false, 'road blocks placement');
assert.equal(g.placeTower('scout', 230, 70), true);
assert.equal(g.money, 115, 'placement deducts cost');
assert.equal(g.placeTower('scout', 240, 75), false, 'tower spacing enforced');
g.money = 0;
assert.equal(g.placeTower('cannon', 470, 80), false, 'insufficient funds rejected');

// Upgrades deduct currency, improve level, and cap at level 3.
g.money = 500; const tower = g.towers[0];
assert.equal(g.upgradeTower(tower.id), true); assert.equal(tower.level, 2); assert.equal(g.money, 440);
assert.equal(g.upgradeTower(tower.id), true); assert.equal(tower.level, 3);
assert.equal(g.upgradeTower(tower.id), false, 'upgrade cap enforced');

// A wave spawns enemies and a tower attack grants reward for a kill.
assert.equal(g.startWave(), true); g.update(.04);
assert.ok(g.enemies.length > 0, 'enemy spawned');
const victim = g.enemies[0]; victim.x=tower.x+5; victim.y=tower.y; victim.hp=1;
const beforeReward=g.money; g.update(.04);
assert.ok(!g.enemies.includes(victim)); assert.ok(g.money>beforeReward, 'kill rewards currency');
assert.equal(g.startWave(), false, 'overlapping wave rejected');

// Escaping enemies cost lives, defeat freezes the run.
const loss = new Game(); loss.lives=1; loss.enemies.push({id:1,x:PATH.at(-1).x-1,y:PATH.at(-1).y,pathIndex:PATH.length-1,hp:10,maxHp:10,speed:100,reward:1});
loss.update(.04); assert.equal(loss.lives,0); assert.equal(loss.outcome,'defeat');

// Completing the final wave produces victory.
const win = new Game({finalWave:1}); win.startWave(); win.spawnLeft=0; win.enemies=[]; win.update(.04);
assert.equal(win.outcome,'victory'); assert.equal(win.startWave(),false);

// Pause prevents simulation, and restart restores every important field.
const paused = new Game(); paused.startWave(); paused.paused=true; paused.update(.04); assert.equal(paused.enemies.length,0);
paused.reset(); assert.deepEqual({money:paused.money,lives:paused.lives,wave:paused.wave,towers:paused.towers.length,outcome:paused.outcome},{money:160,lives:12,wave:0,towers:0,outcome:null});

console.log('PASS: placement, costs, upgrades, spawning, attacks, rewards, lives, pause, victory, defeat, restart');
