/**
 * The extracted details, summarised, with the inputs a press away.
 *
 * WHY THEY ARE NOT ALL ON SCREEN
 *
 * The card used to open with eight input boxes, and the message somebody came
 * to read was underneath them. Nearly all of those fields are right nearly all
 * of the time, so the default is to show what they say rather than ask again:
 * one line each, and a press to correct any of them.
 *
 * WHAT IS NEVER HIDDEN
 *
 * Anything uncertain. A field nobody filled in says so in the summary rather
 * than disappearing, because the thing somebody needs to notice is the gap, not
 * the eight values that are fine. The follow-up date and the facts stay outside
 * this entirely: both are claims a person should be looking at before they save.
 *
 * PRESS A LINE TO FILL IT IN
 *
 * Every line in the summary is a button. Pressing "Not caught" next to Name
 * opens the inputs with the cursor already in the name box, so filling a gap
 * is one press, not a hunt. The match is by position: the third line focuses
 * the third input, textarea or select inside the children. Keep the rows and
 * the inputs in the same order.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DetailRow {
  label: string;
  /** Null renders as a stated absence, never as a blank line. */
  value: string | null;
  /** Said in place of the value when there is none, in the person's terms. */
  absent?: string;
}

export function DetailDisclosure({
  rows,
  children,
  openLabel = 'Edit details',
  closeLabel = 'Done editing',
}: {
  rows: DetailRow[];
  /** The real inputs, shown only when somebody asks for them. */
  children: ReactNode;
  openLabel?: string;
  closeLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // Which input to focus once the inputs appear. A ref, not state: it is
  // read once after the next render and never drawn.
  const focusIndex = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const missing = rows.filter((row) => row.value === null).length;

  // Once the inputs are on screen, put the cursor in the one that was pressed.
  useEffect(() => {
    if (!open || focusIndex.current === null) return;
    const controls = box.current?.querySelectorAll<HTMLElement>('input, textarea, select');
    controls?.[focusIndex.current]?.focus();
    focusIndex.current = null;
  }, [open]);

  return (
    <div className="asst-details" ref={box}>
      {open ? (
        children
      ) : (
        <dl className="asst-summary asst-details-summary">
          {rows.map((row, index) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                <button
                  type="button"
                  className={row.value === null ? 'asst-detail-line asst-absent' : 'asst-detail-line'}
                  aria-label={`${row.label}: ${row.value ?? 'add it'}`}
                  onClick={() => {
                    focusIndex.current = index;
                    setOpen(true);
                  }}
                >
                  {row.value ?? row.absent ?? 'Not recorded'}
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <button className="btn btn-quiet asst-details-toggle" onClick={() => setOpen(!open)}>
        {open ? closeLabel : openLabel}
        {!open && missing > 0 ? (
          <span className="asst-details-missing">
            {missing} not recorded
          </span>
        ) : null}
      </button>
    </div>
  );
}
