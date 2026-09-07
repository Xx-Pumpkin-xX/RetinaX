# Demo images

These are what the deployed instance rebuilds its demo cases from. Free hosting
wipes the disk on restart, so this folder is committed on purpose.

## What is in here now

`placeholder_01..04.jpg` are **drawn placeholders, not retinas.** They exist so
the app can be deployed and demonstrated before the real images are in place.
Replace them.

## What should be in here

8–12 fundus photographs from **APTOS 2019** or **EyePACS** — public datasets,
free to redistribute. Never real patient photographs: this folder is public in
the repository.

## After changing the images

The grading service runs on a lab machine and will not always be reachable from
the deployed API. So the answers are computed once, locally, and committed:

```bash
# with the grading service running
npm run precompute      # writes demo-images/precomputed/
git add demo-images/
```

`precomputed/` holds one `.json` (the grade) and one `.png` (the heatmap) per
image. At boot, seeding asks the live service first and falls back to these if
it cannot be reached — which is what keeps the deployed demo populated when the
lab machine is asleep.
