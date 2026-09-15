"""Train the Stage-2a CRNN on a V15a corpus and export ONNX (V15b, ADR-0031).

  python -m training.train --corpus out/v15a-corpus --out out/v15b --epochs 30 --device cuda

Runs on a RunPod GPU pod (worker/Dockerfile.gpu + tools/runpod/rp); `--device cpu` works for a tiny
smoke run. Validation holds out the last `--val-frac` of seeds (unseen charts), so the reported
token accuracy measures generalization, not memorisation. The artifact is `<out>/model.onnx` plus a
`<out>/metrics.json`; the ONNX runs on onnxruntime CPU in the bespoke engine (V15c).
"""

from __future__ import annotations

import argparse
import json
import os
from functools import partial

import torch
from torch import nn
from torch.utils.data import DataLoader

from .dataset import CropDataset, collate, load_vocab, _read_records
from .decode import greedy_decode, sequence_metrics
from .model import CRNN


def corpus_seeds(corpus_dir: str) -> list[int]:
    return sorted({int(r["seed"]) for r in _read_records(corpus_dir)})


def split_seeds(seeds: list[int], val_frac: float) -> tuple[set[int], set[int]]:
    cut = max(1, int(round(len(seeds) * (1.0 - val_frac))))
    return set(seeds[:cut]), set(seeds[cut:]) or {seeds[-1]}


def unbatch_targets(targets_cat: torch.Tensor, lengths: torch.Tensor) -> list[list[int]]:
    out: list[list[int]] = []
    offset = 0
    for length in lengths.tolist():
        out.append(targets_cat[offset : offset + length].tolist())
        offset += length
    return out


@torch.no_grad()
def evaluate(model: CRNN, loader: DataLoader, device: str) -> dict[str, float]:
    model.eval()
    preds: list[list[int]] = []
    truths: list[list[int]] = []
    for images, targets_cat, _input_lengths, target_lengths in loader:
        logits = model(images.to(device))
        preds.extend(greedy_decode(logits.cpu()))
        truths.extend(unbatch_targets(targets_cat, target_lengths))
    return sequence_metrics(preds, truths)


def export_onnx(model: CRNN, path: str, height: int, device: str) -> None:
    model.eval()
    dummy = torch.zeros(1, 1, height, 512, device=device)
    torch.onnx.export(
        model,
        dummy,
        path,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch", 3: "width"}, "logits": {0: "batch", 1: "time"}},
        opset_version=13,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Stage-2a CRNN+CTC recogniser (V15b).")
    parser.add_argument("--corpus", required=True, help="V15a dump dir (vocab.json + labels.jsonl + crops/)")
    parser.add_argument("--out", default="out/v15b")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--height", type=int, default=128)
    parser.add_argument("--val-frac", type=float, default=0.15)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    vocab = load_vocab(args.corpus)
    train_seeds, val_seeds = split_seeds(corpus_seeds(args.corpus), args.val_frac)
    print(f"vocab {vocab.size} classes | train seeds {len(train_seeds)} | val seeds {len(val_seeds)} | device {args.device}")

    down = CRNN.width_downsample()
    train_ds = CropDataset(args.corpus, seeds=train_seeds, height=args.height)
    val_ds = CropDataset(args.corpus, seeds=val_seeds, height=args.height)
    # `partial`, not a lambda: DataLoader workers pickle the collate fn, and a lambda is unpicklable.
    collate_fn = partial(collate, width_downsample=down)
    train_loader = DataLoader(
        train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers, collate_fn=collate_fn,
    )
    val_loader = DataLoader(
        val_ds, batch_size=args.batch, shuffle=False, num_workers=args.workers, collate_fn=collate_fn,
    )

    model = CRNN(vocab.size).to(args.device)
    ctc = nn.CTCLoss(blank=vocab.blank, zero_infinity=True)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    best = -1.0
    history: list[dict] = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        for images, targets_cat, input_lengths, target_lengths in train_loader:
            optimizer.zero_grad()
            logits = model(images.to(args.device))  # [B, T, C]
            log_probs = logits.log_softmax(2).permute(1, 0, 2)  # [T, B, C] for CTCLoss
            loss = ctc(log_probs, targets_cat.to(args.device), input_lengths, target_lengths)
            loss.backward()
            optimizer.step()
            total += float(loss.item())
        metrics = evaluate(model, val_loader, args.device)
        avg = total / max(1, len(train_loader))
        print(f"epoch {epoch:3d} | loss {avg:.3f} | val exact {metrics['exact_match']:.3f} | val token-acc {metrics['token_accuracy']:.3f}")
        history.append({"epoch": epoch, "loss": avg, **metrics})
        if metrics["token_accuracy"] > best:
            best = metrics["token_accuracy"]
            torch.save(model.state_dict(), os.path.join(args.out, "model.pt"))

    # Reload the best checkpoint and export it.
    model.load_state_dict(torch.load(os.path.join(args.out, "model.pt"), map_location=args.device))
    export_onnx(model, os.path.join(args.out, "model.onnx"), args.height, args.device)
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump({"best_token_accuracy": best, "height": args.height, "vocab_size": vocab.size, "history": history}, fh, indent=2)
    print(f"done | best val token-acc {best:.3f} | wrote {args.out}/model.onnx")


if __name__ == "__main__":
    main()
