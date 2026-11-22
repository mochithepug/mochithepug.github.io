"""Read typed values from Tod_e.exe at virtual addresses.
Usage: python3 -I re/scripts/peek.py <exe> <VA>:<type> ...   types: u8 u16 u32 i32 f32 f64 str
"""
import struct, sys

def sections(pe):
    peoff = struct.unpack_from('<I', pe, 0x3c)[0]
    nsec = struct.unpack_from('<H', pe, peoff + 6)[0]
    optsz = struct.unpack_from('<H', pe, peoff + 20)[0]
    base = struct.unpack_from('<I', pe, peoff + 24 + 28)[0]
    out = []
    for i in range(nsec):
        o = peoff + 24 + optsz + i * 40
        name = pe[o:o + 8].rstrip(b'\0').decode()
        vsize, va, rsize, rptr = struct.unpack_from('<IIII', pe, o + 8)
        out.append((name, base + va, vsize, rsize, rptr))
    return out

def read(pe, secs, va, n):
    for name, sva, vsize, rsize, rptr in secs:
        if sva <= va < sva + max(vsize, rsize):
            off = va - sva
            return pe[rptr + off: rptr + off + n] if off < rsize else b'\0' * n  # .bss part
    raise ValueError(f'{va:#x} not in any section')

pe = open(sys.argv[1], 'rb').read()
secs = sections(pe)
fmt = {'u8': '<B', 'u16': '<H', 'u32': '<I', 'i32': '<i', 'f32': '<f', 'f64': '<d'}
for arg in sys.argv[2:]:
    a, t = arg.split(':')
    va = int(a, 16)
    if t == 'str':
        b = read(pe, secs, va, 128)
        z = b.split(bytes(1))[0]
        print(f'{va:08x} str {z!r}')
    else:
        v = struct.unpack(fmt[t], read(pe, secs, va, struct.calcsize(fmt[t])))[0]
        print(f'{va:08x} {t} {v!r}' + (f'  ({v:#x})' if isinstance(v, int) else ''))
