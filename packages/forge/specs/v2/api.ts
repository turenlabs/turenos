// @ts-nocheck

import { Forge } from "@turenlabs/core"
import { ReadTool } from "@turenlabs/core/tools"

const turenos = Forge.make({})

turenos.tool.add(ReadTool)

turenos.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

turenos.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

turenos.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await turenos.session.create({
  agent: "build",
})

turenos.subscribe((event) => {
  console.log(event)
})

await turenos.session.prompt({
  sessionID,
  text: "hey what is up",
})

await turenos.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await turenos.session.wait()

console.log(await turenos.session.messages(sessionID))
