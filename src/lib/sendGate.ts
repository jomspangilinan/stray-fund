/**
 * The rule for a button that moves money, kept apart from the screen so it can be tested. With a confirm step
 * the first submit only asks; nothing is posted until confirm(). The busy flag is set before anything awaits,
 * so two taps in one frame post once.
 */
export class SendGate<B> {
  private busy = false;
  private waiting: B | null = null;

  constructor(
    private readonly needsConfirm: boolean,
    private post: (body: B) => Promise<void>,
    private readonly changed: () => void = () => {},
  ) {}

  /** Posts through the latest closure on the next send. */
  setPost(post: (body: B) => Promise<void>): void {
    this.post = post;
  }

  /** The body held until the person says Send, or null. */
  get asking(): B | null {
    return this.waiting;
  }

  async submit(body: B): Promise<void> {
    if (this.busy || this.waiting) return;
    if (this.needsConfirm) {
      this.waiting = body;
      this.changed();
      return;
    }
    await this.run(body);
  }

  async confirm(): Promise<void> {
    if (this.waiting) await this.run(this.waiting);
  }

  back(): void {
    if (this.busy) return;
    this.waiting = null;
    this.changed();
  }

  private async run(body: B): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.post(body);
    } finally {
      this.busy = false;
      this.waiting = null;
      this.changed();
    }
  }
}
