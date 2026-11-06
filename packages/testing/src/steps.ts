export type StepRunner = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

export type StepCounter = {
  act<T>(label: string, fn: () => Promise<T>): Promise<T>;
  count(): number;
};

export function createStepCounter(runStep?: StepRunner): StepCounter {
  let attempted = 0;
  const run: StepRunner = runStep ?? ((_, fn) => fn());
  return {
    // Incremented before awaiting so a failed attempt still counts as an action.
    act(label, fn) {
      attempted += 1;
      return run(label, fn);
    },
    count: () => attempted,
  };
}
