import { useEffect, useRef, useState } from 'react';
import type { GameSprite, GameSpriteRole, GameSprites } from '../lib/game-types';
import { readGameSprite } from '../lib/game-sprites';

const roles: { role: GameSpriteRole; label: string; hint: string }[] = [
  { role: 'player', label: 'Player ship', hint: 'Point the nose upward. The sprite turns with your ship.' },
  { role: 'asteroid', label: 'Asteroids', hint: 'Used for large, medium and small rocks.' },
  { role: 'reward', label: 'Rewards', hint: 'Used for energy collectibles and prize pickups.' },
  { role: 'enemy', label: 'Enemy ships', hint: 'Used when enemy ships are enabled.' },
];
function SpritePreview({ sprite, label }: { sprite: GameSprite; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context) return;
    const image = context.createImageData(sprite.width, sprite.height), bytes = atob(sprite.pixels);
    for (let i = 0; i < bytes.length; i++) image.data[i] = bytes.charCodeAt(i);
    context.putImageData(image, 0, 0);
  }, [sprite]);
  return <canvas ref={canvas} width={sprite.width} height={sprite.height} role="img" aria-label={`${label} sprite preview`} />;
}
export function AsteroidSpriteEditor({ sprites, disabled, onChange, onBusyChange }: { sprites?: GameSprites; disabled: boolean; onChange: (value?: GameSprites) => void; onBusyChange: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), latest = useRef({ sprites, onChange, onBusyChange }); latest.current = { sprites, onChange, onBusyChange };
  useEffect(() => () => { generation.current++; latest.current.onBusyChange(false); }, []);
  async function upload(role: GameSpriteRole, file: File) {
    const current = ++generation.current; setBusy(true); setError(''); latest.current.onBusyChange(true);
    try { const sprite = await readGameSprite(file); if (generation.current === current) latest.current.onChange({ ...latest.current.sprites, [role]: sprite }); }
    catch (value) { if (generation.current === current) setError(value instanceof Error ? value.message : 'The sprite could not be read.'); }
    finally { if (generation.current === current) { setBusy(false); latest.current.onBusyChange(false); } }
  }
  function remove(role: GameSpriteRole) { const next = { ...sprites }; delete next[role]; onChange(Object.keys(next).length ? next : undefined); }
  return <section className="asteroid-sprite-editor" aria-label="Custom Asteroids sprites"><h4>Make it look like your game.</h4><p className="game-small-note">Upload PNG, JPEG or WebP images up to 2 MB. Transparent backgrounds work well. Images are resized to fit 64 × 64 pixels and saved with this game when you save the draft. Leave a slot empty to use the standard artwork.</p><fieldset disabled={disabled || busy}><div className="asteroid-sprite-grid">{roles.map(({ role, label, hint }) => <div className="asteroid-sprite-slot" key={role}><label>{label}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(role, file); }} /></label><small>{hint}</small>{sprites?.[role] && <div className="asteroid-sprite-preview"><SpritePreview sprite={sprites[role]!} label={label}/><button type="button" className="text-button" onClick={() => remove(role)}>Use standard {label.toLowerCase()}</button></div>}</div>)}</div></fieldset>{busy && <p role="status">Preparing sprite…</p>}{error && <p role="alert" className="error">{error}</p>}</section>;
}
