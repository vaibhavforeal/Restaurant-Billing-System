# Working in this repo

## Keeping sessions efficient

From the session reports of 2026-11-04 and 2026-11-05 (`session-report-*.html`): this repo uses about 72% of a week's
tokens, and the same patterns showed up in every report.

- **One phase per session for big builds.** For a large feature (like the 30 Oct licensing portal run, 7-11% of a
  week's tokens in one prompt), write the spec and plan first, then build each phase in its own session. Commit at
  the end of each phase and note where to pick up, so the next session starts with a small context instead of
  re-reading hours of history.
- **Execute inline when tasks build on each other.** Running a plan in the main session ("native") with one final
  review did the hold-order feature for 3.1% of a week; agent-team and subagent-driven runs cost the most (5.4% for one
  agent-teams run, 4-6% for subagent-driven-development). Use subagents only for genuinely independent work.
- **Brief subagents narrowly.** Give each subagent the exact files, the question to answer, and what is already ruled
  out. Use `Explore` / `Plan` agents for read-only lookups; `general-purpose` averaged about 2M tokens per call.
- **Confirm scope before a multi-agent run.** A bare "go ahead" once started 696 API calls and 26 subagents (10% of a
  week). Before spawning several agents, say what is in scope and how many agents, and get a yes.
- **Don't switch models mid-session.** The largest cache break (877K tokens re-read) came right after a `/model`
  switch. Suggest a new session for the new model instead.
- **Start a fresh session for a new task.** Idle gaps past the 5-minute prompt cache re-send the whole context
  uncached. When a task is done, suggest `/clear` or a new session rather than carrying on in the same one.
- **Offer follow-ups together.** At the end of a task, offer the usual next steps (commit, push, PR, merge, build) in
  one question, so they can be approved in a single message instead of several turns spaced minutes apart.
