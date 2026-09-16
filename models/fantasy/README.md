# Fantasy-tuned local models

Two customizations of `deepseek-r1:14b` for the three things the app asks a local
model to write: lineup explanations, trade-offer reasons, and League AI answers.
Both were measured with the same eval, on the app's own prompts and checks.

| model | what it is | verdict |
| --- | --- | --- |
| `ds-nfl-fantasy` | the stock model plus a fantasy primer in its Modelfile | no better than stock; do not use |
| `ds-nfl-lora` | the stock model plus a LoRA adapter trained on the app's tasks | better than stock: same pass rate, about 4.6 times faster, no hidden reasoning; use it |

Both share the base model's weights, so neither takes meaningful extra disk
space, and both use the same VRAM as the stock model.

## Measuring a model

```
npx vite-node models/fantasy/eval.ts
npx vite-node models/fantasy/eval.ts -- --runs 5 deepseek-r1:14b ds-nfl-lora
npx vite-node models/fantasy/eval.ts -- --tasks news,picks ds-nfl-lora
```

Thirteen cases go through the app's own provider, prompts, and fact builders:
eight prose ones (three lineups, two trade pitches, three League AI questions, one
of which the brief cannot answer) and five JSON ones (three news digests, two
waiver-pick reads). `--tasks` runs a subset. Each answer is scored by the checks the app runs before showing one
(invented numbers, and for pitches naming the player given up), plus heuristics
for what those checks miss: markdown, lists, length, NFL teams the facts never
mention, generic advice, overstating a trade's gain, scouting claims, and not
admitting when the brief lacks an answer. The checks live in [checks.ts](checks.ts).
A transcript of every answer goes to `models/fantasy/results/`, which is not committed.

The eval's players and team names are not used anywhere in the training data, so
it is a held-out test for the fine-tune.

## The JSON tasks

The app asks a model for prose three times and for a JSON block twice: the news
check's digest (`{"findings": [...]}`) and the waiver-wire picks
(`{"picks": [...]}`). The first training set had only the prose tasks, and it
shows.

Measured on 2026-09-16, three runs of each of the five JSON cases:

