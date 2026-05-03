"""LLM-driven admission policy with rolling memory and periodic compaction.

The policy is a closure that holds:
  - K=5 ring of (state-summary, decision) pairs  (raw recent decisions)
  - a 1-line "policy so far" that summarises how the LLM has been deciding
  - the LLM client (OpenAI or Gemini)

At each call:
  1. Render the current state (live: bed occupancies, queue, new patient).
  2. Append the rolling memory + compacted policy summary.
  3. Ask the LLM for a single integer (bed index).
  4. Store the (state, decision) in the ring.
  5. Every 10 calls, ask the LLM to compact the ring into 1 sentence.
"""

from __future__ import annotations

import os
import re
import time
from collections import deque
from typing import Callable

from ed_model import SimState


SYS_PROMPT = """You are an emergency-department triage dispatcher.
A bed has just freed up. The waiting queue holds 2 or more patients.
Your job: choose ONE patient from the queue to admit next.
Severity scale: 1 = urgent, 2 = moderate, 3 = routine. Lower number is more urgent.
Trade-off: prioritising severity reduces urgent-patient wait but may starve routine patients.
You will see the queue, the current ED state, your last few decisions, and a one-line
summary of your policy so far. Decide consistently.
Reply with ONE integer: the index in the queue (0 = first in line, 1 = second, ...).
Reply with the integer only -- no words, no punctuation, no explanation."""


COMPACT_PROMPT = """Summarise the following recent dispatch decisions in
ONE short sentence (max 25 words) describing your policy so far. Reply
with the sentence only -- no preamble, no quotes."""


def _state_to_text(s: SimState) -> str:
    bed_lines = []
    for b in s.beds:
        if b.busy and b.occupant:
            rel = max(0.0, b.expected_release - s.now)
            bed_lines.append(
                f"  bed {b.idx}: BUSY -> sev{b.occupant.severity} pt, "
                f"~{rel:.0f} min until free"
            )
        else:
            bed_lines.append(f"  bed {b.idx}: FREE")
    queue_lines = []
    for i, p in enumerate(s.queue):
        wait_so_far = s.now - p.arrival_time
        queue_lines.append(
            f"  [{i}] pid={p.pid}, sev={p.severity}, waiting {wait_so_far:.1f} min"
        )
    return (
        f"Time t = {s.now:.1f} min\n"
        f"Beds:\n" + "\n".join(bed_lines) + "\n"
        f"Bed {s.free_bed_idx} just became free.\n"
        f"Queue ({len(s.queue)} patients):\n" + "\n".join(queue_lines)
    )


def _history_to_text(history: list) -> str:
    if not history:
        return "(no prior decisions yet)"
    lines = []
    for h in history[-5:]:
        lines.append(
            f"  t={h['t']}: admitted pid{h['pid']} sev{h['sev']} "
            f"(had waited {h['wait_so_far']} min, queue was {h['queue_len_before']})"
        )
    return "\n".join(lines)


# ---------- LLM wrappers ----------

class OpenAIClient:
    def __init__(self, model: str = "gpt-5.1"):
        from openai import OpenAI
        self.client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self.model = model
        # gpt-5* series are reasoning models; they spend tokens on hidden
        # reasoning before emitting any visible reply, so a "1-token answer"
        # actually needs a couple-dozen tokens of headroom.
        self.is_reasoning = model.startswith("gpt-5") or model.startswith("o")

    def call(self, system: str, user: str, max_tokens: int = 8) -> str:
        try:
            kwargs = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
            if self.is_reasoning:
                # min 200 tokens for reasoning headroom + reply
                kwargs["max_completion_tokens"] = max(max_tokens, 200)
                # reasoning models do not accept temperature
            else:
                kwargs["max_completion_tokens"] = max_tokens
                kwargs["temperature"] = 0.0
            resp = self.client.chat.completions.create(**kwargs)
            return resp.choices[0].message.content or ""
        except Exception as e:
            raise RuntimeError(f"OpenAI call failed: {e}") from e


class GeminiClient:
    def __init__(self, model: str = "gemini-2.5-flash"):
        from google import genai
        self.client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        self.model = model
        # gemini-2.5-flash supports disabling the thinking phase entirely;
        # gemini-2.5-pro forces thinking and so needs much larger budget.
        self.disable_thinking = "flash" in model

    def call(self, system: str, user: str, max_tokens: int = 8) -> str:
        from google.genai import types
        try:
            cfg_kwargs = dict(
                system_instruction=system,
                temperature=0.0,
                max_output_tokens=max(max_tokens, 32),
            )
            if self.disable_thinking:
                cfg_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
            else:
                # pro: must keep thinking enabled and give plenty of headroom
                cfg_kwargs["max_output_tokens"] = max(max_tokens, 1024)
            resp = self.client.models.generate_content(
                model=self.model,
                contents=user,
                config=types.GenerateContentConfig(**cfg_kwargs),
            )
            return (resp.text or "").strip()
        except Exception as e:
            raise RuntimeError(f"Gemini call failed: {e}") from e


# ---------- the policy itself ----------

def make_llm_policy(llm, *, name: str, log_calls: list | None = None) -> Callable[[SimState], int]:
    """Return an admission policy backed by an LLM with rolling memory."""

    summary = {"line": "(no policy yet -- be consistent across decisions)"}
    ring: deque = deque(maxlen=10)  # for compaction
    counter = {"n": 0}

    def parse_int(reply: str, q_len: int) -> int:
        m = re.search(r"-?\d+", reply or "")
        if not m:
            return 0
        idx = int(m.group(0))
        if 0 <= idx < q_len:
            return idx
        return 0

    def maybe_compact():
        if counter["n"] % 10 == 0 and len(ring) >= 5:
            text = "\n".join(
                f"  admitted pid{r['pid']} sev{r['sev']} after waiting {r.get('wait_so_far',0)} min"
                for r in ring
            )
            try:
                line = llm.call(COMPACT_PROMPT, text, max_tokens=80)
                line = line.strip().strip('"').strip("'")
                if line:
                    summary["line"] = line
            except Exception:
                pass

    def fn(s: SimState) -> int:
        q_len = len(s.queue)
        if q_len <= 1:
            return 0
        prompt = (
            "Recent decisions (memory):\n"
            f"{_history_to_text(s.history)}\n\n"
            f"Policy so far: {summary['line']}\n\n"
            f"Current state:\n{_state_to_text(s)}\n\n"
            f"Choose the queue index of the patient to admit next "
            f"(integer in 0..{q_len-1}):"
        )
        t0 = time.time()
        try:
            reply = llm.call(SYS_PROMPT, prompt, max_tokens=8)
            ok = True
        except Exception as e:
            reply = ""
            ok = False
        elapsed = time.time() - t0
        chosen = parse_int(reply, q_len)
        chosen_pt = s.queue[chosen]
        rec = {
            "t": round(s.now, 1),
            "pid": chosen_pt.pid,
            "sev": chosen_pt.severity,
            "wait_so_far": round(s.now - chosen_pt.arrival_time, 1),
            "queue_len_before": q_len,
            "queue_idx_chosen": chosen,
            "raw_reply": (reply or "")[:32],
            "ok": ok,
            "elapsed_s": round(elapsed, 3),
        }
        ring.append(rec)
        if log_calls is not None:
            log_calls.append(rec)
        counter["n"] += 1
        maybe_compact()
        return chosen

    fn.__name__ = name
    return fn
