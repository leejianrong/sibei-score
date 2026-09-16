"""Train the Stage-1 layout detector on a V16a corpus and export ONNX (V16b, ADR-0031).

  python -m training.detect_train --corpus out/v16a-corpus --out out/v16b --epochs 40 --device cuda

Runs on a RunPod GPU pod (worker/Dockerfile.gpu + tools/runpod/rp); `--device cpu` works for a tiny
smoke run. Validation holds out the last `--val-frac` of seeds (unseen pages), so the reported
detection F1 measures generalization. The artifact is `<out>/detect.onnx` plus `<out>/metrics.json`;
the ONNX runs on onnxruntime CPU in the bespoke engine's Stage-1 (V16c). The head is a plain conv
stack, so the graph exports with no dynamic op (the V15b lesson) — decoding is host-side numpy.
"""

from __future__ import annotations

import argparse
import json
import os
from functools import partial

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from .detect_dataset import DetectDataset, collate, corpus_seeds, load_classes
from .detect_decode import decode, detection_metrics
from .detect_model import IN_H, IN_W, Detector
from .tracking import make_tracker


def split_seeds(seeds: list[int], val_frac: float) -> tuple[set[int], set[int]]:
    cut = max(1, int(round(len(seeds) * (1.0 - val_frac))))
    return set(seeds[:cut]), set(seeds[cut:]) or {seeds[-1]}


def focal_loss(pred_logits: torch.Tensor, gt_heat: torch.Tensor) -> torch.Tensor:
    """CenterNet penalty-reduced focal loss over the centre heatmaps."""
    pred = pred_logits.sigmoid().clamp(1e-4, 1 - 1e-4)
    pos = gt_heat.eq(1.0).float()
    neg = 1.0 - pos
    neg_weight = torch.pow(1.0 - gt_heat, 4)
    pos_loss = torch.log(pred) * torch.pow(1.0 - pred, 2) * pos
    neg_loss = torch.log(1.0 - pred) * torch.pow(pred, 2) * neg_weight * neg
    num_pos = pos.sum()
    loss = -(pos_loss.sum() + neg_loss.sum())
    return loss / torch.clamp(num_pos, min=1.0)


def reg_l1(pred: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """L1 on offset/size, only at the centre cells (mask broadcast over the two channels)."""
    loss = (torch.abs(pred - target) * mask).sum()
    return loss / (mask.sum() * pred.shape[1] + 1e-4)


@torch.no_grad()
def evaluate(model: Detector, loader: DataLoader, device: str, class_names: list[str]) -> dict:
    model.eval()
    preds: list[list[dict]] = []
    truths: list[list[dict]] = []
    for images, _targets, gts in loader:
        out = model(images.to(device)).cpu().numpy()  # [B, NC+4, GH, GW]
        for i in range(out.shape[0]):
            # Decode in input-pixel coords (orig = the model input size), matching the GT boxes.
            preds.append(decode(out[i], IN_W, IN_H))
            truths.append(gts[i])
    return detection_metrics(preds, truths, class_names)


def export_onnx(model: Detector, path: str, device: str) -> None:
    model.eval()
    dummy = torch.zeros(1, 1, IN_H, IN_W, device=device)
    kwargs = dict(
        input_names=["page"],
        output_names=["detections"],
        dynamic_axes={"page": {0: "batch"}, "detections": {0: "batch"}},
        opset_version=13,
    )
    # Force the legacy TorchScript exporter: it produces the clean static graph the worker loads and
    # needs no onnxscript. Newer torch defaults to the dynamo exporter (`dynamo=True`); older torch
    # (the pod's 2.1, V15b) has no such kwarg, so fall back to the plain call there.
    try:
        torch.onnx.export(model, dummy, path, dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(model, dummy, path, **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Stage-1 layout detector (V16b).")
    parser.add_argument("--corpus", required=True, help="V16a dump dir (classes.json + labels.jsonl + pages/)")
    parser.add_argument("--out", default="out/v16b")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1.5e-3)
    parser.add_argument("--val-frac", type=float, default=0.15)
    parser.add_argument("--size-weight", type=float, default=1.0)
    parser.add_argument("--offset-weight", type=float, default=1.0)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--tracker", choices=["none", "tensorboard", "wandb"], default="tensorboard")
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--augment", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    class_names = load_classes(args.corpus)
    num_classes = len(class_names)
    train_seeds, val_seeds = split_seeds(corpus_seeds(args.corpus), args.val_frac)
    print(f"classes {class_names} | train seeds {len(train_seeds)} | val seeds {len(val_seeds)} | device {args.device}")

    train_ds = DetectDataset(args.corpus, num_classes, seeds=train_seeds, augment=args.augment)
    val_ds = DetectDataset(args.corpus, num_classes, seeds=val_seeds, augment=False)
    train_loader = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers, collate_fn=collate)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=args.workers, collate_fn=collate)

    model = Detector(num_classes).to(args.device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    tracker = make_tracker(args.tracker, logdir=os.path.join(args.out, "tb"), run_name=args.run_name, config=vars(args))

    best = -1.0
    history: list[dict] = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        for images, targets, _gts in train_loader:
            images = images.to(args.device)
            heat_t = targets["heat"].to(args.device)
            off_t = targets["offset"].to(args.device)
            size_t = targets["size"].to(args.device)
            mask = targets["mask"].to(args.device)

            out = model(images)
            heat_logits = out[:, :num_classes]
            off_pred = out[:, num_classes : num_classes + 2].sigmoid()
            size_pred = out[:, num_classes + 2 : num_classes + 4].sigmoid()

            loss = focal_loss(heat_logits, heat_t) + args.offset_weight * reg_l1(off_pred, off_t, mask) + args.size_weight * reg_l1(size_pred, size_t, mask)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += float(loss.item())

        metrics = evaluate(model, val_loader, args.device, class_names)
        avg = total / max(1, len(train_loader))
        staff_r = metrics["per_class"].get("staff", {}).get("recall", 0.0)
        print(f"epoch {epoch:3d} | loss {avg:.3f} | micro F1 {metrics['micro']['f1']:.3f} | staff recall {staff_r:.3f}")
        history.append({"epoch": epoch, "loss": avg, "micro": metrics["micro"], "staff_recall": staff_r})
        tracker.log(epoch, {
            "train/loss": avg,
            "val/micro_f1": metrics["micro"]["f1"],
            "val/micro_precision": metrics["micro"]["precision"],
            "val/micro_recall": metrics["micro"]["recall"],
            "val/staff_recall": staff_r,
        })
        # Select on staff recall first (the must-win), micro-F1 as the tiebreak.
        score = staff_r + 0.01 * metrics["micro"]["f1"]
        if score > best:
            best = score
            torch.save(model.state_dict(), os.path.join(args.out, "detect.pt"))
            with open(os.path.join(args.out, "val_metrics.json"), "w", encoding="utf-8") as fh:
                json.dump(metrics, fh, indent=2)

    model.load_state_dict(torch.load(os.path.join(args.out, "detect.pt"), map_location=args.device))
    export_onnx(model, os.path.join(args.out, "detect.onnx"), args.device)
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump({"classes": class_names, "best_score": best, "history": history}, fh, indent=2)
    tracker.close()
    print(f"done | best staff-recall-ish {best:.3f} | wrote {args.out}/detect.onnx")


if __name__ == "__main__":
    main()
