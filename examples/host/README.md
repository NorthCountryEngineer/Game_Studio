# Local two-origin integration demonstration

This is a synthetic host, not a modification of NCAcademy or Axolotl. No AWS, model calls or accounts are needed.

From the Game Studio repository root:

```sh
cp game-studio-config.example.json game-studio-config.json
python3 - <<'PY'
import json
from pathlib import Path
p=Path('game-studio-config.json')
c=json.loads(p.read_text())
c['hosts']=[{'id':'local-school','name':'Local lesson demo','origin':'http://127.0.0.1:5181','returnPath':'/'}]
p.write_text(json.dumps(c,indent=2)+'\n')
PY
npm ci --no-audit --no-fund
npm run build:sdk
npm run dev
```

In a second terminal, from the same repository:

```sh
python3 -m http.server 5181 --bind 127.0.0.1 --directory examples/host
```

1. Open `http://127.0.0.1:5180/game-studio` and create a one-level game.
2. Save, complete a playtest, mark it reviewed and publish it.
3. Open its public game and copy the UUID at the end of `/games/UUID`.
4. Open `http://127.0.0.1:5181`, paste the UUID and choose **Load lesson game**.
5. Verify the embedded game shows your branding and a ready event appears in **Host event**. Finish a round to receive a validated completion event.
6. Choose the creator link. It opens the standalone creator in another tab and shows **Return to Local lesson demo**. Creation is not embedded.
7. From Game Studio, pause creation. The published embedded game should still play. Unpublish the synthetic game when finished; the embed will become unavailable after reload.

Before unpublishing, use the embedded player's fullscreen button or press F while the arcade canvas has focus. Confirm the game fills the screen, its Exit button remains available, and Escape returns to the lesson without restarting play. The SDK sets fullscreen permission for the exact studio origin. Also test letter entry in a word-game field: typing F should enter the letter rather than expand the player. Native fullscreen availability depends on the browser; the player can still expand inside its host frame.

Production hosts replace the two localhost origins, configure the matching exact host ID/origin/return path in the installation, and integrate the common SDK with their own page lifecycle. Production hosting headers allow HTTPS hosts only. No wildcard framing, host token forwarding or tenant query parameter is needed.
