import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
// @ts-expect-error Bundled extension source intentionally uses JSX.
import { App as LibraryApp } from '../library/client/App.jsx';
// @ts-expect-error Plain JavaScript domain is also shipped to the worker.
import { createDomainRuntime as libraryRuntime } from '../library/domain.mjs';
// @ts-expect-error Browser file parser has no separate declaration file.
import { parseBook as parseBookBytes, pickAndParseBooks } from '../library/client/importer.js';
// @ts-expect-error Shared plain JavaScript progress logic.
import { ProgressWriter } from '../library/client/reading-position.js';
vi.mock('../library/client/importer.js', async importOriginal => ({ ...await importOriginal<object>(), pickAndParseBooks: vi.fn() }));

function bridge(runtime: any) {
  (window as any).ma = { ready: Promise.resolve(), on: (type: string, callback: (event: unknown) => void) => runtime.subscribe((event: any) => { if (event.type === type) callback(event); }), agent: { domain: { snapshot: () => runtime.getSnapshot(), query: (name: string, args: unknown) => runtime.query(name, args), command: (name: string, args: unknown) => runtime.execute(name, args, { actor: 'human' }) } } };
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
}
function memory() {
  const files = new Map<string, string>();
  return { files, broker: async (method: string, args: string[]) => {
    if (method === 'data.read') return files.has(args[0]) ? { content: files.get(args[0]) } : null;
    if (method === 'data.write') { files.set(args[0], args[1]); return true; }
    throw new Error('Unexpected ' + method);
  } };
}
// fflate and jsdom can construct buffers in different JS realms.
function parseBook(bytes: Uint8Array, name: string) {
  return parseBookBytes(Uint8Array.from(bytes), name);
}

it('parses EPUB spine order safely and detects TXT chapter headings', () => {
  const files = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>',
    'OPS/content.opf': '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>阅读测试</dc:title><dc:creator>测试作者</dc:creator></metadata><manifest><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    'OPS/a.xhtml': '<html><body><h1>第一章</h1><p>正文一</p><script>window.pwned=true</script><p>正文二</p></body></html>',
    'OPS/b.xhtml': '<html><body><h1>第二章</h1><p>后面的文字</p></body></html>',
  };
  const book = parseBook(zipSync(Object.fromEntries(Object.entries(files).map(([key, text]) => [key, strToU8(text)]))), 'book.epub');
  expect(book.title).toBe('阅读测试');
  expect(book.chapters.map((chapter: any) => chapter.title)).toEqual(['第一章', '第二章']);
  expect(book.chapters[0].paragraphs).toEqual(['正文一', '正文二']);
  const txt = parseBook(strToU8('第一章 开始\n正文甲\n第二章 之后\n正文乙'), '试读.txt');
  expect(txt.chapters).toHaveLength(2);
  const fence = String.fromCharCode(96).repeat(3);
  const md = parseBook(strToU8('# 第一节\n**重点**\n\n' + fence + '\n# 代码里的标题\n' + fence + '\n\n# 第二节\n后文'), 'note.md');
  expect(md.chapters).toHaveLength(2);
  expect(md.chapters[0].paragraphs[1]).toContain('# 代码里的标题');
  expect(() => parseBook(new Uint8Array(), 'a.pdf')).toThrow(/支持 EPUB/);
  const encrypted = { ...files, 'META-INF/encryption.xml': '<encryption><EncryptedData/></encryption>' };
  expect(() => parseBook(zipSync(Object.fromEntries(Object.entries(encrypted).map(([key, text]) => [key, strToU8(text)]))), 'locked.epub')).toThrow(/加密/);
});
it('keeps captured chapter positions ordered and does not replay an older failed save', async () => {
  const writes: any[] = [], statuses: string[] = [];
  let rejectFirst!: (error: Error) => void;
  const send = vi.fn((record: unknown) => { writes.push(record); return writes.length === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve(); });
  const writer = new ProgressWriter(send, (status: string) => statuses.push(status));
  writer.schedule({ chapterIndex: 0, percent: .7 });
  const first = writer.flush(); const rejected = expect(first).rejects.toThrow('disk');
  await Promise.resolve();
  writer.schedule({ chapterIndex: 1, percent: .2 });
  const second = writer.flush();
  rejectFirst(new Error('disk')); await rejected; await second; await writer.flush();
  expect(writes).toEqual([{ chapterIndex: 0, percent: .7 }, { chapterIndex: 1, percent: .2 }]);
  expect(statuses.at(-1)).toBe('saved');
  expect(writer.pending).toBeNull();
  writer.cancelTimer();
  const retrySend = vi.fn().mockRejectedValueOnce(new Error('offline disk')).mockResolvedValue(undefined);
  const retryStatus = vi.fn();
  const retry = new ProgressWriter(retrySend, retryStatus);
  retry.schedule({ chapterIndex: 3, paragraphIndex: 9, percent: .4 });
  await expect(retry.flush()).rejects.toThrow('offline disk');
  expect(retry.pending).not.toBeNull();
  expect(retryStatus).toHaveBeenLastCalledWith('error', expect.any(Error));
  await retry.flush();
  expect(retrySend).toHaveBeenNthCalledWith(2, { chapterIndex: 3, paragraphIndex: 9, percent: .4 });
  expect(retryStatus).toHaveBeenLastCalledWith('saved');
  retry.cancelTimer();
});
it('imports, reads, saves chapter position, changes type and reopens from the saved chapter', async () => {
  const store = memory(), runtime = libraryRuntime({ broker: store.broker }); bridge(runtime);
  vi.mocked(pickAndParseBooks).mockResolvedValue([{ title: '私人藏书', author: '作者', sourceName: '私人藏书.md', format: 'markdown', chapters: [{ title: '学而第一', paragraphs: ['**学而时习之**，不亦说乎。', '有朋自远方来，不亦乐乎。'] }, { title: '为政第二', paragraphs: ['为政以德，譬如北辰。', '温故而知新，可以为师矣。'] }] }]);
  const view = render(<LibraryApp />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: '选择一本书' }));
    fireEvent.click(await screen.findByRole('button', { name: '阅读《私人藏书》' }));
    await screen.findByRole('heading', { name: '学而第一' });
    expect(view.container.querySelector('.markdown-block strong')?.textContent).toBe('学而时习之');
    fireEvent.click(screen.getByRole('button', { name: '添加当前位置书签' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '移除当前位置书签' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '阅读设置' }));
    const settings = await screen.findByRole('dialog', { name: '阅读设置' });
    fireEvent.change(within(settings).getByRole('slider', { name: '正文字号' }), { target: { value: '25' } });
    await waitFor(() => expect((within(settings).getByRole('slider', { name: '正文字号' }) as HTMLInputElement).value).toBe('25'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: '下一章' }).at(-1)!);
    await screen.findByRole('heading', { name: '为政第二' });
    fireEvent.click(screen.getByRole('button', { name: '书架' }));
    await screen.findByRole('button', { name: '继续阅读' });
    fireEvent.click(screen.getByRole('button', { name: '继续阅读' }));
    await screen.findByRole('heading', { name: '为政第二' });
    expect((await runtime.query('book.toc', { bookId: (await runtime.getSnapshot()).state.entries[0].id })).entry.progress.chapterIndex).toBe(1);
  } finally { view.unmount(); await runtime.close(); }
});