| model | parsed | news | picks | no code fence | text after the block | median |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek-r1:14b` | 15/15 | 9/9 | 6/6 | 0 | 0 | 6.3 s |
| `ds-nfl-lora` | 15/15 | 9/9 | 6/6 | 7 | 2 | 1.3 s |

Both models are parsed every time only because `lastJsonBlock` now accepts an
unfenced block, one written twice, and trailing text. Before that change the
fine-tune's unfenced answers were rejected outright, which is what
"The model did not end with picks in the agreed format" was in the app.

Format is not the only problem, and the other one moves projections. Neither
model leaves alone a player whose items support nothing:

- both reported a player whose injury a later item resolved — as a role change
  with a factor of **1.25**, a quarter added to the projection of a player the
  news says is healthy;
- `ds-nfl-lora` cut Jaylen Warren by a quarter (`questionable`, 0.75) on an item
  that was only a game recap, and stock cut Rhamondre Stevenson by a tenth.

Each factor is inside the range for its status, so the app applies it. The eval
flags these because the items do not support them.

### The prompts and their answers

Unlike the prose tasks, these answers are not written by hand. `make-prompts.ts`
synthesizes the items, so it knows the findings and picks they support, and
generates the target with the prompt: players with no news, a clear injury, a
report a later item resolves, an item about a teammate, and articles that name
drops, college players, or another week, which must be ignored. Roughly one in
six examples supports nothing, so the answer is `{"findings": []}` or
`{"picks": []}`.

Every generated target goes through the app's own parser before it can enter the
dataset, and `checks.ts` scores a JSON answer on the fence, trailing text, what
the parser accepted, factors inside their range, invented players, and whether
the answer names exactly what the items support. The targets live in
`data/answers-generated.jsonl`; `data/answers.jsonl` stays the hand-written prose.

Counts after adding them: 290 prompts, 261 train and 29 validation — 90 lineup,
60 pitch, 90 chat, 30 news, 20 picks.

## ds-nfl-lora: the fine-tune

A QLoRA adapter on DeepSeek-R1-Distill-Qwen-14B, the weights behind Ollama's
`deepseek-r1:14b`, loaded in Ollama as the stock model plus an `ADAPTER`. It has no
system prompt of its own, so the app uses it as it is: choose `ds-nfl-lora` under
**Connect a league → AI explanations → Ollama**. The provider patch described below
is not needed for it.

### Results

Run on 2026-09-15 on an RTX 5070 Ti with Ollama 0.33.3, three runs of each of the
eight held-out cases per model:

| model | shown by the app | median time | heuristic flags |
| --- | --- | --- | --- |
| `deepseek-r1:14b` | 24/24 | 5.5 s | overstated gain 3 |
| `ds-nfl-lora` | 24/24 | 1.2 s | none |

Hidden reasoning, on three held-out validation prompts (one per task) sent exactly
as the app sends them, with `think: false`:

| model | thinking characters | tokens generated | time |
| --- | --- | --- | --- |
| `deepseek-r1:14b` | 1,352 to 2,063 | 354 to 693 | 5.4 to 13.1 s |
| `ds-nfl-lora` | 0 | 33 to 140 | 0.7 to 2.8 s |

What the numbers show, and what they do not:

- **Speed is the solid result.** The adapter learned to close its think block at
  once, which `think: false` could not make the stock model do. Almost all of the
  stock model's time was reasoning the app never shows, which is where the 4.6 times
  comes from.
- **Both models pass the app's own checks every time.** The heuristic flags are
  weaker evidence for the fine-tune, because its training answers were written to
  avoid exactly those flags; zero flags is partly by construction. Reading the
  transcripts is the better test. The fine-tune's answers are shorter, correct, and
  lead with the change to make. The stock model still calls a 0.3-point gain "a strong
  upgrade", credits a quarterback with "consistent performance and versatility", and
  in one chat answer volunteers trade advice nobody asked for.
- **Weaknesses.** Trade pitches are formulaic, close to word for word the same on
  every run, because the training pitches were. The eval is eight cases. The training
  data is synthetic ESPN-style leagues, so a league with unusual scoring, or a Sleeper
  brief, is untested. Re-run the eval after upgrading Ollama or changing the app's prompts.

### The data

- [lora/make-prompts.ts](lora/make-prompts.ts) builds 240 prompts with the app's own
  fact builders and prompts: 90 lineup explanations, 60 trade pitches, and 90 League
  AI questions over full briefs, 25 of them questions the brief cannot answer. It is
  seeded, so it rebuilds the same prompts, and its lineups are realistic in mix:
  about a third need no changes, a third one or two, and the rest three or more.
- [lora/data/answers.jsonl](lora/data/answers.jsonl) holds a target answer for each,
  written by Claude in the session that built this (no API key was available, so
  there is no generation script). The style is the app's: short, plain, every number
  from the facts, no hype, no scouting, and "the brief doesn't cover that" when it
  doesn't.
- [lora/build-dataset.ts](lora/build-dataset.ts) holds every answer to the same checks
  as the eval and refuses any that fail; all 240 pass. It renders each prompt exactly
  as Ollama renders an app request for this model, and starts each answer with an
  empty `<think></think>` block, which teaches the model to answer without reasoning
  first. Every tenth example is held out for validation: 216 train, 24 validation.

### Training

[lora/train.py](lora/train.py): 4-bit NF4 base, LoRA rank 16 (alpha 32) on every
linear layer, paged 8-bit AdamW, learning rate 2e-4 on a cosine schedule, batch 1
with 8 steps of accumulation, 2 epochs, loss on the answer only. It is sized for a
16 GB card that is also driving a desktop: on an RTX 5070 Ti with about 4.5 GB held
by other apps, it peaked at 11.9 GB and took 16.7 minutes. Validation loss went from
1.62 before training to 0.42 after the first epoch and 0.34 after the second. It
slows sharply if a game or Ollama takes GPU memory while it runs.

To reproduce it, on Windows with Python 3.13 and Node:

```
py -3.13 -m venv %USERPROFILE%\ds-nfl-lora\venv
%USERPROFILE%\ds-nfl-lora\venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128
%USERPROFILE%\ds-nfl-lora\venv\Scripts\pip install transformers peft accelerate bitsandbytes safetensors gguf sentencepiece protobuf huggingface_hub
%USERPROFILE%\ds-nfl-lora\venv\Scripts\hf download deepseek-ai/DeepSeek-R1-Distill-Qwen-14B --local-dir %USERPROFILE%\ds-nfl-lora\base

