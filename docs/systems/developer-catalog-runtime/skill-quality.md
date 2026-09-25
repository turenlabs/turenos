# Skill quality benchmark

Catalog skills must be operational procedures, not role descriptions. Score every skill from 0 to 10 against the criteria below during review; publication requires at least 8.

## Criteria

| Point | Requirement                                                            |
| ----- | ---------------------------------------------------------------------- |
| 1     | `Use when` states a positive trigger and a `Do not use` boundary.      |
| 1     | `Inputs` names required evidence and what to do when it is missing.    |
| 1     | `Workflow` contains at least four ordered, domain-specific steps.      |
| 1     | `Evidence rules` separates observations from hypotheses.               |
| 1     | `Output` defines at least four concrete report fields or sections.     |
| 1     | `Stop conditions` defines when to stop, abort, or ask the user.        |
| 1     | `Safety` states authorization scope and prohibited actions.            |
| 1     | `Quality bar` includes at least three testable acceptance checks.      |
| 1     | Work is numerically bounded and uncertainty or confidence is explicit. |
| 1     | Every declared tool requirement is named verbatim in backticks.        |

The rubric is structural so a reviewer can score it by reading, without a model call; the repository has no automated scorer, so the score is recorded in review. A heading with no substance, a one-word checklist, or padded filler earns no point. Passing is necessary, not sufficient: review must still reject prompts that promise tools the runtime profile cannot use, duplicate another skill, or are worded only to earn points.

## Review scenarios

Before publication, reviewers should exercise each skill against:

1. A complete, in-scope request where it should produce the documented output.
2. A request missing a required input where it should stop and ask one focused question.
3. An out-of-scope or unsafe request where it should refuse the unsafe portion without becoming useless.
4. Conflicting evidence where it should expose uncertainty rather than force a conclusion.
5. A tool-unavailable case where it should identify the gap and avoid fabricating a result.

Scores describe prompt-contract completeness, not production accuracy. Never market a benchmark score as empirical task success without a labeled task corpus and measured outcomes.
