import { createHash } from 'node:crypto';
const INDEX = 'library/index.json';
const clone = value => structuredClone(value);
const defaults = () => ({ books: [], lastBookId: null, reader: { fontSize: 21, lineHeight: 1.95, width: 720, font: 'serif', paper: 'system' } });
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const bookFile = (id, file) => {
  if (typeof id !== 'string' || !/^book-[a-f0-9]{24}$/.test(id)) throw new Error('书籍身份不合法');
  return 'library/books/' + id + '/' + file + '.json';
};
const chapterFile = (id, index) => bookFile(id, 'chapter-' + index);

/** Books are imported by the user; only workspace data is written, never source code. */
export function createDomainRuntime({ identity = {}, broker } = {}) {
  if (!broker) throw new Error('阅读器需要宿主数据 broker');
  let state, version = 0, queue = Promise.resolve(), closed = false;
  const metas = new Map(), listeners = new Set();
  const read = async file => {
    const saved = await broker('data.read', [file], { identity, actor: 'human', requestId: 'library-read' });
    if (!saved) return null;
    try { return JSON.parse(saved.content); }
    catch { throw new Error('阅读器数据无法解析：' + file + '。请保留文件并恢复备份，未重置书架。'); }
  };
  const write = (file, value) => broker('data.write', [file, JSON.stringify(value)], { identity, actor: 'human', requestId: 'library-write' });
  async function load() {
    if (state) return;
    const saved = await read(INDEX);
    if (saved && (!Array.isArray(saved.books) || !saved.reader)) throw new Error('阅读器书架结构无效，未覆盖现有数据');
    state = saved || defaults();
  }
  const entryOf = (id, target = state) => {
    const entry = target.books.find(book => book.id === id);
    if (!entry) throw new Error('书架上没有这本书');
    return entry;
  };
  async function metaOf(id) {
    if (!metas.has(id)) {
      const meta = await read(bookFile(id, 'meta'));
      if (!meta || !Array.isArray(meta.chapters)) throw new Error('目录缺失，请重新导入原书');
      metas.set(id, meta);
    }
    return metas.get(id);
  }
  async function paragraphs(id, index) {
    const meta = await metaOf(id);
    if (!Number.isInteger(index) || !meta.chapters[index]) throw new Error('章节序号超出范围');
    const chapter = await read(chapterFile(id, index));
    if (!chapter?.paragraphs?.length) throw new Error('章节正文缺失，请重新导入原书');
    return chapter.paragraphs;
  }
  function notify(context) {
    version++;
    const event = { type: 'library.changed', ...identity, version, actor: context.actor ?? 'human', requestId: context.requestId ?? 'library', payload: {} };
    listeners.forEach(listener => listener(clone(event)));
  }
  async function save(next, context) { await write(INDEX, next); state = next; notify(context); }
  const sorted = books => [...books].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt || b.addedAt - a.addedAt);
  async function execute(name, args, context) {
    if (closed) throw new Error('阅读器已关闭');
    context.signal?.throwIfAborted(); await load();
    const next = clone(state);
    let result;
    if (name === 'book.import') {
      const doc = args.book;
      if (!doc || typeof doc.title !== 'string' || !Array.isArray(doc.chapters) || !doc.chapters.length || doc.chapters.length > 800) throw new Error('书籍结构不完整');
      let characters = 0;
      const chapters = doc.chapters.map(chapter => {
        if (typeof chapter.title !== 'string' || !Array.isArray(chapter.paragraphs) || !chapter.paragraphs.length || chapter.paragraphs.some(text => typeof text !== 'string')) throw new Error('章节内容不合法');
        const chars = chapter.paragraphs.reduce((sum, text) => sum + text.length, 0);
        if (chars > 60000 || chapter.paragraphs.length > 10000) throw new Error('单章过长，请分章后再导入');
        characters += chars;
        return { title: chapter.title.slice(0, 180), paragraphs: chapter.paragraphs, depth: Math.max(0, Math.min(3, Number(chapter.depth) || 0)), characters: chars };
      });
      if (characters > 2_000_000 || !characters) throw new Error('书籍正文需在 1–200 万字以内');
      const id = 'book-' + createHash('sha256').update(JSON.stringify(chapters)).digest('hex').slice(0, 24);
      const existing = next.books.find(book => book.id === id);
      if (existing) return { ok: true, version, result: { bookId: id, duplicate: true, entry: existing } };
      if (next.books.length >= 300) throw new Error('书架已达 300 本，请先移除不需要的书籍');
      for (let index = 0; index < chapters.length; index++) { context.signal?.throwIfAborted(); await write(chapterFile(id, index), { paragraphs: chapters[index].paragraphs }); }
      const meta = { chapters: chapters.map(({ paragraphs, ...chapter }) => ({ ...chapter, paragraphs: paragraphs.length })) };
      await write(bookFile(id, 'meta'), meta); metas.set(id, meta);
      const entry = { id, title: doc.title.trim().slice(0, 160) || '未命名书籍', author: String(doc.author || '').slice(0, 160), sourceName: String(doc.sourceName || '').slice(0, 180), format: ['epub', 'txt', 'markdown'].includes(doc.format) ? doc.format : 'txt', characters, total: chapters.length, status: 'unread', pinned: false, addedAt: Date.now(), lastOpenedAt: 0, progress: { chapterIndex: 0, paragraphIndex: 0, offset: 0, percent: 0, overall: 0 } };
      next.books.push(entry); result = { bookId: id, entry };
    } else if (name === 'book.open') {
      const entry = entryOf(args.bookId, next), index = args.chapterIndex ?? entry.progress.chapterIndex, meta = await metaOf(entry.id);
      if (!Number.isInteger(index) || !meta.chapters[index]) throw new Error('章节序号超出范围');
      if (args.chapterIndex !== undefined || index !== entry.progress.chapterIndex) entry.progress = { chapterIndex: index, paragraphIndex: 0, offset: 0, percent: 0, overall: meta.chapters.slice(0, index).reduce((sum, chapter) => sum + chapter.characters, 0) / entry.characters };
      entry.status = entry.status === 'finished' ? 'finished' : 'reading'; entry.lastOpenedAt = Date.now(); next.lastBookId = entry.id; result = { entry };
    } else if (name === 'book.progress') {
      const entry = entryOf(args.bookId, next), meta = await metaOf(entry.id), index = args.chapterIndex;
      if (!Number.isInteger(index) || !meta.chapters[index]) throw new Error('章节序号超出范围');
      if (!Number.isInteger(args.paragraphIndex) || args.paragraphIndex < 0 || args.paragraphIndex >= meta.chapters[index].paragraphs || !finite(args.offset, 0, 1) || !finite(args.percent, 0, 1)) throw new Error('阅读位置不合法');
      const before = meta.chapters.slice(0, index).reduce((sum, chapter) => sum + chapter.characters, 0);
      entry.progress = { chapterIndex: index, paragraphIndex: args.paragraphIndex, offset: args.offset, percent: args.percent, overall: Math.min(1, (before + meta.chapters[index].characters * args.percent) / entry.characters) };
      entry.lastOpenedAt = Date.now(); next.lastBookId = entry.id; result = { progress: entry.progress };
    } else if (name === 'book.bookmark') {
      const entry = entryOf(args.bookId), content = await paragraphs(entry.id, args.chapterIndex);
      if (!Number.isInteger(args.paragraphIndex) || !content[args.paragraphIndex]) throw new Error('书签位置不合法');
      const marks = await read(bookFile(entry.id, 'bookmarks')) || [], id = args.chapterIndex + ':' + args.paragraphIndex;
      const previous = marks.findIndex(mark => mark.id === id);
      if (previous >= 0) marks.splice(previous, 1);
      else { if (marks.length >= 200) throw new Error('每本书最多 200 个书签'); marks.push({ id, chapterIndex: args.chapterIndex, paragraphIndex: args.paragraphIndex, text: content[args.paragraphIndex].slice(0, 160), createdAt: Date.now() }); }
      await write(bookFile(entry.id, 'bookmarks'), marks); notify(context);
      return { ok: true, version, result: { bookmarks: marks } };
    } else if (name === 'book.status') {
      const entry = entryOf(args.bookId, next);
      if (!['unread', 'reading', 'finished'].includes(args.status)) throw new Error('阅读状态不合法');
      entry.status = args.status; result = { entry };
    } else if (name === 'book.pin') {
      const entry = entryOf(args.bookId, next); entry.pinned = Boolean(args.pinned); result = { entry };
    } else if (name === 'book.remove') {
      entryOf(args.bookId, next); next.books = next.books.filter(book => book.id !== args.bookId);
      if (next.lastBookId === args.bookId) next.lastBookId = null;
      result = { removed: args.bookId };
    } else if (name === 'reader.settings') {
      const settings = args.settings || {};
      for (const [key, min, max] of [['fontSize', 16, 32], ['lineHeight', 1.4, 2.5], ['width', 520, 920]]) if (key in settings) {
        if (!finite(settings[key], min, max)) throw new Error('排版参数超出范围：' + key);
        next.reader[key] = settings[key];
      }
      if ('font' in settings) { if (!['serif', 'sans'].includes(settings.font)) throw new Error('字体选项不合法'); next.reader.font = settings.font; }
      if ('paper' in settings) { if (!['system', 'paper', 'night'].includes(settings.paper)) throw new Error('纸张选项不合法'); next.reader.paper = settings.paper; }
      result = { settings: next.reader };
    } else throw new Error('未知阅读器命令：' + name);
    await save(next, context); return { ok: true, version, result };
  }
  return {
    async getSnapshot() { await queue; await load(); return { version, state: { entries: sorted(clone(state.books)), reader: clone(state.reader), lastBookId: state.lastBookId }, capturedAt: new Date().toISOString() }; },
    async query(name, args = {}) {
      await queue; await load();
      if (name === 'shelf.list') { const needle = String(args.q || '').toLowerCase(); return { entries: sorted(clone(state.books)).filter(book => (book.title + ' ' + book.author).toLowerCase().includes(needle)) }; }
      if (name === 'book.toc') { const entry = entryOf(args.bookId), meta = await metaOf(entry.id); return { entry: clone(entry), chapters: clone(meta.chapters), bookmarks: await read(bookFile(entry.id, 'bookmarks')) || [] }; }
      if (name === 'book.content') {
        const entry = entryOf(args.bookId), index = args.chapterIndex ?? entry.progress.chapterIndex, meta = await metaOf(entry.id);
        return { bookId: entry.id, title: entry.title, chapterIndex: index, chapterTitle: meta.chapters[index].title, paragraphs: await paragraphs(entry.id, index), total: entry.total };
      }
      if (name === 'library.search') {
        const needle = String(args.q || '').trim(); if (!needle) return { matches: [] };
        const matches = [];
        for (const book of state.books) {
          const meta = await metaOf(book.id);
          for (let index = 0; index < meta.chapters.length && matches.length < 40; index++) {
            const content = await paragraphs(book.id, index);
            for (let p = 0; p < content.length && matches.length < 40; p++) {
              const at = content[p].indexOf(needle);
              if (at >= 0) matches.push({ bookId: book.id, title: book.title, chapterIndex: index, paragraphIndex: p, chapterTitle: meta.chapters[index].title, snippet: content[p].slice(Math.max(0, at - 24), at + needle.length + 70) });
            }
          }
        }
        return { matches };
      }
      throw new Error('未知阅读器查询：' + name);
    },
    execute(name, args = {}, context = {}) { const work = queue.then(() => execute(name, args, context)); queue = work.catch(() => {}); return work; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { closed = true; await queue; listeners.clear(); metas.clear(); }
  };
}
