---
name: craftdriver
description: Explore a live web application or write a durable CraftDriver test. Use for browser actions, page inspection, selector validation, and CraftDriver test debugging.
---

# CraftDriver

For live page exploration, this entry is complete. On a syntax error, use the
closest example below; load [cli.md](cli.md) only when the needed command is not
shown. Do not dump global `--help` into the conversation.

## Fast live-browser loop

Launch, navigate, and receive the initial bounded semantic snapshot atomically:

```bash
npx craftdriver go http://127.0.0.1:3000 --browser chrome --headless --observe=delta
```

`go` auto-starts the daemon; do not start it separately. Use the default session
for one flow. Add the same `--session NAME` to every command only when concurrent
flows need isolation. Agent sessions use a 1280x800 desktop viewport; override a
responsive-layout task with `go URL --viewport WIDTHxHEIGHT`.

Act with the returned `ref=eN` targets. A bare snapshot token such as `e7` is
also accepted when that live ref was issued by this session; use `css=e7` only
when you literally mean the CSS type selector. Refs retain element identity
while the element lives and fail `STALE_REF` after navigation, reload, removal,
or ambiguity; they never move to a different element.

`search`, `form`, `navigation`, and `main` lines marked `(container)` group the
indented controls below them; do not fill or click the container. If the desired
field is absent, use its same-purpose link/button to reveal it, then observe the
delta. Use `fill TARGET VALUE` for a field, `press Enter` for a key, and `type`
only for text sent to the already-focused element. For a searchbox or other
single-field form, submit without carrying a sibling ref across the reactive
fill:

```bash
npx craftdriver fill ref=e5 "Telerik" --submit --observe=page
npx craftdriver text h1
npx craftdriver attr 'link[rel="canonical"]' href
```

For a conventional multi-field form, fill earlier fields normally, then submit
from the final single-line field. Use `--observe=delta` when the resulting
validation message or state determines the next step:

```bash
npx craftdriver fill ref=e7 USER --observe=delta
npx craftdriver fill ref=e9 PASSWORD --submit --observe=delta
```

Do not apply this pattern to textareas, multi-step wizards, or forms whose task
requires a specific secondary action instead of ordinary Enter submission.

A reactive fill can replace neighbouring controls. When a separate sibling
action is genuinely needed, use `fill TARGET VALUE --observe=delta` and act on
the fresh ref it returns. After a predictable navigation, prefer
`--observe=page` plus targeted `text`, `attr`, or `value` reads for evidence you
already know you need. Use `--observe=delta` when the next action depends on
discovering what changed. A navigation delta is the new page's full bounded
snapshot, so do not follow it with another snapshot.

`--observe=page` reports URL, title, document identity, and `documentChange`:
`same`, `changed`, or `unknown`. `unknown` means there was no preceding observed
document and must not be treated as `same`.

Every observed result also carries `errors` — how many the page logged since the
previous observation — and `logCursor`. Non-zero means read them with
`logs --kind error --since <logCursor>` before treating the action as
successful; `(no a11y changes)` alone is not an all-clear.

On `STALE_REF`, use the attached `recoverySnapshot`; take `snapshot --pretty`
only when recovery context is unavailable or more context is genuinely needed.
Actions auto-wait; use `wait` only for a specific asynchronous selector or load
state. Do not call `status` merely to get URL or title.

For required visual evidence, run `screenshot -o final.png`. When finished, run
`daemon stop`; it already closes every session, so do not call `session close`
first.

## Batch what you already know

When the whole sequence is already known, send it as one batch rather than one
command per turn.

```bash
npx craftdriver run <<'EOF'
fill ref=e7 alice
fill ref=e9 hunter2
click ref=e11
expect text '#result' --contains 'Welcome' --observe=delta
EOF
```

It stops at the first failed step and names it. `--observe` goes on the last
step only, where `delta` accumulates what the earlier steps changed.
`--session NAME` goes on `run`, never on a step.

End with an `expect` step when the outcome matters: `expect visible|text|url`
auto-wait and then *fail* (exit 1), and `expect no-errors` checks what the page
logged, where `find`/`text`/`is` only report. Without one, a batch shows only
that every step ran.

Stop batching — return and look — whenever a step depends on what the previous
one showed: a selector taken from the delta, a navigation or wizard step, a
result that decides whether to continue at all.

## Writing or debugging committed tests

Only when the request asks for test source, inspect the repository's existing
tests and scripts, then read [workflow.md](workflow.md). Convert an explored
element with `craftdriver locators ref=eN`; never put a ref in committed source.
