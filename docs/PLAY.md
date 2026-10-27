# CLASSIFIRE Play

Settings → Play opens FIRELINE. Game text is English; the Settings entry uses the existing language catalog. Mouse and keyboard are recommended. OVERSPRAY has been removed from the menu, packaged scripts, server routes and test suite.

## FIRELINE: Pink Foam Incident

Three escalating defence waves run for 45, 50 and 55 seconds of spawning, followed by clearing remaining enemies and choosing an upgrade. A full-body animated CLASSIFIRE operative faces humanoid Matchstick Mobs, scarfed Breach Runners and expressive hovering Ember Drones. The shorter opening, earlier enemies, hit flashes, six-second kill streaks and recovery on kills keep the action moving. Upgrades specialise in crowd control, pressure recovery or defence.

The Pink Foam Monster is a giant animated ball of pink bubbles. He warns before firing a spreading pink volley, then deflates and takes full damage while recovering. At half health he becomes enraged and fires wider volleys. Arcing barrages target all four penetrations after a visible countdown, destroy their existing barricades and clog them with pink foam. E cannot barricade or repair a clogged penetration and does not spend supplies. Spray the plug away (or use cyan suppression foam) and barricade again. Pink floor patches slow and injure the player, can be cleared, and fade after 15 seconds. Projectiles stop at the building and cyan foam zones. Overlapping projectile hits have a short damage cooldown.

Controls: WASD moves, mouse aims, hold left click to fire or clear pink foam, Space dashes, Q throws cyan suppression foam, E places or repairs a nearby barricade and R activates a charged Overdrive. Hit marked targets while avoiding warning areas; release fire to recharge pressure. Building integrity and player health must both stay above zero. Only a completed victory qualifies for a personal best.

Escape or Pause stops the game. Losing window focus, hiding the tab or leaving Play pauses it and clears held inputs. Returning does not resume automatically. Lobby abandons the current run. Finished-run counts and qualified personal bests are saved under `classifire.play.v2` in browser local storage; unavailable storage falls back to the current visit. Previous `classifire.play.v1` scores remain untouched and do not compete against the changed balance.

The game makes no API requests and has no access to project objects, calculators, prices, library records or saved files. It is an arcade simulation with its own balancing values. Updates use fixed simulation steps and seeded random numbers. The engine exposes `create`, returning `update`, `draw`, `action`, `snapshot` and a read-only copied `inspect` state for deterministic testing. The host owns input, animation, pause and storage. Canvas is a fixed 960×600 logical surface scaled by CSS; coordinates use its displayed bounds. The separate character renderer reads state without changing it and also draws the lobby portraits.

## Change classification and validation

Additive optional entertainment UI and game balancing; no calculation, pricing, library, project or export rules changed. No migrations, credentials or external services. The server replaces the removed game's allowlisted path with the new character-renderer path; content security policy is unchanged.

`npm run test:play` exercises mechanics, full input-driven runs and score handling. `npm run test:play-browser` uses a temporary server and database to verify native controls, pause, responsive layouts, scoring and unchanged estimating state. Both run in CI. Character rendering is additionally checked in native Chromium.
