# AGENTS.md — Multiplayer Game Backend

## Project Overview

This project is a multiplayer game backend using Node.js, TypeScript, Express.js, WebSocket (`ws`), and Pino.

The frontend uses React, Three.js, and Blender-exported GLB models.

The game has **one shared room with a maximum of 5 concurrent players**.

## Working Directory Restrictions (CRITICAL)

- **ONLY work within the current project directory and its subdirectories.**
- **NEVER read, create, modify, move, or delete files outside the current project directory.**
- Do not access parent directories (`../`), sibling projects, or unrelated folders.
- Do not execute commands that modify files outside the current project directory.
- Do not change the working directory to a location outside the project.
- Treat the current project directory as the strict workspace boundary.
- If a task requires accessing files outside this directory, **STOP and ask for explicit user permission first.**
- These restrictions apply to all tasks, including reading documentation, running scripts, installing dependencies, and using external tools.

## Architecture Rules

- Keep the architecture simple, clean, and maintainable.
- Use TypeScript with strict type checking.
- Use WebSocket for real-time communication.
- Store player states in memory using `Map`.
- Do not introduce databases, Redis, or multiple rooms unless requested.
- The server is authoritative for player state and movement.
- Validate all incoming WebSocket messages.
- Remove disconnected players and notify remaining players.
- Reject new players when the room is full.
- Use Pino for logging instead of `console.log`.
- Handle errors gracefully.

## Player State

```ts
type Appearance = {
  shirt: 0 | 1 | 2;
  pants: 0 | 1;
  hairstyle: 0 | 1;
  glasses: 0 | 1;
};

type PlayerState = {
  id: string;
  name: string;
  appearance: Appearance;
  position: {
    x: number;
    y: number;
    z: number;
  };
  rotation: number;
  animation: "Idle" | "Walk" | "Run";
};
```

## Appearance Rules (IMPORTANT)

- Players customize their appearance on the frontend before joining the world.
- Appearance is submitted once through the `player:join` WebSocket event.
- Validate appearance values before accepting a player.
- Store the selected appearance in the player's server-side state.
- Appearance remains unchanged throughout the player's session.
- Do not implement `player:appearance` or any in-game appearance update event.
- Send appearance data to other players when someone joins.
- Include appearance data in `world:init` so new players can render existing players.
- Do not repeatedly send appearance data during movement synchronization.
- If a player disconnects and rejoins, they must submit their appearance again.

## WebSocket Events

- `player:join` — Client submits name and appearance.
- `world:init` — Server sends the player's ID and all current player states.
- `player:joined` — Notify existing players of a new player.
- `player:input` — Client sends movement input.
- `player:update` — Server broadcasts position, rotation, and animation.
- `player:left` — Notify players when someone disconnects.

## Code Comment Rules (IMPORTANT)

**Always write meaningful comments when creating or modifying code.**

- Write comments in English.
- Add JSDoc comments to exported functions, classes, and complex methods.
- Explain WHY logic exists, not just WHAT it does.
- Comment WebSocket synchronization, movement validation, and connection handling.
- Document important parameters and return values when necessary.
- Keep comments updated when modifying code.
- Avoid obvious or redundant comments.

## Coding Standards

- Prefer small, reusable functions.
- Use `async/await` for asynchronous operations.
- Avoid `any`; use proper TypeScript types.
- Use descriptive variable and function names.
- Use `const` by default.
- Use early returns.
- Avoid duplicated logic.
- Separate game logic from WebSocket handlers.
- Use Prettier for formatting.

## Game Synchronization

- Maximum 5 players in one shared world.
- Use a server game loop starting at 20 ticks per second.
- Validate movement speed and player input.
- Synchronize position, rotation, and animation.
- Send appearance only during player initialization and joining.
- Never transmit GLB files, textures, or world geometry over WebSocket.
- Keep WebSocket messages small.

## Logging

Use Pino with appropriate log levels:

- `fatal`: Unrecoverable errors.
- `error`: Failed operations.
- `warn`: Invalid messages and rejected connections.
- `info`: Server startup, player joins, and disconnects.
- `debug`: Game state and WebSocket debugging.
- `trace`: Detailed diagnostics when needed.

Do not log every movement update in production.

## Before Completing Any Task

1. Ensure TypeScript compiles.
2. Run Prettier on modified files.
3. Run available lint checks.
4. Add or update meaningful code comments.
5. Avoid unnecessary complexity.
6. Preserve existing functionality.
7. Briefly summarize changes.

## Documentation Rules (IMPORTANT)

- **Always read and follow the relevant documentation in the `docs/` folder before writing or modifying code.**
- Treat `docs/` as the source of truth for project architecture, protocols, and data structures.
- **Always write new instructions, specifications, and technical documentation in the `docs/` folder.**
- Update existing documentation whenever related code changes.
- Keep all documentation clear, accurate, and up to date.