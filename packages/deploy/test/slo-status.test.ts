import { describe, expect, it } from 'vitest';
import { classify } from '../src/index.js';

describe('SLO health', () => {
  it('classifies budget and burn rate', () => {
    expect(classify(null, null)).toBe('no-data');
    expect(classify(0.9, 0.5)).toBe('healthy');
    expect(classify(0.2, 0.5)).toBe('at-risk');
    expect(classify(0.9, 3)).toBe('at-risk');
    expect(classify(-0.1, 0)).toBe('exhausted');
  });
});
