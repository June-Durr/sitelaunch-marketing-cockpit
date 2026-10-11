/**
 * The jump-to bar that sits under the Data & Import heading.
 *
 * WHAT IT IS FOR
 *
 * The screen is long, and the complaint it answers is that you had to read to
 * find out where you were. Six named destinations, each with its own mark, mean
 * you can get to the calendar without scrolling past analytics and reading two
 * paragraphs to check.
 *
 * THE ACTIVE STATE IS OBSERVED, NOT GUESSED
 *
 * An IntersectionObserver reports which group is actually on screen. The
 * alternative, computing offsets on every scroll event, gets the answer wrong
 * the moment a card expands or an image changes height, and this page has
 * expandable Details on every card. Where the observer is unavailable the bar
 * still works; it simply has no highlight, which is the honest failure.
 *
 * MOTION
 *
 * Smooth scrolling is a preference, not a default. Anybody who has asked their
 * system for reduced motion gets an instant jump instead, and the query is read
 * at click time rather than at mount so a mid-session change is respected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IconComponent } from './icons';

export interface SectionNavItem {
  /** The id of the element this scrolls to. Must be unique on the page. */
  id: string;
  label: string;
  Icon: IconComponent;
}

/** True when this person has asked for less movement. Read at call time. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function SectionNav({ items }: { items: SectionNavItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const targets = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    /**
     * The topmost group that is currently intersecting wins.
     *
     * Several groups are usually on screen at once on a desktop, so "is
     * intersecting" alone would flicker between them. Taking the one nearest
     * the top of the viewport is what matches where somebody thinks they are.
     */
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      // The top band of the viewport, so a group counts as "current" when its
      // heading reaches the top rather than when its last card leaves.
      { rootMargin: '-8% 0px -70% 0px', threshold: 0 },
    );

    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [items]);

  const jump = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
    // Move the keyboard focus as well as the viewport. Scrolling alone leaves a
    // keyboard user's next Tab back at the top of the page, which is the usual
    // way an anchor nav is broken for everybody who does not use a mouse.
    target.focus({ preventScroll: true });
    setActive(id);
  }, []);

  return (
    <nav className="section-nav" aria-label="Jump to a section">
      <div className="section-nav-scroll" ref={listRef}>
        {items.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <a
              key={id}
              href={`#${id}`}
              className={`section-nav-item${isActive ? ' is-active' : ''}`}
              // A real anchor, so it is focusable, middle-clickable and
              // announced as a link. aria-current says which one is in view to
              // a screen reader, since the highlight alone says it only to
              // somebody who can see it.
              {...(isActive ? { 'aria-current': 'true' as const } : {})}
              onClick={(event) => {
                event.preventDefault();
                jump(id);
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
