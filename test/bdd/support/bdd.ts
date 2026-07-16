import { describe, it } from 'vitest';

// A minimal Gherkin-style layer over vitest — BDD as a SPECIFICATION STYLE,
// honestly, not as a framework. package.json is frozen (no @cucumber/*), and
// none of cucumber's machinery (regex step registries, world objects, glue
// files) buys anything at this scale: each Scenario is a plain vitest `it`
// whose steps run inline and in order.
//
// What the layer DOES do:
//   * Feature/Scenario wrap describe/it so the tree reads as Gherkin;
//   * every executed step ACCUMULATES its `Given/When/Then <text>` line, and
//     the runner prints the whole transcript when the scenario finishes — the
//     test run doubles as a living, readable specification;
//   * a failing step is marked in the transcript and prepended to the error,
//     so "which business step broke" is the first thing the output says.

export type StepBody = () => void | Promise<void>;
export type Step = (text: string, body?: StepBody) => Promise<void>;

export interface World {
  Given: Step;
  When: Step;
  Then: Step;
  And: Step;
}

let featureBeingDefined: string | null = null;
const printedFeatures = new Set<string>();

export function Feature(title: string, define: () => void): void {
  // vitest DEFERS suite callbacks (they run at collection, not when describe()
  // returns), so the current-feature marker is set inside the callback — the
  // Scenario() calls in `define` still execute synchronously within it.
  describe(`Feature: ${title}`, () => {
    featureBeingDefined = title;
    try {
      define();
    } finally {
      featureBeingDefined = null;
    }
  });
}

export function Scenario(title: string, run: (world: World) => Promise<void>): void {
  const feature = featureBeingDefined;
  if (!feature) throw new Error('Scenario() must be declared inside Feature()');

  it(`Scenario: ${title}`, async () => {
    const transcript: string[] = [];

    const step =
      (keyword: 'Given' | 'When' | 'Then' | 'And'): Step =>
      async (text, body) => {
        // Right-align keywords the way pretty-printed Gherkin does.
        const line = `${keyword.padStart(5)} ${text}`;
        try {
          if (body) await body();
        } catch (err) {
          transcript.push(`${line}   <-- FAILED HERE`);
          print(feature, title, transcript);
          if (err instanceof Error) {
            err.message = `at step "${keyword} ${text}"\n${err.message}`;
          }
          throw err;
        }
        transcript.push(line);
      };

    await run({ Given: step('Given'), When: step('When'), Then: step('Then'), And: step('And') });
    print(feature, title, transcript);
  });
}

function print(feature: string, scenario: string, transcript: string[]): void {
  const out: string[] = [''];
  if (!printedFeatures.has(feature)) {
    printedFeatures.add(feature);
    out.push(`Feature: ${feature}`);
  }
  out.push(`  Scenario: ${scenario}`);
  for (const line of transcript) out.push(`    ${line}`);
  console.log(out.join('\n'));
}
