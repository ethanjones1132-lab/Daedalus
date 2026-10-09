"""Header facts of local GGUFs (architecture, layers, context, experts) without reading tensors or the vocabulary.
gguf.GGUFReader is very slow over E:, so this parses the first KV pairs only and stops at the tokenizer keys.

usage: gguf_arch.py FILE.gguf [FILE.gguf ...]"""
import struct
import sys

SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
FMT = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
WANT = ("general.architecture", "general.name", "general.file_type", ".block_count", ".context_length",
        ".expert_count", ".embedding_length", ".attention.head_count_kv", ".nextn_predict_layers",
        ".ssm.", ".full_attention_interval")


def head(path, limit=8 << 20):
    with open(path, "rb") as f:
        buf = f.read(limit)
    o = 0

    def rd(fmt):
        nonlocal o
        v = struct.unpack_from(fmt, buf, o)
        o += struct.calcsize(fmt)
        return v[0]

    def rstr():
        nonlocal o
        n = rd("<Q")
        s = buf[o:o + n].decode("utf-8", "replace")
        o += n
        return s

    def rval(t):
        nonlocal o
        if t == 8:
            return rstr()
        if t == 9:
            et, n = rd("<I"), rd("<Q")
            if et == 8:
                for _ in range(n):
                    rstr()
            else:
                o += SIZES[et] * n
            return f"<array {n}>"
        return rd(FMT[t])

    assert buf[:4] == b"GGUF", path
    o = 4
    rd("<I")
    rd("<Q")
    nkv = rd("<Q")
    out = {}
    for _ in range(nkv):
        k, t = rstr(), rd("<I")
        if k.startswith("tokenizer."):
            break
        v = rval(t)
        if any(w in k for w in WANT):
            out[k] = v
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(p.rsplit("\\", 1)[-1].rsplit("/", 1)[-1], head(p))
