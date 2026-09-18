import * as http from 'http';

/**
 * A page that exercises every fidelity branch of the recorder:
 *  - a large DOM, a big stylesheet re-read on every snapshot, multi-megabyte
 *    media, an external script bundle,
 *  - a same-origin iframe (multi-frame snapshots),
 *  - an open shadow root (Shadow DOM serialization),
 *  - live form state (checkbox/select/text value markers),
 *  - a constructable/adopted stylesheet,
 *  - an inline <script> whose source must be retained without executing,
 *  - resource-bearing elements whose URLs must be absolutized: link/img/video
 *    poster/srcset, SVG use + image, embed/object, a javascript: anchor and an
 *    inline style url().
 */

export const PORT = 8153;
export const BIG_MEDIA_BYTES = 6 * 1024 * 1024;
export const BIG_IMAGE_BYTES = 5 * 1024 * 1024;

/** A colour only reachable through the external stylesheet. */
export const TITLE_COLOR = 'rgb(1, 2, 3)';

/** Last rule of the big inline stylesheet; present only when CSS is whole. */
export const INLINE_CSS_SENTINEL = '.inline-tail-sentinel';

/** Rule that exists only in the CSSOM (insertRule, empty textContent). */
export const CSSOM_SENTINEL = '.cssom-only-sentinel';

/** Text rendered inside the iframe document. */
export const IFRAME_SENTINEL = 'iframe-sentinel-content-3c92';

/** Text rendered inside an open shadow root. */
export const SHADOW_SENTINEL = 'shadow-sentinel-content-91d5';

/** Inline script source that has to survive in the snapshot but never run. */
export const INLINE_SCRIPT_SENTINEL = 'inline-script-sentinel-7f3a';

/** Element styled only through a document-level adopted stylesheet. */
export const ADOPTED_SENTINEL = 'adopted-stylesheet-sentinel-2b81';

function bigInlineCss(): string {
  const rules = Array.from({ length: 700 },
    (_, i) => `.inline-${i}{padding:${i % 13}px;color:#${(i % 999).toString(16).padStart(3, '0')}}`);
  rules.push(`${INLINE_CSS_SENTINEL}{outline:3px solid rgb(9,8,7)}`);
  return rules.join('');
}

export function buildPage(): string {
  const rows: string[] = [];
  for (let i = 0; i < 1200; i++) {
    rows.push(
      `<tr><td>row ${i}</td><td><span class="cell">value ${i}</span></td>` +
      `<td>${'lorem ipsum dolor sit amet '.repeat(4)}</td></tr>`
    );
  }
  return `<!DOCTYPE html>
<html><head>
<title>Memory Test Page</title>
<link rel="stylesheet" href="/big.css">
<style data-href="/inline.css">.inline { color: rebeccapurple; }</style>
<style id="big-inline">${bigInlineCss()}</style>
<style id="cssom-only"></style>
<script src="/app.js"></script>
</head><body>
<h1 id="title">Memory Test Page</h1>
<button id="btn1">Action One</button>
<button id="btn2">Action Two</button>
<button id="btn3">Action Three</button>
<input id="field" type="text">
<input id="check1" type="checkbox" checked>
<select id="sel"><option value="a">A</option><option value="b" selected>B</option></select>
<iframe id="childFrame" src="/frame.html"></iframe>
<div id="shadow-host"></div>
<div class="adopted-sentinel">${ADOPTED_SENTINEL}</div>
<img src="/small.png" width="20" height="20">
<img src="/huge.png" width="20" height="20">
<video src="/huge.mp4" poster="/small.png" preload="auto" muted></video>
<a id="rel-link" href="/frame.html">relative link</a>
<img id="srcset-img" srcset="/small.png 1x, /small.png 2x" width="10" height="10">
<svg width="20" height="20"><use href="#sym"/></svg>
<svg><image href="/small.png" width="10" height="10"/></svg>
<embed src="/small.png" type="image/png">
<object data="/small.png" type="image/png"></object>
<a href="javascript:alert(1)" id="js-link">javascript link</a>
<div id="inline-bg" style="background:url(/small.png)"></div>
<div class="inline-tail-sentinel">styled only by the tail of the inline sheet</div>
<div class="cssom-only-sentinel">styled only from the CSSOM</div>
<table>${rows.join('')}</table>
<script>
  window.INLINE_SCRIPT_SENTINEL = '${INLINE_SCRIPT_SENTINEL}';
  // Populate the CSSOM-only sheet the way a CSS-in-JS runtime would: rules go in
  // through insertRule, leaving the element's textContent empty.
  (function () {
    var sheet = document.getElementById('cssom-only').sheet;
    for (var i = 0; i < 40; i++)
      sheet.insertRule('.cssom-gen-' + i + '{margin:' + (i % 7) + 'px}', i);
    sheet.insertRule('${CSSOM_SENTINEL}{letter-spacing:3px}', 40);
  })();
  // Open shadow root with content the light DOM cannot contain.
  document.getElementById('shadow-host')
    .attachShadow({ mode: 'open' })
    .innerHTML = '<style>.sh { color: green; }</style>' +
      '<span class="sh">${SHADOW_SENTINEL}</span>';
  // Constructable stylesheet adopted by the whole document.
  var adopted = new CSSStyleSheet();
  adopted.replaceSync('.adopted-sentinel { color: rgb(6, 5, 4); }');
  document.adoptedStyleSheets = [adopted];
  // Pull the big media file through the ordinary network stack: media elements
  // load via a separate pipeline whose body CDP cannot always return, while a
  // fetch() response can. Exercises "media MIME types are retained, not dropped".
  fetch('/huge.mp4').then(function (r) { return r.arrayBuffer(); }).catch(function () {});
</script>
</body></html>`;
}

export function buildFramePage(): string {
  return `<!DOCTYPE html>
<html><head><title>Child Frame</title></head>
<body>
<h2 id="frame-title">${IFRAME_SENTINEL}</h2>
<button id="frame-btn">Frame Action</button>
</body></html>`;
}

export function startServer(): Promise<http.Server> {
  const css = [
    `#title { color: ${TITLE_COLOR}; font-style: italic; }`,
    ...Array.from({ length: 4000 },
      (_, i) => `.rule-${i} { margin: ${i % 20}px; color: #${(i % 999).toString(16).padStart(3, '0')}; }`)
  ].join('\n');

  const smallPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64');
  const hugePng = Buffer.concat([smallPng, Buffer.alloc(BIG_IMAGE_BYTES, 0x41)]);
  const hugeMp4 = Buffer.alloc(BIG_MEDIA_BYTES, 0x42);

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (type: string, body: string | Buffer) => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    switch (url) {
      case '/':
      case '/index.html': return send('text/html; charset=utf-8', buildPage());
      case '/frame.html': return send('text/html; charset=utf-8', buildFramePage());
      case '/big.css': return send('text/css', css);
      case '/app.js': return send('application/javascript',
        `console.log('app booted');\n${'// filler\n'.repeat(20000)}`);
      case '/small.png': return send('image/png', smallPng);
      case '/huge.png': return send('image/png', hugePng);
      case '/huge.mp4': return send('video/mp4', hugeMp4);
      default:
        res.writeHead(404); res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}
