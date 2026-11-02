/** Joins the service's existing shutdown path; a failure during bootstrap exits immediately. */
export class FatalShutdown {
  private handler?: () => void;

  constructor(private readonly exit: (code: number) => void = (code) => process.exit(code)) {}

  install(handler: () => void): void {
    this.handler = handler;
  }

  request(): void {
    if (this.handler) this.handler();
    else this.exit(1);
  }
}

export const fatalShutdown = new FatalShutdown();
