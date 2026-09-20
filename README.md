# site

copy any website into clean next.js code, and prove the copy matches.

most tools that clone a site dump its html. this one records the original, rebuilds it as a
real next.js project, and then refuses to call a page done until a fresh browser run scores it
against the recording: pixels under a gate you set, every computed style exact, every keyframe
and easing exact. what you get is source you can read, edit and ship, not a scrape.

```bash
./bin/site explore https://example.com/ --out sites/example.com   # find the pages and states
./bin/site capture --pack sites/example.com                       # record them
./bin/site scaffold example.com --pack sites/example.com          # make the next.js project
./bin/site build --pack sites/example.com                         # rebuild it, gated
./bin/site report --pack sites/example.com                        # what passed, what blocked
```

the rebuild lands in `builds/example.com`: a standalone next.js app router project with its own
`package.json`. `npm run dev` it, edit it, deploy it, hand it to someone. the tool is not in it.

## how it works

there are two directories and they are input and output.

**the pack** (`sites/<host>/`) is the recording: every page's dom, computed styles, text,
animations, fonts, assets, and screenshots and video at a phone and a desktop viewport, plus the
states behind menus and modals and any flows you record. it is frozen at capture time, so the
live site changing or going down does not move the target mid-run.

**the rebuild** (`builds/<host>/`) is the reproduction: a next.js project scaffolded from the
pack, then filled in section by section by `claude -p` workers running on your subscription.

a unit is a section, a page, a state or a flow step, and the pack's manifest is the queue. a
build works it in dependency order, sections before their page, with as many workers at once as
you allow on independent pages.

## the gate

nothing moves on a worker's word. a unit is `passed` only when two things agree: the
orchestrator's own `site verify` run from a fresh browser, and a separate reviewer worker that
looks at the source, the rebuild and the diff and answers with a verdict and its reasons. the
builder's own report is logged and ignored.

what gates: pixels against the source shot under `--threshold` (0.001 by default, with dynamic
regions masked), every computed style, and every animation (keyframes matched by name, with
durations, easings and delays per element; a missing animation fails). what reports but does not
gate: the structure diff and the motion frames.

a failed round retries up to `--rounds`. then the unit is `blocked` with its artefacts and a
question for you, and everything depending on it blocks too. a rate limit waits with backoff and
retries the same round. every status change is saved before the next, so a run is killable and
resumable: `site build` again picks up where it stopped.

## install

node 24 (`.nvmrc`). npm's default resolver trips on this dependency set:

```bash
nvm use
npm install --legacy-peer-deps
npx playwright install chromium
```

video is recorded by playwright; splitting it into frames needs ffmpeg. one on `PATH`
(`brew install ffmpeg`) is used first, else playwright's own
(`npx playwright install ffmpeg`). without either, capture keeps the video and says so.

## commands

| command | what it does |
|---|---|
| `explore <url>` | crawl same-origin links, find states behind triggers, write the manifest |
| `capture` | record every planned page and state into the pack |
| `scaffold <host>` | create the next.js rebuild from the pack |
| `plan` | print the queue, the flows and the open questions |
| `build` | run the rebuild loop until every unit passes or blocks |
| `report` | write the run's report |
| `verify` | compare one unit of a rebuild against the pack, exit 1 on fail |
| `shot` | screenshot one unit of a rebuild, no comparison |
| `record <flow>` / `replay <flow>` | record a click path, replay it on the source or the rebuild |
| `browser` | drive one page by hand or from an agent, a command at a time |
| `brand` | apply names, logos, colours and fonts to a finished rebuild |

<details>
<summary>full usage</summary>

