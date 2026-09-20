# site

capture any website into a reference pack, then verify a rebuild against it pixel by pixel.

status: milestones 1 to 6 (single-page capture and verify; explore states, record and replay,
attach mode; animations, video and frames, fonts through @font-face, element masks; the next.js
scaffold, the state machine and the orchestrator; real builder, reviewer and explorer workers,
run against the fixture on the real binary; the brand phase) are built and green. the design
notes and the task plans it was built from live under `docs/superpowers/`, which is kept out of
git: they are working papers, and this readme is the account of what the tool does.

milestone 5's gated run on the real binary rebuilt the fixture's index page and, on the tree
after its fix wave, passed all 7 of its units in 8 rounds: every unit at a pixel score of
0.00000 at both viewports, only one section needing a second round (the reviewer rejected a
counter that read 300 instead of 15 at a perfect pixel score), the whole-page unit passing in
its first round, no Stop-hook hold, no hang, 297 builder turns, under fifty minutes. what it
proved: the runner drives `claude -p` end to end for all three roles, the compile checks gate a
round, the per-round allowlist matches a unit id carrying `:` and `#` in every spelling a model
typed, the reviewer catches what the numbers miss and rejects a wrong build from the pictures
alone, and the explorer drives a real browser, marks five real states, saves a flow and refuses
the email field. an earlier run of the same test, before the fix wave, had passed 5 of 7: one
section blocked on a single pixel row at its crop boundary (now excluded from the comparison)
and the whole-page unit cascaded from it; the run before that spent zero turns because zod's
json schema carried a `$schema` the binary rejects. the one denial left in the final run was a
model chaining `; echo` after an approved command, which the brief now forbids by name.

the fix wave after that run addressed what it exposed. a section crop's outer one-device-pixel
ring, the seam with the next section, is blanked in both crops before the diff and left out of
the compared total, which is what that row was; a whole page is untouched, nothing borders its
edges. each round's `site verify` and `site shot` rules now carry the bare, double-quoted and
single-quoted spellings of the pack and the unit, nine rules per command, and the builder brief
says to run the two commands exactly as printed, character for character, because the allowlist
matches the text and a `cd` in front or a pipe after is denied whatever the rules say. a
timed-out or aborted worker is killed as a process group, so a `site verify` with its chromium
holding the inherited pipes cannot hold the round (a 20 minute budget once cost 2h 29m). a
browser keeper now records the process that owns its session and stops when that process is
gone, and a run names itself to its worker in `SITE_BROWSER_OWNER` rather than depending on the
shell. `site verify` deletes only its own artefact names from `--out`, never the pack's pngs.

## setup

node 24 (`.nvmrc`). npm's default resolver trips on this dependency set, so install with:

```
nvm use
npm install --legacy-peer-deps
npx playwright install chromium
```

video is recorded by playwright; splitting it into frames needs ffmpeg. one on `PATH`
(`brew install ffmpeg`) is used first, else the build playwright downloads next to its
browsers (`npx playwright install ffmpeg`). without either, capture still keeps the video
and says so in `meta.json`.

## commands

```
./bin/site explore <url> [--out sites/<host>] [--depth 2] [--scope <glob>...] [--profile] [--headed] [--attach http://127.0.0.1:9222] [--agent [--claude <bin>] [--model <name>]]
./bin/site capture --pack sites/<host> [--unit <id>] [--profile] [--headed] [--attach http://127.0.0.1:9222] [--keep-frames]
./bin/site verify --pack sites/<host> --unit <id> --target http://localhost:3000 [--gate 0.001]
./bin/site record <flow> --pack sites/<host> [--start <url>]
./bin/site replay <flow> --pack sites/<host> [--target http://localhost:3000] [--profile] [--headed] [--attach http://127.0.0.1:9222] [--keep-frames]
./bin/site scaffold <host> [--pack sites/<host>] [--out builds/<host>] [--source <dir>] [--cache <dir>] [--no-install]
./bin/site plan --pack sites/<host>
./bin/site build --pack sites/<host> [--project builds/<host>] [--target http://localhost:3000] [--parallel 2] [--rounds 6] [--threshold 0.001] [--claude <bin>] [--model <name>] [--reviewer-model <name>] [--reopen <unit>...]
./bin/site report --pack sites/<host> [--run <name>]
./bin/site shot --pack sites/<host> --unit <id> --target http://localhost:3000 --out <dir> [--viewport mobile|desktop]
./bin/site browser open <url> [--viewport mobile|desktop] | snapshot | hover|click (--role <r> --name <n> | --text <t> | --css <s>) | fill (the same) --value <v> | state <name> | flow <name> [--input <name>...] | close   (--session <dir> or SITE_BROWSER_SESSION)
./bin/site brand --project builds/<host> --brand brand.json [--pack sites/<host>] [--target http://localhost:3000]
```

