import type { BrowserContext, Frame, Page } from 'playwright';
import { DEFAULT_VIEWPORTS, RECORD } from '../pack/defaults';
import { FLOW_NAME } from '../pack/ids';
import { loadManifest, newManifest, saveManifest, writeJson } from '../pack/io';
import { PackPaths } from '../pack/paths';
import {
  RecordedEventSchema,
  StepsFileSchema,
  type Manifest,
  type RecordedEvent,
  type RecordedField,
  type Step,
  type StepsFile,
  type Target,
} from '../pack/schemas';
import { inPage } from './browser/in-page';
import {
  describeTarget as describeTargetHelper,
  interactiveAncestor as interactiveAncestorHelper,
} from './browser/targets';
import { openPage, type Session } from './session';

// declared in the page by inPage(recorderInPage, [helpers]); see in-page.ts
declare function describeTarget(el: Element): Target;
declare function interactiveAncestor(el: Element): Element;

/**
 * a field counts as sensitive on type, autocomplete, name/id, or its current value already
 * looking like an email. this mirrors the nested `isSensitiveField` inside recorderInPage
 * (deliberately duplicated rather than shared, so each side keeps deciding on its own, per
 * the two independent checkpoints described in maskEvent below), and is also used directly
 * by maskEvent's node-side re-check.
 */
export function isSensitiveField(f: RecordedField & { value: string }): boolean {
  const type = f.type.toLowerCase();
  // a checkbox or radio reports "true" or "false", never a secret, whatever it is named; the
  // page side never masks one either (valueOf returns its checked state before this runs)
  if (type === 'checkbox' || type === 'radio') return false;
  if (type === 'password' || type === 'email') return true;
  const auto = f.autocomplete.toLowerCase();
  if (
    auto.includes('password') ||
    auto.includes('email') ||
    auto.includes('cc-') ||
    auto.includes('one-time-code')
  ) {
    return true;
  }
  const ident = /pass|pwd|email|e-mail|card|cvv|cvc|otp/i;
  if (ident.test(f.name) || ident.test(f.id)) return true;
  return f.value.includes('@');
}

/**
 * in-page recorder, installed as an init script on every document of the context. it
 * reports click, input, change, enter keydown and scroll through the exposed binding, with
 * selectors computed at event time. a password or an email never leaves the page as a
 * value: the field's name goes out as `input` instead, and the value is asked for at plan
 * time. self-contained apart from the two ambient helpers.
 */
