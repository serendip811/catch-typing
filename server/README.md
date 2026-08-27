# Catch Typing server

Authoritative WebSocket room server for the MVP.

## Run

```sh
npm install
npm run dev
```

The default endpoint is `ws://localhost:8080` (`PORT` can override it).

## Client messages

```json
{"type":"create_room","name":"하나"}
{"type":"join_room","roomId":"ABC123","name":"둘"}
{"type":"start_match"}
{"type":"submit","targetId":"ABC123-1","text":"번개"}
```

The server broadcasts authoritative `room_state`, `match_started`,
`submission_result`, `interference`, and `match_ended` events. Submission results
are `success`, `claimed` (another player already won that target), or `miss`.
