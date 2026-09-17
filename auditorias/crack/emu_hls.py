#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Emulador Unicorn para libpp_hls.so (ARM64, protegido con VM propia).

Fase 1: cargar la lib SIN Android, ejecutar INIT_ARRAY (despliega el bytecode
cifrado de .mips sobre .bss) y observar. Meta final: oráculo de firmas.

Uso:  python3 emu_hls.py [--dump] [--budget MILLONES]
"""
import sys, os, struct, zlib
from collections import Counter
from elftools.elf.elffile import ELFFile
from unicorn import *
import unicorn.arm64_const as A64
from unicorn.arm64_const import *

HERE = os.path.dirname(os.path.abspath(__file__))
LIB  = os.path.join(HERE, '..', 'apk', 'lib', 'arm64-v8a', 'libpp_hls.so')

BASE       = 0x40000000
STACK_BASE = 0x7F000000
STACK_SZ   = 0x00400000
HEAP_BASE  = 0x20000000
HEAP_SZ    = 0x01000000
TLS_BASE   = 0x34000000
MMAP_FIRST = 0x50000000
HOOK_PAGE  = 0x60000000
CLOSURE_PAGE = 0x62000000
JNI_PAGE   = 0x64000000
RET_MAGIC  = 0x6E000000

VFILE = {}
HOOKS_ADDR = {}   # nombre -> dirección trampa
HOOKS_NAME = {}   # dirección -> nombre
CLOSURES = {}     # dirección de trampolín -> (cif, fun, user_data)

# APIs que la lib suele resolver por dlsym en runtime
DLSYM_EXTRA = [
    'socket','bind','listen','accept','connect','recv','send','recvfrom','sendto',
    'close','setsockopt','getsockname','getsockopt','shutdown','select','poll',
    'epoll_create1','epoll_ctl','epoll_wait','fcntl','read','write','open','openat',
    'ioctl','getaddrinfo','freeaddrinfo','gethostbyname','inet_pton','inet_ntop',
    'htons','ntohs','getpid','getuid','gettimeofday','clock_gettime','time',
    'pthread_create','pthread_join','pthread_mutex_init','pthread_mutex_lock',
    'pthread_mutex_unlock','pthread_mutex_destroy','pthread_detach','pthread_self',
    'pthread_key_create','pthread_getspecific','pthread_setspecific','pthread_once',
    'syscall','prctl','getrandom','sysconf','usleep','nanosleep','raise','exit',
    '_exit','strtol','strtod','snprintf','sprintf','strchr','strrchr','memmove',
    'memcmp','realloc','qsort','rand','srand','atoi','getenv','setenv','localtime_r',
    'strftime','mktime','__system_property_get','android_getaddrinfofornetwork',
]


def log(*a):
    print(*a, flush=True)


class Host:
    """libc mínima implementada sobre el proceso anfitrión."""

    def __init__(self, uc):
        self.uc = uc
        self.next_alloc = HEAP_BASE + 0x1000
        self.next_mmap = MMAP_FIRST
        self.calls = Counter()
        self.files = {}
        self.dlsym_log = []
        self.dlopen_log = []
        self.clock = 1700000000_000000000  # ns, avanza con cada lectura

    def _alloc(self, n):
        a = self.next_alloc
        self.next_alloc += (n + 0x1f) & ~0xf
        if self.next_alloc >= HEAP_BASE + HEAP_SZ:
            raise RuntimeError('heap agotado')
        return a

    def rstr(self, addr, maxlen=8192):
        out = b''
        while len(out) < maxlen:
            chunk = bytes(self.uc.mem_read(addr + len(out), 128))
            i = chunk.find(b'\0')
            if i >= 0:
                return out + chunk[:i]
            out += chunk
        return out

    def putstr(self, s):
        b = s.encode() if isinstance(s, str) else s
        a = self._alloc(len(b) + 1)
        self.uc.mem_write(a, b + b'\0')
        return a

    # -- libc --
    def malloc(self, n):
        self.calls['malloc'] += 1
        return self._alloc(max(n, 16))

    def calloc(self, n, sz):
        self.calls['calloc'] += 1
        a = self._alloc(max(n * sz, 16))
        self.uc.mem_write(a, b'\0' * (n * sz))
        self.track_alloc(a, n * sz)
        return a

    # --- rastreo de strings que la VM construye en el heap ---
    watched = {}
    seen_strings = []
    snapshots = {}

    def track_alloc(self, a, size):
        if 1 <= size <= 256:
            self.watched[a] = size
            self.snapshots[a] = bytes(self.uc.mem_read(a, size))

    def scan_strings(self):
        """Recoge texto nuevo en las zonas pequeñas reservadas por la VM."""
        out = []
        for a, size in list(self.watched.items()):
            try:
                b = bytes(self.uc.mem_read(a, size))
            except Exception:
                continue
            if b == self.snapshots.get(a):
                continue
            self.snapshots[a] = b
            for t in b.split(b'\0'):
                if len(t) >= 3 and all(32 <= c < 127 for c in t):
                    txt = t.decode()
                    if txt not in self.seen_strings:
                        self.seen_strings.append(txt)
                        out.append((hex(a), txt))
        return out

    def free(self, a):
        self.calls['free'] += 1
        return 0

    def memcpy(self, dst, src, n):
        self.calls['memcpy'] += 1
        if n:
            self.uc.mem_write(dst, bytes(self.uc.mem_read(src, n)))
        return dst

    def memset(self, dst, c, n):
        self.calls['memset'] += 1
        if n:
            self.uc.mem_write(dst, bytes([c & 0xff]) * n)
        return dst

    def mmap(self, addr, length, prot, flags, fd, off):
        self.calls['mmap'] += 1
        length = (length + 0xfff) & ~0xfff
        a = self.next_mmap
        self.next_mmap += length
        try:
            self.uc.mem_map(a, length, UC_PROT_ALL)
        except UcError:
            pass
        log(f'    [mmap {hex(length)} → {hex(a)} prot={prot}]')
        return a

    def mprotect(self, addr, length, prot):
        self.calls['mprotect'] += 1
        log(f'    [mprotect {hex(addr)}+{hex(length)} prot={prot}]')
        return 0

    def munmap(self, a, l):
        self.calls['munmap'] += 1
        return 0

    def uncompress(self, dst, dstlen_p, src, srclen):
        self.calls['uncompress'] += 1
        raw = bytes(self.uc.mem_read(src, srclen))
        try:
            out = zlib.decompress(raw)
        except Exception as e:
            log(f'    !! uncompress FALLÓ ({e}) srclen={srclen} head={raw[:8].hex()}')
            return 1
        self.uc.mem_write(dst, out)
        self.uc.mem_write(dstlen_p, struct.pack('<Q', len(out)))
        log(f'    [uncompress {srclen} → {len(out)}]')
        return 0

    # -- stdio --
    def fopen(self, p_a, m_a):
        self.calls['fopen'] += 1
        p = self.rstr(p_a).decode('latin1')
        log(f'    [fopen "{p}"]')
        body = VFILE.get(p)
        if body is None:
            return 0
        h = 0x7100 + len(self.files)
        self.files[h] = bytearray(body)
        return h

    def fgets(self, buf, size, h):
        self.calls['fgets'] += 1
        b = self.files.get(h)
        if not b:
            return 0
        line = bytes(b[:size - 1])
        i = line.find(b'\n')
        if i >= 0:
            line = line[:i + 1]
        del b[:len(line)]
        self.uc.mem_write(buf, line + b'\0')
        return buf

    def fclose(self, h):
        self.calls['fclose'] += 1
        self.files.pop(h, None)
        return 0

    def fprintf(self, stream, fmt_a, *rest):
        self.calls['fprintf'] += 1
        log(f'    [fprintf {self.rstr(fmt_a)[:100]!r}]')
        return 0

    def puts(self, s_a):
        self.calls['puts'] += 1
        s = self.rstr(s_a)
        log(f'    [puts {s[:200]!r}]')
        return len(s)

    def vsnprintf(self, buf, size, fmt_a, ap):
        self.calls['vsnprintf'] += 1
        out = self.rstr(fmt_a)[:size - 1] + b'\0'
        self.uc.mem_write(buf, out)
        return len(out)

    def sscanf(self, *a):
        self.calls['sscanf'] += 1
        return 0

    # -- strings --
    def strlen(self, a):
        self.calls['strlen'] += 1
        return len(self.rstr(a))

    def strcmp(self, a, b):
        self.calls['strcmp'] += 1
        x, y = self.rstr(a), self.rstr(b)
        return (x > y) - (x < y)

    def strncmp(self, a, b, n):
        self.calls['strncmp'] += 1
        x, y = self.rstr(a, n), self.rstr(b, n)
        return (x > y) - (x < y)

    def strncpy(self, dst, src, n):
        self.calls['strncpy'] += 1
        s = self.rstr(src, n)[:n]
        self.uc.mem_write(dst, s.ljust(n, b'\0'))
        return dst

    def strstr(self, h, nd):
        self.calls['strstr'] += 1
        hs, ns = self.rstr(h), self.rstr(nd)
        i = hs.find(ns)
        return 0 if i < 0 else h + i

    def isspace(self, c):
        self.calls['isspace'] += 1
        return 1 if chr(c & 0xff).isspace() else 0

    def fmod(self, a, b):
        self.calls['fmod'] += 1
        return 0.0

    fmodf = fmod

    # -- dl / señales --
    def dlopen(self, p_a, mode):
        self.calls['dlopen'] += 1
        p = self.rstr(p_a).decode('latin1') if p_a else '(self)'
        self.dlopen_log.append(p)
        log(f'    [dlopen "{p}"]')
        h = 0x9100 + len(self.dlopen_log)
        return h

    def dlsym(self, handle, name_a):
        self.calls['dlsym'] += 1
        nm = self.rstr(name_a).decode('latin1')
        self.dlsym_log.append(nm)
        addr = HOOKS_ADDR.get(nm, 0)
        log(f'    [dlsym "{nm}" → {hex(addr)}]')
        return addr

    def dl_iterate_phdr(self, cb, data):
        self.calls['dl_iterate_phdr'] += 1
        log('    [dl_iterate_phdr → 0]')
        return 0

    def dladdr(self, addr, info):
        self.calls['dladdr'] += 1
        log(f'    [dladdr {hex(addr)} → 0]')
        return 0

    def sigaction(self, sig, act, old):
        self.calls['sigaction'] += 1
        log(f'    [sigaction sig={sig} → 0]')
        return 0

    def abort(self):
        self.calls['abort'] += 1
        raise RuntimeError('la librería llamó abort()')

    def stack_chk_fail(self):
        self.calls['__stack_chk_fail'] += 1
        raise RuntimeError('__stack_chk_fail (canario pisado)')

    def cxa_finalize(self, d):
        self.calls['__cxa_finalize'] += 1
        return 0

    def pure_virtual(self):
        self.calls['__cxa_pure_virtual'] += 1
        return 0

    # -- C++ new/delete --
    def new_op(self, n):
        self.calls['_Znwm'] += 1
        return self._alloc(max(n, 8))

    def new_arr(self, n):
        self.calls['_Znam'] += 1
        return self._alloc(max(n, 8))

    def del_op(self, a):
        self.calls['_ZdlPv'] += 1
        return 0

    del_arr = del_op

    # -- genérico para dlsym no críticos --
    def stub(self, name='?', *a):
        self.calls[f'stub:{name}'] += 1
        log(f'    [stub {name} args={tuple(hex(x) for x in a[:4])} → 0]')
        return 0


HOOK_TABLE_NAMES = {
    'malloc': 'malloc', 'calloc': 'calloc', 'free': 'free',
    'memcpy': 'memcpy', 'memset': 'memset', 'memcmp': 'stub', 'memmove': 'memcpy',
    'mmap': 'mmap', 'mprotect': 'mprotect', 'munmap': 'munmap',
    'uncompress': 'uncompress',
    'fopen': 'fopen', 'fgets': 'fgets', 'fclose': 'fclose',
    'fprintf': 'fprintf', 'puts': 'puts', 'vsnprintf': 'vsnprintf',
    'sscanf': 'sscanf', 'snprintf': 'vsnprintf', 'sprintf': 'vsnprintf',
    'strlen': 'strlen', 'strcmp': 'strcmp', 'strncmp': 'strncmp',
    'strncpy': 'strncpy', 'strstr': 'strstr', 'strchr': 'stub', 'strrchr': 'stub',
    'isspace': 'isspace', 'fmod': 'fmod', 'fmodf': 'fmodf',
    'dlopen': 'dlopen', 'dlsym': 'dlsym', 'dl_iterate_phdr': 'dl_iterate_phdr',
    'dladdr': 'dladdr', 'sigaction': 'sigaction', 'abort': 'abort',
    '__stack_chk_fail': 'stack_chk_fail', '__cxa_finalize': 'cxa_finalize',
    '__cxa_pure_virtual': 'pure_virtual',
    '_Znwm': 'new_op', '_Znam': 'new_arr', '_ZdlPv': 'del_op', '_ZdaPv': 'del_arr',
    'realloc': 'malloc', 'qsort': 'stub', 'rand': 'stub', 'srand': 'stub',
    'atoi': 'stub', 'strtol': 'stub', 'strtod': 'stub', 'getenv': 'stub',
    'setenv': 'stub', 'localtime_r': 'stub', 'strftime': 'stub', 'mktime': 'stub',
    'usleep': 'stub', 'nanosleep': 'stub', 'raise': 'stub', 'exit': 'stub',
    '_exit': 'stub', '__system_property_get': 'stub',
    'socket': 'stub', 'bind': 'stub', 'listen': 'stub', 'accept': 'stub',
    'connect': 'stub', 'recv': 'stub', 'send': 'stub', 'recvfrom': 'stub',
    'sendto': 'stub', 'close': 'stub', 'setsockopt': 'stub', 'getsockname': 'stub',
    'getsockopt': 'stub', 'shutdown': 'stub', 'select': 'stub', 'poll': 'stub',
    'epoll_create1': 'stub', 'epoll_ctl': 'stub', 'epoll_wait': 'stub',
    'fcntl': 'stub', 'read': 'stub', 'write': 'stub', 'open': 'stub',
    'openat': 'stub', 'ioctl': 'stub', 'getaddrinfo': 'stub',
    'freeaddrinfo': 'stub', 'gethostbyname': 'stub', 'inet_pton': 'stub',
    'inet_ntop': 'stub', 'htons': 'stub', 'ntohs': 'stub', 'getpid': 'stub',
    'getuid': 'stub', 'gettimeofday': 'stub', 'clock_gettime': 'stub',
    'time': 'stub', 'pthread_create': 'stub', 'pthread_join': 'stub',
    'pthread_mutex_init': 'stub', 'pthread_mutex_lock': 'stub',
    'pthread_mutex_unlock': 'stub', 'pthread_mutex_destroy': 'stub',
    'pthread_detach': 'stub', 'pthread_self': 'stub', 'pthread_key_create': 'stub',
    'pthread_getspecific': 'stub', 'pthread_setspecific': 'stub',
    'pthread_once': 'stub', 'syscall': 'stub', 'prctl': 'stub',
    'getrandom': 'stub', 'sysconf': 'stub',
    'android_getaddrinfofornetwork': 'stub',
}


class Emu:
    def __init__(self):
        self.uc = Uc(UC_ARCH_ARM64, UC_MODE_LITTLE_ENDIAN)
        uc = self.uc
        self.data = open(LIB, 'rb').read()
        self.elf = ELFFile(open(LIB, 'rb'))

        # segmentos
        self.segments = []
        for s in self.elf.iter_segments():
            if s['p_type'] != 'PT_LOAD':
                continue
            va, off, fsz, msz = s['p_vaddr'], s['p_offset'], s['p_filesz'], s['p_memsz']
            p0 = va & ~0xfff
            size = (((va + msz) + 0xfff) & ~0xfff) - p0
            uc.mem_map(BASE + p0, size, UC_PROT_ALL)
            uc.mem_write(BASE + va, self.data[off:off + fsz].ljust(msz, b'\0'))
            self.segments.append((BASE + va, msz))
            log(f'segmento {hex(va)} filesz={hex(fsz)} memsz={hex(msz)} → {hex(BASE+p0)}+{hex(size)}')

        for addr, size in ((STACK_BASE, STACK_SZ), (HEAP_BASE, HEAP_SZ),
                           (TLS_BASE, 0x10000), (HOOK_PAGE, 0x100000),
                           (RET_MAGIC & ~0xfff, 0x10000),
                           (CLOSURE_PAGE, 0x100000),
                           (JNI_PAGE, 0x40000)):
            uc.mem_map(addr, size, UC_PROT_ALL)
        # trampolín de closures FFI: un único 'ret' (lo interceptamos antes)
        uc.mem_write(CLOSURE_PAGE, b'\xc0\x03\x5f\xd6' * 4)


        # trampolines de imports
        allnames = sorted(set(HOOK_TABLE_NAMES) | set(DLSYM_EXTRA))
        for i, nm in enumerate(allnames):
            a = HOOK_PAGE + 0x100 + i * 0x10
            HOOKS_ADDR[nm] = a
            HOOKS_NAME[a] = nm
            uc.mem_write(a, b'\xc0\x03\x5f\xd6')

        # datos de symbols (GLOB_DAT no-función)
        self.host = Host(uc)
        self.canary = 0x123456789abcdef0
        self.chk_guard = self.host._alloc(8)
        uc.mem_write(self.chk_guard, struct.pack('<Q', self.canary))
        self.sF = self.host._alloc(0x400)   # FILE[3] falsa
        self.DATA_SYMS = {'__stack_chk_guard': self.chk_guard, '__sF': self.sF}

        self._apply_relocs()
        self._build_plt_map()
        self._wire_callbacks()

        # TLS + canario en [tpidr+0x28]
        uc.mem_write(TLS_BASE + 0x28, struct.pack('<Q', self.canary))
        uc.reg_write(UC_ARM64_REG_TPIDR_EL0, TLS_BASE)
        uc.reg_write(UC_ARM64_REG_SP, STACK_BASE + STACK_SZ - 0x1000)

        # /proc/self/maps creíble
        maps = []
        for a, sz in self.segments:
            maps.append(f'{a:x}-{a+sz:x} r-xp 00000000 fe:00 1 /data/app/libpp_hls.so')
        maps.append(f'{HEAP_BASE:x}-{HEAP_BASE+HEAP_SZ:x} rw-p 00000000 00:00 0 [anon]')
        VFILE['/proc/self/maps'] = ('\n'.join(maps) + '\n').encode()
        VFILE['/proc/self/status'] = b'Name:\tpp_hls\nState:\tR\nTracerPid:\t0\nUid:\t10123\n'
        VFILE['/proc/self/cmdline'] = b'com.pp.hls\0'

        self.total_insn = 0
        self.bss_blocks = set()
        self.trace_calls = True
        self.block_hits = Counter()
        self.block_seq = []
        self.trace_blocks = 400
        self.ffi_log = []
        self.next_closure = CLOSURE_PAGE
        self.PLT_MAP = {}
        self.jni_log = []
        self.syscalls = Counter()
        self.bad_svc = []
        self.opcode_count = 0
        self.opcodes = []
        self.dispatch = []
        self.vm_trace = []

    # -- relocalizaciones --
    def _apply_relocs(self):
        uc = self.uc
        dyn = self.elf.get_section_by_name('.dynsym')
        names = {i: s.name for i, s in enumerate(dyn.iter_symbols())}
        defined = {}   # símbolo definido EN esta lib → base + valor
        for i, s in enumerate(dyn.iter_symbols()):
            if s.name and s['st_shndx'] != 'SHN_UNDEF' and s['st_value']:
                defined[s.name] = BASE + s['st_value']
        n = intern = 0
        self.unresolved = []
        for rn in ('.rela.dyn', '.rela.plt'):
            sec = self.elf.get_section_by_name(rn)
            if sec is None:
                continue
            for r in sec.iter_relocations():
                t = r['r_info_type']
                tgt = BASE + r['r_offset']
                if t == 0x403:   # RELATIVE
                    uc.mem_write(tgt, struct.pack('<Q', BASE + r['r_addend']))
                    n += 1
                elif t in (0x401, 0x402):   # GLOB_DAT / JUMP_SLOT
                    sym = names.get(r['r_info_sym'], '')
                    if sym in self.DATA_SYMS:
                        val = self.DATA_SYMS[sym]
                    elif sym in defined:
                        val = defined[sym]   # p.ej. interpreter_wrap_int64_t, ffi_*
                        intern += 1
                    elif sym in HOOKS_ADDR:
                        val = HOOKS_ADDR[sym]
                    else:
                        val = 0
                        log(f'  !! reloc sin resolver para "{sym}"')
                        self.unresolved.append(sym)
                    uc.mem_write(tgt, struct.pack('<Q', val))
                    n += 1
        log(f'relocs: {n} (de ellas {intern} a símbolos internos)')

    def _build_plt_map(self):
        """PLT interno (0x6d020..) → nombre de símbolo, para saber qué llama la lib."""
        uc = self.uc
        self.PLT_MAP = {}
        # GOT → nombre desde .rela.plt
        dyn = self.elf.get_section_by_name('.dynsym')
        names = {i: s.name for i, s in enumerate(dyn.iter_symbols())}
        got2sym = {}
        sec = self.elf.get_section_by_name('.rela.plt')
        for r in sec.iter_relocations():
            got2sym[r['r_offset']] = names.get(r['r_info_sym'], '?')
        # recorrer stubs PLT: adrp x16,page ; ldr x17,[x16,#imm]
        # los stubs viven entre 0x6d020 y 0x6d350 (no hay sección .plt: está ofuscada)
        base, size = 0x6d000, 0x360
        data = self.data[base:base + size]
        for off in range(0, len(data) - 16, 16):
            w0, w1 = struct.unpack_from('<II', data, off)
            if (w0 & 0x9f000000) != 0x90000000 or (w1 & 0xffc00000) != 0xf9400000:
                continue
            immlo = (w0 >> 29) & 3
            immhi = (w0 >> 5) & 0x7ffff
            imm = (immhi << 2) | immlo
            if imm & 0x100000:
                imm -= 0x200000
            page = ((base + off) & ~0xfff) + (imm << 12)
            got = page + (((w1 >> 10) & 0xfff) << 3)
            nm = got2sym.get(got) or got2sym.get(got - BASE)
            if nm:
                self.PLT_MAP[base + off] = nm
        log(f'PLT interno mapeado: {len(self.PLT_MAP)} entradas')

    # -- callbacks --
    def _wire_callbacks(self):
        uc = self.uc

        def on_block(uc, address, size, ud):
            if HOOK_PAGE <= address < HOOK_PAGE + 0x100000:
                return
            if address >= RET_MAGIC:
                uc.emu_stop()
                return
            self.block_hits[address] += 1
            if address == BASE + 0xf0154:      # br x0 del dispatcher de opcodes
                self.opcode_count += 1
                self.dispatch.append(uc.reg_read(UC_ARM64_REG_X0))
            if len(self.block_seq) < self.trace_blocks:
                self.block_seq.append(address)
            if self.block_hits[address] == 3_000_000:
                log(f'    !! bucle: bloque {hex(address)} ejecutado 3M veces — deteniendo')
                uc.emu_stop()
                self.stuck_at = address  # noqa
                return
            if len(self.bss_blocks) < 50000 and BASE + 0x15a858 <= address < BASE + 0x600000:
                self.bss_blocks.add(address)

        def on_intr(uc, intno, ud):
            # SVC: syscall bionic. Registramos y devolvemos 0 / -ENOSYS.
            x8 = uc.reg_read(UC_ARM64_REG_X8)
            pc = uc.reg_read(UC_ARM64_REG_PC)
            if x8 < 500:
                log(f'    [SVC {x8} en {hex(pc)} → 0]')
                self.syscalls[x8] += 1
            elif len(self.bad_svc) < 5:
                log(f'    !! SVC con x8={hex(x8)} en {hex(pc)} (código no válido)')
                self.bad_svc.append((pc, x8))
            uc.reg_write(UC_ARM64_REG_X0, 0)

        def on_mem_invalid(uc, access, address, size, value, ud):
            pc = uc.reg_read(UC_ARM64_REG_PC)
            kind = 'FETCH' if access in (UC_MEM_FETCH_UNMAPPED, UC_MEM_FETCH_PROT) else (
                   'W' if access in (UC_MEM_WRITE_UNMAPPED, UC_MEM_WRITE_PROT) else 'R')
            log(f'    !! acceso inválido {kind} {hex(address)} (size {size}) desde {hex(pc)}')
            if kind == 'FETCH':
                regs = [f'x{i}={uc.reg_read(getattr(A64, f"UC_ARM64_REG_X{i}")):x}' for i in (0, 16, 17, 19, 20, 30)]
                log(f'       regs: {" ".join(regs)}')
                log(f'       últimos 12 bloques: {[hex(a) for a in self.block_seq[-12:]]}')
                log(f'       GOT ceros conocidos: ver dump de relocs sin resolver arriba')
                self.crash_regs = regs
            return False

        def on_opcode(uc, address, size, ud):
            # 0xf0148: ldrh w0,[x1,w0,uxtw #1]  → el índice de opcode está en w0
            idx = uc.reg_read(UC_ARM64_REG_X0) & 0xffff
            self.opcodes.append(idx)
            # estado del intérprete: x19 = contexto, +8 = longitud restante de bytecode
            try:
                x19 = uc.reg_read(UC_ARM64_REG_X19)
                rem = struct.unpack('<Q', bytes(uc.mem_read(x19 + 8, 8)))[0]
                pos = struct.unpack('<Q', bytes(uc.mem_read(x19 + 0x20, 8)))[0]
                self.vm_trace.append((idx, rem, pos))
            except Exception:
                pass

        def on_direct(uc, address, size, ud):
            off = address - BASE
            if off in self.DIRECT:
                log(f'    [llamada directa a {self.DIRECT[off]} ({hex(off)}) x0={hex(uc.reg_read(UC_ARM64_REG_X0))} '
                    f'x1={hex(uc.reg_read(UC_ARM64_REG_X1))} x2={hex(uc.reg_read(UC_ARM64_REG_X2))}]')
                self.direct_calls.append((off, uc.reg_read(UC_ARM64_REG_X0)))

        def on_libcode(uc, address, size, ud):
            off = address - BASE
            if off in self.FFI_HANDLED or off in self.PLT_MAP:
                self._do_internal(address)

        def on_trap(uc, address, size, ud):
            self._do_call(address)

        uc.hook_add(UC_HOOK_CODE, on_trap, begin=HOOK_PAGE, end=HOOK_PAGE + 0x100000)
        def on_closure(uc, address, size, ud):
            if address in CLOSURES:
                self._do_closure(address)
                return
            # el trampolín hace ldr x17,#8 / br x17 → ejecutamos el destino real
            if CLOSURE_PAGE <= address < CLOSURE_PAGE + 0x100000:
                tgt = struct.unpack('<Q', bytes(uc.mem_read(address + 8, 8)))[0]
                uc.reg_write(UC_ARM64_REG_X17, tgt)
                uc.reg_write(UC_ARM64_REG_PC, tgt)

        uc.hook_add(UC_HOOK_BLOCK, on_libcode, begin=BASE, end=BASE + 0x149998)
        uc.hook_add(UC_HOOK_BLOCK, on_direct, begin=BASE, end=BASE + 0x149998)
        uc.hook_add(UC_HOOK_CODE, on_opcode, begin=BASE + 0xf0148, end=BASE + 0xf014c)
        uc.hook_add(UC_HOOK_BLOCK, on_closure, begin=CLOSURE_PAGE, end=CLOSURE_PAGE + 0x100000)

        def on_jni(uc, address, size, ud):
            if address in self.JNI_SLOT_ADDR:
                self._do_jni(address)

        uc.hook_add(UC_HOOK_BLOCK, on_jni, begin=JNI_PAGE, end=JNI_PAGE + 0x40000)

        def on_read_jni_table(uc, access, address, size, value, ud):
            pc = uc.reg_read(UC_ARM64_REG_PC)
            if self.jni_table and self.jni_table <= address < self.jni_table + 232 * 8:
                idx = (address - self.jni_table) // 8
                self.jni_reads.append((idx, pc))
                if len(self.jni_reads) < 2000:
                    log(f'    [lectura tabla JNIEnv[{idx}] desde {hex(pc)}]')

        uc.hook_add(UC_HOOK_MEM_READ, on_read_jni_table,
                    begin=HEAP_BASE, end=HEAP_BASE + HEAP_SZ)
        uc.hook_add(UC_HOOK_BLOCK, on_block)
        uc.hook_add(UC_HOOK_INTR, on_intr)
        uc.hook_add(UC_HOOK_MEM_READ_UNMAPPED | UC_HOOK_MEM_WRITE_UNMAPPED |
                    UC_HOOK_MEM_FETCH_UNMAPPED | UC_HOOK_MEM_READ_PROT |
                    UC_HOOK_MEM_WRITE_PROT | UC_HOOK_MEM_FETCH_PROT, on_mem_invalid)

    # nº de argumentos por función importada (para no pasar basura de registros)
    NARGS = {
        'malloc': 1, 'calloc': 2, 'free': 1, 'memcpy': 3, 'memset': 3,
        'memmove': 3, 'memcmp': 3, 'mmap': 6, 'mprotect': 3, 'munmap': 2,
        'uncompress': 4, 'fopen': 2, 'fgets': 3, 'fclose': 1, 'fprintf': 2,
        'puts': 1, 'vsnprintf': 3, 'sscanf': 2, 'strlen': 1, 'strcmp': 2,
        'strncmp': 3, 'strncpy': 3, 'strstr': 2, 'isspace': 1, 'fmod': 2,
        'fmodf': 2, 'dlopen': 2, 'dlsym': 2, 'dl_iterate_phdr': 2, 'dladdr': 2,
        'sigaction': 3, 'abort': 0, '__stack_chk_fail': 0, '__cxa_finalize': 1,
        '__cxa_pure_virtual': 0, 'realloc': 2,
        '_Znwm': 1, '_Znam': 1, '_ZdlPv': 1, '_ZdaPv': 1,
        'qsort': 4, 'rand': 0, 'srand': 1, 'atoi': 1, 'strtol': 3, 'strtod': 2,
        'getenv': 1, 'setenv': 3, 'localtime_r': 2, 'strftime': 4, 'mktime': 1,
        'usleep': 1, 'nanosleep': 2, 'raise': 1, 'exit': 1, '_exit': 1,
        '__system_property_get': 2, 'socket': 3, 'bind': 3, 'listen': 2,
        'accept': 3, 'connect': 3, 'recv': 4, 'send': 4, 'recvfrom': 6,
        'sendto': 6, 'close': 1, 'setsockopt': 5, 'getsockname': 3,
        'getsockopt': 5, 'shutdown': 2, 'select': 5, 'poll': 3,
        'epoll_create1': 1, 'epoll_ctl': 4, 'epoll_wait': 4, 'fcntl': 3,
        'read': 3, 'write': 3, 'open': 3, 'openat': 4, 'ioctl': 3,
        'getaddrinfo': 4, 'freeaddrinfo': 1, 'gethostbyname': 1,
        'inet_pton': 3, 'inet_ntop': 4, 'htons': 1, 'ntohs': 1, 'getpid': 0,
        'getuid': 0, 'gettimeofday': 2, 'clock_gettime': 2, 'time': 1,
        'pthread_create': 4, 'pthread_join': 2, 'pthread_mutex_init': 2,
        'pthread_mutex_lock': 1, 'pthread_mutex_unlock': 1,
        'pthread_mutex_destroy': 1, 'pthread_detach': 1, 'pthread_self': 0,
        'pthread_key_create': 2, 'pthread_getspecific': 1,
        'pthread_setspecific': 2, 'pthread_once': 2, 'syscall': 2,
        'prctl': 2, 'getrandom': 3, 'sysconf': 1,
        'android_getaddrinfofornetwork': 6,
        'snprintf': 3, 'sprintf': 2, 'strchr': 2, 'strrchr': 2,
    }

    FFI_TRAMPS = {
        'ffi_call_SYSV': 0xf4764, 'ffi_call': 0xf5088,
        'ffi_prep_cif': 0xf5ed0, 'ffi_prep_cif_var': 0xf5eec,
        'ffi_prep_closure_loc': 0xf5314,
        'ffi_java_raw_to_ptrarray': 0xf59bc,
    }

    def _ffi_call_SYSV(self, cif, rvalue, avalue, fn):
        """Reimplementa la llamada FFI: llama fn(args de avalue) en el emulador.

        Layout que usa esta lib (visto en el stub 0xf4764): avalue = bloque con
        8 x u64 en +0x00, x8 en +0x40 y 8 q (128b) en +0x100.
        """
        uc = self.uc
        args = []
        for i in range(8):
            args.append(struct.unpack('<Q', bytes(uc.mem_read(avalue + i * 8, 8)))[0])
        x8 = struct.unpack('<Q', bytes(uc.mem_read(avalue + 0x40, 8)))[0]
        self.ffi_log.append((fn, tuple(args[:3]), x8))
        log(f'    [ffi_call → {hex(fn)} args={tuple(hex(a) for a in args[:4])} x8={hex(x8)}]')
        if fn and not (BASE <= fn < BASE + 0x200000) and fn not in CLOSURES:
            try:
                head = bytes(uc.mem_read(fn, 16))
            except Exception:
                head = b''
            log(f'    !! fn {hex(fn)} NO es código de la lib. Primeros bytes: {head.hex()} '
                f'cif={hex(cif)} avalue={hex(avalue)}')
            cifd = bytes(uc.mem_read(cif, 32)) if cif else b''
            log(f'       cif bytes: {cifd.hex()}')
            self.bad_fn = (fn, head, cifd)
        if not fn:
            if rvalue:
                uc.mem_write(rvalue, b'\0' * 16)
            return
        self.call(fn, args, budget=20_000_000, label=f'ffi {hex(fn)}')
        if rvalue and rvalue < 0x7f000000:
            x0 = uc.reg_read(UC_ARM64_REG_X0)
            x1 = uc.reg_read(UC_ARM64_REG_X1)
            try:
                uc.mem_write(rvalue, struct.pack('<QQ', x0, x1))
            except Exception:
                pass

    # direcciones dentro de la lib que interceptamos (no son PLT de imports)
    # PLT_MAP: instancia, se llena en _build_plt_map
    DIRECT = {0xe7c88: 'GetEnv_wrapper', 0xe7cc8: 'fini_1', 0xe7d0c: 'fini_2',
              0xe7b20: 'init_helper', 0xe7bd8: 'init_1', 0xe7c34: 'JNI_OnLoad'}
    FFI_HANDLED = {0xf4764, 0xf5088, 0xf5ed0, 0xf5eec, 0xf5314, 0xf59bc,
                   0xf5f10, 0xf5c7c, 0xf5cc0, 0xf627c, 0xf62c0, 0xf61e8,
                   0xf5be8, 0xf4fb8, 0xf5948, 0xf5a30, 0xf5f18, 0xf5f7c,
                   0xf5ff0, 0xf62c8, 0xf62f4}

    def _ret(self):
        self.uc.reg_write(UC_ARM64_REG_PC, self.uc.reg_read(UC_ARM64_REG_LR))

    def _do_internal(self, addr):
        uc = self.uc
        off = addr - BASE
        if off == 0xf4764:
            # stub real: (prep_fn x0, bloque x1, rvalue? x2, framesize x3, fn x4)
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(5)]
            log(f'    [ffi_call_SYSV prep={hex(a[0])} bloque={hex(a[1])} fn={hex(a[4])}]')
            self._ffi_call_SYSV(a[0], a[1], a[2], a[4])
            return
        if off == 0xf5088:
            self._ffi_call_entry()
            return
        if False:
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(4)]
            cif, fn, rvalue, avalue = a
            lr = uc.reg_read(UC_ARM64_REG_LR)
            raw = bytes(uc.mem_read(cif, 0x30)) if cif else b''
            log(f'    [ffi_call llamador={hex(lr)} x0..x3={tuple(hex(x) for x in a)}]')
            log(f'       cif bytes: {raw.hex()}')
            for pp in range(0, 0x28, 8):
                v = struct.unpack('<Q', raw[pp:pp+8])[0]
                if v and v < 0x7f000000:
                    try:
                        tgt = bytes(uc.mem_read(v, 0x20))
                        log(f'       cif+{hex(pp)} → {hex(v)}: {tgt.hex()}')
                    except Exception:
                        pass
            abi = struct.unpack('<I', bytes(uc.mem_read(cif, 4)))[0] if cif else 0
            if abi != 1:
                log(f'    [ffi_call con abi={abi} ≠ FFI_SYSV → no hace nada]')
                uc.reg_write(UC_ARM64_REG_X0, 0)
                self._ret()
                return
            nargs = struct.unpack('<I', bytes(uc.mem_read(cif + 0x18, 4)))[0]
            rtype = struct.unpack('<Q', bytes(uc.mem_read(cif + 0x08, 8)))[0]
            atypes = struct.unpack('<Q', bytes(uc.mem_read(cif + 0x10, 8)))[0]
            nargs = min(max(nargs, 0), 8)
            ptrs = []
            for i in range(nargs):
                pp = struct.unpack('<Q', bytes(uc.mem_read(avalue + i * 8, 8)))[0]
                v = struct.unpack('<Q', bytes(uc.mem_read(pp, 8)))[0] if pp else 0
                ptrs.append(v)
            if not hasattr(self, 'ffi_calls'):
                self.ffi_calls = []
            self.ffi_calls.append((fn, nargs, tuple(ptrs[:5])))
            log(f'    [ffi_call #{len(self.ffi_calls)} fn={hex(fn)} nargs={nargs} args={tuple(hex(x) for x in ptrs[:5])}]')
            if not fn:
                log('    [ffi_call fn=0 → sonda, no hace nada]')
                uc.reg_write(UC_ARM64_REG_X0, 0)
                self._ret()
                return
            if not (BASE <= fn < BASE + 0x200000):
                head = bytes(uc.mem_read(fn, 8))
                log(f'    !! fn {hex(fn)} fuera de la lib, head={head.hex()}')
            self.call(fn, ptrs, budget=30_000_000, label=f'ffi→{hex(fn)}', quiet=True)
            if rvalue:
                rsz = struct.unpack('<I', bytes(uc.mem_read(rtype, 4)))[0] if rtype else 8
                x0 = uc.reg_read(UC_ARM64_REG_X0)
                try:
                    if rsz <= 4:
                        uc.mem_write(rvalue, struct.pack('<I', x0 & 0xFFFFFFFF))
                    else:
                        uc.mem_write(rvalue, struct.pack('<Q', x0))
                except Exception:
                    pass
            self._ret()
            return
        if off == 0xf4fb8:                       # ffi_prep_cif_machdep — ¡IMPLEMENTAR!
            # (cif, abi, nargs, rtype, atypes) → FFI_OK; rellena el cif de verdad
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(5)]
            cif, abi, nargs, rtype, atypes = a
            sizes = []
            for i in range(min(nargs, 16)):
                ap = struct.unpack('<Q', bytes(uc.mem_read(atypes + i * 8, 8)))[0]
                sz = struct.unpack('<I', bytes(uc.mem_read(ap, 4)))[0] if ap else 8
                sizes.append(sz)
            rsz = struct.unpack('<I', bytes(uc.mem_read(rtype, 4)))[0] if rtype else 8
            uc.mem_write(cif + 0x00, struct.pack('<I', abi))
            uc.mem_write(cif + 0x18, struct.pack('<I', nargs))
            uc.mem_write(cif + 0x10, struct.pack('<Q', atypes))
            uc.mem_write(cif + 0x08, struct.pack('<Q', rtype))
            # bytes = frame: 8 regs + área de pila redondeada
            stack = sum(sz for sz in sizes[8:])
            frame = 64 + ((stack + 15) & ~15) + 16
            uc.mem_write(cif + 0x20, struct.pack('<I', frame))
            log(f'    [ffi_prep_cif_machdep abi={abi} nargs={nargs} sizes={sizes} rsize={rsz}]')
            self.prep_cif_ok = True
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        if off in (0xf5ed0, 0xf5eec):            # ffi_prep_cif / _var — ¡RELLENAR!
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(5)]
            cif, abi, nargs, rtype, atypes = a
            uc.mem_write(cif + 0x00, struct.pack('<I', abi))
            uc.mem_write(cif + 0x08, struct.pack('<Q', rtype))
            uc.mem_write(cif + 0x10, struct.pack('<Q', atypes))
            uc.mem_write(cif + 0x18, struct.pack('<I', nargs))
            uc.mem_write(cif + 0x20, struct.pack('<I', 0x80))   # frame ficticio
            szs = []
            for i in range(min(nargs, 12)):
                ap = struct.unpack('<Q', bytes(uc.mem_read(atypes + i * 8, 8)))[0]
                sz = struct.unpack('<I', bytes(uc.mem_read(ap, 4)))[0] if ap else 8
                szs.append(sz)
            rsz = struct.unpack('<I', bytes(uc.mem_read(rtype, 4)))[0] if rtype else 8
            log(f'    [ffi_prep_cif abi={abi} nargs={nargs} argsizes={szs} retsize={rsz}]')
            self.prep_cif_ok = True
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        if off in (0xf5f10, 0xf5cc0, 0xf62c0):   # ffi_prep_*_closure (sin code)
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        if off in (0xf5c7c, 0xf627c):            # ffi_prep_*_closure_loc
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(5)]
            cif, closure, code, fun, user_data = a
            self.next_closure += 0x40
            tramp = CLOSURE_PAGE + ((self.next_closure - CLOSURE_PAGE) % 0xff000)
            CLOSURES[tramp] = (cif, fun, user_data)
            uc.mem_write(tramp, struct.pack('<II', 0x58000051, 0xd61f0220))
            uc.mem_write(tramp + 8, struct.pack('<Q', tramp + 16))
            uc.mem_write(tramp + 16, struct.pack('<QQ', closure, cif))
            if code:
                uc.mem_write(code, struct.pack('<Q', tramp))
            log(f'    [ffi_prep_closure_loc@{hex(off)} fun={hex(fun)} user={hex(user_data)} → {hex(tramp)}]')
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        if off == 0xf62c8:                       # ffi_closure_alloc(size, &code)
            sz = uc.reg_read(UC_ARM64_REG_X0)
            codep = uc.reg_read(UC_ARM64_REG_X1)
            cl = self.host._alloc(max(sz, 64))
            self.next_closure += 0x40
            tramp = CLOSURE_PAGE + ((self.next_closure - CLOSURE_PAGE) % 0xff000)
            CLOSURES[tramp] = (0, 0, 0)
            uc.mem_write(tramp, struct.pack('<II', 0x58000051, 0xd61f0220))
            uc.mem_write(tramp + 8, struct.pack('<Q', tramp + 16))
            uc.mem_write(tramp + 16, struct.pack('<QQ', cl, 0))
            uc.mem_write(codep, struct.pack('<Q', tramp))
            self.pending_closure_code = tramp
            log(f'    [ffi_closure_alloc({sz}) → closure {hex(cl)}, code {hex(tramp)}]')
            uc.reg_write(UC_ARM64_REG_X0, cl)
            self._ret()
            return
        if off == 0xf62f4:                       # ffi_closure_free
            self._ret()
            return
        if off in (0xf5948, 0xf5f18):            # ffi_*_raw_size
            uc.reg_write(UC_ARM64_REG_X0, 64)
            self._ret()
            return
        if off in (0xf5be8, 0xf61e8):            # ffi_*_raw_call(cif, rvalue, args, fn)
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(4)]
            log(f'    [ffi_raw_call → fn={hex(a[3])}]')
            self._ffi_call_SYSV(a[0], a[1], a[2], a[3])
            return
        if off in (0xf59bc, 0xf5f7c, 0xf5a30, 0xf5ff0):  # raw ↔ ptrarray
            self._ret()
            return
        if off == 0xf5314:
            # ffi_prep_closure_loc(cif, closure, code, fun, user_data) → FFI_OK
            a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(5)]
            cif, closure, code, fun, user_data = a
            self.next_closure += 0x40
            tramp = CLOSURE_PAGE + ((self.next_closure - CLOSURE_PAGE) % 0xff000)
            CLOSURES[tramp] = (cif, fun, user_data)
            # el trampolín DEBE ser código real: el ABI de esta lib lee el
            # descriptor desde x17 (ver ffi_closure_SYSV en 0xf4800)
            uc.mem_write(tramp, struct.pack('<II',
                0x58000051,                       # ldr x17, #8
                0xd61f0220))                      # br  x17
            uc.mem_write(tramp + 8, struct.pack('<Q', tramp + 16))
            uc.mem_write(tramp + 16, struct.pack('<QQ', closure, cif))
            uc.mem_write(tramp + 32, struct.pack('<Q', 0xf4800))  # no usado
            if code:
                uc.mem_write(code, struct.pack('<Q', tramp))
            log(f'    [ffi_prep_closure_loc cif={hex(cif)} fun={hex(fun)} user={hex(user_data)} → tramp {hex(tramp)}]')
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        if off == 0xf59bc:                      # ffi_java_raw_to_ptrarray
            self._ret()
            return
        nm = self.PLT_MAP.get(off)
        if nm:
            tramp = HOOKS_ADDR.get(nm, 0)
            log(f'    [PLT interno {hex(off)} → {nm}]')
            if tramp:
                uc.reg_write(UC_ARM64_REG_PC, tramp)
            else:
                self._ret()

    def _do_closure(self, tramp):
        uc = self.uc
        cif, fun, user_data = CLOSURES[tramp]
        args = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(8)]
        x8 = uc.reg_read(UC_ARM64_REG_X8)
        lr = uc.reg_read(UC_ARM64_REG_LR)
        if len(self.jni_log) < 400:
            log(f'    [closure → fun={hex(fun)} args={tuple(hex(x) for x in args[:5])}]')
        self.jni_log.append((fun, tuple(args[:6])))
        # ABI de handler FFI: fun(ffi_cif *cif, void *ret, void **args, void *user_data)
        retbuf = self.host._alloc(64)
        argp = self.host._alloc(8 * 9)
        for i, v in enumerate(args):
            uc.mem_write(argp + i * 8, struct.pack('<Q', v))
        uc.mem_write(argp + 64, struct.pack('<Q', x8))
        self.call(fun, (cif, retbuf, argp, user_data), budget=50_000_000, label=f'closure {hex(fun)}')
        uc.reg_write(UC_ARM64_REG_PC, lr)


    # ---------------- JNI de juguete ----------------
    JNI_NAMES = {
        4: 'GetVersion', 6: 'FindClass', 13: 'Throw', 15: 'ExceptionOccurred',
        17: 'ExceptionClear', 21: 'NewGlobalRef', 22: 'DeleteGlobalRef',
        23: 'DeleteLocalRef', 24: 'IsSameObject', 27: 'AllocObject',
        28: 'NewObject', 30: 'NewObjectA', 31: 'GetObjectClass', 32: 'IsInstanceOf',
        33: 'GetMethodID', 34: 'CallObjectMethod', 36: 'CallObjectMethodA',
        49: 'CallIntMethod', 52: 'CallLongMethod', 61: 'CallVoidMethod',
        64: 'GetObjectField', 69: 'GetIntField', 70: 'GetLongField',
        94: 'GetStaticMethodID', 114: 'CallStaticObjectMethod',
        116: 'CallStaticObjectMethodA', 124: 'CallStaticIntMethod',
        141: 'CallStaticVoidMethod', 167: 'NewStringUTF', 169: 'GetStringUTFChars',
        171: 'GetStringUTFLength', 172: 'GetArrayLength', 174: 'NewObjectArray',
        184: 'GetByteArrayElements', 186: 'GetCharArrayElements',
        206: 'GetFieldID', 215: 'RegisterNatives', 228: 'ExceptionCheck',
        229: 'NewDirectByteBuffer', 230: 'GetDirectBufferAddress',
    }
    JNI_SLOT_ADDR = {}

    def _build_jni(self):
        uc = self.uc
        self.jni_strings = {}     # ref -> (tipo, dato)
        self.jni_natives = []     # (clase, nombre, firma, fn)
        self.jni_arrays = {}
        self.next_ref = 0x8100
        self.jni_reads = []
        self.jni_unknown = []
        self.getenv_env_addr = 0
        self.direct_calls = []
        self.ffi_calls = []
        table = self.host._alloc(232 * 8)
        for i in range(232):
            a = JNI_PAGE + 0x1000 + i * 0x10
            self.JNI_SLOT_ADDR[a] = i
            uc.mem_write(a, b'\xc0\x03\x5f\xd6')
            uc.mem_write(table + i * 8, struct.pack('<Q', a))
        self.jni_table = table
        env = self.host._alloc(8)
        uc.mem_write(env, struct.pack('<Q', table))
        itab = self.host._alloc(7 * 8)
        for i in range(7):
            a = JNI_PAGE + 0x2000 + i * 0x10
            self.JNI_SLOT_ADDR[a] = ('vm', i)
            uc.mem_write(a, b'\xc0\x03\x5f\xd6')
            uc.mem_write(itab + i * 8, struct.pack('<Q', a))
        vm = self.host._alloc(8)
        uc.mem_write(vm, struct.pack('<Q', itab))
        self.jni_env = env
        self.java_vm = vm
        # volcar el bytecode de JNI_OnLoad ANTES y DESPUÉS de ejecutarlo
        self.bc_jni = (BASE + 0xfaf20, 0xb58)
        pre = bytes(self.uc.mem_read(*self.bc_jni))
        with open(os.path.join(HERE, 'bytecode_jni_onload.bin'), 'wb') as f:
            f.write(pre)
        self.bc_pre = pre
        log(f'    [bytecode JNI_OnLoad volcado: {len(pre)} B, entropía '
            f'{-sum((c/len(pre))*__import__("math").log2(c/len(pre)) for c in set(pre.count(b) for b in pre)):.2f}]')
        return vm

    def _jni_ref(self, data):
        self.next_ref += 0x10
        self.jni_strings[self.next_ref] = data
        return self.next_ref

    def _do_jni(self, addr):
        uc = self.uc
        slot = self.JNI_SLOT_ADDR[addr]
        a = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(6)]
        lr = uc.reg_read(UC_ARM64_REG_LR)
        r = 0
        if isinstance(slot, tuple):
            if slot[1] == 6:                  # GetEnv(vm, &env, version)
                uc.mem_write(a[1], struct.pack('<Q', self.jni_env))
                self.getenv_env_addr = a[1]
                self.after_getenv_ops = len(self.opcodes)
                log(f'    [JNI GetEnv(version={hex(a[2])}) -> env {hex(self.jni_env)} escrito en {hex(a[1])}; '
                    f'opcode #{self.after_getenv_ops}]')
            else:
                log(f'    [JNI vm slot {slot[1]} -> 0]')
        else:
            nm = self.JNI_NAMES.get(slot, f'slot{slot}')
            if True:
                for addr, txt in self.host.scan_strings():
                    log(f'    [string VM {addr}: "{txt}"]')
                # la VM lee el JNIEnv: registrar qué slot toca
                for i in range(8):
                    v = a[i]
                    if self.jni_env and v == self.jni_env:
                        log(f'    [la VM usa JNIEnv (arg {i})]')
                    if v and (v - self.jni_table) // 8 == (v - self.jni_table) // 8 and \
                            self.jni_table <= v < self.jni_table + 232 * 8:
                        log(f'    [la VM toca la tabla JNIEnv índice {(v - self.jni_table)//8}]')
            if nm == 'GetEnv' or (isinstance(slot, tuple) and slot[1] == 6):
                self.getenv_env_addr = a[1]
                self.after_getenv_ops = len(self.opcodes)
                log(f'    [GetEnv: env se escribirá en {hex(a[1])}]')
            if nm == 'FindClass':
                cname = self.host.rstr(a[1]).decode('latin1', 'replace')
                r = self._jni_ref(('class', cname))
                log(f'    [JNI FindClass("{cname}") -> {hex(r)}]')
            elif nm == 'RegisterNatives':
                env, clazz, methods, n = a[:4]
                info = self.jni_strings.get(clazz, ('?', hex(clazz)))
                cname = info[1] if isinstance(info[1], str) else hex(clazz)
                for i in range(n):
                    mn = struct.unpack('<Q', bytes(uc.mem_read(methods + i * 24, 8)))[0]
                    ms = struct.unpack('<Q', bytes(uc.mem_read(methods + i * 24 + 8, 8)))[0]
                    mf = struct.unpack('<Q', bytes(uc.mem_read(methods + i * 24 + 16, 8)))[0]
                    name = self.host.rstr(mn).decode('latin1', 'replace')
                    sig = self.host.rstr(ms).decode('latin1', 'replace')
                    self.jni_natives.append((cname, name, sig, mf))
                    extra = f' (lib+{hex(mf - BASE)})' if BASE <= mf < BASE + 0x200000 else ' FUERA!'
                    log(f'    [JNI RegisterNatives {cname}.{name}{sig} -> {hex(mf)}{extra}]')
            elif nm == 'NewStringUTF':
                r = self._jni_ref(('str', self.host.rstr(a[1])))
            elif nm == 'GetStringUTFChars':
                d = self.jni_strings.get(a[1], ('str', b''))[1]
                if isinstance(d, str):
                    d = d.encode()
                r = self.host.putstr(d)
            elif nm == 'GetStringUTFLength':
                d = self.jni_strings.get(a[1], ('str', b''))[1]
                r = len(d)
            elif nm in ('GetMethodID', 'GetStaticMethodID'):
                mname = self.host.rstr(a[2]).decode('latin1', 'replace')
                msig = self.host.rstr(a[3]).decode('latin1', 'replace')
                r = self._jni_ref(('mid', mname, msig))
                log(f'    [JNI {nm}("{mname}") -> {hex(r)}]')
            elif nm == 'GetFieldID':
                mname = self.host.rstr(a[2]).decode('latin1', 'replace')
                r = self._jni_ref(('fid', mname))
                log(f'    [JNI GetFieldID("{mname}") -> {hex(r)}]')
            elif nm in ('CallObjectMethod', 'CallStaticObjectMethod',
                        'CallObjectMethodA', 'CallStaticObjectMethodA'):
                ref = a[2]
                info = self.jni_strings.get(ref, ('mid', '?', ''))
                mname = info[1] if len(info) > 1 else '?'
                r = self._jni_ret_object(mname, a)
                log(f'    [JNI {nm}("{mname}") -> {hex(r)}]')
            elif nm == 'GetArrayLength':
                r = self.jni_arrays.get(a[1], 0)
            elif nm == 'GetVersion':
                r = 0x00010006
                log(f'    [JNI GetVersion -> {hex(r)}]')
            elif nm == 'ExceptionCheck':
                r = 0
            else:
                log(f'    [JNI {nm} args={tuple(hex(x) for x in a[1:5])} -> 0]')
                self.jni_unknown.append((slot, tuple(a[1:5])))
        uc.reg_write(UC_ARM64_REG_X0, r & 0xFFFFFFFFFFFFFFFF)
        uc.reg_write(UC_ARM64_REG_PC, lr)

    def _jni_ret_object(self, mname, a):
        """Respuestas mínimas a getters de Java que el sign pueda usar."""
        if mname == 'getPackageName':
            return self._jni_ref(('str', b'com.pp.hls'))
        if mname in ('getDeviceId', 'getImei', 'getAndroidId'):
            return self._jni_ref(('str', b'861234567890123'))
        if mname == 'getModel':
            return self._jni_ref(('str', b'Pixel 6'))
        if mname == 'getLanguage':
            return self._jni_ref(('str', b'es'))
        if mname == 'getCountry':
            return self._jni_ref(('str', b'MX'))
        return 0


    def _ffi_call_entry(self):
        """ffi_call(cif, fn, rvalue, avalue) — ABI real de libffi."""
        uc = self.uc
        cif, fn, rvalue, avalue = (uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(4))
        abi = struct.unpack('<I', bytes(uc.mem_read(cif, 4)))[0] if cif else 0
        if abi != 1:
            log(f'    [ffi_call abi={abi} != FFI_SYSV -> nada]')
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        nargs = struct.unpack('<I', bytes(uc.mem_read(cif + 0x18, 4)))[0]
        rtype = struct.unpack('<Q', bytes(uc.mem_read(cif + 0x08, 8)))[0]
        atypes = struct.unpack('<Q', bytes(uc.mem_read(cif + 0x10, 8)))[0]
        nargs = min(max(nargs, 0), 8)
        sizes = []
        for i in range(nargs):
            ap = struct.unpack('<Q', bytes(uc.mem_read(atypes + i * 8, 8)))[0]
            sizes.append(struct.unpack('<I', bytes(uc.mem_read(ap, 4)))[0] if ap else 8)
        args = []
        for i in range(nargs):
            pp = struct.unpack('<Q', bytes(uc.mem_read(avalue + i * 8, 8)))[0]
            sz = sizes[i] if i < len(sizes) else 8
            if not pp:
                args.append(0)
                continue
            raw = bytes(uc.mem_read(pp, min(sz, 8)))
            if sz <= 1:
                args.append(struct.unpack('<B', raw[:1])[0])
            elif sz <= 2:
                args.append(struct.unpack('<H', raw[:2])[0])
            elif sz <= 4:
                args.append(struct.unpack('<I', raw[:4])[0])
            else:
                args.append(struct.unpack('<Q', raw.ljust(8, b'\0'))[0])
        self.ffi_calls.append((fn, nargs, tuple(args[:5])))
        log(f'    [ffi_call #{len(self.ffi_calls)} fn={hex(fn)} nargs={nargs} sizes={sizes} args={tuple(hex(x) for x in args[:5])}]')
        if not fn:
            log('    [ffi_call fn=0 -> sonda, no hace nada]')
            uc.reg_write(UC_ARM64_REG_X0, 0)
            self._ret()
            return
        self.call(fn, args, budget=30_000_000, label=f'ffi->{hex(fn)}', quiet=True)
        if rvalue:
            rsz = struct.unpack('<I', bytes(uc.mem_read(rtype, 4)))[0] if rtype else 8
            x0 = uc.reg_read(UC_ARM64_REG_X0)
            try:
                if rsz <= 1:
                    uc.mem_write(rvalue, struct.pack('<B', x0 & 0xff))
                elif rsz <= 2:
                    uc.mem_write(rvalue, struct.pack('<H', x0 & 0xffff))
                elif rsz <= 4:
                    uc.mem_write(rvalue, struct.pack('<I', x0 & 0xffffffff))
                else:
                    uc.mem_write(rvalue, struct.pack('<Q', x0))
            except Exception as e:
                log(f'    !! no pude escribir rvalue {hex(rvalue)}: {e}')
        self._ret()

    def _do_call(self, addr):
        uc = self.uc
        nm = HOOKS_NAME[addr]
        fnname = HOOK_TABLE_NAMES.get(nm, 'stub')
        fn = getattr(self.host, fnname)
        k = self.NARGS.get(nm, 8)
        args = [uc.reg_read(getattr(A64, f'UC_ARM64_REG_X{i}')) for i in range(k)]

        if fnname == 'stub':
            args = [nm] + args
        if self.trace_calls and nm not in ('malloc', 'free', 'memcpy', 'memset'):
            log(f'    → {nm}({", ".join(hex(x) for x in args[:4])})')
        try:
            r = fn(*args)
        except RuntimeError:
            raise
        except Exception as e:
            log(f'    !! excepción en {nm}: {e}')
            r = 0
        if isinstance(r, float):
            uc.reg_write(UC_ARM64_REG_D0, struct.unpack('<Q', struct.pack('<d', r))[0])
        else:
            uc.reg_write(UC_ARM64_REG_X0, (r or 0) & 0xFFFFFFFFFFFFFFFF)
        lr = uc.reg_read(UC_ARM64_REG_LR)
        uc.reg_write(UC_ARM64_REG_PC, lr)

    # -- ejecución --
    def call(self, addr, args=(), budget=200_000_000, label='', quiet=False):
        uc = self.uc
        for i in range(8):
            v = args[i] if i < len(args) else 0
            uc.reg_write(getattr(A64, f'UC_ARM64_REG_X{i}'), v & 0xFFFFFFFFFFFFFFFF)
        uc.reg_write(UC_ARM64_REG_X29, STACK_BASE + STACK_SZ - 0x2000)
        uc.reg_write(UC_ARM64_REG_LR, RET_MAGIC)
        uc.reg_write(UC_ARM64_REG_SP, STACK_BASE + STACK_SZ - 0x1000)
        chunk = 10_000_000
        ran = 0
        pc = addr
        while ran < budget:
            try:
                uc.emu_start(pc, RET_MAGIC, count=chunk)
            except UcError as e:
                pc2 = uc.reg_read(UC_ARM64_REG_PC)
                log(f'  UcError {e} en {hex(pc2)} tras {ran:,} instrucciones ({label})')
                raise
            ran += chunk
            self.total_insn += chunk
            pc = uc.reg_read(UC_ARM64_REG_PC)
            if pc >= RET_MAGIC:
                break
            if not quiet:
                log(f'  ... {ran/1e6:.0f}M instrucciones, PC={hex(pc)} ({label})')
        self.total_insn += ran % chunk
        x0 = uc.reg_read(UC_ARM64_REG_X0)
        log(f'  → {label}: retornó {hex(x0)} tras ~{ran:,} instrucciones')
        return x0

    # -- análisis --
    def analyze(self):
        import math
        log('\n== estado de memoria tras init ==')
        for a, sz in self.segments:
            data = bytes(self.uc.mem_read(a, min(sz, 0x600000)))
            cnt = Counter(data)
            n = len(data)
            ent = -sum((v / n) * math.log2(v / n) for v in cnt.values())
            zeros = data.count(0)
            log(f'  {hex(a)}+{hex(sz)}: entropía {ent:.2f}  ceros {zeros*100//n}%')
            # strings nuevas (>=8 chars)
            strs, cur = [], b''
            for ch in data:
                if 32 <= ch < 127:
                    cur += bytes([ch])
                else:
                    if len(cur) >= 8:
                        strs.append(cur)
                    cur = b''
            if len(cur) >= 8:
                strs.append(cur)
            uniq = list(dict.fromkeys(s.decode() for s in strs))
            log(f'    strings>=8: {len(uniq)} únicas')
            for s in uniq[:40]:
                log(f'      {s[:100]}')
        # mmaps
        total_mm = self.host.next_mmap - MMAP_FIRST
        log(f'  mmaps pedidos: {total_mm:,} bytes')
        a = MMAP_FIRST
        while a < self.host.next_mmap:
            try:
                data = bytes(self.uc.mem_read(a, min(0x100000, self.host.next_mmap - a)))
            except Exception:
                a += 0x1000; continue
            cnt = Counter(data); n = len(data) or 1
            ent = -sum((v / n) * math.log2(v / n) for v in cnt.values())
            strs, cur = [], b''
            for ch in data:
                if 32 <= ch < 127:
                    cur += bytes([ch])
                else:
                    if len(cur) >= 8: strs.append(cur)
                    cur = b''
            uniq = list(dict.fromkeys(x.decode() for x in strs))
            log(f'  mmap {hex(a)}: entropía {ent:.2f} ceros {data.count(0)*100//n}% strings {len(uniq)}')
            for x in uniq[:25]:
                log(f'      {x[:110]}')
            a += 0x100000
        log(f'  bloques nuevos en zona data: {len(self.bss_blocks)}')

    def dump(self, path):
        import math
        with open(path, 'wb') as f:
            for a, sz in self.segments:
                f.write(bytes(self.uc.mem_read(a, sz)))
        log(f'volcado en {path}')


def main():
    budget = 200_000_000
    do_dump = '--dump' in sys.argv
    if '--budget' in sys.argv:
        budget = int(sys.argv[sys.argv.index('--budget') + 1]) * 1_000_000

    log('== cargando libpp_hls.so en Unicorn ==')
    emu = Emu()

    # init_array
    ia = emu.elf.get_section_by_name('.init_array')
    entries = []
    relmap = {}
    for r in emu.elf.get_section_by_name('.rela.dyn').iter_relocations():
        if r['r_info_type'] == 0x403 and ia['sh_addr'] <= r['r_offset'] < ia['sh_addr'] + ia['sh_size']:
            relmap[r['r_offset'] - ia['sh_addr']] = r['r_addend']
    for i in range(0, ia['sh_size'], 8):
        v = relmap.get(i, 0)
        if v:
            entries.append(v)
    log(f'init_array: {[hex(e) for e in entries]}')

    for e in entries:
        log(f'\n== ejecutando init {hex(e)} (presupuesto {budget/1e6:.0f}M) ==')
        try:
            emu.call(BASE + e, budget=budget, label=f'init {hex(e)}')
        except Exception as ex:
            log(f'  init {hex(e)} abortó: {ex}')
            break

    # ---------- FASE 2: JNI_OnLoad ----------
    jni_onload = 0xe7c34
    log(f'\n== llamando JNI_OnLoad ({hex(jni_onload)}) con JavaVM de juguete ==')
    vm = emu._build_jni()
    try:
        rv = emu.call(BASE + jni_onload, (vm,), budget=400_000_000, label='JNI_OnLoad')
        log(f'JNI_OnLoad devolvio {hex(rv)} (JNI_VERSION_1_6 = 0x10006)')
    except Exception as ex:
        log(f'JNI_OnLoad aborto: {ex}')
    a0, ln = emu.bc_jni
    post = bytes(emu.uc.mem_read(a0, ln))
    if post != emu.bc_pre:
        with open(os.path.join(HERE, 'bytecode_jni_onload_post.bin'), 'wb') as f:
            f.write(post)
        print('\n!! el bytecode de JNI_OnLoad CAMBIÓ durante la ejecución (se descifró sobre la marcha)')
    else:
        print('\n(el bytecode no cambió)')

    from collections import Counter as _C
    log('\n== todas las llamadas ffi ==')
    for i, (fn, n, args) in enumerate(getattr(emu, 'ffi_calls', []), 1):
        tag = 'DENTRO LIB' if BASE <= fn < BASE + 0x200000 else (
              'JNI' if JNI_PAGE <= fn < JNI_PAGE + 0x40000 else 'fuera')
        log(f'  #{i} fn={hex(fn)} ({tag}) nargs={n} args={tuple(hex(x) for x in args)}')

    log('\n== lecturas a la tabla JNIEnv (índice, PC) ==')
    from collections import Counter as _CC
    log(f'  total {len(emu.jni_reads)} | por índice: {_CC(i for i, _ in emu.jni_reads).most_common(20)}')
    log(f'  últimas 15: {[(i, hex(p)) for i, p in emu.jni_reads[-15:]]}')

    if emu.getenv_env_addr:
        v = struct.unpack('<Q', bytes(emu.uc.mem_read(emu.getenv_env_addr, 8)))[0]
        log(f'\nvalor final en la salida de GetEnv ({hex(emu.getenv_env_addr)}): {hex(v)}')
        log(f'  env de juguete era: {hex(emu.jni_env)}  tabla: {hex(emu.jni_table)}')

    log('\n== llamadas directas a funciones conocidas ==')
    from collections import Counter as _CD
    log(f'  {_CD(emu.DIRECT[o] for o, _ in emu.direct_calls).most_common()}')

    log('\n== slots JNI desconocidos que la librería tocó ==')
    for slot, args in getattr(emu, 'jni_unknown', []):
        log(f'  slot {slot} args={tuple(hex(x) for x in args)}')
    if not getattr(emu, 'jni_unknown', []):
        log('  (ninguno)')

    log('\n== zonas de memoria con algo escrito (fuera de la imagen original) ==')
    import math as _m
    for start, end, name in ((HEAP_BASE, emu.host.next_alloc, 'heap'),
                             (MMAP_FIRST, emu.host.next_mmap, 'mmap'),
                             (STACK_BASE, STACK_BASE + STACK_SZ, 'stack')):
        a = start
        while a < end:
            n = min(0x40000, end - a)
            try:
                blk = bytes(emu.uc.mem_read(a, n))
            except Exception:
                a += n; continue
            nz = sum(1 for b in blk if b)
            if nz > 64:
                cnt = Counter(blk)
                ent = -sum((v / n) * _m.log2(v / n) for v in cnt.values())
                log(f'  {name} {hex(a)}+{hex(n)}: {nz} bytes no nulos, entropía {ent:.2f}')
            a += n

    log('\n== strings que la VM escribió en el heap ==')
    for addr, txt in emu.host.scan_strings():
        log(f'  {addr}: "{txt}"')
    log(f'  (total {len(emu.host.seen_strings)})')

    log(f'\nopcodes ejecutados: {len(emu.opcodes)} | distintos: {sorted(set(emu.opcodes))}')
    log(f'frecuencia: {_C(emu.opcodes).most_common(30)}')
    log(f'últimos 40 opcodes: {emu.opcodes[-40:]}')
    log('\n== últimos 45 pasos del intérprete (opcode, bytes restantes, posición) ==')
    for idx, rem, pos in emu.vm_trace[-45:]:
        log(f'  op {idx:5d}  restan {rem:6d}  pos {pos}')

    log(f'\n== metodos nativos registrados: {len(emu.jni_natives)} ==')
    for c, nm2, sg, fn in emu.jni_natives:
        off = f'lib+{hex(fn - BASE)}' if BASE <= fn < BASE + 0x200000 else hex(fn)
        log(f'  {c}.{nm2}{sg} -> {off}')
    with open(os.path.join(HERE, 'jni_natives.txt'), 'w') as f:
        for c, nm2, sg, fn in emu.jni_natives:
            off = fn - BASE if BASE <= fn < BASE + 0x200000 else 0
            f.write(f'{c}\t{nm2}\t{sg}\t{hex(off)}\n')

    from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN
    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    log('\n== últimos 25 bloques ejecutados ==')
    for a in emu.block_seq[-25:]:
        try:
            code = bytes(emu.uc.mem_read(a, 16))
        except Exception:
            log(f'  {hex(a)} <ilegible>')
            continue
        ins = next(md.disasm(code, a), None)
        txt = f'{ins.mnemonic} {ins.op_str}' if ins else '?'
        log(f'  {hex(a)}  {txt}')

    emu.analyze()
    log('\n== llamadas a la libc ==')
    for k, v in emu.host.calls.most_common(30):
        log(f'  {k}: {v}')
    log(f'\ndlopen: {emu.host.dlopen_log}')
    log(f'dlsym ({len(emu.host.dlsym_log)}): {list(dict.fromkeys(emu.host.dlsym_log))[:60]}')

    if do_dump:
        emu.dump(os.path.join(HERE, 'bss_dump.bin'))


if __name__ == '__main__':
    main()
