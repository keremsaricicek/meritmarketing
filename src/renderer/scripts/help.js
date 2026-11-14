'use strict';
/* =====================================================================
   Help: the user manual, inside the application.

   The manual is the same Markdown as docs/USER-MANUAL.md and
   docs/KULLANIM-KILAVUZU.md, bundled by scripts/build-help.js into
   help-content.js (window.HELP_CONTENT) — the window's policy forbids any
   fetch, and the manual must work with no network at all.

   The Markdown is turned into DOM nodes with createElement and textContent.
   No string from the manual is ever parsed as HTML, links may only point at
   headings inside the manual, and images may only come from the bundled
   manual-images folder.
   ===================================================================== */

function helpSlug(text){
  return 'help-' + String(text).toLowerCase()
    .replace(/['’]/g, '')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* Inline: **bold**, `code`, [text](#anchor) and plain text — as nodes. */
function helpInline(parent, text){
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0, m;
  while ((m = re.exec(text))){
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]){ const b = document.createElement('strong'); b.textContent = m[2]; parent.appendChild(b); }
    else if (m[3]){ const c = document.createElement('code'); c.textContent = m[4]; parent.appendChild(c); }
    else if (m[5]){
      const target = m[7];
      if (target.startsWith('#')){
        /* Only jumps inside the manual. The heading id is derived the same way
           the headings derive theirs. */
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = m[6];
        a.dataset.helpTarget = helpSlug(decodeURIComponent(target.slice(1)));
        parent.appendChild(a);
      } else {
        /* An outside address is shown as text, never as a link. */
        parent.appendChild(document.createTextNode(m[6]));
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function helpImage(src, alt){
  /* Bundled images only: a bare file name inside manual-images/. */
  const name = String(src).split('/').pop();
  if (!/^[a-z0-9._-]+\.png$/i.test(name)) return null;
  const fig = document.createElement('figure');
  fig.className = 'help-figure';
  const img = document.createElement('img');
  img.src = './manual-images/' + name;
  img.alt = alt || '';
  img.loading = 'lazy';
  fig.appendChild(img);
  if (alt){ const cap = document.createElement('figcaption'); cap.textContent = alt; fig.appendChild(cap); }
  return fig;
}

/** Markdown → a DocumentFragment, plus the list of level-2 headings. */
function helpRender(markdown){
  const frag = document.createDocumentFragment();
  const toc = [];
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const isBlockStart = (l) => /^(#{1,4}\s|[-*]\s|\d+\.\s|>\s?|\|)/.test(l) || /^---+$/.test(l) || /^!\[/.test(l) || l.startsWith('```');
  while (i < lines.length){
    const line = lines[i];
    if (!line.trim()){ i++; continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))){
      const level = m[1].length;
      const h = document.createElement('h' + Math.min(6, level + 1));
      const text = m[2].trim();
      h.id = helpSlug(text);
      helpInline(h, text);
      frag.appendChild(h);
      /* The manual's own contents list is already the sidebar. */
      if (level === 2 && !/^(contents|içindekiler)$/i.test(text)) toc.push({ id: h.id, text });
      i++; continue;
    }
    if (/^---+$/.test(line.trim())){ frag.appendChild(document.createElement('hr')); i++; continue; }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim()))){
      const fig = helpImage(m[2], m[1]);
      if (fig) frag.appendChild(fig);
      i++; continue;
    }
    if (line.startsWith('```')){
      const pre = document.createElement('pre');
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      pre.textContent = body.join('\n');
      frag.appendChild(pre);
      continue;
    }
    if (/^>\s?/.test(line)){
      const q = document.createElement('blockquote');
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ''));
      const p = document.createElement('p');
      helpInline(p, parts.join(' '));
      q.appendChild(p);
      frag.appendChild(q);
      continue;
    }
    if (line.startsWith('|')){
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const table = document.createElement('table');
      table.className = 'help-table';
      const head = document.createElement('thead');
      const hr = document.createElement('tr');
      cells(rows[0]).forEach(c => { const th = document.createElement('th'); th.scope = 'col'; helpInline(th, c); hr.appendChild(th); });
      head.appendChild(hr);
      table.appendChild(head);
      const body = document.createElement('tbody');
      rows.slice(1).filter(r => !/^\|[\s:|-]+\|?$/.test(r)).forEach(r => {
        const tr = document.createElement('tr');
        cells(r).forEach(c => { const td = document.createElement('td'); helpInline(td, c); tr.appendChild(td); });
        body.appendChild(tr);
      });
      table.appendChild(body);
      const wrap = document.createElement('div');
      wrap.className = 'help-table-wrap';
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }
    if (/^([-*]|\d+\.)\s/.test(line)){
      const ordered = /^\d+\.\s/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])){
        const li = document.createElement('li');
        let text = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        i++;
        /* a wrapped list item continues on indented lines */
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) text += ' ' + lines[i++].trim();
        helpInline(li, text);
        list.appendChild(li);
      }
      frag.appendChild(list);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    const p = document.createElement('p');
    helpInline(p, para.join(' '));
    frag.appendChild(p);
  }
  return { frag, toc };
}

let helpRenderedLang = null;
function renderHelp(){
  const body = el('helpBody'), tocNode = el('helpToc');
  if (!body || !tocNode) return;
  const lang = currentLanguage();
  const content = (window.HELP_CONTENT || {})[lang] || (window.HELP_CONTENT || {}).en || '';
  if (helpRenderedLang === lang && body.childNodes.length) return;
  const { frag, toc } = helpRender(content);
  body.replaceChildren(frag);
  const title = document.createElement('div');
  title.className = 'help-toc-title';
  title.textContent = t('h.contents');
  const list = document.createElement('ol');
  for (const item of toc){
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = item.text;
    a.dataset.helpTarget = item.id;
    li.appendChild(a);
    list.appendChild(li);
  }
  tocNode.replaceChildren(title, list);
  helpRenderedLang = lang;
  body.scrollTop = 0;
}

/* One listener for every in-manual jump, in the contents or the text. */
document.addEventListener('click', (e) => {
  const a = e.target?.closest?.('[data-help-target]');
  if (!a) return;
  e.preventDefault();
  const target = document.getElementById(a.dataset.helpTarget);
  if (target) target.scrollIntoView({ block:'start', behavior:'smooth' });
});
