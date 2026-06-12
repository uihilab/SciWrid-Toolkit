#!/usr/bin/env node
/**
 * scripts/build-docs.js — render the Markdown docs into styled HTML pages that
 * match the demo design system (examples/index.html).
 *
 *   npm run build:docs
 *   → writes docs/api.html      (from docs/API.md)
 *     writes readme.html        (from README.md)
 *
 * The Markdown files remain the single source of truth; re-run this whenever
 * they change. A focused converter handles exactly the constructs these two
 * files use: ATX headings, fenced code, GitHub tables, ordered/unordered lists,
 * blockquotes, horizontal rules, and inline code / bold / emphasis / links.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');

/* ── inline + helpers ─────────────────────────────────────────────────────── */

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// GitHub-compatible heading slug, so existing #anchor deep links keep working.
function slug(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

// Faithful but emoji-free: swap the two status glyphs for clean inline marks.
function deEmoji(s) {
  return s
    .replace(/✅️?/g, '<span class="mk mk-ok" aria-label="supported"></span>')
    .replace(/⚠️?/g, '<span class="mk mk-warn" aria-label="partial"></span>');
}

// Rewrite Markdown links that point at the source .md files to the built pages.
function rewriteHref(href) {
  return href
    .replace(/(^|\/)README\.md/i, '$1readme.html')
    .replace(/(^|\/)API\.md/i, '$1api.html');
}

function inline(srcRaw) {
  // 1. pull code spans out so their contents are never treated as markup.
  //    The {{Cn}} sentinel can't occur in the Markdown source, so restoring is
  //    unambiguous (a bare " 5 " in prose would not be).
  const codes = [];
  let src = srcRaw.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `{{C${codes.length - 1}}}`;
  });
  // 2. escape the rest
  src = esc(src);
  // 3. links (text may contain code placeholders)
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => {
    const href = rewriteHref(h.trim());
    const ext = /^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${href}"${ext}>${t}</a>`;
  });
  // 4. bold, then emphasis
  src = src
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // 5. restore code spans
  src = src.replace(/\{\{C(\d+)\}\}/g, (_, i) => codes[+i]);
  return deEmoji(src);
}

function cells(row) {
  // protect escaped pipes (\|), split on the real ones, then restore them
  const parts = row.replace(/\\\|/g, '{{P}}').trim().replace(/^\||\|$/g, '').split('|');
  return parts.map((c) => c.replace(/\{\{P\}\}/g, '|').trim());
}

/* ── block parser ─────────────────────────────────────────────────────────── */

function parse(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  const isSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push({ t: 'code', lang: fence[1], text: buf.join('\n') });
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push({ t: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }

    // horizontal rule
    if (/^---+\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', text: buf.join(' ') });
      continue;
    }

    // table (header row + separator)
    if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ t: 'table', head, rows });
      continue;
    }

    // list (ordered or unordered)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    // paragraph
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    blocks.push({ t: 'p', text: buf.join(' ') });
  }
  return blocks;
}

function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h': {
        const id = slug(b.text);
        out.push(`<h${b.level} id="${id}">${inline(b.text)}</h${b.level}>`);
        break;
      }
      case 'p':
        out.push(`<p>${inline(b.text)}</p>`);
        break;
      case 'hr':
        out.push('<hr>');
        break;
      case 'quote':
        out.push(`<blockquote>${inline(b.text)}</blockquote>`);
        break;
      case 'code':
        out.push(`<pre><code>${esc(b.text)}</code></pre>`);
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push(
          `<${tag}>${b.items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`,
        );
        break;
      }
      case 'table': {
        const head = b.head.map((c) => `<th>${inline(c)}</th>`).join('');
        const body = b.rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('');
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
        );
        break;
      }
    }
  }
  return out.join('\n');
}

/* ── page shell (shared design system) ────────────────────────────────────── */

