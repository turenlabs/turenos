export { transcript } from "./messages"
export { errorText } from "./server/errors"
export { connect } from "./server/connect"
export type { ConnectionOptions, Session, Todo } from "./server/context"

import type { connect } from "./server/connect"

export type Connection = ReturnType<typeof connect>
export type Snapshot = Awaited<ReturnType<Connection["snapshot"]>>
export type Detail = Awaited<ReturnType<Connection["detail"]>>
