import { unzipSync, strFromU8 } from 'fflate';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TEXT = 2_000_000;
const chapterPattern = /^(?:第[〇零一二三四五六七八九十百千万两\d]+[章回卷节部篇集]|卷[〇零一二三四五六七八九十百千万两\d]+|chapter\s+\d+|#{1,3}\s+).{0,70}$/i;
const clean = text => String(text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim();
function decode(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}
function plainParagraphs(text) {
  return clean(text).split(/\n\s*\n|\n(?=\S)/).map(clean).filter(Boolean);
}
function bounded(book) {
  const chapters = [];
  let total = 0;
  for (const chapter of book.chapters) {
    let paragraphs = [], size = 0, part = 0;
    const flush = () => { if (paragraphs.length) { chapters.push({ title: chapter.title + (part ? ' · 续 ' + part : ''), paragraphs, depth: chapter.depth || 0 }); paragraphs = []; size = 0; part++; } };
    for (const raw of chapter.paragraphs) {
      // Keep chapters below the host data-file bound without dropping text.
      for (let offset = 0; offset < raw.length; offset += 20000) {
        const text = raw.slice(offset, offset + 20000);
        if (size + text.length > 60000) flush();
        paragraphs.push(text); size += text.length; total += text.length;
        if (total > MAX_TEXT) throw new Error('正文超过 200 万字，请先拆分书籍后再导入');
      }
    }
    flush();
  }
  if (!chapters.length) throw new Error('没有找到可阅读的正文');
  if (chapters.length > 800) throw new Error('章节超过 800 个，请先拆分书籍');
  return { ...book, chapters, characters: total };
}
function parseText(bytes, name, format) {
  const text = clean(decode(bytes));
  const title = name.replace(/\.(?:txt|md|markdown)$/i, '');
  let chapter = { title: '开始阅读', paragraphs: [] }, chapters = [];
  let block = [], fence = '';
  const flushBlock = () => { if (block.some(line => line.trim())) chapter.paragraphs.push(block.join('\n')); block = []; };
  const lines = text.split('\n');
  for (const line of lines) {
    const value = line.trim();
    if (format === 'markdown') {
      const marker = /^(?:\x60{3,}|~{3,})/.exec(value)?.[0];
      if (marker) { fence = fence ? '' : marker[0]; block.push(line); continue; }
      if (!fence && chapterPattern.test(value)) {
        flushBlock();
        if (chapter.paragraphs.length) chapters.push(chapter);
        chapter = { title: value.replace(/^#{1,3}\s+/, ''), paragraphs: [] };
      } else if (!fence && !value) flushBlock();
      else block.push(line);
      continue;
    }
    if (!value) continue;
    if (chapterPattern.test(value)) {
      if (chapter.paragraphs.length) chapters.push(chapter);
      chapter = { title: value.replace(/^#{1,3}\s+/, ''), paragraphs: [] };
    } else chapter.paragraphs.push(value);
  }
  flushBlock();
  if (chapter.paragraphs.length) chapters.push(chapter);
  return bounded({ title, author: '', format, sourceName: name, chapters });
}
function xml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('EPUB 目录 XML 格式无效');
  return doc;
}
const local = (doc, name) => [...doc.getElementsByTagName('*')].filter(element => element.localName === name);
function archivePath(base, href) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) throw new Error('EPUB 内部章节不能引用外部网址');
  const path = decodeURIComponent(new URL(href, 'https://book.invalid/' + base).pathname).slice(1);
  if (path.includes('\0') || path.startsWith('../')) throw new Error('EPUB 内部路径无效');
  return path;
}
function parseEpub(bytes, name) {
  let size = 0, entries = 0;
  const files = unzipSync(bytes, { filter(file) {
    if (!/\.(?:opf|xhtml?|html?|xml|ncx)$/i.test(file.name)) return false;
    size += file.originalSize; entries++;
    if (file.originalSize > 4 * 1024 * 1024 || size > 24 * 1024 * 1024 || entries > 1400) throw new Error('EPUB 解压后内容过大');
    return true;
  } });
  const read = path => { if (!files[path]) throw new Error('EPUB 缺少文件：' + path); return strFromU8(files[path]); };
  if (files['META-INF/encryption.xml'] && /EncryptedData/i.test(read('META-INF/encryption.xml'))) throw new Error('这本 EPUB 含加密内容，暂不支持 DRM 书籍');
  const root = xml(read('META-INF/container.xml'));
  const opfPath = local(root, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 没有有效的内容目录');
  const opf = xml(read(opfPath));
  const title = local(opf, 'title')[0]?.textContent?.trim() || name.replace(/\.epub$/i, '');
  const author = local(opf, 'creator').map(element => element.textContent.trim()).filter(Boolean).join(' / ');
  const items = new Map(local(opf, 'item').map(item => [item.getAttribute('id'), item]));
  const navNames = new Map();
  const ncx = [...items.values()].find(item => item.getAttribute('media-type') === 'application/x-dtbncx+xml');
  if (ncx) {
    const ncxPath = archivePath(opfPath, ncx.getAttribute('href')), doc = xml(read(ncxPath));
    for (const point of local(doc, 'navPoint')) {
      const content = local(point, 'content')[0], label = local(point, 'text')[0]?.textContent.trim();
      if (!content || !label) continue;
      let parent = point.parentElement, depth = 0;
      while (parent) { if (parent.localName === 'navPoint') depth++; parent = parent.parentElement; }
      const path = archivePath(ncxPath, content.getAttribute('src'));
      if (!navNames.has(path)) navNames.set(path, { title: label, depth: Math.min(3, depth) });
    }
  }
  const nav = [...items.values()].find(item => item.getAttribute('properties')?.split(/\s+/).includes('nav'));
  if (nav) {
    const navPath = archivePath(opfPath, nav.getAttribute('href'));
    const doc = new DOMParser().parseFromString(read(navPath), 'text/html');
    for (const link of doc.querySelectorAll('nav a[href]')) {
      try { const path = archivePath(navPath, link.getAttribute('href')); if (!navNames.has(path)) navNames.set(path, { title: clean(link.textContent), depth: Math.min(3, [...link.parentElement.parentElement.closest('nav').querySelectorAll('ol')].filter(list => list.contains(link)).length - 1) }); }
      catch { /* A navigation link outside the archive is not a readable chapter. */ }
    }
  }
  const chapters = [];
  for (const ref of local(opf, 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = items.get(ref.getAttribute('idref'));
    if (!item || !/html/i.test(item.getAttribute('media-type') || '')) continue;
    const path = archivePath(opfPath, item.getAttribute('href'));
    const doc = new DOMParser().parseFromString(read(path), 'text/html');
    doc.querySelectorAll('script,style,nav,svg,iframe,object,noscript').forEach(node => node.remove());
    const blocks = [...doc.body.querySelectorAll('h1,h2,h3,h4,p,blockquote,li,pre')].filter(node => !node.parentElement.closest('p,blockquote,li,pre'));
    const paragraphs = blocks.map(node => clean(node.textContent)).filter(Boolean);
    if (!paragraphs.length) paragraphs.push(...plainParagraphs(doc.body.textContent));
    if (!paragraphs.length) continue;
    const heading = doc.body.querySelector('h1,h2,h3')?.textContent.trim();
    const navigation = navNames.get(path);
    const chapterTitle = navigation?.title || heading || doc.title || '第 ' + (chapters.length + 1) + ' 章';
    if (heading && paragraphs[0] === heading) paragraphs.shift();
    if (!paragraphs.length) continue;
    chapters.push({ title: chapterTitle, paragraphs, depth: navigation?.depth || 0 });
  }
  return bounded({ title, author, format: 'epub', sourceName: name, chapters });
}
export function parseBook(bytes, name) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE) throw new Error('请选择 20MB 以内的书籍');
  const format = /\.epub$/i.test(name) ? 'epub' : /\.md$|\.markdown$/i.test(name) ? 'markdown' : /\.txt$/i.test(name) ? 'txt' : null;
  if (!format) throw new Error('支持 EPUB、TXT、Markdown 格式');
  return format === 'epub' ? parseEpub(bytes, name) : parseText(bytes, name, format);
}
export async function pickAndParseBooks() {
  const paths = await window.ma.files.pick();
  const books = [];
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop();
    if (!/\.(epub|txt|md|markdown)$/i.test(name)) throw new Error('请选择 EPUB、TXT 或 Markdown 书籍');
    const asset = await window.ma.media.import(path, 'book-import-' + Date.now() + '.bin');
    try {
      if (asset.size > MAX_FILE) throw new Error('请选择 20MB 以内的书籍');
      const response = await fetch(asset.url);
      if (!response.ok) throw new Error('无法读取已选择的书籍');
      books.push(parseBook(new Uint8Array(await response.arrayBuffer()), name));
    } finally { await window.ma.media.release(asset.assetId); }
  }
  return books;
}
