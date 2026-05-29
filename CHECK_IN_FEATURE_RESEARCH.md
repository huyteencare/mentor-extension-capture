# Check-in Feature Research

## Goal

Investigate whether Google Meet can provide a usable participant email for check-in, especially for external signed-in users, while keeping the UX as automatic as possible.

## What We Tested

### Track A: Extension-side DOM / Meet UI surfaces

Tested surfaces:

- participant tile DOM
- Meet `People / Participants` panel
- debug-only identity snapshot from the extension

Observed result:

- no usable participant email was exposed
- only display names, UI labels, and Meet device-like IDs such as `spaces/.../devices/...`
- this held true in both tile DOM and People panel

Verdict:

- Track A is not feasible for external participant email in the tested case
- do not continue investing in broader DOM heuristics unless a materially different Meet surface appears

### Track B: Google Meet API identity probe

Backend probe flow implemented and tested:

- `conferenceRecords.list`
- `conferenceRecords.participants.list`
- `conferenceRecords.participants.participantSessions.list`
- matching by meeting code + join time
- classification of `signedinUser` / `anonymousUser` / `phoneUser`
- logging of `signedinUser.user`
- follow-up People API lookup from `signedinUser.user`

## Key Findings

### 1. Pipeline is working end-to-end

We proved:

- extension can emit `attendance-candidate`
- backend can receive the candidate
- backend probe can run asynchronously without blocking capture upload

### 2. Meeting visibility depends on auth context

For one meeting, backend returned:

- `selectedConferenceRecord: null`
- `finalVerdict: no_matching_participant_session`

This indicated the meeting was not visible under the current delegated auth context, so the failure happened before participant matching.

### 3. Successful signed-in identity match was proven

For meeting code `etn-qiit-iqa`, backend returned:

- a selected conference record
- a matched participant id
- a matched participant session id
- `participantType: signedinUser`
- `signedinUser.user: users/112121410834113088974`
- `finalVerdict: matched_signedin_user`

This proves the Google Meet API path can successfully match:

- `attendance-candidate` -> conference record -> participant -> participant session

and can expose a usable signed-in identity handle:

- `signedinUser.user`

### 4. People API lookup worked, but email was not exposed

Using the proven identity handle:

- `signedinUser.user = users/112121410834113088974`

we successfully resolved it through People API to:

- `people/112121410834113088974`

The response returned:

- `ok: true`
- `resourceName: people/112121410834113088974`
- `emailAddresses: []`
- `names: []`

This means:

- the external signed-in account identity is visible
- the People resource exists
- but a usable email was not exposed for this tested case

## Verified Test Cases

### Case A: External signed-in account `Ducchuy`

Meet probe result:

- `finalVerdict: matched_signedin_user`
- `participantType: signedinUser`
- `signedinUser.user: users/112121410834113088974`

People API result:

- `resourceName: people/112121410834113088974`
- `emailAddresses: []`
- `metadata.sources[0].type: PROFILE`

Verdict:

- signed-in identity handle was successfully matched
- usable email was not exposed

### Case B: Another signed-in account `Another Account Just`

Initial issue:

- backend first matched the wrong overlapping participant (`TeenCare Global`)
- this was traced to backend scoring preferring overlap too strongly over exact display-name match

Fix:

- backend scoring was updated so an exact display-name match with a near session start can outrank an unrelated overlapping session

Post-fix Meet probe result:

- `finalVerdict: matched_signedin_user`
- `participantType: signedinUser`
- `meetDisplayName: Another Account Just`
- `signedinUser.user: users/117369108119322273649`

Verdict:

- signed-in identity handle was successfully matched
- backend matching is now more reliable for near-simultaneous participant joins

### Case C: Internal Workspace account `TeenCare Global`

Meet probe result:

- `finalVerdict: matched_signedin_user`
- `signedinUser.user: users/113317505806612900108`

People API result:

- `resourceName: people/113317505806612900108`
- `emailAddresses[0].value: info@teencare.vn`
- `metadata.sources[0].type: DOMAIN_PROFILE`

Verdict:

- signed-in identity handle was successfully matched
- usable email was exposed
- this is the clearest confirmed internal Workspace-style case so far

### Case D: `Vu Canh` using `@teencare.vn` domain account

Meet probe result:

- `finalVerdict: matched_signedin_user`
- `participantType: signedinUser`
- `meetDisplayName: Vu Canh`
- `signedinUser.user: users/114397724713755196710`

People API result:

- `resourceName: people/114397724713755196710`
- `emailAddresses: []`
- `metadata.sources[0].type: PROFILE`
- `profileMetadata.userTypes: GOOGLE_USER, GOOGLE_APPS_USER`

Verdict:

- the participant was matched correctly
- a People resource exists
- usable email was still not exposed
- `@teencare.vn` domain alone is not enough to assume the account behaves like a resolvable internal Workspace profile

## Current Conclusion Against The Email Goal

- We have **not** proven usable external participant email.
- We **have** proven that Google Meet API can expose a stable signed-in identity handle in at least one real case.
- We **have** proven that this identity handle can resolve to a People resource without yielding email.
- The strongest proven identity anchor so far is:
  - `signedinUser.user`

Current evidence therefore says:

- identity handle retrieval = yes
- email retrieval = mixed
- internal Workspace-style case = positive
- external and non-`DOMAIN_PROFILE` cases = currently negative in tested samples

## Product / Technical Implication

Short term:

- email should not be treated as solved for external users
- `signedinUser.user` is now the best proven auto identity signal

Likely UX direction:

- auto-suggest based on available identity signals
- mentor confirmation when confidence is insufficient
- reuse previous confirmed mapping later

## Recommended Next Step

Phase 2 should answer one narrower question:

- can `signedinUser.user` be resolved into a usable and sufficiently stable email for the real external signed-in join modes we care about

If not:

- do not continue with email-first automation as the primary model
- fall back to manual mentor mapping on top of the proven identity signal

Recommended framing for the team right now:

- the original goal is still participant email
- current research does not support claiming that external participant email is reliably available
- a `@teencare.vn` address does not automatically mean People API will expose the email
- if the product still requires email, we need more targeted validation across more external accounts
- if the product can tolerate a non-email identity anchor, `signedinUser.user` is the strongest proven signal so far
