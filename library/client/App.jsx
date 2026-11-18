import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Icon, IconButton, useDomain, usePresenceValue } from '../../support/common.jsx';
import { pickAndParseBooks } from './importer.js';
import { capturePosition, restorePosition, ProgressWriter } from './reading-position.js';

const STATUS = { unread: '未读', reading: '在读', finished: '读完' };
const percentage = value => Math.round((value || 0) * 100);
const query = (name, args) => window.ma.agent.domain.query(name, args);

function Cover({ book, small = false }) {
  const theme = parseInt(book.id.slice(-2), 16) % 5;
  return <div className={'book-cover cover-' + theme + (small ? ' small' : '')} aria-hidden="true"><span className="cover-rule" /><span className="cover-format">{book.format.toUpperCase()}</span><strong>{book.title}</strong><span className="cover-author">{book.author || '私人藏书'}</span><i /><span className="cover-number">书 房 · {String(book.total).padStart(2, '0')}</span></div>;
}
function Shelf({ entries, lastBookId, busy, onImport, onOpen, command }) {
  const [filter, setFilter] = React.useState('all'), [search, setSearch] = React.useState('');
  const [view, setView] = React.useState('covers');
  const [managed, setManaged] = React.useState(null);
  const managedPresence = usePresenceValue(managed);
  React.useEffect(() => {
    if (!managed) return;
    const close = event => { if (event.key === 'Escape') setManaged(null); };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [managed]);
  const last = entries.find(book => book.id === lastBookId);
  const shown = entries.filter(book => (filter === 'all' || book.status === filter) && (book.title + ' ' + book.author).toLowerCase().includes(search.toLowerCase()));
  const reading = entries.filter(book => book.status === 'reading').length;
  return <div className="library-home">
    <header className="library-header"><div className="library-brand"><Icon name="book" size={24} /><div><h1>书房</h1></div></div><button type="button" className="soft-button" disabled={busy} onClick={onImport}><span className="plus">+</span>{busy ? '正在导入…' : '导入书籍'}</button></header>
    <main className="shelf-main">
      {last ? <section className="continue-reading"><div className="continue-copy"><span className="eyebrow">留在这一页的时间</span><h2>{last.title}</h2><p>{last.author || '继续属于你的阅读'}</p><div className="continue-progress"><i style={{ width: percentage(last.progress.overall) + '%' }} /></div><div className="continue-bottom"><span>已读 {percentage(last.progress.overall)}% · 第 {last.progress.chapterIndex + 1} / {last.total} 章</span><button type="button" className="primary-button" onClick={() => onOpen(last.id)}>继续阅读<Icon name="next" size={16} /></button></div></div><Cover book={last} small /></section> : <section className="shelf-intro"><p>导入 EPUB、TXT 或 Markdown 开始阅读。</p></section>}
      <div className="shelf-heading"><div><h2>我的藏书 <span>{entries.length}</span></h2><p>{reading ? reading + ' 本正在读，慢慢来。' : '读什么、什么时候读，都由你决定。'}</p></div><div className="shelf-tools"><label className="book-search"><Icon name="search" size={16} /><input aria-label="搜索书名或作者" placeholder="搜索书名、作者" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="segmented"><button aria-label="封面视图" aria-pressed={view === 'covers'} onClick={() => setView('covers')}><Icon name="grid" size={15} /></button><button aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setView('list')}><Icon name="menu" size={15} /></button></div></div></div>
      <nav className="shelf-filters" aria-label="阅读状态筛选">{[['all', '全部'], ['reading', '在读'], ['unread', '未读'], ['finished', '读完']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{id === 'all' ? entries.length : entries.filter(book => book.status === id).length}</span></button>)}</nav>
      {shown.length ? <div className={'shelf-books ' + (view === 'list' ? 'as-list' : '')} id="shelfGrid">{shown.map(book => <article key={book.id} className="shelf-book">
        <button type="button" className="book-open" aria-label={'阅读《' + book.title + '》'} onClick={() => onOpen(book.id)}><Cover book={book} /><div className="book-details"><h3>{book.title}</h3><p>{book.author || '本地导入'}<span>{book.total} 章</span></p><div className="book-reading-line"><span>{book.status === 'reading' ? '读至 ' + percentage(book.progress.overall) + '%' : STATUS[book.status]}</span><div><i style={{ width: percentage(book.progress.overall) + '%' }} /></div></div></div></button>
        <IconButton icon="pin" label={book.pinned ? '取消置顶《' + book.title + '》' : '置顶《' + book.title + '》'} aria-pressed={book.pinned} onClick={() => void command('book.pin', { bookId: book.id, pinned: !book.pinned }).catch(() => {})} />
        <button type="button" className="book-manage" aria-label={'管理《' + book.title + '》'} onClick={() => setManaged(book)}>•••</button>
      </article>)}</div> : <section className="shelf-empty"><div className="empty-book"><Icon name="book" size={40} /></div><h3>{entries.length ? '这里还没有符合条件的书' : '从你的第一本藏书开始'}</h3><p>{entries.length ? '换个关键词，或看看其他阅读状态。' : '导入文字版 EPUB、TXT 或 Markdown，离线也能安心读。'}</p>{!entries.length ? <button type="button" className="primary-button" disabled={busy} onClick={onImport}>选择一本书</button> : null}</section>}
      <footer className="shelf-footer"><span>EPUB · TXT · Markdown</span><span>本地导入 · 段落进度 · 私人书签</span></footer>
    </main>
    {managedPresence.value ? <div className="overlay mp-scrim" {...managedPresence.presence.spread} onClick={event => event.target === event.currentTarget && setManaged(null)}><section className="drawer mp-panel" {...managedPresence.presence.spread} role="dialog" aria-label="管理藏书"><header><h2>管理藏书</h2><IconButton icon="close" label="关闭藏书管理" onClick={() => setManaged(null)} /></header><h3 className="managed-title">{managedPresence.value.title}</h3><p className="managed-source">{managedPresence.value.author || '本地导入'}<br />{managedPresence.value.sourceName}<br />{managedPresence.value.total} 章 · {managedPresence.value.characters.toLocaleString()} 字</p><div className="managed-actions">{Object.entries(STATUS).map(([status, label]) => <button type="button" key={status} className="soft-button" onClick={() => void command('book.status', { bookId: managedPresence.value.id, status }).then(() => setManaged(null)).catch(() => {})}>标记为{label}</button>)}</div><button type="button" className="soft-button remove-book" onClick={() => void command('book.remove', { bookId: managedPresence.value.id }).then(() => setManaged(null)).catch(() => {})}>移出书架</button><p className="settings-note">移出书架不会删除磁盘上的原书。</p></section></div> : null}
  </div>;
}
function Toc({ doc, search, setSearch, onChapter, onClose }) {
  return <><header><div><h2>目录 <small>{doc.total} 章</small></h2></div>{onClose ? <IconButton icon="close" label="关闭目录" onClick={onClose} /> : null}</header><label className="toc-search"><Icon name="search" size={15} /><input aria-label="筛选章节" value={search} onChange={event => setSearch(event.target.value)} placeholder="查找章节" /></label><nav className="toc-list" aria-label="章节目录">{doc.toc.filter(chapter => chapter.title.toLowerCase().includes(search.toLowerCase())).map(chapter => <button key={chapter.index} type="button" aria-current={doc.chapterIndex === chapter.index ? 'location' : undefined} onClick={() => onChapter(chapter.index)} style={{ paddingLeft: 12 + chapter.depth * 12 }}><span>{String(chapter.index + 1).padStart(2, '0')}</span><strong>{chapter.title}</strong>{doc.chapterIndex === chapter.index ? <i /> : null}</button>)}</nav></>;
}
const markdownComponents = { img: ({ alt }) => alt ? <span className="reader-image-alt">〔{alt}〕</span> : null };
const Paragraphs = React.memo(function Paragraphs({ paragraphs, paragraphRefs, format }) {
  return <>{paragraphs.map((text, index) => format === 'markdown' ? <div className="markdown-block" key={index} data-paragraph={index} ref={element => { paragraphRefs.current[index] = element; }}><ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown></div> : <p key={index} data-paragraph={index} ref={element => { paragraphRefs.current[index] = element; }}>{text}</p>)}</>;
});
export function App() {
  const domain = useDomain('library.changed');
  const [currentDoc, setDoc] = React.useState(null), [importing, setImporting] = React.useState(false), [loading, setLoading] = React.useState(false);
  const readerPresence = usePresenceValue(currentDoc);
  const doc = readerPresence.value;
  const [drawer, setDrawer] = React.useState(null), [tocSearch, setTocSearch] = React.useState(''), [saveStatus, setSaveStatus] = React.useState('saved');
  const [progress, setProgress] = React.useState(0);
  const drawerPresence = usePresenceValue(drawer);
  const scroll = React.useRef(null), paragraphRefs = React.useRef([]), docRef = React.useRef(null), restoring = React.useRef(false), epoch = React.useRef(0);
  docRef.current = doc;
  const writerRef = React.useRef(null);
  if (!writerRef.current) writerRef.current = new ProgressWriter(record => window.ma.agent.domain.command('book.progress', record), (status, error) => { setSaveStatus(status); if (error) domain.setError('进度保存失败：' + error.message); });
  const writer = writerRef.current;
  const position = () => scroll.current && docRef.current ? { bookId: docRef.current.bookId, chapterIndex: docRef.current.chapterIndex, ...capturePosition(scroll.current, paragraphRefs.current.filter(Boolean)) } : null;
  const flushPosition = async () => { const record = position(); if (record && !restoring.current) writer.schedule(record); await writer.flush(); };
  const setFailure = error => domain.setError(error.message);
  async function openBook(bookId, chapterIndex, anchor) {
    if (loading) return;
    setLoading(true); domain.setError('');
    const generation = ++epoch.current;
    try {
      await flushPosition();
      const opened = await domain.command('book.open', { bookId, ...(chapterIndex === undefined ? {} : { chapterIndex }) });
      const [toc, content] = await Promise.all([query('book.toc', { bookId }), query('book.content', { bookId, chapterIndex: chapterIndex ?? opened.entry.progress.chapterIndex })]);
      if (generation !== epoch.current) return;
      const next = { ...content, entry: toc.entry, toc: toc.chapters.map((chapter, index) => ({ ...chapter, index })), bookmarks: toc.bookmarks, anchor: anchor || opened.entry.progress };
      paragraphRefs.current = []; restoring.current = true; setTocSearch(''); setDoc(next); setDrawer(null); setSaveStatus('saved'); setProgress(next.anchor.percent);
    } catch (error) { setFailure(error); }
    finally { setLoading(false); }
  }
  React.useLayoutEffect(() => {
    if (!doc || !scroll.current) return;
    restorePosition(scroll.current, paragraphRefs.current.filter(Boolean), doc.anchor);
    const frame = requestAnimationFrame(() => { if (scroll.current) restorePosition(scroll.current, paragraphRefs.current.filter(Boolean), doc.anchor); restoring.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [doc?.bookId, doc?.chapterIndex]);
  React.useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') void flushPosition().catch(setFailure); };
    const key = event => {
      if (event.key === 'Escape' && drawer) { event.preventDefault(); setDrawer(null); return; }
      if (!doc || readerPresence.presence.stage === 'out' || drawer || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.key === 'ArrowRight' && doc.chapterIndex + 1 < doc.total) { event.preventDefault(); void openBook(doc.bookId, doc.chapterIndex + 1); }
      if (event.key === 'ArrowLeft' && doc.chapterIndex > 0) { event.preventDefault(); void openBook(doc.bookId, doc.chapterIndex - 1); }
    };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('keydown', key);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', key); };
  }, [doc, drawer, loading]);
  React.useEffect(() => () => { writer.cancelTimer(); void writer.flush().catch(() => {}); }, []);
  async function importBooks() {
    setImporting(true); domain.setError('');
    try { for (const book of await pickAndParseBooks()) await domain.command('book.import', { book }); }
    catch (error) { setFailure(error); }
    finally { setImporting(false); }
  }
  async function closeReader() {
    try { await flushPosition(); setDoc(null); setDrawer(null); await domain.refresh(); }
    catch (error) { setFailure(error); }
  }
  async function bookmark() {
    if (!doc) return;
    const record = position(); if (!record) return;
    try { const result = await domain.command('book.bookmark', { bookId: record.bookId, chapterIndex: record.chapterIndex, paragraphIndex: record.paragraphIndex }); setDoc(previous => ({ ...previous, bookmarks: result.bookmarks })); }
    catch (error) { setFailure(error); }
  }
  async function settings(patch) {
    try {
      const record = position();
      await domain.command('reader.settings', { settings: patch });
      requestAnimationFrame(() => { if (scroll.current && record) restorePosition(scroll.current, paragraphRefs.current.filter(Boolean), record); });
    } catch (error) { setFailure(error); }
  }
  if (!domain.snapshot) return <div className="loading">{domain.error || '正在打开书房…'}</div>;
  const { entries, reader, lastBookId } = domain.snapshot.state;
  const scrollChanged = () => {
    if (restoring.current || loading || !doc) return;
    const record = position(); if (!record) return;
    setProgress(previous => Math.round(previous * 100) === Math.round(record.percent * 100) ? previous : record.percent); writer.schedule(record);
  };
  const marked = doc?.bookmarks.some(mark => mark.chapterIndex === doc.chapterIndex && mark.paragraphIndex === (position()?.paragraphIndex ?? 0));
  return <div className="library-app">
    {domain.error ? <div className="error-banner" role="alert">{domain.error}{saveStatus === 'error' ? <button className="soft-button" onClick={() => void writer.flush().then(() => domain.setError('')).catch(setFailure)}>重试保存</button> : null}</div> : null}
    {!doc ? <Shelf entries={entries} lastBookId={lastBookId} busy={importing} command={domain.command} onImport={() => void importBooks()} onOpen={id => void openBook(id)} /> : <div id="reader" className={'reader mp-panel paper-' + reader.paper} {...readerPresence.presence.spread} style={{ '--reading-size': reader.fontSize + 'px', '--reading-leading': reader.lineHeight, '--reading-width': reader.width + 'px', '--reading-font': reader.font === 'serif' ? '"Source Han Serif SC","Noto Serif CJK SC","Songti SC","SimSun",Georgia,serif' : 'var(--font-sans,system-ui)' }}>
      <header className="reader-toolbar"><button type="button" className="reader-back" onClick={() => void closeReader()}><Icon name="back" />书架</button><div className="reader-title"><strong>{doc.title}</strong><span>{doc.chapterTitle}</span></div><div className="reader-toolbar-actions"><IconButton icon="menu" label="打开目录" className="icon-button mobile-toc-button" onClick={() => setDrawer('toc')} /><IconButton icon="bookmark" label={marked ? '移除当前位置书签' : '添加当前位置书签'} aria-pressed={marked} onClick={() => void bookmark()} /><IconButton icon="book" label="查看书签" onClick={() => setDrawer('bookmarks')} /><IconButton icon="tune" label="阅读设置" onClick={() => setDrawer('settings')} /></div></header>
      <div className="reader-layout"><aside className="reader-sidebar"><Toc doc={doc} search={tocSearch} setSearch={setTocSearch} onChapter={index => void openBook(doc.bookId, index)} /></aside>
        <div className="reader-page" ref={scroll} onScroll={scrollChanged} tabIndex={0} aria-label="阅读正文">
          <article className="reader-prose"><header><span className="chapter-count">第 {String(doc.chapterIndex + 1).padStart(2, '0')} 章 / 共 {doc.total} 章</span><h1>{doc.chapterTitle}</h1><div className="chapter-rule" /></header><Paragraphs paragraphs={doc.paragraphs} paragraphRefs={paragraphRefs} format={doc.entry.format} /><div className="chapter-end"><span>本章完</span>{doc.chapterIndex + 1 < doc.total ? <button className="soft-button" disabled={loading} onClick={() => void openBook(doc.bookId, doc.chapterIndex + 1)}>下一章<Icon name="next" size={16} /></button> : <button className="soft-button" onClick={() => void domain.command('book.status', { bookId: doc.bookId, status: 'finished' }).then(closeReader).catch(setFailure)}><Icon name="check" size={16} />标记读完</button>}</div></article>
        </div>
      </div>
      <footer className="reader-footer"><span className={'save-state ' + saveStatus} role="status">{saveStatus === 'saved' ? '进度已保存' : saveStatus === 'saving' ? '正在保存…' : saveStatus === 'error' ? '保存失败' : '待保存'}</span><div><IconButton icon="back" label="上一章" disabled={loading || doc.chapterIndex === 0} onClick={() => void openBook(doc.bookId, doc.chapterIndex - 1)} /><span>{doc.chapterIndex + 1} / {doc.total}<i>本章 {percentage(progress)}%</i></span><IconButton icon="next" label="下一章" disabled={loading || doc.chapterIndex + 1 === doc.total} onClick={() => void openBook(doc.bookId, doc.chapterIndex + 1)} /></div><span>{doc.entry.format.toUpperCase()}</span></footer>
      {drawerPresence.value ? <div className="overlay mp-scrim" {...drawerPresence.presence.spread} onClick={event => event.target === event.currentTarget && setDrawer(null)}><section className="drawer mp-panel" {...drawerPresence.presence.spread} role="dialog" aria-label={drawerPresence.value === 'settings' ? '阅读设置' : drawerPresence.value === 'toc' ? '目录' : '我的书签'}>
        {drawerPresence.value === 'toc' ? <Toc doc={doc} search={tocSearch} setSearch={setTocSearch} onChapter={index => void openBook(doc.bookId, index)} onClose={() => setDrawer(null)} /> : <><header><h2>{drawerPresence.value === 'settings' ? '阅读设置' : '我的书签'}</h2><IconButton icon="close" label="关闭侧栏" onClick={() => setDrawer(null)} /></header>
          {drawerPresence.value === 'settings' ? <div className="reader-settings"><label>字号 <span>{reader.fontSize}px</span><input type="range" aria-label="正文字号" min="16" max="32" value={reader.fontSize} onChange={event => void settings({ fontSize: Number(event.target.value) })} /></label><label>行距 <span>{reader.lineHeight}</span><input type="range" aria-label="正文行距" min="1.4" max="2.5" step=".05" value={reader.lineHeight} onChange={event => void settings({ lineHeight: Number(event.target.value) })} /></label><label>版心宽度 <span>{reader.width}px</span><input type="range" aria-label="版心宽度" min="520" max="920" step="20" value={reader.width} onChange={event => void settings({ width: Number(event.target.value) })} /></label><section><h3>字体</h3><div className="segmented"><button aria-pressed={reader.font === 'serif'} onClick={() => void settings({ font: 'serif' })}>宋体</button><button aria-pressed={reader.font === 'sans'} onClick={() => void settings({ font: 'sans' })}>黑体</button></div></section><section><h3>纸张</h3><div className="paper-options">{[['system', '跟随主题'], ['paper', '暖纸'], ['night', '夜读']].map(([value, label]) => <button key={value} className={'paper-option ' + value} aria-pressed={reader.paper === value} onClick={() => void settings({ paper: value })}><span>Aa</span>{label}</button>)}</div></section><p className="settings-note">排版偏好会保存。改变字号或版心后，仍停在当前段落。</p></div> : <div className="bookmark-list">{doc.bookmarks.length ? doc.bookmarks.map(mark => <button key={mark.id} onClick={() => void openBook(doc.bookId, mark.chapterIndex, { paragraphIndex: mark.paragraphIndex, offset: 0, percent: .001 })}><span>{doc.toc[mark.chapterIndex].title}</span><p>{mark.text}</p><small>{new Date(mark.createdAt).toLocaleDateString()}</small></button>) : <div className="empty-marks"><Icon name="bookmark" size={28} /><p>遇到想再读一遍的话，<br />点右上角的书签留下它。</p></div>}</div>}
        </>}
      </section></div> : null}
    </div>}
    {loading ? <div className="book-loading" role="status">正在打开章节…</div> : null}
  </div>;
}
