/**
 * Copy rules, enforced.
 *
 * Alberto asked for plain, personable language that does not read as machine
 * written. Em dashes are the clearest tell, so they are banned outright rather
 * than left to whoever edits next.
 *
 * The character is built from its code point below, so this file does not trip
 * its own check.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_GROUPS, METRIC_GUIDE, METRIC_KEYS } from '../types/domain';

function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const EM_DASH = String.fromCharCode(0x2014);

describe('no em dashes anywhere', () => {
  it('finds none in any source file', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line: string, i: number) => {
          if (line.includes(EM_DASH)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('every metric explains itself', () => {
  it('has a plain explanation and a reason it matters', () => {
    for (const key of METRIC_KEYS) {
      const guide = METRIC_GUIDE[key];
      expect(guide, `${key} has no explanation`).toBeDefined();
      expect(guide.what.length, `${key} explanation too thin`).toBeGreaterThan(20);
      expect(guide.why.length, `${key} reason too thin`).toBeGreaterThan(20);
    }
  });

  it('puts every metric into exactly one group, so none go missing on screen', () => {
    const grouped = METRIC_GROUPS.flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual([...METRIC_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('avoids the jargon a non-marketer would trip over', () => {
    const prose = Object.values(METRIC_GUIDE)
      .map((g) => `${g.what} ${g.why}`)
      .join(' ')
      .toLowerCase();
    for (const jargon of ['downstream', 'cohort', 'attribution', 'utm', 'conversion rate']) {
      expect(prose, `explanations should not say "${jargon}"`).not.toContain(jargon);
    }
  });
});
