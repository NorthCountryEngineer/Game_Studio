import { isEndlessAsteroids, type ArcadeGameSpec, type GamePowerUpType, type GameSpec } from '../lib/game-types';
import { setPowerUpsEnabled, setPowerUpType, updatePowerUps } from '../lib/game-multiplayer-design';

export const asteroidPrizeChoices: { type: GamePowerUpType; name: string; description: string }[] = [
  { type: 'triple-shot', name: 'Triple shot', description: 'Fire three rounds in a spread instead of one.' },
  { type: 'rapid-fire', name: 'Rapid fire', description: 'Hold Shoot for a faster, continuous stream of rounds.' },
  { type: 'shield', name: 'Shield', description: 'Absorb one extra hit. Stays until hit or the level restarts.' },
  { type: 'speed-boost', name: 'Speed boost', description: 'Fly 1.6 times faster while the boost is active.' },
];

export function AsteroidPrizeGuide({ spec }: { spec: GameSpec }) {
  if ((spec.version !== 5 && spec.version !== 6) || !spec.powerUps) return null;
  const endless = isEndlessAsteroids(spec);
  return <div className="game-prize-guide"><strong>Collect prizes for a boost.</strong><p>A prize appears every {spec.powerUps.spawnInterval} seconds. Fly over it to collect it for your ship. {endless ? 'Boosts stay active until your ship takes a hit. Any damaging hit clears every boost; a shield absorbs that hit and clears the other boosts too.' : <>Timed effects last {spec.powerUps.duration} seconds and can be combined; collecting the same prize refreshes its timer.</>}</p><ul>{asteroidPrizeChoices.filter(prize => spec.powerUps!.types.includes(prize.type)).map(prize => <li key={prize.type}><strong>{prize.name}:</strong> {prize.description}</li>)}</ul></div>;
}

export function AsteroidPrizeEditor({ spec, change }: { spec: ArcadeGameSpec; change: (next: ArcadeGameSpec) => void }) {
  if (spec.genre !== 'dodge' || !spec.arcade?.shooting) return null;
  const prizes = spec.version === 5 || spec.version === 6 ? spec.powerUps : undefined, endless = isEndlessAsteroids(spec);
  return <div className="game-prize-options">
    <h5>Periodic prizes</h5>
    <label className="game-checkbox"><input type="checkbox" checked={Boolean(prizes)} onChange={event => change(setPowerUpsEnabled(spec, event.target.checked))} />Drop prizes during the game</label>
    <p className="game-small-note">Fly over a prize to collect it. In two-player games, only the ship that collects it receives the effect. {endless ? 'Boosts combine and remain active until a hit. Any damaging hit clears all boosts; a shield absorbs one hit and clears them too.' : 'Recollecting a timed prize refreshes its timer; effects can be combined.'}</p>
    {prizes && <>
      <div className="game-prize-choices" role="group" aria-label="Prizes that may appear">
        {asteroidPrizeChoices.map(prize => <label className="game-checkbox" key={prize.type}><input type="checkbox" checked={prizes.types.includes(prize.type)} disabled={prizes.types.length === 1 && prizes.types.includes(prize.type)} onChange={event => change(setPowerUpType(spec, prize.type, event.target.checked))} /><span><strong>{prize.name}</strong><small>{prize.description}</small></span></label>)}
      </div>
      <div className="game-field-pair">
        <label>Drop a prize every<select value={prizes.spawnInterval} onChange={event => change(updatePowerUps(spec, { spawnInterval: Number(event.target.value) }))}>{Array.from({ length: 56 }, (_, index) => index + 5).map(seconds => <option value={seconds} key={seconds}>{seconds} seconds</option>)}</select></label>
        {!endless && <label>Timed effects last<select value={prizes.duration} onChange={event => change(updatePowerUps(spec, { duration: Number(event.target.value) }))}>{Array.from({ length: 28 }, (_, index) => index + 3).map(seconds => <option value={seconds} key={seconds}>{seconds} seconds</option>)}</select></label>}
      </div>
      <p className="game-small-note">Choose at least one prize. {endless ? 'Endless survival ignores the saved duration; turning endless survival off restores that timing.' : 'Triple shot, rapid fire and speed boost use the duration above. Shield absorbs one hit and does not expire with that timer.'} Save, playtest and publish to change a live game.</p>
    </>}
  </div>;
}