export function recorderInPage(opts: { binding: string; scrollDebounce: number }): void {
  const FIELD_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
  // duplicated from the node-side isSensitiveField above: this function is stringified and
  // injected standalone (see inPage in ./browser/in-page.ts), so it cannot import it.
  function isSensitiveField(f: {
    type: string;
    autocomplete: string;
    name: string;
    id: string;
    value: string;
  }): boolean {
    const type = f.type.toLowerCase();
    if (type === 'password' || type === 'email') return true;
    const auto = f.autocomplete.toLowerCase();
    if (
      auto.includes('password') ||
      auto.includes('email') ||
      auto.includes('cc-') ||
      auto.includes('one-time-code')
    ) {
      return true;
    }
    const ident = /pass|pwd|email|e-mail|card|cvv|cvc|otp/i;
    if (ident.test(f.name) || ident.test(f.id)) return true;
    return f.value.includes('@');
  }
  function send(event: RecordedEvent): void {
    // looked up at event time: the binding may be installed after this script runs
    const bound = (window as unknown as Record<string, ((e: RecordedEvent) => void) | undefined>)[
      opts.binding
    ];
    if (bound) bound(event);
  }
  function fieldName(el: Element): string {
    return (
      el.getAttribute('name') || el.getAttribute('id') || describeTarget(el).role?.name || 'field'
    );
  }
  function fieldMeta(el: Element): {
    type: string;
    autocomplete: string;
    name: string;
    id: string;
  } {
    return {
      type: (el.getAttribute('type') || '').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
    };
  }
  function valueOf(el: Element): {
    value: string | null;
    input: string | null;
    field: { type: string; autocomplete: string; name: string; id: string };
  } {
    const native = el as HTMLInputElement;
    const meta = fieldMeta(el);
    if (meta.type === 'checkbox' || meta.type === 'radio') {
      return { value: String(native.checked), input: null, field: meta };
    }
    const raw = native.value ?? '';
    if (isSensitiveField({ ...meta, value: raw })) {
      return { value: null, input: fieldName(el), field: meta };
    }
    return { value: raw, input: null, field: meta };
  }
  function fieldOf(e: Event): Element | null {
    const el = e.target instanceof Element ? e.target : null;
    return el && FIELD_TAGS.includes(el.tagName) ? el : null;
  }
  // the form an element belongs to, as an index into document.forms: stable enough within
  // one page load to let the node side tell whether two events share a form.
  function formIndex(el: Element): number | null {
    const form = el.closest('form');
    if (!form) return null;
    const i = Array.prototype.indexOf.call(document.forms, form);
    return i === -1 ? null : i;
  }
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const el = interactiveAncestor(e.target);
      send({
        kind: 'click',
        target: describeTarget(el),
        value: null,
        input: null,
        scroll: null,
        field: null,
        form: formIndex(el),
      });
    },
    true,
  );
  document.addEventListener(
    'input',
    (e) => {
      const el = fieldOf(e);
      if (el) {
        send({
          kind: 'input',
          target: describeTarget(el),
          ...valueOf(el),
          scroll: null,
          form: formIndex(el),
        });
      }
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const el = fieldOf(e);
      if (el) {
        send({
          kind: 'change',
          target: describeTarget(el),
          ...valueOf(el),
          scroll: null,
          form: formIndex(el),
        });
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter') return;
      const el = e.target instanceof Element ? e.target : document.activeElement;
      if (!el) return;
      send({
        kind: 'keydown',
        target: describeTarget(el),
        value: 'Enter',
        input: null,
        scroll: null,
        field: null,
        form: formIndex(el),
      });
    },
    true,
  );
  let scrollTimer = 0;
  window.addEventListener(
    'scroll',
    () => {
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        send({
          kind: 'scroll',
          target: null,
          value: null,
          input: null,
          scroll: { x: window.scrollX, y: window.scrollY },
          field: null,
          form: null,
        });
      }, opts.scrollDebounce);
    },
    { passive: true },
  );
}

export interface Recording {
  page: Page;
  context: BrowserContext;
  /** resolves when the context closes, after the steps file and the manifest are written. */
  done: Promise<StepsFile>;
}

const BINDING = '__siteRecord';

/**
 * belt-and-braces re-application of the masking rule on the node side, on every event the
 * schema accepted: the page already masks a sensitive field before the value leaves it, but
 * the exposed binding is reachable from any script running on the page, which could call it
 * directly with a forged, schema-valid payload claiming non-sensitive field metadata while
 * still carrying a raw value. that forgery is a bounded risk: recording only runs against a
 * site the user chose to walk with a visible browser, never unattended, and forging a step
 * only affects that user's own recording. a value containing '@' is masked even with no
 * field metadata at all, which a forged event cannot talk its way around.
 */
function maskEvent(ev: RecordedEvent): RecordedEvent {
  if (ev.value === null) return ev;
  const sensitive = ev.field
    ? isSensitiveField({ ...ev.field, value: ev.value })
    : ev.value.includes('@');
  if (!sensitive) return ev;
  const name = ev.field?.name || ev.field?.id || ev.target?.role?.name || ev.input || 'field';
  return { ...ev, value: null, input: name };
}

/**
 * start recording a flow: open the start url in a window-sized page, listen through the
 * binding, and write steps/<flow>.json plus the manifest's flow entry and its open input
 * questions when the context closes. the caller drives the page (a person, or a test).
 */
