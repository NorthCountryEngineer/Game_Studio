import type { ArcadeGameSpec, GameAsteroidEnemies } from '../lib/game-types';
import { defaultAsteroidSettings, updateAsteroidEnemies, updateAsteroidSettings } from '../lib/game-design';

const enemyStyles: { value: GameAsteroidEnemies['difficulty']; label: string; description: string }[] = [
  { value: 'easy', label: 'Easy · wandering', description: 'Enemy ships wander through the field.' },
  { value: 'medium', label: 'Medium · gentle tracking', description: 'Enemy ships gradually track your ship.' },
  { value: 'hard', label: 'Hard · pursuit and fire', description: 'Enemy ships pursue your ship, aim, and fire.' },
];

export function AsteroidChallengeEditor({ spec, change }: { spec: ArcadeGameSpec; change: (next: ArcadeGameSpec) => void }) {
  if (spec.genre !== 'dodge' || !spec.arcade?.shooting) return null;
  const settings = spec.version === 6 ? spec.asteroids! : defaultAsteroidSettings();
  return <div className="game-asteroid-challenge">
    <h5>Survival and enemy ships</h5>
    <label className="game-checkbox"><input type="checkbox" checked={settings.endless} disabled={Boolean(spec.flow)} onChange={event => change(updateAsteroidSettings(spec, { endless: event.target.checked }))} />Endless survival</label>
    {spec.flow && <p className="game-small-note">This game has a custom level flow. Use “Use levels only” in the flow editor before switching to continuous play.</p>}
    <p className="game-small-note">Survive as long as you can, with no timer or collection goal. The challenge increases during active play. Your first saved level starts the run; the rest of your level plan stays saved for when you turn endless survival off.</p>
    {settings.endless && <label>Increase difficulty every · {settings.difficultyInterval} seconds of active play<input type="range" min={10} max={120} step={1} value={settings.difficultyInterval} aria-valuetext={`${settings.difficultyInterval} seconds of active play`} onChange={event => change(updateAsteroidSettings(spec, { difficultyInterval: Number(event.target.value) }))} /><small>10–120 seconds</small></label>}
    <label>Asteroid sizes<select value={settings.sizes} disabled={!spec.arcade.splitAsteroids} onChange={event => change(updateAsteroidSettings(spec, { sizes: Number(event.target.value) as 2 | 3 }))}><option value={2}>Two sizes · large → small</option><option value={3}>Three sizes · large → medium → small</option></select></label>
    <p className="game-small-note">Each stage takes one shot. Large rocks split into smaller rocks until the smallest pieces are destroyed. Enable asteroid splitting above to choose the stages.</p>
    <label className="game-checkbox"><input type="checkbox" checked={settings.enemies.enabled} onChange={event => change(updateAsteroidEnemies(spec, { enabled: event.target.checked }))} />Add enemy ships</label>
    {settings.enemies.enabled && <>
      <label>Enemy behavior<select value={settings.enemies.difficulty} onChange={event => change(updateAsteroidEnemies(spec, { difficulty: event.target.value as GameAsteroidEnemies['difficulty'] }))}>{enemyStyles.map(style => <option key={style.value} value={style.value}>{style.label}</option>)}</select></label>
      <p className="game-small-note">{enemyStyles.find(style => style.value === settings.enemies.difficulty)!.description}</p>
      <div className="game-field-pair"><label>Shots to defeat an enemy<select value={settings.enemies.hitPoints} onChange={event => change(updateAsteroidEnemies(spec, { hitPoints: Number(event.target.value) }))}>{Array.from({ length: 10 }, (_, index) => index + 1).map(hits => <option key={hits} value={hits}>{hits} {hits === 1 ? 'shot' : 'shots'}</option>)}</select></label><label>Enemy ships at once<select value={settings.enemies.maxShips} onChange={event => change(updateAsteroidEnemies(spec, { maxShips: Number(event.target.value) }))}>{Array.from({ length: 6 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}</select></label></div>
      <label>Send an enemy every · {settings.enemies.spawnInterval} seconds<input type="range" min={5} max={60} step={1} value={settings.enemies.spawnInterval} aria-valuetext={`${settings.enemies.spawnInterval} seconds`} onChange={event => change(updateAsteroidEnemies(spec, { spawnInterval: Number(event.target.value) }))} /><small>5–60 seconds</small></label>
    </>}
    {spec.arcade.scoring && <p className="game-small-note">Points per hit: large rock 20{settings.sizes === 3 ? ', medium rock 30' : ''}, small rock 50. Defeated enemy ships: easy 100, medium 200, hard 300. Each collectible gives 10 points.</p>}
    <p className="game-small-note">Save these choices, playtest the saved version, then publish when you are ready.</p>
  </div>;
}
