"""Thin training script over sense-model's own modules (wsd.train: PreparedDataset, collate, ChoiceTrainer,
choice_loss, read_teacher, _metrics; wsd.predict.Predictor), for prompts pre-built by the extension's code.

Differences from `wsd train` (whose main() is otherwise followed):
  - candidates keep the extension's order (PreparedDataset(shuffle=False)); `wsd train` always shuffles them;
  - batches are grouped by length (group_by_length) to keep padding low on prompts of 30-2048 tokens;
  - several train files may be given (labelled, teacher-only); the development set may be capped (--dev-limit);
  - no validate_splits shingle check (leakage is checked separately by check_leaks.py).
Loss (wsd.train.choice_loss): labelled rows with teacher scores: (1 - alpha) CE + alpha T^2 KL; labelled rows without:
CE; unlabelled rows: T^2 KL. Label smoothing over valid slots as in the repository default (0.1).
  venv/bin/python -I train_thin.py --train A.jsonl[,B.jsonl] --dev DEV.jsonl --output RUN [--teacher-scores CACHE] ...
"""
import argparse
import json
import random
import sys
import time
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path.home() / "src/sense-model/src"))
import torch  # noqa: E402
from transformers import EarlyStoppingCallback, TrainerCallback, TrainingArguments, set_seed  # noqa: E402
from wsd.data import read_jsonl  # noqa: E402
from wsd.predict import Predictor  # noqa: E402
from torch.nn import functional as F  # noqa: E402
from torch.utils.tensorboard import SummaryWriter  # noqa: E402
from wsd.train import ChoiceTrainer, PreparedDataset, collate, read_teacher  # noqa: E402

RUNS = Path.home() / ".cache/contextual-dictionary/validation/train/runs"
CHECKPOINT_FILES = ("model.safetensors", "optimizer.pt", "scheduler.pt", "trainer_state.json", "rng_state.pth")


def newest_complete_checkpoint(folder):
    """The highest-step checkpoint-N in folder holding every file a resume needs (a crash mid-save leaves one without)."""
    found = []
    for ck in Path(folder).glob("checkpoint-*"):
        if ck.name.split("-")[-1].isdigit() and all((ck / f).exists() for f in CHECKPOINT_FILES):
            try:
                json.loads((ck / "trainer_state.json").read_text())
            except ValueError:
                continue
            found.append((int(ck.name.split("-")[-1]), ck))
    return str(max(found)[1]) if found else None


class C1600EarlyStopping(EarlyStoppingCallback):
    """Early stopping on development accuracy at 24|c1600 only: the uncapped set's evaluation (a separate on_evaluate
    call with its own metrics) is skipped silently instead of warning."""

    def on_evaluate(self, args, state, control, metrics, **kwargs):
        if "eval_c1600_first" in metrics:
            super().on_evaluate(args, state, control, metrics, **kwargs)


def dev_metrics(pred):
    """Labelled meaning first (argmax over the offered meanings and "none of the above" is the gold one) and in the top
    three offered meanings (none of the above excluded); development rows all have their labelled meaning offered."""
    import numpy as np

    logits, labels = pred
    gold = labels.argmax(-1)
    first = (logits.argmax(-1) == gold).mean()
    offered = logits.copy()
    offered[:, 127] = -1e30
    top3 = (np.argsort(-offered, axis=-1)[:, :3] == gold[:, None]).any(-1).mean()
    nota = (logits.argmax(-1) == 127).mean()
    return {"first": float(first), "top3": float(top3), "nota": float(nota)}


from transformers.trainer_pt_utils import LengthGroupedSampler  # noqa: E402


class EpochSeededLengthSampler(LengthGroupedSampler):
    """LengthGroupedSampler whose shuffle comes from its own generator seeded by (seed, epoch), not from torch's global
    random state: a run resumed mid-epoch replays exactly the order of that epoch, so skipping the batches already
    trained leaves the rest of the epoch as it was (the stock sampler draws a new permutation after a restart)."""

    def __init__(self, *args, seed=42, **kwargs):
        super().__init__(*args, **kwargs)
        self.seed, self.epoch = seed, 0

    def set_epoch(self, epoch):
        self.epoch = int(epoch)

    def __iter__(self):
        self.generator = torch.Generator().manual_seed(self.seed * 1000 + self.epoch)
        return super().__iter__()


