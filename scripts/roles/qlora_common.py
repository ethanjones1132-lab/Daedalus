"""QLoRA pieces shared by the trainer and the smoke test (runs in Unsloth Studio's Python)."""
ATTN_MLP = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
EXCLUDE = r".*(visual|vision|merger).*"


def prefer_efficient_sdpa():
    """Qwen3.5 attention has 256-wide heads: PyTorch's flash kernel does not support them on this GPU, and HF's grouped-query
    shortcut (enable_gqa) then falls back to the math kernel, which materializes 16 x 4096 x 4096 scores (4.3 GB per layer).
    Expanding the keys and values instead lets the memory-efficient kernel run (250 MiB). Measured 2026-10-09."""
    import transformers.integrations.sdpa_attention as sa
    sa.use_gqa_in_sdpa = lambda *a, **k: False


def load_qlora(path, targets="all-linear", rank=16):
    """4-bit NF4 base with gradient checkpointing (no fp32 upcast of the embeddings) and a LoRA on top."""
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig

    prefer_efficient_sdpa()
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                             bnb_4bit_compute_dtype=torch.bfloat16)
    model = AutoModelForCausalLM.from_pretrained(path, quantization_config=bnb, dtype=torch.bfloat16, device_map={"": 0})
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    cfg = LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, task_type="CAUSAL_LM", exclude_modules=EXCLUDE,
                     target_modules="all-linear" if targets == "all-linear" else ATTN_MLP)
    return get_peft_model(model, cfg)


def swap_head(model):
    """Replace the output head with an identity (so forward returns hidden states) and return the real head."""
    import torch
    base = model.get_base_model() if hasattr(model, "get_base_model") else model
    head = base.get_output_embeddings()
    base.lm_head = torch.nn.Identity()
    return head


def _ce(head, x, y):
    import torch
    return torch.nn.functional.cross_entropy(head(x).float(), y, reduction="sum")


def reply_loss(model, head, ids, labels, chunk=512):
    """(mean loss over the reply tokens, their count): the forward gives hidden states; the real head and the
    cross-entropy run only on reply positions, in checkpointed chunks, so the 248k-wide logits never all exist."""
    import torch
    from torch.utils.checkpoint import checkpoint
    hidden = model(input_ids=ids).logits[0]
    target = labels[0, 1:]
    pos = (target != -100).nonzero(as_tuple=True)[0]
    hs, tg = hidden[:-1][pos], target[pos]
    total = hs.new_zeros((), dtype=torch.float32)
    for i in range(0, len(pos), chunk):
        total = total + checkpoint(_ce, head, hs[i:i + chunk], tg[i:i + chunk], use_reentrant=False)
    return total / len(pos), len(pos)