export async function startRecording(opts: {
  root: string;
  flow: string;
  start: string;
  session: Session;
}): Promise<Recording> {
  if (!FLOW_NAME.test(opts.flow)) {
    throw new Error(`flow name must be lowercase letters, digits and hyphens, got "${opts.flow}"`);
  }
  const pack = new PackPaths(opts.root);
  let manifest: Manifest;
  try {
    manifest = await loadManifest(opts.root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    manifest = newManifest({ host: new URL(opts.start).host, sourceUrl: opts.start });
  }
  const recordedAt = new Date().toISOString();
  const steps: Step[] = [];
  const opened = await openPage(opts.session, DEFAULT_VIEWPORTS.desktop, { viewport: null });
  const { page, context } = opened;

  // the form of the field behind the most recent Enter keydown step, used to scope the
  // implicit-submit echo rule below; stale once anything else gets pushed, since `last` will
  // no longer be that keydown step.
  let lastEnterForm: number | null = null;

  await context.exposeBinding(BINDING, (source: { page: Page }, raw: unknown) => {
    const parsed = RecordedEventSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      console.warn(
        `record: dropped a malformed event from the page: ${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid shape'}`,
      );
      return;
    }
    const ev = maskEvent(parsed.data);
    const at = new Date().toISOString();
    const last = steps[steps.length - 1];
    const sameField = last !== undefined && last.target?.css === ev.target?.css;
    // keystrokes arrive one input event at a time: one step per field, holding the last value
    if (last && sameField && ev.kind === 'input' && last.kind === 'input') {
      last.value = ev.value;
      last.input = ev.input;
      last.at = at;
      return;
    }
    // the change a text field fires on blur repeats the input step before it
    if (
      last &&
      sameField &&
      ev.kind === 'change' &&
      last.kind === 'input' &&
      last.value === ev.value &&
      last.input === ev.input
    ) {
      return;
    }
    // of a run of scrolls only the last offset matters
    if (last && ev.kind === 'scroll' && last.kind === 'scroll') {
      last.scroll = ev.scroll;
      last.at = at;
      return;
    }
    // pressing enter to submit a form's only field makes chromium fire a synchronous change
    // and a click at that form's default submit button as part of the keydown's own default
    // action; replaying the keydown already reproduces the submission, so recording that
    // click too would replay as a second one. scoped to the same form as the keydown's field
    // (by document.forms index) so a genuine click elsewhere, landing in the same window by
    // coincidence, is kept.
    if (
      last &&
      last.kind === 'keydown' &&
      last.value === 'Enter' &&
      (ev.kind === 'change' || ev.kind === 'click') &&
      ev.form !== null &&
      ev.form === lastEnterForm &&
      Date.now() - Date.parse(last.at) < RECORD.implicitSubmitWindow
    ) {
      return;
    }
    steps.push({
      n: steps.length + 1,
      kind: ev.kind,
      target: ev.target,
      value: ev.value,
      input: ev.input,
      scroll: ev.scroll,
      url: source.page.url(),
      at,
    });
    if (ev.kind === 'keydown' && ev.value === 'Enter') lastEnterForm = ev.form;
  });
  await context.addInitScript(
    inPage(recorderInPage, [describeTargetHelper, interactiveAncestorHelper]),
    { binding: BINDING, scrollDebounce: RECORD.scrollDebounce },
  );

  // a navigation soon after an action is where that action led: it becomes the step's url
  const onNavigated = (frame: Frame) => {
    if (frame !== frame.page().mainFrame()) return;
    const last = steps[steps.length - 1];
    if (last && Date.now() - Date.parse(last.at) < RECORD.navigationWindow) last.url = frame.url();
  };
  page.on('framenavigated', onNavigated);
  context.on('page', (p) => p.on('framenavigated', onNavigated));

  async function finish(): Promise<StepsFile> {
    const file: StepsFile = { flow: opts.flow, start: opts.start, recordedAt, steps };
    StepsFileSchema.parse(file);
    await writeJson(pack.stepsFile(opts.flow), file);
    const flow = manifest.flows[opts.flow] ?? { steps: [], inputs: {} };
    for (const s of steps) if (s.input && !(s.input in flow.inputs)) flow.inputs[s.input] = null;
    manifest.flows[opts.flow] = flow;
    for (const [name, value] of Object.entries(flow.inputs)) {
      const id = `flow:${opts.flow}:input:${name}`;
      if (value === null && !manifest.questions.some((q) => q.id === id)) {
        manifest.questions.push({
          id,
          text: `flow "${opts.flow}" needs a value for "${name}": it was typed during recording and not stored. set manifest.flows.${opts.flow}.inputs.${name} before replaying.`,
        });
      }
    }
    await saveManifest(opts.root, manifest);
    return file;
  }
  const done = new Promise<StepsFile>((resolve, reject) => {
    context.once('close', () => {
      finish().then(resolve, reject);
    });
  });

  await page.goto(opts.start, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return { page, context, done };
}
