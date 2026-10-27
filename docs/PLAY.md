# CLASSIFIRE Play

Settings → Play opens the local arcade. Game text is English; the Settings entry uses the existing language catalog. Mouse and keyboard are recommended.

OVERSPRAY contains three contracts. Place protective covers before starting, hold the mouse to coat or clean, change fan width with N and inspect with I. Each contract requires a stated share of steel inside the target band before its earnings qualify for a personal best. Time, waste, cleanup and damage affect earnings. FIRELINE has three defence waves, upgrades between them and a Firestarter boss. WASD moves, the mouse aims, left click fires, Space dashes, Q throws foam, E places or repairs a nearby barricade and R activates a charged Overdrive.

Escape or Pause stops either game. Losing window focus, hiding the tab or leaving Play pauses it and clears held inputs. Returning does not resume automatically. Games returns to the selection screen and abandons the current run. Only finished-run counts and qualified personal bests are saved, under `classifire.play.v1` in browser local storage; unavailable storage falls back to the current visit.

The games make no API requests and have no access to project objects, calculators, prices, library records or saved files. They are arcade simulations with their own balancing values. All engine updates use fixed simulation steps and seeded random numbers. Each engine exposes `create`, returning `update`, `draw`, `action` and `snapshot`; FIRELINE also exposes a copied inspection state for deterministic testing. The shared host owns input, animation, pause and storage. Canvas is a fixed 960×600 logical surface scaled by CSS; coordinates are mapped using its displayed bounds.

Validation: `npm run test:play` exercises simulation and scoring; `npm run test:play-browser` uses a temporary server and database to verify native input, pause, responsive layouts, result storage and unchanged estimating state. Both are included in CI. The existing server allowlist explicitly serves the four game assets without relaxing the content security policy.
