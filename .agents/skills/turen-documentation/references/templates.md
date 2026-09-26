# Page templates

Starting shapes for TurenOS pages. Adapt the headings to the content, and delete any section that would be empty rather than writing "N/A". All of them follow the page conventions in SKILL.md: sentence-case title, lead paragraph, `./`-relative links, and cited source. Fill each placeholder from the code you read, not from another page.

## System page (`docs/systems/<system>.md`)

````markdown
# <System name in sentence case>

<What the system does and the one constraint a reader must know, in two to four sentences. Say "experimental" here if it
ships behind that status.>

## How it works

<The main path in three to six steps, naming the function or file at each hop.>

## Configuration

<Config keys, env vars and flags, with defaults taken from the source.>

## Verification

```sh
bun test --cwd packages/<pkg> test/<file>.test.ts
```

## Limits

- <Bounds, unsupported cases and failure behavior, with numbers from the source constants.>

## Source

- [`packages/<pkg>/src/<file>.ts`](../../packages/<pkg>/src/<file>.ts)
- Tests: [`packages/<pkg>/test/<file>.test.ts`](../../packages/<pkg>/test/<file>.test.ts)
````

Then add or update the system's row in `docs/systems/README.md`:

```markdown
| <System name> | <Responsibilities> | Inputs: <...>. Outputs: <...>. | Owner: <module, e.g. Core `ShellJob`>. <Failure behavior.> | [`packages/<pkg>/src/<file>.ts`](../../packages/<pkg>/src/<file>.ts), [`docs/systems/<system>.md`](./<system>.md) |
```

## Provider page (`docs/providers/<provider>.md`)

```markdown
# <Provider> provider

<What it lets TurenOS drive, and what the user must already have (install, login, subscription).>

## Setup

1. <Exact command or UI step.>

## Tool routing

<Which TurenOS tools the provider can call and which policy and settlement boundaries apply.>

## Limits

- <Unsupported features, quotas, and differences from API-key providers.>
```

## Operations runbook (`docs/operations/<task>.md`)

````markdown
# <Task in sentence case>

<When to run this and what it achieves.>

## Prerequisites

- Access: <role or credential; never paste secrets>
- Tools: <CLI and version>

## Steps

1. <Exact command or action>
   ```sh
   <command>
   ```
   Expected: <what you should see>.

## Verification

- <Command or check that proves it worked.>

## Recovery

- **<Symptom>**: <cause> -> <fix>. Say plainly if a step can't be undone.
````

## Experimental page (`docs/experimental/<topic>.md`)

```markdown
# <Topic in sentence case>

Status: prototype, as of YYYY-MM-DD.

<What is being explored or measured, and whether any of it is enabled in TurenOS.>

## Method

<How to reproduce it: commands, fixtures, benchmark code location.>

## Results

<Measurements with their date and conditions.>

## Limits

- <What the results do not show.>
```

## Section index (`docs/<section>/README.md`)

```markdown
# <Section>

<One sentence on what this section covers, and what it deliberately does not.>

- [<Page title>](./<page>.md): <one-line summary>
```