`explore` crawls same-origin links, writes `manifest.json` with every page as a planned unit,
and tries each page's triggers (nav items to hover; menus, accordions, tabs and modal buttons
to click) at both viewports; every trigger that changes the page becomes a planned state unit
`state:<slug>/<name>` with the actions that reach it and the viewports that reach it (a
hamburger is a mobile-only state). `capture` turns each planned page into a directory under
`pages/<slug>/` (`meta.json`, `sections.json`, `text.json`, `styles.json`, `animations.json`,
`dom.html`, `snapshot.html`, `assets/`, and `mobile/` and `desktop/` with `full.png`, one crop
per section, `video.webm` of the load and the interaction, and `frames/` split from it at the
manifest's fps when `--keep-frames` is given; the load segment ends where the page settles, so
the capture's own scroll sweep is not in it) and each planned state into
`pages/<slug>/states/<name>/` of the same shape, reached by replaying its actions at the
viewports it lists. `animations.json` holds every `@keyframes` rule (read from the page, or
parsed from the captured stylesheet when the page may not read it and then spelled the way the
page's own cssom would spell it, so a rule compares whichever reader found it), the animation
and transition longhands of every element that declares any, and the animations chromium
reported over cdp during the load and the interaction. fonts are attributed to their captured
files through `@font-face`; a page that loaded a web font over http whose file was not captured
is blocked, not captured. dynamic regions (a live counter) are masked by the live element's own
box, passing over anything far larger than the change itself so a modal backdrop never masks
the viewport; a carousel is masked for what it is, and `manifest.capture.dynamicShots` and
`dynamicGap` widen the span a slow one needs.
`--attach` connects over cdp to a chrome you started with `--remote-debugging-port` on your own
profile; nothing is emulated there, so the pack records that chrome's pixel ratio, captures
mobile by resizing the page, and records no video (`meta.json` says so).

a page that answers 4xx or does not load at all is planned as `blocked` with the reason and a
question rather than stopping the crawl, and a unit that cannot be captured (a challenge page, a
trigger that has vanished, a dead url, an unanswered flow input) is blocked the same way while the
rest of the run carries on. `--profile` and `--attach` mean the same thing on `explore`, `capture`
and `replay`, and are refused together; `replay --target` always walks the rebuild in a fresh
session.

`scaffold` creates the rebuild: bulletproof-react's `apps/nextjs-app` at a pinned commit
(`79710eb`, recorded in `src/orchestrate/scaffold/snapshot.ts`) with its demo features, mock
server and test stack removed, `images.unoptimized` on, `tsconfig` with `@/*`, the eslint config
with `import/no-restricted-paths` and `check-file`, prettier, tailwind and postcss. with a pack it
also writes one feature per page with one stub component per section (`<section
data-section="<id>">` and the heading), routes composing the stubs in the pack's order, header
and footer shared under `src/components/layouts/` when more than one page has them, the pack's
colours, font families and keyframes into the tailwind theme, the font files under
`src/assets/fonts/` declared in `src/styles/fonts.css` under their own family names, and the
images under `src/assets/`. it installs (`npm install --legacy-peer-deps`) and formats. the
snapshot is fetched once into `~/.cache/site`; `--source` takes a local copy instead.

`plan` prints the queue: units by status and kind, what is ready, the flows and their inputs, and
the open questions. `build` works it: it refuses to start while a question is unanswered, takes
`runs/.lock` so two builds never share a pack (`explore`, `capture`, `record` and a capturing
`replay` take the same lock, so nothing rewrites a pack under a running build), puts back
whatever a killed run left in flight, starts `npm run dev` in the project and waits for it (or
takes `--target`), and then runs up to `--parallel` units at once on independent pages, sections
of one page never together. a unit's round is: a brief under
`runs/<run>/<unit>/round-N/brief.md` (the pack's paths, boxes, styles,
animations, refs, fonts, the previous round's verdict and the reviewer's notes, the rules); a
builder worker, `claude -p` with the brief on stdin, a turn budget, an allowlist, a permission
mode that never prompts and a settings file whose Stop hook reruns `site verify` and holds the
worker while it fails and whose PreToolUse hook denies edits outside the unit's files; `tsc` and
`next lint`; the orchestrator's own `site verify` from a fresh browser; a reviewer worker with
read-only tools answering `{ verdict, reasons }`. only that verify and that verdict move a unit
to `passed`; the worker's own report is logged and ignored. a failed round retries up to
`--rounds`, then the unit is `blocked` with its artefacts and a question, and everything that
depends on it blocks too; a rate limit waits (with backoff, logged) and retries the same round.
every transition is saved to `manifest.json` before the next; `report` writes
`runs/<run>/report.md`. `--reopen <unit>` puts a blocked unit back once its question is answered.

workers run on the subscription through `claude -p` (never the agent sdk); every flag was
measured against the binary rather than read from the docs, on 2.1.276 and again on 2.1.278,
and the measurements are kept with the design notes. two of them are load-bearing:
`--setting-sources project`, because a user's own `~/.claude/settings.json` may allow
`Bash(*)` and carry hooks, and a worker run without it would inherit both and the allowlist
would mean nothing; and the worker's environment, from which the runner strips `CLAUDECODE`,
`CLAUDE_CODE_*` and `CLAUDE_PID`, because a claude nested inside a claude code session refuses
to run and `site build` has to work from inside one. each builder is told how to work: the
theme classes the scaffold generated (`bg-pack-<hex>`, `font-<family>`, `animate-<name>`),
arbitrary values for the rest, `site shot` to look at its own render (the full page and its
section's crop, into the round's `shots/`), `site verify` to gate itself, and the json to
answer with; the theme and `src/styles/` are read-only for every worker, so two builders never
race on them. the reviewer is told how to look and to reject only for a difference it can name.
`--model` picks the alias for both workers (`sonnet`, `haiku`, `opus`); `--reviewer-model` the
reviewer's alone. a Stop hook hold costs a turn and claude stops honouring a hook after nine
consecutive holds, so `build` refuses a budget that would defeat either.

`explore --agent` runs an explorer worker per page after the crawl. the worker drives a real
browser through `site browser`, one command per Bash call: the page lives in a keeper process
between calls, every call prints the page (url, title, the open dialog, the interactive
elements by role and name), `state <name>` and `flow <name>` mark what the browser journaled,
and `fill` refuses a field that takes personal data or a payment and records it as an input to
ask for instead. what the tool journaled becomes planned states, flows under `steps/` with unset
inputs, and questions; what the worker claims is never read as data. `site browser` works by
hand too, with `--session <dir>`.

the ordinary tests never call the real binary: `test/helpers/fake-claude/` is a scripted
stand-in that honours the same flags, the settings file's hooks, the nine-hold override and the
nested-session refusal, and answers from a json scenario, which is how the gate, the retries,
blocking, rate-limit waits, a killed-and-resumed run and the explorer's merge are proven. the
real binary is run by one gated file:

```
npm run test:real     # SITE_REAL_CLAUDE=1: the fixture index rebuilt by real workers, a wrong
                      # build rejected by a real reviewer, the fixture explored; hours, on the
                      # subscription window; never part of npm test
```

`record` opens a visible browser on the pack's profile and writes every click, input, change,
enter key and scroll to `steps/<flow>.json` with resilient selectors (role and name, text, css
path) until you close the window. a password or an email you type is never stored: the field's
name lands under `manifest.flows.<flow>.inputs` for you to fill in. `replay` walks the steps
headless and captures each step as `flows/<flow>/step-NN-<name>/`; with `--target` it walks the
rebuild instead and verifies every step. `verify` captures the target with the same pipeline
(a state or a flow step is reached by replaying) and writes `verify.json`, a `diff.png` and a
contact sheet per viewport under `runs/verify/<unit>/`, exit code 1 on fail. pixels, styles and
animations gate (keyframes, durations, easings and delays per element, a missing animation
fails); structure and the motion frames report only: frames at matching times are diffed
loosely and a side-by-side strip per segment (`page.<vp>.<segment>.strip.png`) sits next to the
contact sheet.

`shot` is that walk without the comparison: it opens the unit's page on the rebuild the way
verify reaches it (a state by its actions, a flow step by its flow), settles and freezes it, and
writes `<viewport>.full.png` and, for a section, `<viewport>.<section-id>.png` cropped to the
element carrying that section's `data-section` or, failing that, the source's own selector. it
is cheap enough to run after every edit, which is what a builder does with it; by hand it takes
any `--out` dir and `--viewport` for one viewport only.

`brand` is phase two. a `brand.json` beside the project (validated on read, path and field on
failure) names what changes: `names` (source string to brand string, replaced as whole words
over every component, route and layout, never inside an import specifier, any `data-*`
attribute, a class name, an id or a handle such as `href`, `src`, `srcSet`, `name`, `key`,
`htmlFor` or the `sectionId` the wrapper stubs carry, and never inside a string that begins like
a path (`/`, `./`, `../`, `@/`, `#` or a scheme) wherever it stands; the match's case picks the
replacement's, so `FIXTURE CO` becomes `ACME LTD`), `logos` (an asset under `src/assets/` by its
file name or the source's basename, to the file that replaces it in place, same format), `colors`
(a theme token such as `pack-2563eb` to its new value; the token keeps its name, so
`bg-pack-2563eb` in a component now paints the brand's colour and no component changes) and
`fonts` (a source family to the brand family and its face files; the family's token keeps its
key, the faces are copied under `src/assets/fonts/` and declared in `src/styles/fonts.css` under
the brand family, and the source's faces are removed). a brand string that carries a source name
as a whole word, and a chain such as `A -> B` beside `B -> C`, are refused on read: both would
brand again on a second run. the theme and `fonts.css` are regenerated from the pack with the
brand layered over them, in the pack's own face order, which is why the pack is needed (`--pack`,
defaulting to `sites/<host>` from the project's package name); a `--project` that is not a
rebuild is refused before anything is written, naming what is missing; the files that changed are
formatted by the project's own prettier; a second run changes nothing. then the structure diff
(headings, items, buttons, image and svg counts) runs over every captured page of the pack
against the rebuild (`npm run dev` in the project, or `--target`) with brand normalisation:
ours' words are mapped back through the same table before they are compared, so a branded
heading equals its source and a missing item is still missing. no pixel, style or animation
gate: a brand is meant to look different. `deviations.md` in the project lists what changed,
what was left for a hand (a quoted source family still in a component, such as `font-['Fixture']`)
and what the gate found, a skipped page with its reason, and a `verdict:` line; a codemod step
that throws still writes the report, naming the step and what had landed. exit 1 on a gate
failure. `data-section` and `data-ref` stay on the components (the gate matches by them), and
the gate does not walk states or flow steps: their words are their page's.
`test/fixtures/brand/` is the sample the tests apply to the fixture.

## tests

```
npm test            # unit and integration (headless chromium against the fixture site)
npm run check       # typecheck, eslint (module direction included), prettier
```

the suite runs one file at a time (`fileParallelism: false` in `vitest.config.ts`). an
integration file drives its own chromium and, in the scaffold and orchestrator files, a dev
server; several assertions are about wall clock, so files run side by side would measure the
load on the machine rather than the thing under test.

`test/real/claude.test.ts` is included by vitest only under `SITE_REAL_CLAUDE=1`; `npm test`
runs `test/unit` and `test/integration` and nothing else.

the fixture site lives in `test/fixtures/site`; `test/fixtures/site-mutated` differs from it by
exactly four lines and proves the verifier names each drift. `app.html` in both is an app-shell
page (no `<main>`, one wrapped root) for section detection; `shape.html` puts every trigger
below the fold; the index has a live counter (masked), a keyframe animation and a transition
(gated), two font files of which one is hashed (attributed through `@font-face`), and a
hamburger shown at phone width only (a mobile-only state). `test/fixtures/scaffold/nextjs-app`
holds the ten files of the pinned bulletproof-react commit the scaffold reads, so the scaffold
tests run offline; one test fetches the tarball once into `os.tmpdir()/site-scaffold-cache` and
proves the vendored bytes, and skips itself without a network. the scaffold's `node_modules` is
installed once per package.json into the same cache dir and linked into each test project; the
first run on a machine needs the network. `test/fixtures/brand/` is the brand sample for the
fixture (three names, the hero as a logo, two colour tokens, the `Fixture` family as `Acme Sans`
with two faces that are the fixture's own Inter bytes); `test/helpers/built-fixture.ts` is the
fixture's index rebuilt by hand, the markup of `index.html` as the scaffold's components, so the
structure gate has a rebuild to pass over without a builder running. the orchestrator tests drive
`test/helpers/fake-claude`
through `SITE_FAKE_SCENARIO`, put it on the child's `PATH` themselves, and never install it.
