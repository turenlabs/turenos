# @turenlabs/client

Generated client target derived directly from TurenOS's authoritative Effect `HttpApi`.

## Entrypoints

- `@turenlabs/client`: zero-Effect Promise client using `fetch`.
- `@turenlabs/client/effect`: rich Effect network client using an environment-provided `HttpClient`.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@turenlabs/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The generated namespace remains `Forge` for source compatibility with existing
SDK consumers. It is an API identifier, not the product name; new prose and
application surfaces should use TurenOS.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@turenlabs/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, Forge, Prompt } from "@turenlabs/client/effect"

const client = yield * Forge.make({ baseUrl: "https://turenos.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```
