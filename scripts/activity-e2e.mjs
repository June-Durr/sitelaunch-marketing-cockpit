import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const KEY = 'slmc.dataset.v1';
const check = (l, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' :: ' + d : ''}`); if (!ok) process.exitCode = 1; };

await p.goto('http://localhost:5173/tasks', { waitUntil: 'networkidle' });
await p.waitForSelector('h1');

const before = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
check('starts with no activity', before.activityEvents.length === 0, `${before.tasks.length} tasks`);

// Finish the first open task.
await p.getByRole('button', { name: 'Done' }).first().click();
await p.waitForTimeout(600);
const after1 = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
check('finishing a task logs exactly one activity', after1.activityEvents.length === 1,
  after1.activityEvents[0]?.title);
check('the activity is linked back to the task',
  Boolean(after1.activityEvents[0]?.task_id), after1.activityEvents[0]?.task_id);
check('it is labelled as coming from the task',
  after1.activityEvents[0]?.source === 'task_completion');
check('the user is told it was logged',
  (await p.getByText(/on the Activity screen/).count()) > 0);

// Reopen it and finish it again.
const taskId = after1.activityEvents[0].task_id;
await p.evaluate(([k, id]) => {
  const d = JSON.parse(localStorage.getItem(k));
  d.tasks = d.tasks.map((t) => (t.id === id ? { ...t, status: 'open', completed_at: null } : t));
  localStorage.setItem(k, JSON.stringify(d));
}, [KEY, taskId]);
await p.reload({ waitUntil: 'networkidle' });
await p.waitForSelector('h1');
await p.getByRole('button', { name: 'Done' }).first().click();
await p.waitForTimeout(600);

const after2 = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
check('finishing it again creates no duplicate', after2.activityEvents.length === 1,
  `${after2.activityEvents.length} records`);

// Skipping logs nothing.
const beforeSkip = after2.activityEvents.length;
const skips = await p.getByRole('button', { name: 'Skip' }).count();
if (skips > 0) {
  await p.getByRole('button', { name: 'Skip' }).first().click();
  await p.waitForTimeout(500);
  const afterSkip = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
  check('skipping logs nothing', afterSkip.activityEvents.length === beforeSkip);
}

// It shows up on Today and on Activity.
await p.goto('http://localhost:5173/activity', { waitUntil: 'networkidle' });
await p.waitForSelector('h1');
check('the record appears on the Activity screen',
  (await p.getByText(/From finishing a task/).count()) > 0);

check('no runtime errors', errs.length === 0, errs[0] ?? '');
await b.close();
console.log(process.exitCode ? '\nSome checks failed.' : '\nAll activity e2e checks passed.');
