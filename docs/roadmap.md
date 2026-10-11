# Roadmap

Natural next steps, roughly in order of value. Checked items are done and the
commit is cited; unchecked items are open.

## Done

- [x] **Verify the prompt against a live model.** `scripts/goal-prompt-check.mjs`
      reports 5/5 against a local 7B, so the claim is verified against a live
      model rather than inferred from the mock.
- [x] **Get responsive AI control.** 0.68s per intent on the GPU, comfortably
      inside the brain's 2s poll. What replaced latency as the open problem is
      *quality*, not speed.
- [x] **Run fully offline.** Ollama, native `qwen3:4b`, 100% GPU, verified
      end-to-end with `npm run check:ollama`.
- [x] **A static-hosted demo.** `?demo=1` answers the three endpoints in-page,
      so the project can be linked and played with no backend at all.

## Open, in priority order

### 1. Let the model choose between goals

There is one reward, and the prompt strongly suggests it, so the model is not
yet *deciding* — it is being told. This is the top open item precisely because
latency stopped hiding it.

The honest way to fix it is to make the choice real, not to make the prompt more
insistent. Two rewards, or a choice of which corner, would exercise the intent
layer properly. The measurement to beat is already in place: `bench:local`
reports **goal-selection rate**, so a change here is measurable rather than
impressionistic.

### 2. Real characters

Swap the generator behind the spec contract (MPFB2 / CharMorph / glTF). The
contract is already the load-bearing part — build it first, swap the generator
later.

**Blocker to solve first:** the maze is currently sized for a *sphere*. A
non-spherical character needs a different clearance rule, and `gridSizeFor` would
need to reason about a bounding volume rather than a radius.

### 3. Multiple rewards

One reward is a straight line. More than one forces route planning, which means
the navigator's waypoint choice becomes a real decision rather than a lookup.

### 4. Goal prioritisation

Let the model weigh rewards — nearest, safest, most valuable — rather than always
taking the suggested one. This is the natural companion to item 1 and shares most
of the work.

### 5. Multi-agent competition

Two or more characters, each with its own model or its own prompt, competing for
rewards in the same maze. The physics is already multi-body capable; the brain is
per-character, so the split should be clean.

The interesting question is what happens when they disagree about a goal — that
is a coordination problem the current architecture has no opinion about.

### 6. Character evolution

Accumulate across generations instead of replacing: keep a trait the model
noted as working, and pass it into the next design prompt. The `personality`
field is already a free-text hook for this.

### 7. Advanced model experiments

The open question is where the quality/size curve actually turns. `bench:local`
exists to answer it — run it against 7B, 8B and 14B and report the goal-selection
rate, not the latency.

A 13B–14B needs a newer GPU than the 1080 Ti supports: `cuda_v12` carries `sm_61`,
`cuda_v13` does not, so Pascal sits at the very bottom of what current builds
still support. Anything Turing or newer has tensor cores and would run a 13B
comfortably in 11 GB. That is the single biggest available hardware win.

### 8. Deployment polish

The demo is deployable today as static hosting. Remaining work is in
[README.md](../README.md#demo--no-backend-required):

- a screenshot in the GitHub social preview
- verifying the Rapier WASM base64 payload under a Pages subpath
- a one-click "run with a real model" path (today: clone, `ollama pull`, `npm run serve`)

---

## How to add behaviour

**Put it in `brain.js` as a *deterministic* action. The model picks which action;
the code decides what it does.**

That split is what keeps the thing debuggable — and the maze is the proof: all
the hard problems were in deterministic code, and **none of them needed the
model.**

## Rules for this file

- Update the roadmap when an item is done or the priority order changes.
- Record decisions with their reason; a decision without its rationale gets
  re-litigated next session.
- Every claim about performance should cite a measurement that can be re-run.
  If it cannot, it is a guess and should be marked as one.