```
./bin/site explore <url> [--out sites/<host>] [--depth 2] [--scope <glob>...] [--profile] [--headed] [--attach http://127.0.0.1:9222] [--agent [--claude <bin>] [--model <name>]]
./bin/site capture --pack sites/<host> [--unit <id>] [--profile] [--headed] [--attach http://127.0.0.1:9222] [--keep-frames]
./bin/site scaffold <host> [--pack sites/<host>] [--out builds/<host>] [--source <dir>] [--cache <dir>] [--no-install]
./bin/site plan --pack sites/<host>
./bin/site build --pack sites/<host> [--project builds/<host>] [--target http://localhost:3000] [--parallel 2] [--rounds 6] [--threshold 0.001] [--claude <bin>] [--model <name>] [--reviewer-model <name>] [--reopen <unit>...]
./bin/site report --pack sites/<host> [--run <name>]
./bin/site verify --pack sites/<host> --unit <id> --target http://localhost:3000 [--gate 0.001]
./bin/site shot --pack sites/<host> --unit <id> --target http://localhost:3000 --out <dir> [--viewport mobile|desktop]
./bin/site record <flow> --pack sites/<host> [--start <url>]
./bin/site replay <flow> --pack sites/<host> [--target http://localhost:3000] [--profile] [--headed] [--attach http://127.0.0.1:9222] [--keep-frames]
./bin/site browser open <url> [--viewport mobile|desktop] | snapshot | hover|click (--role <r> --name <n> | --text <t> | --css <s>) | fill (the same) --value <v> | state <name> | flow <name> [--input <name>...] | close   (--session <dir> or SITE_BROWSER_SESSION)
./bin/site brand --project builds/<host> --brand brand.json [--pack sites/<host>] [--target http://localhost:3000]
```

</details>

## capturing

`explore` crawls same-origin links and writes every page as a planned unit, then tries each
page's triggers at both viewports: nav items to hover, menus, accordions, tabs and modal buttons
to click. every trigger that changes the page becomes a planned state with the actions that reach
it and the viewports it appears at, so a hamburger is recorded as a mobile-only state.

`capture` turns each planned unit into a directory holding `meta.json`, `sections.json`,
`text.json`, `styles.json`, `animations.json`, `dom.html`, `snapshot.html`, `assets/`, and a
`mobile/` and `desktop/` with the full page, one crop per section, a video of the load and the
interaction, and its frames when `--keep-frames` is given.

some details that matter:

- **keyframes** are read from the page where the browser will let it, and parsed out of the
  captured stylesheet where it will not, then respelled the way the page's own cssom would spell
  them, so a rule compares the same whichever reader found it.
- **fonts** are attributed to their captured files through `@font-face`. a page that loaded a web
  font whose file was not captured blocks rather than capturing a lie.
- **live regions** (a counter, a carousel) are masked by the changing element's own box, passing
  over anything far larger than the change itself so a modal backdrop never masks the viewport.
- **a page that will not load** or answers 4xx is planned as blocked with a question, and the
  crawl carries on. the same is true of a unit that cannot be captured: a challenge page, a
  vanished trigger, an unanswered flow input.
- **`--attach`** connects over cdp to a chrome you started with `--remote-debugging-port` on your
  own profile. nothing is emulated there, so the pack records that chrome's pixel ratio, captures
  mobile by resizing, and records no video.

`record` opens a visible browser and writes every click, input, change, enter and scroll to
`steps/<flow>.json` with resilient selectors until you close the window. a password or an email
you type is never stored: the field's name lands in the manifest's flow inputs for you to fill
in. `replay` walks those steps headless against the source, or against the rebuild with
`--target`, verifying each step.

## rebuilding

`scaffold` creates the project from bulletproof-react's `apps/nextjs-app` at a pinned commit,
with its demo features, mock server and test stack removed. from a pack it also writes one
feature per page, one stub component per section, routes composing them in the pack's order,
shared header and footer as layouts, the pack's colours, families and keyframes in the tailwind
theme, the fonts declared under their source family names, and the images.

`build` then works the queue. it refuses to start while a question is unanswered, takes a lock so
two builds never share a pack, puts back whatever a killed run left in flight, starts the dev
server or takes `--target`, and runs the rounds.

