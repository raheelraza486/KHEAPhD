# Working agreement

Eight people on one codebase for twelve weeks. These conventions exist so the work
merges cleanly and so each person's contribution stays visible in the history.

## Commit under your own account

Set your identity **per repository**, using your university address:

```bash
git config user.name "Your Name"
git config user.email "unikey@uni.sydney.edu.au"
```

Never commit or push on someone else's behalf. Each member's individual mark is
argued from what they can evidence, and `git log` is the cleanest evidence there is.

## Branches

`main` is always in a working state. Nobody pushes to it directly.

Branch names carry the area and a short description:

```
catalogue/ess-b2brouter-fixes
composition/match-scope
discovery/audio-input
ui/discovery-results
docs/readme-refresh
```

Start every branch from an up-to-date `main`, and delete it once it is merged.

## Pull requests

- **Run `./scripts/check.sh` first.** There is no CI on this repository, so
  nothing runs automatically.
- One PR per piece of work, small enough to review in one sitting.
- At least one approval from someone in another group before merging.
- Say what changed and how you checked it. If you did not check it, say that.
- **Declare any use of generative AI in the PR description.** The unit permits AI
  but requires it to be acknowledged, and these declarations are what you will draw
  on when writing the AI acknowledgement in your individual reports.

Suggested PR description:

```
What: one or two sentences
Why: the task or issue this closes
Checked: how you verified it works, including ./scripts/check.sh
AI: which tool, for what part, and what you verified yourself — or "none"
```

## Integration

Merge into `main` as soon as a piece of work is reviewed, rather than holding
branches open. The groups meet at agreed interfaces: process JSON 1.0 between
Discovery and the BP-Builder (`frontend/lib/composition/process-format.ts`), and
the `/api/composition` response between the BP-Builder and the result pages
(`frontend/lib/composition/api-contract.ts`). Changing either one is a change
for both sides: agree it with the other group before writing the code.

## Documents stay out of the repository

Manuals, reviews, meeting notes, exported spreadsheets, PDFs and screenshots go
in the shared project folder on OneDrive, never in this repository. The only
documentation here is a README that explains the code next to it.

## Decisions

Anything that changes scope or architecture goes in the decision log, with a date
and the reason. The decision log lives in the shared project folder on OneDrive,
not in this repository: the repository carries the system, and the coursework
documentation sits with the rest of the coursework. Scope decisions agreed with the client belong there too —
the proposal is described in the course material as an informal contract with the
client, and a written record is what makes it enforceable in both directions.