npx vite-node models/fantasy/lora/make-prompts.ts
npx vite-node models/fantasy/lora/build-dataset.ts
%USERPROFILE%\ds-nfl-lora\venv\Scripts\python models/fantasy/lora/train.py --base %USERPROFILE%\ds-nfl-lora\base --out %USERPROFILE%\ds-nfl-lora\run1
```

Then turn the adapter into an Ollama model. [lora/export.ps1](lora/export.ps1) converts
it to GGUF with llama.cpp's converter (unzip the llama.cpp source into
`%USERPROFILE%\ds-nfl-lora` first) and runs `ollama create`:

```
powershell -File models\fantasy\lora\export.ps1 -Adapter %USERPROFILE%\ds-nfl-lora\run1\epoch-2
```

A Blackwell card (RTX 50-series) needs the CUDA 12.8 build of PyTorch, as above.

## ds-nfl-fantasy: the primer

```
ollama create ds-nfl-fantasy -f models/fantasy/Modelfile
```

The `SYSTEM` block in the [Modelfile](Modelfile) teaches the model how season-long
fantasy works and how to talk about it, and gives it no facts or numbers. Measured,
it was no better than stock:

| model | shown by the app | median time | heuristic flags |
| --- | --- | --- | --- |
| `deepseek-r1:14b` | 24/24 | 6.9 s | overstated gain 1 |
| `ds-nfl-fantasy`, first primer | 24/24 | 7.1 s | overstated gain 5 of 6 pitches, scouting claims 2, markdown 1, length 1 |
| `ds-nfl-fantasy`, current primer | 23/24 | 8.2 s | invented number 1, overstated gain 2, markdown 2, generic advice 1 |

The first primer cast the model as an enthusiastic analyst, and it called a 0.3-point
gain "a big boost" and described players from memory. Removing the persona fixed
most of that but did not bring it level with stock: the app's prompts, its fact-only
brief, and its number guard already do the work a primer would, and the longer prompt
costs about a second per answer.

### The provider patch it would need

Ollama applies a Modelfile's `SYSTEM` only to requests with no system message, and
every request from the app has one; checked on Ollama 0.33.3. A custom `TEMPLATE`
is no way around it, because Ollama renders this model with its built-in chat
template. [app-integration.patch](app-integration.patch) makes `OllamaProvider` fetch
the model's own system prompt from `/api/show` and put it ahead of the app's. Only a
model with its own `SYSTEM` needs it, so with the primer set aside it can stay unapplied.

## Known issue: `think: false` does not switch off reasoning

The provider sends `think: false` so that DeepSeek-R1 skips its reasoning. On Ollama
0.33.3 the stock model reasons anyway: 1,200 to 2,600 characters of hidden thinking
per answer, even for a one-word reply. The text shown is unaffected, because thinking
comes back in a separate field, but it is most of the stock model's wait.
`ds-nfl-lora` does not have the problem: it was trained to open and close an empty
think block, and on held-out prompts it produced no thinking at all.
