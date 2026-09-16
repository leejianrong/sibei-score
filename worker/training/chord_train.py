"""Train the Stage-2b chord-band recogniser on a V17b corpus and export ONNX (V17c, ADR-0031).

  python -m training.chord_train --corpus out/v17b-corpus --out out/v17c --epochs 30 --device cuda

Runs on a RunPod GPU pod (worker/Dockerfile.gpu + tools/runpod/rp train-relay); `--device cpu` works
for a tiny smoke run. Validation holds out the last `--val-frac` of seeds (unseen charts), so the
reported accuracy measures generalization, not memorisation. Two accuracies are reported:

- **character accuracy** — 1 - (character edit distance / true characters), the direct CTC signal;
- **chord accuracy** — 1 - (chord-level edit distance / true chords), where each chord (the text
  between separators) is one atomic token. This is what the downstream V5 corrector consumes, so it is
  the headline, and the best checkpoint is selected on it.

The artifact is `<out>/chord.onnx` plus `<out>/metrics.json`; the ONNX runs on onnxruntime CPU in the
bespoke engine's Stage-2b (V17d). This mirrors Stage-2a's `train.py`; the chord-level metric and the
band model (`ChordCRNN`, sized for the wide-short strip) are the differences.
"""

from __future__ import annotations

import argparse
import json
import os
from functools import partial

import torch
from torch import nn
from torch.utils.data import DataLoader

from .chord_dataset import BandCropDataset, collate, load_vocab
from .chord_model import ChordCRNN
from .dataset import _read_records
from .decode import edit_distance, greedy_decode, sequence_metrics
from .tracking import make_tracker


def corpus_seeds(corpus_dir: str) -> list[int]:
    return sorted({int(r["seed"]) for r in _read_records(corpus_dir)})


def split_seeds(seeds: list[int], val_frac: float) -> tuple[set[int], set[int]]:
    cut = max(1, int(round(len(seeds) * (1.0 - val_frac))))
    return set(seeds[:cut]), set(seeds[cut:]) or {seeds[-1]}


def read_sep(corpus_dir: str) -> int:
    with open(os.path.join(corpus_dir, "vocab.json"), encoding="utf-8") as fh:
        return int(json.load(fh).get("sep", 1))


def unbatch_targets(targets_cat: torch.Tensor, lengths: torch.Tensor) -> list[list[int]]:
    out: list[list[int]] = []
    offset = 0
    for length in lengths.tolist():
        out.append(targets_cat[offset : offset + length].tolist())
        offset += length
    return out


def split_chords(seq: list[int], sep: int) -> list[tuple[int, ...]]:
    """Split a character-id band sequence into per-chord character tuples on the separator id.

    Empty runs (a leading/trailing/doubled separator) are dropped, so a spurious separator costs one
    chord in the edit-distance metric rather than injecting an empty phantom chord.
    """
    chords: list[tuple[int, ...]] = []
    current: list[int] = []
    for cls in seq:
        if cls == sep:
            if current:
                chords.append(tuple(current))
                current = []
        else:
            current.append(cls)
    if current:
        chords.append(tuple(current))
    return chords


def chord_metrics(preds: list[list[int]], truths: list[list[int]], sep: int) -> dict[str, float]:
    """Chord-level exact-match and edit-rate: each chord (chars between separators) is one token.

    The band's decoded character stream is split on the separator, then the two chord sequences are
    compared with Levenshtein over atomic chord tokens — robust to a chord being dropped, inserted or
    split, which a positional zip would mis-score by shifting everything after it.
    """
    total_chords = 0
    chord_errors = 0
    exact_bands = 0
    for pred, truth in zip(preds, truths):
        p_chords = split_chords(pred, sep)
        t_chords = split_chords(truth, sep)
        # Map each distinct chord tuple to an int so the id-list edit distance can score them atomically.
        ids: dict[tuple[int, ...], int] = {}
        p_ids = [ids.setdefault(c, len(ids)) for c in p_chords]
        t_ids = [ids.setdefault(c, len(ids)) for c in t_chords]
        chord_errors += edit_distance(p_ids, t_ids)
        total_chords += len(t_chords)
        if p_chords == t_chords:
            exact_bands += 1
    return {
        "chord_accuracy": 1.0 - chord_errors / max(1, total_chords),
        "chord_error_rate": chord_errors / max(1, total_chords),
        "band_exact_match": exact_bands / max(1, len(truths)),
    }


