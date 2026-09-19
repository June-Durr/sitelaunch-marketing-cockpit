/**
 * Program date maths.
 *
 * Every counting rule is asserted here, including the inclusive/exclusive
 * choices, because an off-by-one in this file would misreport the whole program.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRAM, PROGRAM_PHASES, isInProgram, phaseFor,
  programLength, programPosition, validateProgram, type ProgramConfig,
} from './program';

describe('the agreed program dates are preserved exactly', () => {
  it('starts 27 August 2026 and targets 25 November 2026', () => {
    expect(DEFAULT_PROGRAM.startDate).toBe('2026-08-27');
    expect(DEFAULT_PROGRAM.targetDate).toBe('2026-11-25');
  });

  it('runs 91 days, counting both ends', () => {
    expect(programLength()).toBe(91);
  });
});

describe('program day counts the start date as Day 1', () => {
  it('makes 19 September 2026 Day 24', () => {
    expect(programPosition('2026-09-19').day).toBe(24);
  });

  it('makes the start date Day 1, not Day 0', () => {
    expect(programPosition('2026-08-27').day).toBe(1);
    expect(programPosition('2026-08-28').day).toBe(2);
  });

  it('makes the target date the final day', () => {
    const position = programPosition('2026-11-25');
    expect(position.day).toBe(91);
    expect(position.day).toBe(position.totalDays);
  });

  it('agrees with a day by day walk from the start date', () => {
    // Belt and braces: count forward one day at a time and check the arithmetic
    // version matches at every step, which catches month-length mistakes.
    const start = new Date('2026-08-27T12:00:00Z');
    for (let i = 0; i < 91; i += 1) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      expect(programPosition(iso).day, `day ${i + 1} (${iso})`).toBe(i + 1);
    }
  });
});

describe('before and after the program', () => {
  it('reports "before" and no day number ahead of the start', () => {
    const position = programPosition('2026-08-26');
    expect(position.status).toBe('before');
    expect(position.day).toBeNull();
    expect(position.daysUntilStart).toBe(1);
  });

  it('counts down to the start', () => {
    expect(programPosition('2026-08-20').daysUntilStart).toBe(7);
  });

  it('reports "active" on the first and last day', () => {
    expect(programPosition('2026-08-27').status).toBe('active');
    expect(programPosition('2026-11-25').status).toBe('active');
  });

  it('reports "after" past the target, and keeps counting the day number', () => {
    const position = programPosition('2026-11-26');
    expect(position.status).toBe('after');
    expect(position.day).toBe(92);
    expect(position.daysUntilStart).toBe(0);
  });
});

describe('days remaining is exclusive of today', () => {
  it('reads 0 on the target date itself', () => {
    expect(programPosition('2026-11-25').daysRemaining).toBe(0);
  });

  it('reads 1 the day before the target', () => {
    expect(programPosition('2026-11-24').daysRemaining).toBe(1);
  });

  it('goes negative after the target', () => {
    expect(programPosition('2026-11-27').daysRemaining).toBe(-2);
  });

  it('reads 67 on Day 24, which with the day number accounts for all 91 days', () => {
    const position = programPosition('2026-09-19');
    expect(position.daysRemaining).toBe(67);
    // Day 24 elapsed plus 67 still to come equals the full 91 day program.
    expect((position.day as number) + position.daysRemaining).toBe(91);
  });
});

describe('phases', () => {
  it('covers the whole program with no gaps and no overlaps', () => {
    expect(PROGRAM_PHASES[0].start).toBe(DEFAULT_PROGRAM.startDate);
    expect(PROGRAM_PHASES[PROGRAM_PHASES.length - 1].end).toBe(DEFAULT_PROGRAM.targetDate);
    for (let i = 1; i < PROGRAM_PHASES.length; i += 1) {
      const previousEnd = new Date(`${PROGRAM_PHASES[i - 1].end}T12:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      expect(PROGRAM_PHASES[i].start).toBe(previousEnd.toISOString().slice(0, 10));
    }
  });

  it('puts every day of the program in exactly one phase', () => {
    const start = new Date('2026-08-27T12:00:00Z');
    for (let i = 0; i < 91; i += 1) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const matches = PROGRAM_PHASES.filter(
        (p) => iso >= p.start && iso <= p.end,
      );
      expect(matches, iso).toHaveLength(1);
    }
  });

  it('treats a phase end date as belonging to that phase', () => {
    expect(phaseFor('2026-09-26')?.number).toBe(1);
    expect(phaseFor('2026-09-27')?.number).toBe(2);
    expect(phaseFor('2026-10-26')?.number).toBe(2);
    expect(phaseFor('2026-10-27')?.number).toBe(3);
  });

  it('puts Day 24 in Phase 1', () => {
    const position = programPosition('2026-09-19');
    expect(position.phase?.number).toBe(1);
    expect(position.phase?.name).toBe('Productize and Retain');
  });

  it('returns no phase outside the program', () => {
    expect(phaseFor('2026-08-26')).toBeNull();
    expect(phaseFor('2026-11-26')).toBeNull();
  });
});

describe('isInProgram decides which records count', () => {
  it('includes both the start and target dates', () => {
    expect(isInProgram('2026-08-27')).toBe(true);
    expect(isInProgram('2026-11-25')).toBe(true);
  });

  it('excludes the day either side', () => {
    expect(isInProgram('2026-08-26')).toBe(false);
    expect(isInProgram('2026-11-26')).toBe(false);
  });

  it('accepts a full timestamp, not just a date', () => {
    expect(isInProgram('2026-09-19T12:00:00.000Z')).toBe(true);
    expect(isInProgram('2026-08-26T12:00:00.000Z')).toBe(false);
  });

  it('treats nothing as outside the program', () => {
    expect(isInProgram(null)).toBe(false);
  });
});

describe('a custom program is respected', () => {
  const custom: ProgramConfig = {
    name: 'Short run',
    startDate: '2027-01-01',
    targetDate: '2027-01-10',
    goal: 'Prove the loop works',
  };

  it('counts against the configured dates, not the defaults', () => {
    expect(programLength(custom)).toBe(10);
    expect(programPosition('2027-01-01', custom).day).toBe(1);
    expect(programPosition('2027-01-10', custom).daysRemaining).toBe(0);
    expect(programPosition('2026-09-19', custom).status).toBe('before');
  });

  it('decides membership against the configured dates', () => {
    expect(isInProgram('2027-01-05', custom)).toBe(true);
    expect(isInProgram('2026-09-19', custom)).toBe(false);
  });
});

describe('program validation', () => {
  it('accepts the default', () => {
    expect(validateProgram(DEFAULT_PROGRAM)).toBeNull();
  });

  it('rejects a target on or before the start', () => {
    expect(
      validateProgram({ ...DEFAULT_PROGRAM, targetDate: '2026-08-27' }),
    ).toMatch(/after the start/);
  });

  it('rejects a missing name and a malformed date', () => {
    expect(validateProgram({ ...DEFAULT_PROGRAM, name: '  ' })).toMatch(/name/);
    expect(validateProgram({ ...DEFAULT_PROGRAM, startDate: 'soon' })).toMatch(/real date/);
  });
});
