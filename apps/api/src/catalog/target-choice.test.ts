// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { chooseBindings } from './target-choice.js';

type T = { id: string; provider: string };
const azureSim: T = { id: 'azure-sim', provider: 'mock' };
const awsSim: T = { id: 'aws-sim', provider: 'mock' };
const aws: T = { id: 'aws', provider: 'aws' };

describe('chooseBindings', () => {
  it('moves past a first target that cannot host the slot', () => {
    // The first compatible target lacks a queue; the second can host everything.
    const errors = (c: Readonly<Record<string, T>>) => (c.primary!.id === 'azure-sim' ? 2 : 0);
    const calls: string[] = [];
    const choice = chooseBindings([{ name: 'primary', providers: [] }], [azureSim, awsSim], (c) => {
      calls.push(c.primary!.id);
      return errors(c);
    });
    expect(choice?.primary).toBe(awsSim);
    expect(calls).toEqual(['azure-sim', 'aws-sim']);
  });

  it('keeps the first target when it already validates', () => {
    let n = 0;
    const choice = chooseBindings([{ name: 'primary', providers: ['aws', 'mock'] }], [aws, awsSim], () => {
      n++;
      return 0;
    });
    expect(choice?.primary).toBe(aws);
    expect(n).toBe(1);
  });

  it('respects the providers each slot allows and keeps the best choice when none is clean', () => {
    const slots = [
      { name: 'app', providers: ['aws'] },
      { name: 'data', providers: ['mock'] },
    ];
    const choice = chooseBindings(slots, [azureSim, aws, awsSim], (c) => (c.data!.id === 'azure-sim' ? 3 : 1));
    expect(choice).toEqual({ app: aws, data: awsSim });
  });

  it('returns null when a slot has no compatible target', () => {
    expect(chooseBindings([{ name: 'edge', providers: ['vercel'] }], [aws], () => 0)).toBeNull();
  });
});
