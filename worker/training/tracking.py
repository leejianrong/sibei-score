"""Optional training-metric tracking (V15b): TensorBoard by default, Weights & Biases opt-in.

Kept tiny and backend-agnostic so `train.py` calls one `tracker.log(step, metrics)` and the run
prints + `metrics.json` are always written regardless. TensorBoard is the default because it is
offline and needs no account, matching the project's local-first stance (ADR-0024); wandb is there
for a live cloud dashboard when watching a remote pod train, reading `WANDB_API_KEY` from the env
by reference (never logged), the same discipline as the RunPod key. A missing backend degrades to a
no-op with a printed note, never a crash — tracking must never be able to fail a training run.
"""

from __future__ import annotations

from typing import Any


class _Null:
    def log(self, step: int, metrics: dict[str, float]) -> None:  # noqa: D401
        pass

    def close(self) -> None:
        pass


class _TensorBoard:
    def __init__(self, logdir: str) -> None:
        from torch.utils.tensorboard import SummaryWriter

        self._writer = SummaryWriter(logdir)

    def log(self, step: int, metrics: dict[str, float]) -> None:
        for key, value in metrics.items():
            self._writer.add_scalar(key, value, step)

    def close(self) -> None:
        self._writer.close()


class _Wandb:
    def __init__(self, run_name: str | None, config: dict[str, Any] | None) -> None:
        import wandb

        self._wandb = wandb
        wandb.init(project="sibei-stage2a", name=run_name, config=config or {})

    def log(self, step: int, metrics: dict[str, float]) -> None:
        self._wandb.log({**metrics, "epoch": step})

    def close(self) -> None:
        self._wandb.finish()


def make_tracker(
    kind: str,
    logdir: str | None = None,
    run_name: str | None = None,
    config: dict[str, Any] | None = None,
) -> Any:
    """Build a tracker: 'tensorboard', 'wandb', or 'none'. Falls back to a no-op if the backend is
    absent, so a missing dependency (or a missing WANDB key) never fails training."""
    try:
        if kind == "tensorboard":
            return _TensorBoard(logdir or "runs")
        if kind == "wandb":
            return _Wandb(run_name, config)
    except Exception as error:  # noqa: BLE001 — a tracking backend must never break the run.
        print(f"tracker '{kind}' unavailable ({error}); metrics go to the console and metrics.json only")
        return _Null()
    return _Null()