function shell({ title, kicker, heroTitle, lead, pills, navActive, toc, body }) {
  const navLink = (href, label, key) =>
    `<a href="${href}"${navActive === key ? ' aria-current="page" class="active"' : ''}>${label}</a>`;
  const pillsHtml = pills?.length
    ? `<div class="formats">${pills.map((p) => `<span class="pill">${p}</span>`).join('')}</div>`
    : '';
  const tocHtml = toc.length
    ? `<nav class="doc-toc" aria-label="On this page">
        <p class="toc-title">On this page</p>
        <ul>${toc.map((t) => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join('')}</ul>
      </nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --radius: 0.625rem;
      --background: oklch(0.992 0.004 240);
      --foreground: oklch(0.21 0.03 252);
      --card: oklch(1 0.002 240);
      --card-foreground: oklch(0.21 0.03 252);
      --secondary: oklch(0.96 0.01 240);
      --secondary-foreground: oklch(0.28 0.04 252);
      --muted: oklch(0.965 0.008 240);
      --muted-foreground: oklch(0.52 0.03 248);
      --accent: oklch(0.95 0.02 242);
      --accent-foreground: oklch(0.28 0.04 252);
      --brand: oklch(0.55 0.16 245);
      --brand-foreground: oklch(0.99 0.005 240);
      --border: oklch(0.91 0.012 245);
      --input: oklch(0.86 0.014 245);
      --ring: oklch(0.55 0.16 245);
      --success: oklch(0.6 0.13 165);
      --warn: oklch(0.68 0.15 70);
      --shadow-tint: oklch(0.45 0.05 250 / 0.10);
      --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --font-mono: ui-monospace, "Cascadia Code", "Consolas", "Courier New", monospace;
      --check: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M13.5 4.5 6.5 11.5 2.5 7.5" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      --alert: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1z" fill="none" stroke="black" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6v3.4M8 11.6v.2" stroke="black" stroke-width="1.6" stroke-linecap="round"/></svg>');
    }
    .dark {
      --background: oklch(0.17 0.022 250);
      --foreground: oklch(0.97 0.006 240);
      --card: oklch(0.205 0.025 252);
      --card-foreground: oklch(0.97 0.006 240);
      --secondary: oklch(0.27 0.03 252);
      --secondary-foreground: oklch(0.97 0.006 240);
      --muted: oklch(0.24 0.025 252);
      --muted-foreground: oklch(0.69 0.025 245);
      --accent: oklch(0.29 0.04 250);
      --accent-foreground: oklch(0.97 0.006 240);
      --brand: oklch(0.70 0.13 240);
      --brand-foreground: oklch(0.17 0.022 250);
      --border: oklch(0.30 0.03 252);
      --input: oklch(0.30 0.03 252);
      --ring: oklch(0.70 0.13 240);
      --success: oklch(0.72 0.15 165);
      --warn: oklch(0.78 0.15 75);
      --shadow-tint: oklch(0 0 0 / 0.35);
    }

    * { box-sizing: border-box; }
    body {
      font-family: var(--font-sans); margin: 0; line-height: 1.6;
      background-color: var(--background);
      background-image:
        radial-gradient(1100px 480px at 8% -10%, oklch(from var(--brand) l c h / 0.10), transparent 55%),
        radial-gradient(900px 420px at 100% 0%, oklch(from var(--brand) l c h / 0.06), transparent 60%);
      background-attachment: fixed; background-repeat: no-repeat;
      color: var(--foreground);
    }
    a { color: inherit; text-decoration: none; }

    /* header */
    .site-header {
      position: sticky; top: 0; z-index: 20;
      background: oklch(from var(--background) l c h / 0.92);
      border-bottom: 1px solid var(--border); backdrop-filter: blur(12px);
    }
    .site-header-inner {
      width: min(1200px, calc(100% - 2rem)); margin: 0 auto; min-height: 64px;
      display: flex; align-items: center; gap: 1rem;
    }
    .brand { display: inline-flex; align-items: center; gap: .75rem; min-width: max-content; }
    .brand-mark {
      width: 32px; height: 32px; display: inline-grid; place-items: center;
      background: var(--brand); color: var(--brand-foreground);
      border-radius: calc(var(--radius) - 2px); font-size: 12px; font-weight: 700;
      box-shadow: 0 2px 8px oklch(from var(--brand) l c h / 0.35);
    }
    .brand strong { display: block; font-size: 14px; line-height: 1.1; }
    .brand span:last-child span { display: block; color: var(--muted-foreground); font-size: 11px; line-height: 1.2; }
    .site-nav { display: flex; align-items: center; gap: .25rem; margin-left: auto; }
    .site-nav a {
      padding: 6px 10px; color: var(--muted-foreground);
      border-radius: calc(var(--radius) - 2px); font-size: 13px; font-weight: 500; white-space: nowrap;
    }
    .site-nav a:hover, .site-nav a:focus-visible { background: var(--accent); color: var(--accent-foreground); outline: none; }
    .site-nav a.active { color: var(--foreground); background: var(--accent); }
    #theme-toggle {
      padding: 6px 10px; min-width: 36px; background: transparent; color: var(--muted-foreground);
      border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
      cursor: pointer; opacity: .85; font-size: 14px;
    }
    #theme-toggle:hover { opacity: 1; background: var(--accent); }

    /* hero */
    .page-hero {
      width: min(1200px, calc(100% - 2rem)); margin: 1.5rem auto 0;
      padding: clamp(1.5rem, 1rem + 3vw, 2.75rem) clamp(1.25rem, .5rem + 2.5vw, 2.5rem);
      border: 1px solid var(--border); border-radius: calc(var(--radius) + 6px);
      background: linear-gradient(180deg, oklch(from var(--brand) l c h / 0.07), transparent 45%), var(--card);
      box-shadow: 0 1px 2px var(--shadow-tint), 0 30px 70px -50px var(--shadow-tint);
    }
    .kicker {
      color: var(--brand); font-size: 12px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; margin: 0 0 .6rem; display: inline-flex; align-items: center; gap: .5rem;
    }
    .kicker::before { content: ""; width: 18px; height: 2px; border-radius: 2px; background: var(--brand); }
    .page-hero h1 {
      margin: 0; font-size: clamp(1.8rem, 1.3rem + 2.4vw, 2.6rem);
      line-height: 1.05; letter-spacing: -0.03em; font-weight: 600;
    }
    .page-hero .lead { max-width: 64ch; margin: 1rem 0 0; color: var(--muted-foreground); font-size: 1.05rem; }
    .formats { margin-top: 1.1rem; display: flex; flex-wrap: wrap; gap: .4rem; }
    .pill {
      font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
      background: var(--secondary); color: var(--secondary-foreground); border: 1px solid var(--border);
    }

    /* doc layout */
    .doc-layout {
      width: min(1200px, calc(100% - 2rem)); margin: 2rem auto 0;
      display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 3rem;
      padding-bottom: 4rem; align-items: start;
    }
    .doc-toc { position: sticky; top: 84px; }
    .doc-toc .toc-title {
      margin: 0 0 .6rem; font-size: 11px; font-weight: 700; letter-spacing: .07em;
      text-transform: uppercase; color: var(--muted-foreground);
    }
    .doc-toc ul { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
    .doc-toc li { margin: 0; }
    .doc-toc a {
      display: block; padding: 5px 0 5px 14px; margin-left: -1px;
      border-left: 2px solid transparent; color: var(--muted-foreground);
      font-size: 12.5px; line-height: 1.35;
    }
    .doc-toc a code { font-size: .95em; background: none; padding: 0; border: 0; }
    .doc-toc a:hover { color: var(--foreground); }
    .doc-toc a.active { color: var(--brand); border-left-color: var(--brand); font-weight: 600; }

    /* doc content */
    .doc-content { min-width: 0; }
    .doc-content h2 {
      margin: 2.4rem 0 .9rem; padding-top: .4rem; font-size: 1.5rem; font-weight: 600;
      letter-spacing: -0.02em; line-height: 1.2; scroll-margin-top: 84px;
    }
    .doc-content h2:first-child { margin-top: .5rem; }
    .doc-content h3 {
      margin: 1.8rem 0 .7rem; font-size: 1.12rem; font-weight: 600;
      letter-spacing: -0.01em; scroll-margin-top: 84px;
    }
    .doc-content h4 { margin: 1.3rem 0 .5rem; font-size: 1rem; font-weight: 600; }
    .doc-content h2 code, .doc-content h3 code { font-size: .92em; color: var(--brand); background: none; border: 0; padding: 0; }
    .doc-content p { margin: .75rem 0; color: var(--foreground); max-width: 72ch; }
    .doc-content a:not(.pill) {
      color: var(--brand); border-bottom: 1px dashed oklch(from var(--brand) l c h / 0.45);
    }
    .doc-content a:hover { border-bottom-style: solid; }
    .doc-content ul, .doc-content ol { margin: .75rem 0; padding-left: 1.3rem; max-width: 72ch; }
    .doc-content li { margin: .35rem 0; }
    .doc-content li::marker { color: var(--muted-foreground); }
    .doc-content code {
      font-family: var(--font-mono); font-size: .85em;
      background: var(--secondary); padding: 1px 6px; border-radius: 5px;
      border: 1px solid var(--border); color: var(--foreground);
    }
    .doc-content pre {
      margin: 1rem 0; padding: 1rem 1.1rem; overflow-x: auto;
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); box-shadow: 0 1px 2px var(--shadow-tint);
    }
    .doc-content pre code {
      font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7;
      background: none; border: 0; padding: 0; color: var(--foreground);
    }
    .doc-content blockquote {
      margin: 1rem 0; padding: .7rem 1.1rem; color: var(--muted-foreground);
      border-left: 3px solid var(--brand);
      background: oklch(from var(--brand) l c h / 0.05);
      border-radius: 0 var(--radius) var(--radius) 0;
    }
    .doc-content blockquote p { margin: 0; max-width: none; }
    .doc-content hr { margin: 2rem 0; border: 0; border-top: 1px solid var(--border); }
    .table-wrap { margin: 1rem 0; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
    .doc-content table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    .doc-content th, .doc-content td {
      padding: .55rem .8rem; text-align: left; vertical-align: top;
      border-bottom: 1px solid var(--border);
    }
    .doc-content thead th {
      background: var(--secondary); color: var(--secondary-foreground);
      font-weight: 600; white-space: nowrap;
    }
    .doc-content tbody tr:last-child td { border-bottom: 0; }
    .doc-content tbody tr:hover { background: oklch(from var(--accent) l c h / 0.4); }
    .doc-content td code { white-space: nowrap; }

    /* status marks (emoji-free) */
    .mk { display: inline-block; width: 15px; height: 15px; vertical-align: -2px; margin-right: .15rem; }
    .mk-ok { background: var(--success); -webkit-mask: var(--check) center/contain no-repeat; mask: var(--check) center/contain no-repeat; }
    .mk-warn { background: var(--warn); -webkit-mask: var(--alert) center/contain no-repeat; mask: var(--alert) center/contain no-repeat; }

    .doc-foot {
      width: min(1200px, calc(100% - 2rem)); margin: 0 auto; padding: 1.5rem 0 3rem;
      border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: .85rem;
    }
    .doc-foot a { color: var(--brand); }
    .doc-foot code { font-family: var(--font-mono); background: var(--secondary); padding: 1px 6px; border-radius: 5px; }

    @media (max-width: 900px) {
      .doc-layout { grid-template-columns: 1fr; gap: 1.5rem; }
      .doc-toc { display: none; }
    }
  </style>
  <script>
    /* Apply the saved/system theme before first paint. Shares 'apidemo-theme'. */
    (function () {
      var stored = localStorage.getItem('apidemo-theme');
      var dark = stored ? stored === 'dark'
        : window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', dark);
    })();
  </script>
</head>
<body>
  <header class="site-header">
    <div class="site-header-inner">
      <a class="brand" href="/">
        <span class="brand-mark">wp</span>
        <span><strong>webparsers</strong><span>documentation</span></span>
      </a>
      <nav class="site-nav" aria-label="Primary">
        ${navLink('/docs/api.html', 'API', 'api')}
        ${navLink('/readme.html', 'README', 'readme')}
        ${navLink('/examples/api-demo.html', 'Demos', 'demos')}
        ${navLink('https://github.com/uihilab/webparsers', 'GitHub', 'github')}
        <button id="theme-toggle" type="button" aria-label="Toggle light/dark theme">&#9685;</button>
      </nav>
    </div>
  </header>

  <section class="page-hero">
    <p class="kicker">${kicker}</p>
    <h1>${heroTitle}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ''}
    ${pillsHtml}
  </section>

  <main class="doc-layout">
    ${tocHtml}
    <article class="doc-content">
${body}
    </article>
  </main>

  <footer class="doc-foot">
    Generated from <code>${navActive === 'api' ? 'docs/API.md' : 'README.md'}</code> &middot;
    <a href="https://github.com/uihilab/webparsers">github.com/uihilab/webparsers</a> &middot;
    run the demos with <code>npm run demo:web</code>.
  </footer>

  <script>
    /* Theme toggle — touches only the .dark class + localStorage. */
    (function () {
      var btn = document.getElementById('theme-toggle');
      function sync() {
        var dark = document.documentElement.classList.contains('dark');
        btn.innerHTML = dark ? '&#9728;' : '&#9685;';
        btn.setAttribute('aria-pressed', String(dark));
      }
      btn.addEventListener('click', function () {
        var dark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('apidemo-theme', dark ? 'dark' : 'light');
        sync();
      });
      sync();
    })();
  </script>
  <script>
    /* Highlight the current section in the on-this-page nav. */
    (function () {
      var links = Array.prototype.slice.call(document.querySelectorAll('.doc-toc a'));
      if (!links.length || !('IntersectionObserver' in window)) return;
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
      var targets = links
        .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
        .filter(Boolean);
      var current = null;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) current = e.target.id; });
        links.forEach(function (a) { a.classList.remove('active'); });
        if (current && byId[current]) byId[current].classList.add('active');
      }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
      targets.forEach(function (t) { io.observe(t); });
    })();
  </script>
</body>
</html>`;
}

