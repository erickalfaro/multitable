// Polymorphic delta reducer. Different providers stream text differently:
//
//   - Claude  → ADDITIVE: each text_delta carries a chunk to append.
//   - Codex   → CUMULATIVE: each item.updated carries the entire text-so-far,
//                must REPLACE the buffer.
//   - Copilot → ADDITIVE: each assistant.message_delta.deltaContent appends.
//
// The manager + WS layer always receive cumulative text (so the frontend can
// just `setLivePreview(text)`). Adapters wrap their stream in a StreamBuffer
// so the reducer logic lives in one place.

export type DeltaKind = 'additive' | 'cumulative';

export class StreamBuffer {
  private buf = '';

  constructor(private readonly kind: DeltaKind) {}

  /**
   * Apply a chunk and return the new full text.
   *
   * For 'additive' streams, `chunk` is the delta to append.
   * For 'cumulative' streams, `chunk` is the entire text so far — replaces.
   */
  apply(chunk: string): string {
    if (this.kind === 'cumulative') {
      this.buf = chunk;
    } else {
      this.buf += chunk;
    }
    return this.buf;
  }

  /** Current accumulated text. */
  get text(): string {
    return this.buf;
  }

  /** Has anything been buffered? */
  get isEmpty(): boolean {
    return this.buf === '';
  }

  /** Clear the buffer. */
  reset(): void {
    this.buf = '';
  }
}
