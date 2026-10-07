import type { ResolvedService, ResolvedWorkspace } from './model.js';

/** Read-only view over the services of a resolved workspace. */
export class ServiceRegistry {
  readonly #services: Map<string, ResolvedService>;

  constructor(workspace: ResolvedWorkspace) {
    this.#services = new Map(workspace.services.map((s) => [s.name, s]));
  }

  list(): ResolvedService[] {
    return [...this.#services.values()];
  }

  get(name: string): ResolvedService | undefined {
    return this.#services.get(name);
  }

  byTeam(team: string): ResolvedService[] {
    return this.list().filter((s) => s.team === team);
  }

  /** Internal services that `name` depends on. */
  dependenciesOf(name: string): ResolvedService[] {
    const svc = this.#services.get(name);
    if (!svc) return [];
    return svc.dependencies
      .flatMap((d) => ('service' in d ? [this.#services.get(d.service)] : []))
      .filter((s): s is ResolvedService => s !== undefined);
  }

  /** Services that depend on `name`. */
  dependentsOf(name: string): ResolvedService[] {
    return this.list().filter((s) =>
      s.dependencies.some((d) => 'service' in d && d.service === name),
    );
  }

  /**
   * Dependency cycles between internal services. Cycles are legal (and common), but they
   * matter when reasoning about cascading failures, so they are surfaced to the user.
   */
  cycles(): string[][] {
    const cycles: string[][] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const visit = (name: string) => {
      state.set(name, 'visiting');
      stack.push(name);
      for (const dep of this.dependenciesOf(name)) {
        const s = state.get(dep.name);
        if (s === 'visiting') cycles.push(stack.slice(stack.indexOf(dep.name)));
        else if (s === undefined) visit(dep.name);
      }
      stack.pop();
      state.set(name, 'done');
    };
    for (const name of [...this.#services.keys()].sort()) {
      if (!state.has(name)) visit(name);
    }
    return cycles;
  }
}
