# ds-nfl-fantasy

`deepseek-r1:14b` with a fantasy football primer built in. It shares the base
model's weights, so it takes no extra disk space and the same VRAM.

```
ollama create ds-nfl-fantasy -f models/fantasy/Modelfile
ollama run ds-nfl-fantasy
```

**Measured against the stock model on the app's own tasks, it is not better yet**
(see [Results](#results)). Keep the app on `deepseek-r1:14b` unless a later version
of this model beats it in the eval below. What is worth keeping from this folder is
the eval itself, which is the test any customization, including a fine-tune, has
to pass.

## What the primer does

The `SYSTEM` block in the [Modelfile](Modelfile) teaches the model how season-long
fantasy works (slots such as FLEX and OP, PPR, projections and margins, locks,
injury designations, waivers against free agents, why a trade is judged on
starters) and how to talk about it: plainly, with the numbers carrying the weight,
no scouting labels, no generic advice, no markdown.

It gives the model **no facts**. The model's memory of players, teams, and injuries
is out of date, and the primer says so; current facts still come only from the
engine's brief. The primer contains no numbers either, because the app withholds
any answer with a number the engine did not produce, so a figure in the primer
could only get an answer rejected.

## Using it in the app needs a small change

Ollama applies a Modelfile's `SYSTEM` only to requests that have no system message,
and every request from the app has one. Checked on Ollama 0.33.3: a model whose
`SYSTEM` held a code word repeated it when asked with no system message, and did
not know it once the request carried one. A custom `TEMPLATE` is no way around
this: Ollama renders `deepseek-r1:14b` with its built-in chat template and ignores
one written in the Modelfile.

[app-integration.patch](app-integration.patch) makes `OllamaProvider` ask Ollama once
for the model's own system prompt (`/api/show`) and put it ahead of the app's
instructions, which come second and win where they are stricter. Models with no
`SYSTEM`, such as stock `deepseek-r1:14b`, get exactly the request they got before,
and a failed lookup sends the request without the primer. While `packages/` is
uncommitted, the change travels as a patch:

```
git apply models/fantasy/app-integration.patch
npm test
```

It touches `packages/llm/src/ollama.ts` and the three test files whose fake `fetch`
had to answer the new lookup. It only matters once there is a model worth
selecting, so it can wait until then.

## Measuring it

```
npx vite-node models/fantasy/eval.ts
npx vite-node models/fantasy/eval.ts -- --runs 5 deepseek-r1:14b ds-nfl-fantasy
```

Eight cases (three lineups, two trade pitches, three League AI questions, one of
which the brief cannot answer) go through the app's own provider, prompts, and fact
builders, with the provider change above applied. Each answer is scored by the
checks the app runs before showing one (invented numbers, and for pitches naming
the player given up), plus heuristics for what those checks miss: markdown, lists,
length, NFL teams the facts never mention, generic advice, overstating a trade's
gain, scouting claims, and not admitting when the brief lacks an answer. A
transcript of every answer goes to `models/fantasy/results/`, which is not committed.

## Results

Run on 2026-09-14: RTX 5070 Ti, Ollama 0.33.3, 3 runs per case, 24 answers per model.

| model | shown by the app | median time | heuristic flags |
| --- | --- | --- | --- |
| `deepseek-r1:14b` | 24/24 | 6.9 s | overstated gain 1 |
| `ds-nfl-fantasy`, first primer | 24/24 | 7.1 s | overstated gain 5 of 6 pitches, scouting claims 2, markdown 1, length 1 |
| `ds-nfl-fantasy`, current primer | 23/24 | 8.2 s | invented number 1, overstated gain 2, markdown 2, generic advice 1 |

The first primer cast the model as an enthusiastic analyst. It called a 0.3-point
gain "a big boost" and described players from memory ("a franchise QB", "a dynamic
rushing and receiving threat"), both of which the pitch prompt forbids. Removing the
persona and adding explicit rules fixed the scouting claims and most of the
hype, but did not bring it level with stock.

The stock model has little headroom on these checks. The app's prompts, its
fact-only brief, and the number guard already do the work a primer would. The
fantasy knowledge the primer adds is knowledge the brief makes unnecessary, and
the longer prompt costs about a second per answer. Differences of one or two
flags in 24 answers are within run-to-run noise; the eval would need more runs
and harder cases to separate models that are this close.

## Where the real gains are

**Reasoning is not switched off.** The provider sends `think: false` so that
DeepSeek-R1 skips its reasoning. On Ollama 0.33.3 it reasons anyway: every probe
response carried 1,200 to 2,600 characters of thinking, even for a one-word answer.
The text shown is unaffected, because thinking comes back in a separate field, but
it is probably most of the local model's wait, for the stock model and this one alike.

**Fine-tuning**, if prompt-level customization is not enough. A LoRA fine-tune of
the same base (DeepSeek-R1-Distill-Qwen-14B) with Unsloth fits a 14B QLoRA run
in about 15 GB of VRAM. It would be trained on the app's own tasks: facts built by
the engine, with answers written by Claude and kept only if they pass the same
checks. The adapter loads with an `ADAPTER` line in this Modelfile, and the eval
above is the before-and-after test. Fine-tuning can teach the model the app's rules;
it cannot make the model current, because rosters and injuries change weekly, and
that is what the brief is for.
