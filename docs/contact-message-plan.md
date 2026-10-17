# One input, one review, one send confirmation

After a person describes meeting a contact, the first assistant response must show the contact or conversation fields, the suggested initial action date, an editable message and the pending tracking status together. This applies when the person is new and when the assistant matches an existing lead. Saving the review preserves the message and opens the ordinary Copy / Messages / contact-card / confirmed-send controls without another Ask request.

The initial action is suggested for today when there is a next action to fulfil, or tomorrow for a fresh meeting without one. An explicit day is preserved. All suggestions are editable and clearable. The existing generic lead cadence is not used to postpone this first action by 30 days.

## What each action means

- Rendering the review makes no record, sends nothing and performs no additional model request.
- Copy before saving only copies the proposed wording, with a truthful fallback if clipboard access fails.
- Save / Record keeps the approved contact or conversation, the selected action date and the message draft. Sync status remains queued until completion is reported.
- Copy after saving records a copy only. Messages hands off text without claiming that the other app sent it. Contact-card export remains separate from outreach.
- I sent this records the approved final wording once. The check-in date is reviewed on the same message card and applied by the same confirmation; no second scheduling button or Ask is needed.
- If send recording succeeds but reminder saving fails, the screen explicitly separates these results. Retry saving the reminder must never record a second send.
- An absent reply record is unknown, not proof of no response.

## Timing rationale

The HubSpot practitioner guidance recommends following up within 24 hours after a meaningful meeting. Mailchimp's event guidance recommends 24-48 hours. These are practical guidelines, not controlled evidence for an optimal interval for every contact.

https://blog.hubspot.com/sales/follow-up-email-after-meeting-networking
https://mailchimp.com/resources/event-marketing/

The later 3 / 5 / 7 day defaults in followUpSuggestion.ts remain product heuristics, based on a question in the message and prior replies. They are shown as editable suggestions, not research-proven optimal timings. A promise, explicit date, actual reply or user edit takes precedence over a generic cadence.

## Verification

UI checks cover new and matched contacts, message visibility before saving, preserving edited wording through save, a single model call, no writes on preview, copying without sending, clipboard refusal, double-click send confirmation, reminder scheduling and a reminder-only failure retry. Browser QA uses invented records and stubbed adapters only. No real outreach or paid model request is needed to exercise this handoff.

