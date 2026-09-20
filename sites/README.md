# sites

captured packs live here, one directory per host. **nothing in this directory is committed**
except this note: a pack holds another site's pages, copy, screenshots and a browser profile,
and it is an input the tool regenerates on demand, never source.

make one:

```bash
./bin/site explore https://example.com/ --out sites/example.com
./bin/site capture --pack sites/example.com
```

what a pack looks like when it is there:

```
sites/<host>/
  manifest.json          the index and the queue: every unit, its status, its dependencies
  pages/<slug>/          one directory per page; a url's path segments joined with `--`
    meta.json            viewports, masks, fonts, colours, motion
    sections.json        the sections the extractor found, with their boxes
    styles.json          computed styles per element, keyed by a stable dom path
    text.json            the page's text
    animations.json      keyframes and the animations observed
    dom.html             the dom as captured
    snapshot.html        a standalone copy with its assets inlined or rewritten
    assets/              images, fonts and stylesheets, named by a hash of their url
    desktop/, mobile/    full.png, section crops, video.webm and frames when kept
  steps/<flow>.json      a recorded flow, with sensitive fields masked and never stored
  runs/<run>/            what a build or a verify wrote: diffs, contact sheets, logs
  profile/               the browser profile a capture used, when one was kept
```

the rebuild that a pack drives goes to `builds/<host>/`, which is not committed either.