@torch.no_grad()
def evaluate(model: ChordCRNN, loader: DataLoader, device: str, sep: int) -> dict[str, float]:
    model.eval()
    preds: list[list[int]] = []
    truths: list[list[int]] = []
    for images, targets_cat, _input_lengths, target_lengths in loader:
        logits = model(images.to(device))
        preds.extend(greedy_decode(logits.cpu()))
        truths.extend(unbatch_targets(targets_cat, target_lengths))
    return {**sequence_metrics(preds, truths), **chord_metrics(preds, truths, sep)}


def export_onnx(model: ChordCRNN, path: str, height: int, device: str) -> None:
    model.eval()
    dummy = torch.zeros(1, 1, height, 1024, device=device)
    kwargs = dict(
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch", 3: "width"}, "logits": {0: "batch", 1: "time"}},
        opset_version=13,
    )
    # Force the legacy TorchScript exporter: it produces the clean static graph the worker loads and
    # needs no onnxscript. Newer torch defaults to the dynamo exporter (`dynamo=True`); older torch
    # (the pod's 2.1, V15b) has no such kwarg, so fall back to the plain call there (mirrors detect_train).
    try:
        torch.onnx.export(model, dummy, path, dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(model, dummy, path, **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Stage-2b chord-band CRNN+CTC recogniser (V17c).")
    parser.add_argument("--corpus", required=True, help="V17b dump dir (vocab.json + labels.jsonl + crops/)")
    parser.add_argument("--out", default="out/v17c")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--height", type=int, default=32)
    parser.add_argument("--val-frac", type=float, default=0.15)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--tracker", choices=["none", "tensorboard", "wandb"], default="tensorboard")
    parser.add_argument("--run-name", default=None)
    parser.add_argument(
        "--augment",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Light per-epoch augmentation on the training split (on by default; --no-augment to disable).",
    )
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    vocab = load_vocab(args.corpus)
    sep = read_sep(args.corpus)
    train_seeds, val_seeds = split_seeds(corpus_seeds(args.corpus), args.val_frac)
    print(f"vocab {vocab.size} classes (sep={sep}) | train seeds {len(train_seeds)} | val seeds {len(val_seeds)} | device {args.device}")

    down = ChordCRNN.width_downsample()
    train_ds = BandCropDataset(args.corpus, seeds=train_seeds, height=args.height, augment=args.augment)
    val_ds = BandCropDataset(args.corpus, seeds=val_seeds, height=args.height, augment=False)
    # `partial`, not a lambda: DataLoader workers pickle the collate fn, and a lambda is unpicklable.
    collate_fn = partial(collate, width_downsample=down)
    train_loader = DataLoader(
        train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers, collate_fn=collate_fn,
    )
    val_loader = DataLoader(
        val_ds, batch_size=args.batch, shuffle=False, num_workers=args.workers, collate_fn=collate_fn,
    )

    model = ChordCRNN(vocab.size).to(args.device)
    ctc = nn.CTCLoss(blank=vocab.blank, zero_infinity=True)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    # Cosine decay: the V16 retro found checkpoint selection on a noisy val metric grabs an LR-driven
    # spike; a decaying LR settles the metric so the pick is less lucky (agent_docs/v15-training-notes.md).
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    tracker = make_tracker(
        args.tracker,
        logdir=os.path.join(args.out, "tb"),
        run_name=args.run_name,
        config=vars(args),
    )

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
        scheduler.step()
        metrics = evaluate(model, val_loader, args.device, sep)
        avg = total / max(1, len(train_loader))
        print(
            f"epoch {epoch:3d} | loss {avg:.3f} | char-acc {metrics['token_accuracy']:.3f} "
            f"| chord-acc {metrics['chord_accuracy']:.3f} | band-exact {metrics['band_exact_match']:.3f}"
        )
        history.append({"epoch": epoch, "loss": avg, **metrics})
        tracker.log(epoch, {
            "train/loss": avg,
            "val/char_accuracy": metrics["token_accuracy"],
            "val/chord_accuracy": metrics["chord_accuracy"],
            "val/chord_error_rate": metrics["chord_error_rate"],
            "val/band_exact_match": metrics["band_exact_match"],
        })
        if metrics["chord_accuracy"] > best:
            best = metrics["chord_accuracy"]
            torch.save(model.state_dict(), os.path.join(args.out, "chord.pt"))

    # Reload the best checkpoint and export it.
    model.load_state_dict(torch.load(os.path.join(args.out, "chord.pt"), map_location=args.device))
    export_onnx(model, os.path.join(args.out, "chord.onnx"), args.height, args.device)
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {"best_chord_accuracy": best, "height": args.height, "vocab_size": vocab.size, "sep": sep, "history": history},
            fh,
            indent=2,
        )
    tracker.close()
    print(f"done | best val chord-acc {best:.3f} | wrote {args.out}/chord.onnx")


if __name__ == "__main__":
    main()
