import { ServiceUnavailableException } from '@nestjs/common';

/** Sticky until process exit. Disabled consumers and transient broker disconnects never enter it. */
export class ConsumerFailures {
  private readonly services = new Set<string>();

  report(service: string): void {
    this.services.add(service);
  }

  isHealthy(service: string): boolean {
    return !this.services.has(service);
  }
}

export const consumerFailures = new ConsumerFailures();

/** Internal terminal failure check for both probes; broker availability is not checked here. */
export function assertConsumerHealth(service: string): void {
  if (!consumerFailures.isHealthy(service)) {
    throw new ServiceUnavailableException('CONSUMER_TERMINAL_CRASH');
  }
}
