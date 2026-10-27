# Intent

This file explains **why** the project exists and **how to make judgment calls** when the other docs don't cover something. Read it first. When a spec and this file seem to disagree, the spec wins on details and this file wins on direction; flag the conflict.

## What we are building

A web platform where board games live, get played and get made.

- **A game center.** The platform manages users, matches, assets and data. Games are not hard-coded into it: they are **registered dynamically** as packages built with our SDK, and anyone with access can play them together in the browser.
- **An SDK.** Developers and designers build games against a small set of capabilities: rules, components, randomness, hidden information, turn structure. The platform supplies everything else: rendering, networking, accounts, storage and replays.
- **A shared resource library.** Common components (cards, dice, tokens, boards, meeples, tables, materials) are shared and reused across games instead of being rebuilt by every author.
- **A table that feels real.** In later phases the table is rendered in 3D with Three.js on WebGPU, with physical materials (wood, felt, metal, translucent resin) and plausible physics for dice and pieces. 3D is a quality tier on top of a solid game model, never a requirement to play.

## Who it is for, in order

1. **Indie board game designers** are the first users. They need to turn an idea into something playable, test it remotely with other people, and iterate fast. They usually own the rights to their designs, which keeps us clear of licensing problems.
2. **Playtesters** are the designers' guests. They join by link, without installing anything and without needing an account.
3. **Players** come later, once designers have filled the center with finished games they are allowed to publish.

## The job we do for designers

Take a board game from a **rough sketch** to a **playable, testable, eventually balanced** game:

1. Sketch: components on a table, rules enforced by the people playing (sandbox mode).
2. Script: rules gradually encoded, so the platform enforces them (enforced mode).
3. Evidence: bots and simulation produce balance data the designer can act on (Phase 3).
4. Showcase: a polished 3D presentation the designer can use to pitch to publishers or crowdfunding backers (Phase 2 onward).

Existing tools cover the two ends of this path: free-form sandboxes, and platforms that require the whole game in code. The gap between them is the opportunity.

## Principles

1. **Rules and rendering are separate.** A game is a deterministic state machine. 2D, 3D, replays and bots all read the same state.
2. **The server is authoritative.** Each seat receives only what it is allowed to see.
3. **Content is data.** Components, materials and physical properties are declared; the platform renders them. Game code never touches the renderer.
4. **Web first, local-first.** Everything runs in the browser, nothing to install. Designers' unpublished projects stay on their own machine until they choose to share them.
5. **Every technology earns its place, with a reason we can explain.** Our own code is TypeScript. WebAssembly libraries are used where they are clearly the best tool (sandboxing untrusted code, physics, compressed textures) and each use is recorded with its reason and fallback (D-002).
6. **Decide late where it is cheap to.** Many library choices start as defaults with alternatives kept open behind small interfaces, and get settled with evidence at the stage where they matter ([decisions.md](docs/decisions.md#decision-points-by-stage)).

## Tie-breakers for judgment calls

When two good options conflict, prefer, in this order:

1. **Correct hidden information** over convenience. Leaking a hand of cards is a critical bug.
2. **Determinism** over cleverness. Same seed plus same moves must give the same game, everywhere.
3. **Designer iteration speed** over visual fidelity.
4. **Simple and narrow** over general, especially in Phase 1. Build what the current phase needs; leave clean seams for later.
5. **Reversible** over irreversible. When unsure, choose the option that is easiest to change later, and record the question.
6. **Measured** over assumed. When a choice is open, a small spike with numbers beats an argument.

## Non-goals

- Competing with large platforms on catalog size or licensed games.
- A virtual tabletop for role-playing games.
- Real-time action games. Board games are turn-based or loosely simultaneous.
- A free-form 3D physics sandbox as the main product. Physics serves the game.
- Native desktop or mobile apps in the early phases.

## What success looks like

- **Phase 1:** designers come back to playtest their own games with remote guests, without being asked.
- **Phase 2:** the standard 3D tier runs smoothly on mid-range phones, and designers use it to show their games.
- **Phase 3:** designers change their games because of the balance reports.
- **Phase 4:** the public play center is filled with designers' own published games.

## Context

The team behind the project is a university research group with long experience building specialized web applications. Some later features (simulation-based balance analysis, spatial analytics of board positions) double as research topics. That is a reason to keep data clean and well structured from the start: every match should be replayable and analyzable.
