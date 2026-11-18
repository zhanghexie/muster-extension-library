const clamp = value => Math.max(0, Math.min(1, value));
export function capturePosition(container, elements) {
  const rect = container.getBoundingClientRect(), line = rect.top + 26;
  let lo = 0, hi = elements.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (elements[mid].getBoundingClientRect().bottom <= line) lo = mid + 1; else hi = mid;
  }
  const element = elements[lo], box = element?.getBoundingClientRect();
  const max = container.scrollHeight - container.clientHeight;
  return { paragraphIndex: lo, offset: box ? clamp((line - box.top) / Math.max(1, box.height)) : 0, percent: max > 1 ? clamp(container.scrollTop / max) : 1 };
}
export function restorePosition(container, elements, anchor) {
  if (!anchor || !elements.length || anchor.percent === 0 && anchor.paragraphIndex === 0 && anchor.offset === 0) { container.scrollTop = 0; return; }
  const element = elements[Math.min(anchor.paragraphIndex, elements.length - 1)];
  if (!element) return;
  const rect = element.getBoundingClientRect();
  container.scrollTop += rect.top - container.getBoundingClientRect().top - 26 + rect.height * anchor.offset;
}
/** Capture the record when scheduled; a delayed write must never adopt a later chapter. */
export class ProgressWriter {
  constructor(send, status) { this.send = send; this.status = status; this.pending = null; this.tail = Promise.resolve(); this.timer = 0; this.revision = 0; this.inFlight = 0; }
  schedule(record) {
    this.pending = { record: structuredClone(record), revision: ++this.revision }; this.status('dirty'); clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 400);
  }
  async flush() {
    clearTimeout(this.timer);
    const pending = this.pending;
    if (!pending) return this.tail;
    this.pending = null; this.inFlight++; this.status('saving');
    const work = this.tail.then(() => this.send(pending.record)); this.tail = work.catch(() => {});
    try { await work; this.inFlight--; this.status(this.pending ? 'dirty' : this.inFlight ? 'saving' : 'saved'); }
    catch (error) {
      this.inFlight--;
      if (pending.revision === this.revision) { this.pending = pending; this.status('error', error); }
      throw error;
    }
  }
  cancelTimer() { clearTimeout(this.timer); }
}