one round for one unit is: a brief written from the pack (the paths, boxes, styles, animations,
refs and fonts, plus the last round's verdict and the reviewer's notes); a builder worker with a
turn budget, an allowlist, a permission mode that never prompts, and hooks that rerun verify when
it tries to stop and deny any edit outside that unit's files; `tsc` and `next lint`; the
orchestrator's own verify; then the reviewer.

each builder is told how to work: the theme classes the scaffold generated, arbitrary values for
anything the theme lacks, `site shot` to look at its own render, `site verify` to gate itself.
the theme and `src/styles/` are read-only to every worker, so two builders never race on them.

`--model` picks the alias for both roles, `--reviewer-model` the reviewer's alone.

### the agent explorer

`explore --agent` runs an explorer worker per page after the crawl, to find what a crawler
cannot. it drives a real browser through `site browser`, one command per call, with the page
living in a keeper process between them. every call prints the page back: url, title, the open
dialog, the interactive elements by role and name.

what the browser journaled becomes planned states, flows and questions. what the worker claims
is never read as data. `fill` refuses any field that takes personal data or a payment and records
it as an input to ask you about instead.

## branding

`brand` is phase two, and it is a codemod, not a worker. a `brand.json` names what changes:

- **`names`**: source string to brand string, replaced as whole words across every component and
  route, case-preserving, and never inside an import path, a `data-*` attribute, a class name, an
  id, a handle such as `href` or `src`, or any string that begins like a path.
- **`logos`**: an asset under `src/assets/` to the file that replaces it.
- **`colors`**: a theme token to a new value. the token keeps its name, so every component that
  used it now paints the new colour and no component changes.
- **`fonts`**: a source family to the brand family and its face files.

the theme and `fonts.css` are regenerated from the pack with the brand layered over them, which
is why `--pack` is needed. a project that is not a rebuild is refused before anything is written.
a second run changes nothing.

then the structure diff runs over the pack with brand normalisation: the rebuild's words are
mapped back through the same table before comparison, so a branded heading equals its source and
a missing item is still missing. there is no pixel gate here, because a brand is meant to look
different. `deviations.md` lists what changed, what was left for a hand, and what the gate found.

## tests

```bash
npm test          # unit and integration, headless chromium against the fixture site
npm run check     # typecheck, eslint (module direction included), prettier
npm run test:real # the real binary, hours, never part of npm test
```

the ordinary suite never calls the real binary. `test/helpers/fake-claude/` is a scripted
stand-in that honours the same flags, the settings file's hooks, the nine-hold override and the
nested-session refusal, and answers from a json scenario. that is how the gate, the retries,
blocking, rate-limit waits, a killed-and-resumed run and the explorer's merge are proven.

files run one at a time (`fileParallelism: false`): several assertions are about wall clock, and
files side by side would measure the machine's load instead of the thing under test.

the fixture site is in `test/fixtures/site`, and `test/fixtures/site-mutated` differs from it by
exactly four lines, which is how the verifier is proven to name each drift.

## status

milestones 1 to 6 are built and green: capture and verify, explore and record, animations and
video, the scaffold and the orchestrator, real workers, the brand phase. 45 test files, 460
tests.

the gated real run rebuilt the fixture's index page with real workers and passed all 7 of its
units in 8 rounds: every unit at a pixel score of 0.00000 at both viewports, the whole-page unit
passing in its first round, no hook hold, no hang, 297 builder turns, under fifty minutes. one
section needed a second round, because the reviewer rejected a counter that read 300 instead of
15 at a perfect pixel score, which is the case the reviewer exists for.

workers run on the subscription through `claude -p`, never the agent sdk. every flag was measured
against the binary rather than read from the docs. two are load-bearing: `--setting-sources
project`, because a personal `~/.claude/settings.json` may allow `Bash(*)` and carry hooks that
would make the allowlist meaningless, and the worker's environment, from which the session
variables are stripped, because a claude nested inside a claude code session refuses to run.

the design notes and the task plans this was built from live under `docs/superpowers/`, kept out
of git. this readme is the account of what the tool does.