class LoggedTrainer(ChoiceTrainer):
    """ChoiceTrainer whose loss is unchanged; also accumulates the label CE and teacher KL parts for logging."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.parts = {"ce": 0.0, "ce_n": 0, "kl": 0.0, "kl_n": 0, "examples": 0}

    def _get_train_sampler(self, train_dataset=None):
        dataset = train_dataset if train_dataset is not None else self.train_dataset
        return EpochSeededLengthSampler(self.args.train_batch_size * self.args.gradient_accumulation_steps, dataset=dataset,
                                        model_input_name="input_ids", seed=self.args.seed)

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        result = super().compute_loss(model, {**inputs}, return_outputs=True, num_items_in_batch=num_items_in_batch)
        loss, out = result
        if model.training:
            with torch.no_grad():
                logits = out["logits"]
                labels, valid = inputs["labels"], inputs["valid_mask"]
                log_probs = F.log_softmax(logits, dim=-1)
                labeled = labels.sum(-1) > 0
                ce = -torch.logsumexp(log_probs.masked_fill(~labels.bool(), -1e9), dim=-1)
                if self.smoothing:
                    uniform = -(log_probs.masked_fill(~valid, 0).sum(-1) / valid.sum(-1))
                    ce = (1 - self.smoothing) * ce + self.smoothing * uniform
                avail = inputs["teacher_available"].bool()
                t = self.temperature
                kl = (inputs["teacher_probs"] * (inputs["teacher_probs"].clamp_min(1e-30).log() - F.log_softmax(logits / t, dim=-1))).sum(-1) * t * t
                self.parts["ce"] += float(ce[labeled].sum()); self.parts["ce_n"] += int(labeled.sum())
                self.parts["kl"] += float(kl[avail].sum()); self.parts["kl_n"] += int(avail.sum())
                self.parts["examples"] += int(labels.shape[0])
        return (loss, out) if return_outputs else loss

BASE = Path.home() / "src/sense-model/artifacts/upstream-english"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", default=str(BASE))
    p.add_argument("--train", required=True, help="comma-separated Example JSONL files")
    p.add_argument("--dev", required=True)
    p.add_argument("--output", required=True, help="checkpoints and final model")
    p.add_argument("--run-name", required=True, help="TensorBoard folder name under train/runs/")
    p.add_argument("--dev127", help="development examples of the uncapped form (evaluated alongside --dev)")
    p.add_argument("--reference", help="JSON of reference scalars (untrained student, teacher) to draw as flat lines")
    p.add_argument("--teacher-scores")
    p.add_argument("--distill-alpha", type=float, default=0.7)
    p.add_argument("--distill-temperature", type=float, default=2.0)
    p.add_argument("--label-smoothing", type=float, default=0.1)
    p.add_argument("--drop-labels", action="store_true", help="teacher-only: train labelled files without their labels")
    p.add_argument("--epochs", type=float, default=1)
    p.add_argument("--max-steps", type=int, default=-1)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--learning-rate", type=float, default=5e-5)
    p.add_argument("--weight-decay", type=float, default=0.01)
    p.add_argument("--save-steps", type=int, default=200)
    p.add_argument("--patience", type=int, default=4)
    p.add_argument("--train-limit", type=int)
    p.add_argument("--dev-limit", type=int, default=2000)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--gradient-checkpointing", action="store_true")
    a = p.parse_args()
    set_seed(a.seed)
    out = Path(a.output)
    if (out / "final" / "model.safetensors").exists():
        print(f"{out}/final exists: run already finished", flush=True)
        return
    out.mkdir(parents=True, exist_ok=True)
    (out / "args.json").write_text(json.dumps(vars(a), indent=2))

    train = [ex for f in a.train.split(",") for ex in read_jsonl(f)]
    random.Random(a.seed).shuffle(train)
    if a.train_limit:
        train = train[: a.train_limit]
    dev = read_jsonl(a.dev)
    random.Random(a.seed).shuffle(dev)
    dev = dev[: a.dev_limit]
    predictor = Predictor.from_pretrained(a.model, device="cuda")
    # The cache's fingerprints cover gold_ids, so it is checked against the examples as stored, before labels are dropped.
    teacher = read_teacher(a.teacher_scores, train, a.distill_temperature) if a.teacher_scores else {}
    if a.drop_labels:
        for ex in train:
            ex.gold_ids = None
    before = len(train)
    train = [ex for ex in train if ex.gold_ids is not None or ex.id in teacher]
    print(f"train {len(train)} (dropped {before - len(train)} unlabelled without teacher), teacher rows {len(teacher)}, dev {len(dev)}", flush=True)
    from wsd.tokenizer import encode_examples

    def fits(ex):
        try:
            encode_examples([ex], predictor.tokenizer, predictor.metadata)
            return True
        except ValueError:
            return False

    t0 = time.time()
    before = len(train)
    train = [ex for ex in train if fits(ex)]
    print(f"dropped {before - len(train)} training examples over {predictor.metadata['max_length']} tokens", flush=True)
    train_ds = PreparedDataset(train, predictor, a.seed, shuffle=False, teacher=teacher)
    dev_ds = PreparedDataset(dev, predictor)
    dev127 = read_jsonl(a.dev127) if a.dev127 else []
    random.Random(a.seed).shuffle(dev127)
    dev127_ds = PreparedDataset(dev127[: a.dev_limit], predictor) if dev127 else None
    print(f"encoded in {time.time() - t0:.0f} s", flush=True)
    predictor.model.train()
    predictor.model.config.label_smoothing = 0
    if a.gradient_checkpointing:
        predictor.model.gradient_checkpointing_enable()
    args = TrainingArguments(
        output_dir=str(out / "checkpoints"), per_device_train_batch_size=a.batch_size, per_device_eval_batch_size=16,
        gradient_accumulation_steps=a.grad_accum, learning_rate=a.learning_rate, weight_decay=a.weight_decay,
        num_train_epochs=a.epochs, max_steps=a.max_steps, seed=a.seed, eval_strategy="steps", save_strategy="steps",
        eval_steps=a.save_steps, save_steps=a.save_steps, save_total_limit=2, load_best_model_at_end=True,
        metric_for_best_model="eval_c1600_first", greater_is_better=True, logging_steps=10, lr_scheduler_type="cosine",
        warmup_steps=0.1, bf16=True, report_to="none", remove_unused_columns=False, label_names=["labels"],
        dataloader_num_workers=0, train_sampling_strategy="group_by_length",
    )

    resume = newest_complete_checkpoint(out / "checkpoints")
    resume_step = json.loads((Path(resume) / "trainer_state.json").read_text())["global_step"] if resume else None
    # On resume, purge_step makes TensorBoard drop events the interrupted process wrote after its last checkpoint,
    # so the step axis continues without duplicates.
    # (events at the checkpoint's own step, such as its development evaluation, belong to it and are kept)
    writer = SummaryWriter(log_dir=str(RUNS / a.run_name), flush_secs=30, purge_step=resume_step + 1 if resume else None)
    if resume:
        with (out / "metrics.jsonl").open("a") as f:
            f.write(json.dumps({"resume_from_step": resume_step, "checkpoint": Path(resume).name, "time": time.time()}) + "\n")
    writer.add_text("settings", "```\n" + json.dumps({**vars(a), "train_examples": len(train_ds), "dev_examples": len(dev_ds),
                    "dev127_examples": len(dev127_ds) if dev127_ds else 0, "teacher_rows": len(teacher)}, indent=1) + "\n```")
    reference = json.loads(Path(a.reference).read_text()) if a.reference else {}
    clock = {"t": time.time(), "examples": 0}

    class Log(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kw):
            logs = logs or {}
            with (out / "metrics.jsonl").open("a") as f:
                f.write(json.dumps({"step": state.global_step, "time": time.time(), **logs}) + "\n")
            step = state.global_step
            for k, v in logs.items():
                if not isinstance(v, (int, float)):
                    continue
                if k == "loss":
                    writer.add_scalar("train/loss_total", v, step)
                elif k == "learning_rate":
                    writer.add_scalar("train/learning_rate", v, step)
                elif k == "grad_norm":
                    writer.add_scalar("train/grad_norm", v, step)
                elif k.startswith("eval_"):
                    name = k[5:]
                    if name.endswith(("first", "top3", "nota", "loss")):
                        form, _, metric = name.rpartition("_")
                        writer.add_scalar(f"dev_{form}/{metric}", v, step)
            pr = trainer.parts
            if "loss" in logs:
                if pr["ce_n"]:
                    writer.add_scalar("train/loss_label_ce", pr["ce"] / pr["ce_n"], step)
                if pr["kl_n"]:
                    writer.add_scalar("train/loss_teacher_kl_T2", pr["kl"] / pr["kl_n"], step)
                now = time.time()
                writer.add_scalar("train/examples_per_second", (pr["examples"] - clock["examples"]) / max(now - clock["t"], 1e-9), step)
                writer.add_scalar("train/steps_per_second_logged", 10 / max(now - clock["t"], 1e-9), step)
                clock.update(t=now, examples=pr["examples"])
                writer.add_scalar("train/gpu_peak_allocated_gb", torch.cuda.max_memory_allocated() / 2**30, step)
                pr.update(ce=0.0, ce_n=0, kl=0.0, kl_n=0)
            writer.flush()

        def on_save(self, args, state, control, **kw):
            ck = Path(args.output_dir) / f"checkpoint-{state.global_step}"
            predictor.tokenizer.save_pretrained(ck)
            (ck / "model_metadata.json").write_text(json.dumps(predictor.metadata, indent=2) + "\n")

    evals = {"c1600": dev_ds, **({"uncapped": dev127_ds} if dev127_ds else {})}
    trainer = LoggedTrainer(model=predictor.model, args=args, train_dataset=train_ds, eval_dataset=evals,
                            data_collator=partial(collate, pad_id=predictor.tokenizer.pad_token_id), compute_metrics=dev_metrics,
                            callbacks=[Log(), C1600EarlyStopping(early_stopping_patience=a.patience)],
                            alpha=a.distill_alpha if teacher else 0, temperature=a.distill_temperature, smoothing=a.label_smoothing)
    # wsd's model forward takes **kwargs, so transformers 5 treats the loss as already normalised for gradient
    # accumulation and does not divide it; ChoiceTrainer returns a per-micro-batch mean, so without this the logged
    # loss and the gradients are grad_accum times too large.
    trainer.model_accepts_loss_kwargs = False
    baseline_file = out / "baseline.json"
    if resume is None or not baseline_file.exists():
        metrics0 = trainer.evaluate()
        baseline_file.write_text(json.dumps(metrics0, indent=1))
    else:
        metrics0 = json.loads(baseline_file.read_text())
    print("before training:", json.dumps(metrics0), flush=True)
    print(f"resuming from {resume}" if resume else "starting fresh", flush=True)
    total = trainer.args.max_steps if trainer.args.max_steps > 0 else int(len(train_ds) * a.epochs / (a.batch_size * a.grad_accum))
    if resume is None:
        for step in (0, total):
            for k, v in reference.items():
                writer.add_scalar(f"reference/{k}", v, step)
            for k, v in metrics0.items():
                if k.endswith(("first", "top3")):
                    writer.add_scalar(f"reference/untrained_{k[5:]}", v, step)
        writer.add_text("plan", f"total optimizer steps planned: {total}")
    else:
        writer.add_text("resume", f"resumed from {Path(resume).name}")
        for k, v in reference.items():  # the flat lines' end points lie after the purge step: write them again
            writer.add_scalar(f"reference/{k}", v, total)
        for k, v in metrics0.items():
            if k.endswith(("first", "top3")):
                writer.add_scalar(f"reference/untrained_{k[5:]}", v, total)
    writer.flush()
    trainer.train(resume_from_checkpoint=resume)
    metrics = trainer.evaluate()
    writer.add_text("result", "```\n" + json.dumps(metrics, indent=1) + "\n```")
    writer.close()
    predictor.model.eval()
    predictor.save_pretrained(out / "final")
    (out / "metrics.json").write_text(json.dumps({"before": metrics0, "after": metrics}, indent=2))
    print("after training:", json.dumps(metrics), flush=True)


if __name__ == "__main__":
    main()