/* ── build ────────────────────────────────────────────────────────────────── */

async function build(srcRel, outRel, { kicker, navActive, pills }) {
  const md = await readFile(resolve(root, srcRel), 'utf8');
  const blocks = parse(md);

  // Lift a leading H1 (+ following paragraph) into the hero.
  let heroTitle = '';
  let lead = '';
  if (blocks[0]?.t === 'h' && blocks[0].level === 1) heroTitle = inline(blocks.shift().text);
  if (blocks[0]?.t === 'p') lead = inline(blocks.shift().text);

  const toc = blocks
    .filter((b) => b.t === 'h' && b.level === 2)
    .map((b) => ({ id: slug(b.text), text: b.text }));

  const html = shell({
    title: `webparsers — ${navActive === 'api' ? 'API reference' : 'README'}`,
    kicker,
    heroTitle: heroTitle || 'webparsers',
    lead,
    pills,
    navActive,
    toc,
    body: renderBlocks(blocks),
  });

  await writeFile(resolve(root, outRel), html);
  console.log(`build:docs -> wrote ${outRel}  (${toc.length} sections)`);
}

await build('docs/API.md', 'docs/api.html', {
  kicker: 'API reference',
  navActive: 'api',
  pills: ['GRIB2', 'NetCDF3', 'NetCDF4 / HDF5', 'Zarr v2', 'TIFF / GeoTIFF / COG'],
});

await build('README.md', 'readme.html', {
  kicker: 'Project overview',
  navActive: 'readme',
  pills: null,
});
