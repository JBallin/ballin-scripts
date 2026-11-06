// Render trusted repository Markdown. Bundle text never passes through this renderer.
const fs = require('node:fs');
const path = require('node:path').posix;
const MarkdownIt = require('../../site/node_modules/markdown-it');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const pages = new Set(input.pages.map(page => page.path));
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
const outputPath = file => file === 'README.md' ? 'index.html' : file.replace(/README\.md$/, 'index.md').replace(/\.md$/, '.html');
const rendered = input.pages.map(page => {
  const md = new MarkdownIt({ html: true, linkify: false });
  const counts = new Map();
  const headingIds = new Set();
  const rewrite = value => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return value;
    const match = /^([^?#]*)(.*)$/.exec(value);
    if (match[1].startsWith('/')) throw new Error('Use repository-relative links instead of root-relative URLs: ' + value + ' in ' + page.path);
    if (/%(?:2f|5c|00)/i.test(match[1])) throw new Error('Encoded path separators or NUL are unsupported: ' + value + ' in ' + page.path);
    const target = path.normalize(path.join(path.dirname(page.path), decodeURIComponent(match[1])));
    if (target.startsWith('../') || target.startsWith('/')) throw new Error('Link outside repository: ' + value);
    let destination;
    if (pages.has(target)) destination = input.base + '/' + encodePath(outputPath(target));
    else if (target.startsWith('docs/assets/') && !target.endsWith('.md')) destination = input.base + '/' + encodePath(target);
    else destination = input.sourceBase + '/' + encodePath(target);
    return destination + match[2];
  };
  md.core.ruler.push('site-links-and-headings', state => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type === 'blockquote_open' && state.tokens[i + 2]?.type === 'inline') {
        const inline = state.tokens[i + 2];
        const alert = /^\[!(TIP|NOTE|WARNING|IMPORTANT|CAUTION)\](?:\n|$)/.exec(inline.content);
        if (alert) {
          token.attrSet('class', 'alert');
          inline.content = alert[1][0] + alert[1].slice(1).toLowerCase() + ': ' + inline.content.slice(alert[0].length);
          inline.children = [];
          md.inline.parse(inline.content, md, state.env, inline.children);
        }
      }
      if (token.type === 'heading_open') {
        const title = state.tokens[i + 1].children.filter(t => ['text', 'code_inline'].includes(t.type)).map(t => t.content).join('');
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
        let count = counts.get(slug) || 0;
        let id = slug + (count ? '-' + count : '');
        while (headingIds.has(id)) id = slug + '-' + (++count);
        counts.set(slug, count + 1);
        headingIds.add(id);
        token.attrSet('id', id);
      }
      for (const child of token.children || []) {
        if (child.type === 'link_open') child.attrSet('href', rewrite(child.attrGet('href')));
        if (child.type === 'image') child.attrSet('src', rewrite(child.attrGet('src')));
      }
      const rewriteHtml = html => html.replace(/\b(href|src)=(['"])(.*?)\2/g, (_, attr, quote, url) => attr + '=' + quote + rewrite(url) + quote);
      if (token.type === 'html_block') token.content = rewriteHtml(token.content);
      for (const child of token.children || []) if (child.type === 'html_inline') child.content = rewriteHtml(child.content);
    }
  });
  const tokens = md.parse(page.text, {});
  const heading = tokens.findIndex(t => t.type === 'heading_open');
  return { path: outputPath(page.path), source: page.path, title: heading >= 0 ? tokens[heading + 1].content : 'Ballin', content: md.renderer.render(tokens, md.options, {}) };
});
const outputPaths = new Set();
for (const page of rendered) {
  if (outputPaths.has(page.path)) throw new Error('Duplicate site output path: ' + page.path);
  outputPaths.add(page.path);
}
process.stdout.write(JSON.stringify(rendered));
