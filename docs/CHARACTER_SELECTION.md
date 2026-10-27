# Selectable player characters and backend synchronization

## Status and scope

The backend implements this selection contract. Verify and deploy the frontend together with the backend before enabling fixed-model selection. Existing movement, chat, vehicle, shared-room and five-player rules remain in force.

Before joining, players choose one of three characters:

| Model ID  | Asset                       | Customization                                        | Walk clip | Run clip  | Idle presentation  |
| --------- | --------------------------- | ---------------------------------------------------- | --------- | --------- | ------------------ |
| `custom`  | `/models/character.glb`     | Existing shirt, pants, hairstyle and glasses options | `Walk`    | `Run`     | `Idle` clip        |
| `person2` | `/models/person2.glb`       | None; use original materials                         | `walk`    | `run`     | Imported rest pose |
| `ceo`     | `/models/ceo-character.glb` | None; use original materials                         | `Walking` | `Running` | Imported rest pose |

Clip names are case-sensitive. Neither fixed model currently contains an Idle clip. On Idle, stop movement actions and restore the imported rest pose rather than continuing locomotion or inventing an animation. Dance and gesture clips are not player movement states. Person 1 is not included in this selection extension.

Hide appearance controls when a fixed model is selected. Show its preview before joining. Preserve the custom character's draft settings when switching selections in the dressing room. Lock model and appearance after joining; selecting another model requires leaving and starting a new session. Reconnect with the same session selection.

## Extended join and player schemas

Keep the existing `Appearance` type unchanged. Add a discriminated selection shared by the frontend and backend:

```ts
type CharacterSelection =
  { model: 'custom'; appearance: Appearance } | { model: 'person2' | 'ceo'; appearance: null };

type PlayerJoinPayload = { name: string } & CharacterSelection;

type PlayerState = {
  id: string;
  name: string;
  position: Vector3;
  rotation: number;
  animation: 'Idle' | 'Walk' | 'Run';
} & CharacterSelection;
```

Custom join example:

```json
{
  "type": "player:join",
  "payload": {
    "name": "Player1",
    "model": "custom",
    "appearance": { "shirt": 1, "pants": 0, "hairstyle": 1, "glasses": 0 }
  }
}
```

Fixed-model join example:

```json
{
  "type": "player:join",
  "payload": { "name": "Player2", "model": "person2", "appearance": null }
}
```

The CEO uses the same fixed-model shape with `model: "ceo"`. Do not send asset URLs, filenames, scale, clip names or material settings. The frontend resolves allowlisted model IDs to local assets.

## Backend requirements

1. Validate model against exactly `custom`, `person2` and `ceo`. Custom requires a valid existing Appearance; fixed models require explicit `appearance: null`. Reject unknown IDs, invalid combinations and attempts to provide custom settings for fixed models with `server:error` code `INVALID_MESSAGE`. A rejected join must not create a player or broadcast `player:joined`.
2. For old clients only, an omitted `model` plus a valid existing Appearance is normalized to `model: "custom"`. Explicit null or unknown model IDs are invalid. Always emit the normalized explicit model in extended player snapshots.
3. Assign identity and spawn as before, and store the validated model and appearance in the socket's player session. The client cannot supply an ID. There is one shared room and at most five players across all model choices; model selection creates no extra room or connection.
4. Include model and appearance in every full PlayerState: all entries in `world:init.payload.players`, `player:joined.payload.player`, and non-null `vehicle:released.payload.player`. Late joiners and reconnecting visitors must see the same selections as current visitors.
5. Keep `player:move` and `player:update` unchanged. They contain semantic `Idle`, `Walk`, `Run` states, never model-specific clip names. Do not accept model/appearance changes through movement or any new update event. Movement updates merge into the stored player and preserve its selection; vehicle entry/exit also preserves it.
6. Disconnect removes the player as before. Reconnect validates a new join and assigns a fresh ID; it does not restore an old identity or driving lease. No database persistence is required for the selection.

Backend validation and full snapshots support this contract. Frontend rendering and live browser integration still require verification.

## Frontend rendering and lifecycle

Validate all extended snapshots using the same discriminated schema. Preserve stored selection when applying movement-only updates. Reject malformed snapshots rather than creating partial players. A legacy snapshot missing model may normalize to custom only when its Appearance is valid; a fixed selection cannot be inferred from null appearance. Do not enable fixed choices against an older backend: an old server might discard the model field or reject null appearance. Use a coordinated rollout; this specification introduces no capability handshake.

Cache each requested model template and its clips once per scene. Clone skeletons per player, keep a single player-object map keyed by server ID, and use the received selection for local and remote characters. Never apply customizable material overrides to fixed models. Share immutable geometries/textures and dispose per-instance materials and skeletons without disposing assets still used by other players. Ignore and release asynchronous loads after a player leaves or the scene unmounts.

Map semantic movement states to the clips in the table locally. Advance mixers with frame delta time, transition only when states change, and interpolate remote transforms as before. Gate CEO and garden dancers remain separate decorative instances with independent animation mixers; their dance/gesture loops must not control player instances.

For selectable player instances, normalize each model uniformly to 1.6 world units in height, with feet at the player's transform origin and forward along positive Z. Keep the existing collision capsule, speed, spawn, camera and vehicle interaction rules. The garden person 2's decorative 2x scale does not apply to player instances. Measure bounds from the rest pose and use a placement wrapper so animation tracks cannot overwrite normalization. Verify feet alignment and root motion; locomotion clips must not add displacement on top of network transforms.

## Acceptance checks before enabling selection

- Join with each model and confirm local and remote clients display the same model. Verify two players choosing the same fixed model have independent animation/skeleton state and one player leaving does not break the other.
- Verify custom settings still work, fixed models have no customization controls, and changing dressing-room selection never changes an already joined player.
- Validate missing/unknown model IDs, null/custom appearance mismatches, malformed appearance, spoofed asset paths and attempted in-session selection updates. Confirm rejected joins do not create duplicate players.
- Verify late joins, all full snapshots, reconnects and vehicle release preserve selection. Check the five-player cap across mixed model choices and no additional sockets or rooms.
- Verify Idle/rest pose, Walk and Run mapping for all models, movement ordering/interpolation, consistent scale, feet/ground alignment, collisions and vehicle seating visibility. Check decorative NPCs retain their original behavior.
- Verify leaving during model download, rejoining, repeated updates, and unmount release owned resources and prevent stale/duplicate instances.
- Run frontend TypeScript, ESLint, formatter and relevant protocol/resource tests; add backend validation/broadcast tests and run an actual multi-client integration test. Document results without claiming unexecuted checks passed.
