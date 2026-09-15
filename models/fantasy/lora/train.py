"""
QLoRA fine-tune of DeepSeek-R1-Distill-Qwen-14B, the weights behind Ollama's
deepseek-r1:14b, on the app's three writing tasks.

    python models/fantasy/lora/train.py --base <hf model dir> --out <adapter dir>

Reads data/train.jsonl and data/val.jsonl from build-dataset.ts: each row is a
prompt rendered exactly as Ollama renders it, plus a completion. Loss is taken
on the completion only.

Sized for a 16 GB GPU that is also driving a desktop, which can leave about
11 GB: a 4-bit NF4 base, gradient checkpointing, batch 1 with gradient
accumulation, logits computed only for the completion, and a paged 8-bit AdamW.
peft's prepare_model_for_kbit_training is deliberately not used: it upcasts the
embedding and output layers to fp32, about 6 GB more on this model.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import bitsandbytes as bnb
import torch
import torch.nn.functional as F
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, get_cosine_schedule_with_warmup

HERE = Path(__file__).resolve().parent
# Must each be one token, or the prompt the model trains on is not the one Ollama sends.
SPECIAL = ['<｜begin▁of▁sentence｜>', '<｜User｜>', '<｜Assistant｜>', '<｜end▁of▁sentence｜>']


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def encode(tok, row: dict, max_len: int) -> tuple[list[int], int]:
    """Token ids of prompt + completion, and how many of them are the completion."""
    prompt = tok(row['prompt'], add_special_tokens=False)['input_ids']
    completion = tok(row['completion'], add_special_tokens=False)['input_ids']
    if len(prompt) + len(completion) > max_len:
        raise SystemExit(f"{row['id']} is {len(prompt) + len(completion)} tokens, over --max-len {max_len}")
    return prompt + completion, len(completion)


def completion_loss(model, ids: list[int], n: int) -> torch.Tensor:
    # Logits at position t predict token t + 1, so the last n + 1 positions cover
    # every completion token; the final one predicts past the end and is dropped.
    logits = model(input_ids=torch.tensor([ids], device='cuda'), logits_to_keep=n + 1).logits[0, :-1]
    return F.cross_entropy(logits.float(), torch.tensor(ids[-n:], device='cuda'))


@torch.no_grad()
def evaluate(model, rows: list[tuple[list[int], int]]) -> float:
    model.eval()
    total = sum(completion_loss(model, ids, n).item() for ids, n in rows)
    model.train()
    return total / len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True, help='Hugging Face model directory')
    ap.add_argument('--out', required=True, help='where adapters are saved, one per epoch')
    ap.add_argument('--data', default=str(HERE / 'data'))
    ap.add_argument('--epochs', type=int, default=2)
    ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--rank', type=int, default=16)
    ap.add_argument('--alpha', type=int, default=32)
    ap.add_argument('--accum', type=int, default=8)
    ap.add_argument('--max-len', type=int, default=4096)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--limit', type=int, default=0, help='train on only the first N rows: a smoke test of speed and memory')
    ap.add_argument(
        '--quantize-lm-head',
        action='store_true',
        help='also quantize the output layer to 4-bit, saving about 1.1 GB of VRAM',
    )
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.backends.cuda.matmul.allow_tf32 = True

    tok = AutoTokenizer.from_pretrained(args.base)
    for s in SPECIAL:
        n = len(tok(s, add_special_tokens=False)['input_ids'])
        assert n == 1, f'{s!r} is {n} tokens; the training prompt would not match what Ollama sends'

    data = Path(args.data)
    train = [encode(tok, r, args.max_len) for r in load(data / 'train.jsonl')]
    val = [encode(tok, r, args.max_len) for r in load(data / 'val.jsonl')]
    if args.limit:
        train, val = train[: args.limit], val[: max(1, args.limit // 4)]
    longest = max(len(ids) for ids, _ in train + val)
    print(f'{len(train)} train, {len(val)} val, longest {longest} tokens', flush=True)

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type='nf4',
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
        # transformers keeps lm_head in bf16 unless the skip list is non-empty and
        # leaves it out; naming a module that does not exist does exactly that.
        **({'llm_int8_skip_modules': ['__none__']} if args.quantize_lm_head else {}),
    )
    t_load = time.time()
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=quantization,
        dtype=torch.bfloat16,
        device_map={'': 0},
        attn_implementation='sdpa',
    )
    print(f'loaded in {time.time() - t_load:.0f}s, {torch.cuda.memory_allocated() / 2**30:.1f} GB on the GPU', flush=True)
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    model.enable_input_require_grads()
    model = get_peft_model(
        model,
        LoraConfig(
            r=args.rank,
            lora_alpha=args.alpha,
            lora_dropout=0.05,
            task_type='CAUSAL_LM',
            target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        ),
    )
    model.print_trainable_parameters()

    params = [p for p in model.parameters() if p.requires_grad]
    opt = bnb.optim.PagedAdamW8bit(params, lr=args.lr, weight_decay=0.0)
    steps = math.ceil(len(train) / args.accum) * args.epochs
    sched = get_cosine_schedule_with_warmup(opt, max(1, steps // 20), steps)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f'val loss before training: {evaluate(model, val):.4f}', flush=True)
    step, t0 = 0, time.time()
    model.train()
    for epoch in range(1, args.epochs + 1):
        order = list(range(len(train)))
        random.shuffle(order)
        running, in_group = 0.0, 0
        for i, j in enumerate(order, 1):
            ids, n = train[j]
            loss = completion_loss(model, ids, n)
            (loss / args.accum).backward()
            running += loss.item()
            in_group += 1
            if in_group == args.accum or i == len(order):
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
                step += 1
                print(
                    f'epoch {epoch} step {step}/{steps} loss {running / in_group:.4f} '
                    f'lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s '
                    f'peak {torch.cuda.max_memory_allocated() / 2**30:.1f} GB',
                    flush=True,
                )
                running, in_group = 0.0, 0
        v = evaluate(model, val)
        print(f'epoch {epoch} val loss {v:.4f}, peak GPU {torch.cuda.max_memory_allocated() / 2**30:.1f} GB', flush=True)
        model.save_pretrained(out / f'epoch-{epoch}')
    print(f'done in {(time.time() - t0) / 60:.1f} min; adapters in {out}', flush=True)


if __name__ == '__main__':
    main()
