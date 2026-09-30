export const PATH = [
  { x: -30, y: 330 }, { x: 120, y: 330 }, { x: 120, y: 150 },
  { x: 340, y: 150 }, { x: 340, y: 430 }, { x: 570, y: 430 },
  { x: 570, y: 230 }, { x: 830, y: 230 }
];

export const TOWER_TYPES = {
  scout: { name: 'Scout', cost: 45, range: 120, damage: 11, cooldown: .55, color: '#5eead4' },
  cannon: { name: 'Cannon', cost: 75, range: 105, damage: 28, cooldown: 1.25, color: '#fb7185' }
};

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const segmentDistance = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x-a.x)*dx + (p.y-a.y)*dy) / (dx*dx + dy*dy)));
  return Math.hypot(p.x-(a.x+t*dx), p.y-(a.y+t*dy));
};

export class Game {
  constructor(options = {}) {
    this.finalWave = options.finalWave || 5;
    this.reset();
  }

  reset() {
    this.money = 160; this.lives = 12; this.wave = 0; this.score = 0;
    this.towers = []; this.enemies = []; this.shots = [];
    this.running = false; this.paused = false; this.outcome = null;
    this.spawnLeft = 0; this.spawnTimer = 0; this.nextTowerId = 1; this.nextEnemyId = 1;
  }

  canPlace(x, y) {
    const point = {x, y};
    if (x < 28 || x > 772 || y < 28 || y > 532) return false;
    if (this.towers.some(t => distance(point, t) < 54)) return false;
    return !PATH.slice(0, -1).some((a, i) => segmentDistance(point, a, PATH[i+1]) < 46);
  }

  placeTower(type, x, y) {
    const spec = TOWER_TYPES[type];
    if (!spec || this.outcome || this.money < spec.cost || !this.canPlace(x, y)) return false;
    this.money -= spec.cost;
    this.towers.push({ id: this.nextTowerId++, type, x, y, level: 1, cooldown: 0 });
    return true;
  }

  upgradeTower(id) {
    const tower = this.towers.find(t => t.id === id);
    if (!tower || tower.level >= 3 || this.outcome) return false;
    const cost = this.upgradeCost(tower);
    if (this.money < cost) return false;
    this.money -= cost; tower.level++; return true;
  }

  upgradeCost(tower) { return 35 + tower.level * 25; }

  startWave() {
    if (this.outcome || this.running || this.wave >= this.finalWave) return false;
    this.wave++; this.running = true; this.spawnLeft = 4 + this.wave * 2; this.spawnTimer = 0;
    return true;
  }

  spawnEnemy() {
    const hp = 38 + this.wave * 20;
    this.enemies.push({ id: this.nextEnemyId++, x: PATH[0].x, y: PATH[0].y, pathIndex: 1,
      hp, maxHp: hp, speed: 48 + this.wave * 3, reward: 9 + this.wave * 2 });
  }

  update(dt) {
    if (this.paused || this.outcome) return;
    dt = Math.min(dt, .05);
    if (this.running && this.spawnLeft > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) { this.spawnEnemy(); this.spawnLeft--; this.spawnTimer = .72; }
    }
    for (const e of [...this.enemies]) this.moveEnemy(e, dt);
    for (const tower of this.towers) {
      tower.cooldown -= dt;
      const spec = TOWER_TYPES[tower.type];
      const range = spec.range + (tower.level - 1) * 14;
      const target = this.enemies.filter(e => distance(tower, e) <= range)
        .sort((a,b) => b.pathIndex - a.pathIndex || distance(b, PATH[b.pathIndex])-distance(a, PATH[a.pathIndex]))[0];
      if (target && tower.cooldown <= 0) {
        const damage = spec.damage * (1 + (tower.level - 1) * .55);
        target.hp -= damage; tower.cooldown = spec.cooldown * Math.pow(.88, tower.level - 1);
        this.shots.push({x1:tower.x,y1:tower.y,x2:target.x,y2:target.y,life:.1,color:spec.color});
        if (target.hp <= 0 && this.enemies.includes(target)) {
          this.enemies.splice(this.enemies.indexOf(target), 1); this.money += target.reward; this.score += target.reward * 10;
        }
      }
    }
    this.shots.forEach(s => s.life -= dt); this.shots = this.shots.filter(s => s.life > 0);
    if (this.running && this.spawnLeft === 0 && this.enemies.length === 0) {
      this.running = false;
      if (this.wave === this.finalWave) this.outcome = 'victory';
    }
  }

  moveEnemy(e, dt) {
    const target = PATH[e.pathIndex];
    const d = distance(e, target), step = e.speed * dt;
    if (step >= d) {
      e.x = target.x; e.y = target.y; e.pathIndex++;
      if (e.pathIndex >= PATH.length) {
        this.enemies.splice(this.enemies.indexOf(e), 1); this.lives--;
        if (this.lives <= 0) { this.lives = 0; this.outcome = 'defeat'; this.running = false; }
      }
    } else { e.x += (target.x-e.x)/d*step; e.y += (target.y-e.y)/d*step; }
  }
}
