# Composer predictions

Composer predictions suggest a next user message from the current conversation. The feature is off by default.
When enabled, the app automatically requests suggestions from the session model. These requests can incur provider costs.

## Automatic requests

Enable **Composer predictions** on the app settings page. The app waits 800 milliseconds before requesting a suggestion.
The session must have a completed assistant message without an error, and the composer must be empty and in normal mode.
Working sessions, question requests, goal mode, attachments, comments, and selected context prevent the automatic request.

The app attempts one request per completed assistant message while the composer component remains mounted.
It aborts the client request when the eligible conversation or composer state changes.
This is not a durable cache; remounting the composer can request the same suggestion again.

The app calls `POST /session/{sessionID}/prediction` through the legacy JavaScript SDK.
The request retains server authentication and Location headers. The response has the shape `{ "text": "suggested message" }`.
The app setting controls automatic requests, not access to the endpoint.

## Suggestion behavior

The server uses the session model through `SessionRunnerModel`. It does not invoke agent tools for prediction.
It reads up to 40 recent context messages, then selects at most 12 user and assistant text messages.
It excludes synthetic inputs, machine-origin user inputs, reasoning, and tool output.
User text is limited to its first 2,000 characters; assistant text is limited to its last 4,000 characters.

The server returns an empty suggestion for child sessions or unsuitable conversation history.
A suitable history contains a user message and ends with assistant text.
Model resolution or generation errors and the 15-second prediction timeout also return an empty suggestion.
The model request permits up to 2,048 output tokens. Output cleaning rejects empty text, unfinished reasoning, and text longer than 500 characters.

Click the suggestion or press Tab to place it in the composer. Acceptance does not send the message.
Press Escape or click the dismiss button to hide the suggestion for that completed assistant message.

## Verification

- `packages/core/test/session-prediction.test.ts` checks text selection, bounds, and output cleaning.
- `packages/sdk/js/test/composer-prediction.test.ts` checks the request method, path, authentication, Location header, and cancellation signal.
- `packages/forge/test/server/httpapi-session.test.ts` covers the prediction HTTP endpoint.

## Limits

Suggestions are model output, not verified user intent or permission to act.
Review the suggestion before sending it. Prediction failure does not prevent manual composition.
Aborting a client request does not prove that a provider stopped processing it or avoided billing.

## Source

- [Composer trigger and controls](../../packages/app/src/components/prompt-input.tsx)
- [Default and stored setting](../../packages/app/src/context/settings.tsx)
- [App settings control](../../packages/app/src/components/settings-v2/general.tsx)
- [HTTP endpoint](../../packages/forge/src/server/routes/instance/httpapi/groups/session.ts)
- [Prediction handler](../../packages/forge/src/server/routes/instance/httpapi/handlers/session.ts)
- [Text selection and output cleaning](../../packages/core/src/session/prediction.ts)
- [SDK request](../../packages/sdk/js/src/v2/client.ts)
