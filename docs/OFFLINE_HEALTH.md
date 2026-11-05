# Offline health game for Mac

The separate `codex/health-offline-mac` branch includes a ready-to-run copy of the shared-screen **10th Grade Health: Drugs & Decision-Making** board. The package works from a local HTML file in Safari or Firefox on Intel and Apple silicon Macs. It needs no installer, terminal, local server, Node, Python, Docker, Kubernetes, account or service connection.

## Open the game

Download the release ZIP while connected, or download this branch's repository ZIP. Extract the archive on the Mac. Open [Drugs-and-Decision-Making.html](../offline/mac/Drugs-and-Decision-Making.html) in `offline/mac/`; the dedicated release ZIP places that file directly in its game folder. Double-click the HTML file. If macOS opens it as text, Control-click it and choose **Open With → Safari** or **Firefox**.

Click **Use Gracie's Questions** to add the reviewed 19-question bank. File upload and manual question entry remain available. Set up four teams, choose the first team, and use **Full screen** for projection. Every required image, style, script, piece and template is inside the HTML file. Copying just that file to another Mac is sufficient to open the game without a connection.

## Carry a game between computers

Use **Save game backup** before closing or moving to another Mac. Keep the downloaded JSON file. On the destination Mac, open the HTML game, choose **Restore game backup**, review the parsed summary, then click **Restore this game**. This carries the question bank, source metadata, teams, scores, committed dice and board progress.

Browser storage for local files can differ. Moving or renaming the HTML file, switching browsers, private browsing or clearing browser data may not retain a browser save. The explicit backup file is the portable copy. Keep private custom questions and backups on devices you control.

For the browser behavior behind this requirement, see [MDN localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage), which documents file-origin differences and possible storage access errors.

The adjacent `gracies-questions.txt` and `gracies-questions.json` contain the same questions. They can be edited in an ordinary text editor and imported without Word. Upload one format rather than both. The prepared-bank button skips exact existing copies; ordinary file import appends the reviewed batch.

## Source references

Question text, correct answers, explanations, source addresses and APA-style citations remain available offline. The **Read source (requires internet)** links are optional. They contact the original publisher only when opened in a connected browser. The game makes no automatic connection to those publishers or any service.

Only this health board is packaged. Online Game Studio accounts, administration, multiplayer rooms, leaderboards and AI services are outside the offline copy.

## Rebuild in a development checkout

With the repository's existing development dependencies available, run:

```sh
npm run build:offline-health
```

This developer command writes the tracked ready-to-run files under `offline/mac/` and a dedicated `dist/offline-health/Gracies-Health-Game-Mac.zip` with a `ZIP_SHA256.txt` receipt. Players do not run the command or install its build tools.

The builder mounts `QuestionQuest` through `src/offline-health.tsx`. It does not import App, Core configuration, authentication, APIs, multiplayer or provider modules. It reads only its explicit local source, package, license and asset inputs; deployment configuration and environment files are excluded. The build rejects unexpected dependencies, dynamic imports, network APIs, remote CSS and active/remote SVG content.

The HTML uses one bundled IIFE, embedded styles and data URLs. Its content security policy permits only the exact inline script hash, blocks network connections and external executable resources, and permits local images and inline style attributes used by the board. No service worker or cached website is needed. Source links and local backup/download anchors remain explicit user actions.

`offline/mac/MANIFEST.json` records a source fingerprint over sorted exact input-file hashes and the bundler version, plus hashes for the HTML and accompanying files. It deliberately excludes current timestamps and Git HEAD from generated content to avoid commit self-reference. ZIP entries use a fixed date and deterministic stored records. Rebuilding the same inputs produces the same HTML, manifest and ZIP bytes. The manifest does not hash itself; the separate ZIP receipt covers the complete archive.

This branch's CI rebuilds the package and requires `git diff --exit-code -- offline/mac` to pass, so the checked-in ready copy stays tied to its source. Packaging checks also reject altered script hashes, relaxed connection policies, external resources, changed embedded assets, deployment-module imports and stale source fingerprints.

The package includes the notices for React, React DOM, Scheduler and the esbuild build tool. The supplied school logo and original artwork are retained unchanged. See [third-party notices](../offline/mac/THIRD-PARTY-NOTICES.txt).
