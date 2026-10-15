/**
 * What the assistant knows about where you are standing.
 *
 * The panel follows you around the app, so "who is overdue" asked on the
 * Pipeline and the same words asked on the Content Log should both work, but
 * the answer is better when it knows which one you are looking at. This is the
 * whole of that awareness: a name and a line about what the screen is for.
 *
 * Kept as a table rather than read off the route tree, because the route tree
 * knows paths and this needs words. The fallback matters more than the table:
 * a screen added later and not listed here says so plainly instead of claiming
 * to be the Today screen.
 */

interface ScreenFacts {
  name: string;
  /** One line, in the prompt, about what somebody on this screen is doing. */
  doing: string;
}

const SCREENS: Record<string, ScreenFacts> = {
  '/': {
    name: 'Today',
    doing: 'looking at what is due today and what has happened recently',
  },
  '/content': {
    name: 'Content Log',
    doing: 'looking at posts and their numbers',
  },
  '/website': {
    name: 'Website Outcomes',
    doing: 'looking at website traffic and enquiries',
  },
  '/pipeline': {
    name: 'Pipeline',
    doing: 'looking at contacts and where each one stands',
  },
  '/tasks': {
    name: 'Tasks',
    doing: 'working through the task list',
  },
  '/activity': {
    name: 'Activity',
    doing: 'looking at the log of what has actually happened',
  },
  '/recommendations': {
    name: 'Recommendations',
    doing: 'reading what the Cockpit suggests from the numbers',
  },
  '/data': {
    name: 'Data and Import',
    doing: 'checking connections, imports and backups',
  },
};

/** The screen's own name, for the panel header and the prompt. */
export function screenName(pathname: string): string {
  return SCREENS[normalisePath(pathname)]?.name ?? 'the Cockpit';
}

/** The sentence the prompt gets: where they are and what that means. */
export function screenDescription(pathname: string): string {
  const facts = SCREENS[normalisePath(pathname)];
  if (!facts) return 'somewhere in the Cockpit';
  return `${facts.name}, ${facts.doing}`;
}

/** Trailing slashes and query strings off, so '/pipeline/' is '/pipeline'. */
function normalisePath(pathname: string): string {
  const path = pathname.split('?')[0].replace(/\/+$/, '');
  return path === '' ? '/' : path;
}
