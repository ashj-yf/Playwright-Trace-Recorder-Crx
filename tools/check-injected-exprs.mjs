#!/usr/bin/env node
/**
 * Guards the injected page expressions in src/service_worker.js.
 *
 * These expressions are built as template literals that the recorder ships into
 * a page through CDP. A backtick inside one of them - trivially introduced by
 * writing `someName` in a comment - terminates the literal early. The file still
 * passes `node --check`, because the truncated remainder parses as a different
 * (tagged-template) expression, but the string handed to the page is broken and
 * every snapshot capture throws at runtime. That is exactly how a documented
 * comment once took the whole recorder down.
 *
 * The e2e suite catches this too, but only after a full browser run; this is the
 * cheap static gate. It flags the precise failure mode: an unescaped backtick
 * or `${` inside a line comment that sits within an injected template literal.
 *
 * Usage: node tools/check-injected-exprs.mjs [path-to-service-worker.js]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, '..', 'src', 'service_worker.js');

const lines = fs.readFileSync(target, 'utf8').split('\n');

// Regions that are injected into a page: a constant named *EXPR, or a builder
// function whose body returns the `(function(){...` prelude.
const CONST_EXPR = /^const\s+([A-Z][A-Z0-9_]*EXPR)\s*=\s*`/;
const BUILDER = /^function\s+(\w+)\s*\([^)]*\)\s*\{\s*$/;
const RETURNS_TEMPLATE = /return\s+`/;

let regions = 0;
const problems = [];

for (let i = 0; i < lines.length; i++) {
  const constMatch = lines[i].match(CONST_EXPR);
  const builderMatch = lines[i].match(BUILDER);

  let start = -1;
  let name = '';
  if (constMatch) {
    start = i;
    name = constMatch[1];
  } else if (builderMatch) {
    // Scan the function body for its `return \`...\`` template.
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\}/.test(lines[j])) break;                  // function ended
      if (RETURNS_TEMPLATE.test(lines[j])) { start = j; name = builderMatch[1]; break; }
    }
  }
  if (start < 0) continue;

  regions++;
  const openCol = lines[start].indexOf('`');
  let end = start;
  // The literal ends at the first backtick that closes it; track nesting of
  // `${ }` so a backtick inside an interpolation is not mistaken for the end.
  let depth = 0;
  let closed = false;
  for (let j = start; j < lines.length && !closed; j++) {
    const text = j === start ? lines[j].slice(openCol + 1) : lines[j];
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      const next = text[k + 1];
      if (ch === '\\') { k++; continue; }               // escaped char
      if (ch === '$' && next === '{') { depth++; k++; continue; }
      if (ch === '}' && depth > 0) { depth--; continue; }
      if (ch === '`' && depth === 0) { end = j; closed = true; break; }
    }
  }
  if (!closed) continue;

  // Inspect the region for backticks / `${` hidden in line comments.
  for (let j = start; j <= end; j++) {
    const raw = j === start ? lines[j].slice(openCol + 1) : lines[j];
    // Strip a trailing interpolated value line's closing backtick.
    const commentAt = raw.indexOf('//');
    if (commentAt < 0) continue;
    const comment = raw.slice(commentAt);
    if (comment.includes('`')) {
      problems.push(`${name}: line ${j + 1} has a backtick inside a comment — ` +
        `this terminates the injected template literal:\n      ${raw.trim()}`);
    }
    if (/\$\{/.test(comment)) {
      problems.push(`${name}: line ${j + 1} has \${ inside a comment — ` +
        `this is evaluated as an interpolation:\n      ${raw.trim()}`);
    }
  }
}

if (problems.length) {
  console.log(`\n❌ ${problems.length} problem(s) in injected expressions:\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('');
  process.exit(1);
}
console.log(`✅ ${regions} injected expression(s) clean ` +
  `(no backticks or \${ in their comments)`);
process.exit(0);
