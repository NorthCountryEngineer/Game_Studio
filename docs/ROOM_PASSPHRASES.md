# Join a game with a passphrase

Online Mafia, the five other party games, and supported two-player arcade games accept a host-selected passphrase. Players do not need an account or a room link.

## Host a room

Open the game's page, choose **Create a room**, enter your name/avatar where applicable, and set the optional passphrase before creating the private room. Arcade hosts can choose cooperative or versus settings first. A phrase has 6–48 characters and uses letters, numbers, spaces or hyphens. Capitalization and extra spaces do not matter: `Purple   Comet` and `purple comet` refer to the same phrase.

Tell your group the game's name/page and the phrase. The phrase is scoped to that particular game, so another game may use the same phrase. Two active rooms for the same game cannot claim the same phrase; choose a different phrase when it is already in use. Private invitation links remain available as an alternative. Anyone with the phrase or invitation can join an available seat.

## Join a room

Open that game's normal landing page. For a party game, select **Join with passphrase**, enter the phrase and choose your own name/avatar. On an arcade page, enter it under **Join with a passphrase**. No room ID or invitation URL is required. The host sees the new player and starts normally. The phrase never grants host/narrator authority or access to another player's private information.

Party games admit new players only in the lobby; normal room and seat limits still apply. Arcade rooms admit one guest, whether they use the phrase or invitation. Arcade public open seats remain a separate choice: clear the optional phrase to offer a public seat. The exact published game edition and room match settings must still agree.

Closing or expiring a room releases its phrase for a new room. A party rematch keeps the existing room, group and phrase. Entering a wrong phrase, a phrase for another game, or a room that cannot accept a new player returns bounded help. Wait when the service reports too many attempts.

## Privacy and storage

Passphrases travel in anonymous HTTPS request bodies, not URLs, public lobby entries, game snapshots, chat, role projections or provider prompts. The service stores scoped SHA-256 digests, never plaintext phrases. Phrase lookup and admission are conditional with the existing room/index operations. Guest admission through a phrase competes for the same seats as invitations; it cannot bypass phases, publication checks or capacity.

The phrase is handled only in the current page's memory and is never saved in browser storage. Party forms clear it after admission, so remember the phrase you chose; the service cannot retrieve it. Party pages retain the existing seat credentials after successful admission. An uncertain phrase admission keeps the same in-memory request identity: keep that tab open and use **Retry the same request**. This confirms the original room and seat. After five minutes, the form requires an explicit start over. Server receipts are retained for at least two hours. Existing rooms created without a phrase continue to accept their original invitations.

Lookup attempts have bounded per-source and installation limits in existing storage. No model calls, new infrastructure, saved-game migration, authentication change or SDK protocol change is needed. Local tests and browser rehearsals do not establish production deployment; publication remains a separately authorized release.
