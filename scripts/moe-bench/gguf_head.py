"""Read GGUF metadata (scalar/string keys only) from a remote file via HTTP Range."""
import struct, sys, urllib.request
url = sys.argv[1]
req = urllib.request.Request(url, headers={"Range": "bytes=0-16777215"})
buf = urllib.request.urlopen(req, timeout=120).read()
o = 0
def rd(fmt):
    global o
    v = struct.unpack_from(fmt, buf, o); o += struct.calcsize(fmt); return v[0]
def rstr():
    global o
    n = rd("<Q"); s = buf[o:o+n].decode("utf-8", "replace"); o += n; return s
SIZES = {0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8}
FMT = {0:"<B",1:"<b",2:"<H",3:"<h",4:"<I",5:"<i",6:"<f",7:"<?",10:"<Q",11:"<q",12:"<d"}
def rval(t):
    global o
    if t == 8: return rstr()
    if t == 9:
        et = rd("<I"); n = rd("<Q")
        if et == 8:
            for _ in range(n): rstr()
        else:
            o += SIZES[et] * n
        return f"<array {n}>"
    return rd(FMT[t])
assert buf[:4] == b"GGUF", buf[:4]
o = 4; ver = rd("<I"); nt = rd("<Q"); nkv = rd("<Q")
print("version", ver, "tensors", nt, "kv", nkv)
for _ in range(nkv):
    k = rstr(); t = rd("<I"); v = rval(t)
    if k == "tokenizer.chat_template": print("  chat_template present, chars:", len(v))
    elif any(s in k for s in ("architecture", "expert_count", "block_count")) and not k.startswith("tokenizer"):
        print(f"  {k} = {v}")
