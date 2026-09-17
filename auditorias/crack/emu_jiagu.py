#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EMULADOR DUAL — libpp_hls (0x40000000) + libjiagu_descifrada (0x50000000)
========================================================================
Ejecuta el JNI_OnLoad de libjiagu (arranque del servidor de control y
descifrado/descompresión de la región 2) y captura:
  1) el PRIMER bloque ejecutado dentro de la región 2 (0x37000..0xc8000)
     → volcado de la región YA VIVA en RAM (handler 0x70ef8 al descubierto);
  2) la respuesta del handler /control?msg=verify → oráculo del sign.

Uso:
  python3 emu_jiagu.py --load               (solo carga + relocalizaciones)
  python3 emu_jiagu.py --run                (JNI_OnLoad, para en 1ª región 2)
  python3 emu_jiagu.py --run --budget N     (millones de instrucciones)
"""
import sys, os, struct, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import emu_hls as eh
from emu_hls import BASE, RET_MAGIC, log, HOOKS_ADDR, HOOKS_NAME, ELFFile
from unicorn import UC_HOOK_BLOCK, UcError
from unicorn.arm64_const import (UC_ARM64_REG_X0, UC_ARM64_REG_X1,
                                 UC_ARM64_REG_X2)

JLIB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    'jiagu_descifrada.so')
JBASE = 0x50000000
R2_LO, R2_HI = 0x37000, 0xc8000

R_AARCH64_GLOB_DAT, R_AARCH64_JUMP_SLOT, R_AARCH64_RELATIVE = 1025, 1026, 1027

# ------------------------------------------------------------- stubs nuevos
# nombre libc → método de JiaguHost (todos se definen abajo)
NUEVOS = [
    'socket', 'bind', 'listen', 'accept', 'accept4', 'connect', 'getsockopt',
    'setsockopt', 'shutdown', 'getsockname', 'epoll_create', 'epoll_create1',
    'epoll_ctl', 'epoll_wait', 'epoll_pwait', 'fork', 'pthread_create',
    'pthread_detach', 'pthread_mutex_lock', 'pthread_mutex_unlock',
    'pthread_mutex_init', 'pthread_mutex_destroy', 'pthread_cond_wait',
    'pthread_cond_signal', 'getuid', 'getgid', 'geteuid', 'getpid', 'gettid',
    'getppid', 'time', 'gettimeofday', 'sleep', 'usleep', 'nanosleep', 'kill',
    'inotify_init1', 'inotify_add_watch', 'popen', 'pclose', 'strdup',
    'strtok', 'strtok_r', 'strcat', 'strcpy', 'strtoul', 'strtoull',
    'getpagesize', '_exit', 'exit', 'waitpid', 'wait4', 'select',
    '__clear_cache', '__aarch64_sync_cache_range', 'fprintf', 'puts',
    'putchar', 'fputs', 'fwrite', 'fflush', 'setvbuf', 'fseek', 'ftell',
    'rewind', 'remove', 'tmpfile', 'tmpnam', 'system', 'daemon', 'sysinfo',
    'uname', 'gethostname', 'getcwd', 'chdir', 'rename', 'unlink', 'rmdir',
    'readlink', 'ftruncate', 'fsync', 'flock', 'pipe', 'ptrace', 'prctl',
    'syscall', 'sigemptyset', 'sigaddset', 'pthread_sigmask', 'getrlimit',
    'setrlimit', 'madvise', 'msync', 'mincore', 'mremap', 'posix_memalign',
    'memalign', 'calloc', 'realloc', 'vasprintf', 'asprintf', 'vsnprintf',
    'vfprintf', 'rand', 'srand', 'qsort', 'bsearch', 'abs', 'labs',
    'localtime', 'gmtime', 'mktime', 'strftime', 'clock_gettime',
    'pthread_self', 'pthread_equal', 'pthread_getspecific',
    'pthread_setspecific', 'pthread_key_delete', 'sched_yield', 'times',
    'getrusage', 'prlimit64', 'eventfd', 'timerfd_create', 'signalfd',
    'pipe2', 'socketpair', 'sendmsg', 'recvmsg', 'sendto', 'recvfrom',
    'poll', 'ppoll', 'dup2', 'execv', 'execve', 'setsid', 'umask',
    'getifaddrs', 'freeifaddrs', 'inet_ntop', 'inet_pton', 'htons', 'htonl',
    'ntohs', 'ntohl', 'open', 'openat',
    '__errno', 'feof', 'readdir', 'opendir', 'closedir', 'stat', 'fstat',
    'lseek', 'access', 'mkdir', 'inet_aton', 'inotify_init', 'signal',
    'ldexp',
]

NARGS_JIAGU = {
    'socket': 3, 'bind': 3, 'listen': 2, 'accept': 3, 'accept4': 4,
    'connect': 3, 'getsockopt': 5, 'setsockopt': 5, 'shutdown': 2,
    'getsockname': 3, 'epoll_create': 1, 'epoll_create1': 1, 'epoll_ctl': 4,
    'epoll_wait': 4, 'epoll_pwait': 5, 'fork': 0, 'pthread_create': 4,
    'pthread_detach': 1, 'getuid': 0, 'getgid': 0, 'geteuid': 0, 'getpid': 0,
    'gettid': 0, 'getppid': 0, 'time': 1, 'gettimeofday': 2, 'sleep': 1,
    'usleep': 1, 'nanosleep': 2, 'kill': 2, 'inotify_init1': 1,
    'inotify_add_watch': 3, 'popen': 2, 'pclose': 1, 'strdup': 1, 'strtok': 2,
    'strtok_r': 3, 'strcat': 2, 'strcpy': 2, 'strtoul': 3, 'strtoull': 3,
    'getpagesize': 0, '_exit': 1, 'exit': 1, 'waitpid': 3, 'wait4': 4,
    'select': 5, 'poll': 3, 'ppoll': 5, 'fork_ret': 0, 'ptrace': 4,
    'prctl': 5, 'syscall': 6, 'sigemptyset': 1, 'sigaddset': 2,
    'pthread_sigmask': 3, 'getrlimit': 2, 'setrlimit': 2, 'madvise': 3,
    'msync': 3, 'mincore': 3, 'mremap': 4, 'posix_memalign': 3, 'memalign': 2,
    'calloc': 2, 'realloc': 2, 'vasprintf': 3, 'asprintf': 2, 'vsnprintf': 4,
    'vfprintf': 3, 'rand': 0, 'srand': 1, 'qsort': 4, 'bsearch': 5, 'abs': 1,
    'labs': 1, 'localtime': 1, 'gmtime': 1, 'mktime': 1, 'strftime': 4,
    'clock_gettime': 2, 'pthread_self': 0, 'pthread_equal': 2,
    'pthread_getspecific': 1, 'pthread_setspecific': 2,
    'pthread_key_delete': 1, 'sched_yield': 0, 'times': 1, 'getrusage': 2,
    'prlimit64': 4, 'eventfd': 2, 'timerfd_create': 2, 'signalfd': 4,
    'pipe2': 2, 'socketpair': 4, 'sendmsg': 3, 'recvmsg': 3, 'sendto': 6,
    'recvfrom': 6, 'dup2': 2, 'execv': 2, 'execve': 3, 'setsid': 0,
    'umask': 1, 'getifaddrs': 1, 'freeifaddrs': 1, 'inet_ntop': 4,
    'inet_pton': 3, 'htons': 1, 'htonl': 1, 'ntohs': 1, 'ntohl': 1,
    'uname': 1, 'gethostname': 2, 'getcwd': 2, 'chdir': 1, 'rename': 2,
    'unlink': 1, 'rmdir': 1, 'readlink': 3, 'ftruncate': 2, 'fsync': 1,
    'flock': 2, 'pipe': 1, 'system': 1, 'daemon': 2, 'sysinfo': 1,
    'fputs': 2, 'fwrite': 4, 'fflush': 1, 'setvbuf': 4, 'fseek': 3,
    'ftell': 1, 'rewind': 1, 'remove': 1, 'tmpfile': 0, 'tmpnam': 1,
    'fprintf': 2, 'puts': 1, 'putchar': 1, 'strcat': 2,
    '__errno': 0, 'feof': 1, 'readdir': 1, 'opendir': 1, 'closedir': 1,
    'stat': 2, 'fstat': 2, 'lseek': 3, 'access': 2, 'mkdir': 2,
    'inet_aton': 2, 'inotify_init': 0, 'signal': 2, 'ldexp': 2,
}


class JiaguHost(eh.Host):
    def __init__(self, uc, ge):
        super().__init__(uc)
        self.ge = ge
        self.fds = {}
        self.conn_recv_queue = []
        self.captured_send = bytearray()
        self.next_fd = 100
        self.accept_count = 0
        self.hls_exports = {}

    def mprotect(self, addr, length, prot):
        log(f'    [mprotect] {hex(addr)}+{hex(length)} prot={prot}')
        self.ge.mprotects.append((addr, length, prot))
        return 0

    def mmap(self, addr, length, prot, flags, fd, off):
        a = eh.Host.mmap(self, addr, length, prot, flags, fd, off)
        log(f'    [mmap] len={hex(length)} → {hex(a)}')
        self.ge.mmaps.append((a, length))
        return a

    # -- red --
    def socket(self, *a):
        self.next_fd += 1
        self.fds[self.next_fd] = 'sock'
        return self.next_fd

    def bind(self, fd, addr_a, ln):
        nm = bytes(self.rstr(addr_a + 2, 108))
        self.ge.sock_names.append(('bind', fd, nm))
        log(f'    [bind] fd {fd} → {nm!r}')
        return 0

    def listen(self, fd, n):
        self.ge.sock_names.append(('listen', fd, n))
        log(f'    [listen] fd {fd} backlog {n}')
        return 0

    def accept(self, fd, addr_a, ln_a):
        self.accept_count += 1
        if self.accept_count > 1:
            raise RuntimeError('accept #2 — primera conexión ya procesada, paro')
        self.next_fd += 1
        self.fds[self.next_fd] = 'conn'
        self.ge.sock_names.append(('accept', fd, self.next_fd))
        log(f'    [accept] fd {fd} → conexión fd {self.next_fd}')
        return self.next_fd

    def accept4(self, fd, a, b, fl):
        return self.accept(fd, a, b)

    def connect(self, fd, addr_a, ln):
        nm = bytes(self.rstr(addr_a + 2, 108))
        self.ge.sock_names.append(('connect', fd, nm))
        log(f'    [connect] fd {fd} → {nm!r} → -ENOENT (no hay servidor aún)')
        return -2 & 0xFFFFFFFFFFFFFFFF

    def recv(self, fd, buf, n, flags=0):
        if self.conn_recv_queue:
            data = self.conn_recv_queue.pop(0)
        else:
            return 0
        n = min(n, len(data))
        self.uc.mem_write(buf, data[:n])
        log(f'    [recv] fd {fd} ← {n} bytes: {data[:n]!r}')
        return n

    def send(self, fd, buf, n, flags=0):
        data = bytes(self.uc.mem_read(buf, n))
        self.captured_send += data
        log(f'    [send] fd {fd} → {n} bytes: {data[:200]!r}')
        return n

    def sendto(self, fd, buf, n, fl, dst, dl):
        return self.send(fd, buf, n, fl)

    def recvfrom(self, fd, buf, n, fl, src, sl):
        return self.recv(fd, buf, n, fl)

    def getsockopt(self, fd, level, opt, val, lenp):
        if opt == 0x11:  # SO_PEERCRED → struct ucred {pid,uid,gid}
            self.uc.mem_write(val, struct.pack('<III', 4242, 10123, 10123))
            log('    [getsockopt SO_PEERCRED → uid 10123]')
        return 0

    def sendmsg(self, *a):
        return 0

    recvmsg = sendmsg
    socketpair = sendmsg
    shutdown = sendmsg
    getsockname = sendmsg
    setsockopt = sendmsg

    def uncompress(self, dst, dstlen_p, src, srclen):
        head = bytes(self.uc.mem_read(src, 32))
        log(f'    [uncompress] src={hex(src)} len={hex(srclen)} head={head.hex()}')
        full = bytes(self.uc.mem_read(src, srclen))
        fn = f'uncompress_src_{len(self.ge.uncompress_srcs)}.bin'
        open(os.path.join(os.path.dirname(os.path.abspath(__file__)), fn), 'wb').write(full)
        log(f'    [uncompress] src volcado → {fn}')
        self.ge.uncompress_srcs.append((src, srclen, head))
        return eh.Host.uncompress(self, dst, dstlen_p, src, srclen)

    def getsockopt(self, fd, level, opt, val, lenp=0):
        if opt == 0x11:  # SO_PEERCRED → struct ucred {pid,uid,gid}
            self.uc.mem_write(val, struct.pack('<III', 4242, 10123, 10123))
            log('    [getsockopt SO_PEERCRED → uid 10123]')
        return 0

    def close(self, fd):
        self.calls['close'] += 1
        if fd in self.fds:
            del self.fds[fd]
            log(f'    [close] fd {fd}')
            return 0
        return 0

    def read(self, fd, buf, n):
        if fd in self.fds:
            return self.recv(fd, buf, n)
        return 0

    def write(self, fd, buf, n):
        if fd in self.fds:
            return self.send(fd, buf, n)
        return n

    def open(self, p_a, *a):
        self.next_fd += 1
        return self.next_fd

    def openat(self, d, p_a, *a):
        return self.open(p_a)

    # -- epoll --
    def epoll_create1(self, *a):
        self.next_fd += 1
        return self.next_fd

    epoll_create = epoll_create1

    def epoll_ctl(self, epfd, op, fd, ev):
        if op == 1:  # EPOLL_CTL_ADD
            mask = 0
            try:
                mask = struct.unpack('<I', bytes(self.uc.mem_read(ev, 4)))[0]
            except Exception:
                pass
            self.ge.epoll_pending.append((fd, mask))
            log(f'    [epoll_ctl ADD fd {fd} mask={hex(mask)}]')
        return 0

    def epoll_wait(self, epfd, events, maxev, timeout):
        if self.ge.epoll_pending:
            fd, mask = self.ge.epoll_pending.pop(0)
            self.uc.mem_write(events, struct.pack('<I4xQ', mask, fd))
            log(f'    [epoll_wait] → evento EPOLLIN fd {fd}')
            return 1
        return 0

    epoll_pwait = epoll_wait

    # -- procesos / hilos --
    def fork(self):
        self.ge.fork_calls += 1
        log('    [fork] → 0 (emulamos el HIJO: bucle de servir)')
        return 0

    def pthread_create(self, th_a, attr_a, fn, arg):
        self.ge.pending_threads.append((fn, arg))
        log(f'    [pthread_create] fn={hex(fn)} arg={hex(arg)} (encolado)')
        return 0

    def pthread_detach(self, *a):
        return 0

    def pthread_mutex_lock(self, *a):
        return 0

    pthread_mutex_unlock = pthread_mutex_lock
    pthread_mutex_init = pthread_mutex_lock
    pthread_mutex_destroy = pthread_mutex_lock
    pthread_cond_wait = pthread_mutex_lock
    pthread_cond_signal = pthread_mutex_lock

    def getuid(self):
        return 10123

    geteuid = getuid
    getgid = getuid

    def getpid(self):
        return 4242

    getppid = getpid
    gettid = getpid

    def kill(self, *a):
        return 0

    def time(self, t_a):
        v = 1789712000
        if t_a:
            self.uc.mem_write(t_a, struct.pack('<Q', v))
        return v

    def gettimeofday(self, tv, tz):
        if tv:
            self.uc.mem_write(tv, struct.pack('<QQ', 1789712000, 0))
        return 0

    def clock_gettime(self, clk, tp):
        if tp:
            self.uc.mem_write(tp, struct.pack('<QQ', 1789712000, 0))
        return 0

    def sleep(self, *a):
        return 0

    usleep = sleep
    nanosleep = sleep

    def waitpid(self, *a):
        return 0

    wait4 = waitpid

    def popen(self, *a):
        return 0

    def pclose(self, *a):
        return 0

    def _exit(self, code):
        raise RuntimeError(f'_exit({code})')

    def exit(self, code):
        raise RuntimeError(f'exit({code})')

    def select(self, *a):
        return 0

    def poll(self, *a):
        return 0

    ppoll = poll

    def dup2(self, *a):
        return 0

    def execv(self, *a):
        return 0

    execve = execv

    def setsid(self):
        return 0

    def ptrace(self, *a):
        log('    [ptrace → 0]')
        return 0

    def prctl(self, *a):
        return 0

    def syscall(self, *a):
        return 0

    # -- cadenas --
    def strdup(self, s):
        t = bytes(self.rstr(s))
        p = self._alloc(len(t) + 1)
        self.uc.mem_write(p, t + b'\0')
        return p

    def strcat(self, d, s):
        t = bytes(self.rstr(d)) + bytes(self.rstr(s))
        self.uc.mem_write(d, t + b'\0')
        return d

    def strcpy(self, d, s):
        t = bytes(self.rstr(s))
        self.uc.mem_write(d, t + b'\0')
        return d

    def strtok(self, *a):
        return 0

    strtok_r = strtok

    def strtoul(self, s, end, base):
        try:
            return int(bytes(self.rstr(s)).decode('latin1').strip(), base or 10)
        except Exception:
            return 0

    strtoull = strtoul

    def getpagesize(self):
        return 4096

    def _errno_impl(self):
        return eh.TLS_BASE + 0x200

    def localtime(self, *a):
        return self._alloc(64)

    gmtime = localtime

    def mktime(self, *a):
        return 1789712000

    def strftime(self, *a):
        return 0

    def rand(self):
        self.ge.rand_state = (self.ge.rand_state * 1103515245 + 12345) & 0x7fffffff
        return self.ge.rand_state

    def srand(self, *a):
        return 0

    def qsort(self, *a):
        return 0

    def bsearch(self, *a):
        return 0

    def abs(self, v):
        return abs(v) & 0xFFFFFFFFFFFFFFFF

    labs = abs

    def uname(self, buf):
        self.uc.mem_write(buf, b'Linux\x00' + b' ' * 59 + b'aarch64\x00' + b'\0' * 256)
        return 0

    def getcwd(self, buf, sz):
        self.uc.mem_write(buf, b'/data/data/com.movievn.cinevi\x00')
        return buf

    def readlink(self, p, buf, sz):
        s = b'/system/bin/app_process64'
        self.uc.mem_write(buf, s)
        return len(s)

    def inotify_init1(self, *a):
        self.next_fd += 1
        return self.next_fd

    def inotify_add_watch(self, *a):
        return 1

    def sigemptyset(self, *a):
        return 0

    sigaddset = sigemptyset
    pthread_sigmask = sigemptyset

    def getrlimit(self, *a):
        return 0

    setrlimit = getrlimit

    def madvise(self, *a):
        return 0

    msync = madvise
    mincore = madvise
    mremap = madvise

    def posix_memalign(self, p, al, sz):
        a = self.malloc(sz)
        self.uc.mem_write(p, struct.pack('<Q', a))
        return 0

    memalign = posix_memalign

    def calloc(self, n, sz):
        a = self._alloc(max(int(n * sz), 16))
        self.uc.mem_write(a, b'\0' * int(n * sz))
        return a

    def realloc(self, p, sz):
        old = bytes(self.uc.mem_read(p, 64)) if p else b''
        a = self._alloc(max(int(sz), 16))
        if p:
            self.uc.mem_write(a, old)
        return a

    def vasprintf(self, *a):
        return 0

    asprintf = vasprintf
    vsnprintf = vasprintf
    vfprintf = vasprintf

    def fprintf(self, *a):
        return 0

    def puts(self, *a):
        return 0

    putchar = puts
    fputs = puts
    fwrite = puts
    fflush = puts
    setvbuf = puts
    fseek = puts
    ftell = puts
    rewind = puts
    remove = puts
    tmpfile = puts
    tmpnam = puts

    def system(self, *a):
        return 0

    daemon = system

    def sysinfo(self, *a):
        return 0

    def gethostname(self, buf, sz):
        self.uc.mem_write(buf, b'emulador\x00')
        return 0

    def chdir(self, *a):
        return 0

    umask = chdir
    rename = chdir
    unlink = chdir
    rmdir = chdir

    def ftruncate(self, *a):
        return 0

    fsync = ftruncate
    flock = ftruncate
    pipe = ftruncate
    eventfd = ftruncate
    timerfd_create = ftruncate
    signalfd = ftruncate
    pipe2 = ftruncate

    def getifaddrs(self, *a):
        return 0

    freeifaddrs = getifaddrs
    inet_ntop = getifaddrs
    inet_pton = getifaddrs

    def htons(self, v):
        return ((v & 0xFF) << 8) | (v >> 8)

    def htonl(self, v):
        return struct.unpack('<I', struct.pack('>I', v & 0xFFFFFFFF))[0]

    def ntohs(self, v):
        return self.htons(v)

    ntohl = htonl

    def pthread_self(self):
        return 0x7000

    pthread_equal = pthread_self
    pthread_getspecific = pthread_self

    def pthread_setspecific(self, *a):
        return 0

    pthread_key_delete = pthread_setspecific

    def sched_yield(self):
        return 0

    def times(self, *a):
        return 0

    getrusage = times
    prlimit64 = times

    def clear_cache_impl(self, *a):
        return 0

    def dladdr(self, addr, info):
        self.calls['dladdr'] += 1
        base = 0
        if JBASE <= addr < JBASE + 0x210000:
            base = JBASE
        elif 0x500c9000 <= addr < 0x500c9000 + 0x1d4000:
            base = 0x500c9000
        elif BASE <= addr < BASE + 0x600000:
            base = BASE
        fname = self.putstr('/data/app/com.movievn.cinevi/lib/arm64/libjiagu_sdk_pp_hlsProtected.so')
        self.uc.mem_write(info, struct.pack('<QQQQ', fname, base, 0, 0))
        log(f'    [dladdr {hex(addr)} → base {hex(base)}]')
        return 1

    def strcmp(self, a, b):
        r = eh.Host.strcmp(self, a, b)
        try:
            sa = bytes(self.rstr(a, 64)); sb = bytes(self.rstr(b, 64))
            if len(self.ge.strcmp_log) < 200:
                self.ge.strcmp_log.append((sa, sb))
        except Exception:
            pass
        return r

    # -- archivos / varios --
    def feof(self, *a):
        return 0

    def opendir(self, *a):
        return self._alloc(64)

    def readdir(self, *a):
        return 0

    def closedir(self, *a):
        return 0

    def stat(self, *a):
        return -1 & 0xFFFFFFFFFFFFFFFF

    fstat = stat
    access = stat

    def mkdir(self, *a):
        return 0

    def lseek(self, *a):
        return 0

    def inet_aton(self, *a):
        return 1

    def inotify_init(self):
        self.next_fd += 1
        return self.next_fd

    def signal(self, *a):
        return 0

    def ldexp(self, x, e):
        import math
        return math.ldexp(float(x), e)

    # dlsym extendido: exports REALES de libpp_hls
    def dlsym(self, handle, name_a):
        self.calls['dlsym'] += 1
        nm = self.rstr(name_a).decode('latin1')
        self.dlsym_log.append(nm)
        if nm in self.hls_exports:
            addr = self.hls_exports[nm]
        else:
            addr = HOOKS_ADDR.get(nm, 0)
        log(f'    [dlsym "{nm}" → {hex(addr)}]')
        return addr


# atributos con nombre reservado / con mangling
setattr(JiaguHost, 'raise', JiaguHost.kill)
setattr(JiaguHost, '__errno', JiaguHost._errno_impl)
setattr(JiaguHost, '__clear_cache', JiaguHost.clear_cache_impl)
setattr(JiaguHost, '__aarch64_sync_cache_range', JiaguHost.clear_cache_impl)


class JiaguEmu:
    def __init__(self):
        for nm in NUEVOS:
            eh.HOOK_TABLE_NAMES.setdefault(nm, nm)
        # remapear stubs → implementaciones reales
        for nm in NUEVOS:
            eh.HOOK_TABLE_NAMES[nm] = nm
        eh.HOOK_TABLE_NAMES['close'] = 'close'
        eh.Emu.NARGS.update(NARGS_JIAGU)

        self.emu = eh.Emu()
        self.host = JiaguHost(self.emu.uc, self)
        self.emu.host = self.host

        self.hls_exports = {}
        for s in self.emu.elf.get_section_by_name('.dynsym').iter_symbols():
            if s['st_value'] and s['st_shndx'] != 'SHN_UNDEF':
                self.hls_exports[s.name] = BASE + s['st_value']
        self.host.hls_exports = self.hls_exports
        log(f'[jiagu] exports de libpp_hls disponibles para dlsym: '
            f'{len(self.hls_exports)}')

        self.sock_names = []
        self.fork_calls = 0
        self.pending_threads = []
        self.rand_state = 1
        self.r2_hit = None
        self.vm_calls = 0
        self.strcmp_log = []
        self.mprotects = []
        self.mmaps = []
        self.epoll_pending = []
        self.uncompress_srcs = []
        self.r2_writes = None
        self.jiagu_blocks = []
        self._load_jiagu()

    def _load_jiagu(self):
        uc = self.emu.uc
        self.jdata = open(JLIB, 'rb').read()
        self.jelf = ELFFile(open(JLIB, 'rb'))
        for s in self.jelf.iter_segments():
            if s['p_type'] != 'PT_LOAD':
                continue
            va, off, fsz, msz = s['p_vaddr'], s['p_offset'], s['p_filesz'], s['p_memsz']
            p0 = va & ~0xfff
            size = (((va + msz) + 0xfff) & ~0xfff) - p0
            uc.mem_map(JBASE + p0, size)
            uc.mem_write(JBASE + va, self.jdata[off:off + fsz].ljust(msz, b'\0'))
            log(f'[jiagu] segmento {hex(va)} → {hex(JBASE+p0)}+{hex(size)}')

        dyn = self.jelf.get_section_by_name('.dynsym')
        names = [s.name for s in dyn.iter_symbols()]
        unresolved = {}
        n_rel = 0
        for secname in ('.rela.dyn', '.rela.plt'):
            sec = self.jelf.get_section_by_name(secname)
            if not sec:
                continue
            for r in sec.iter_relocations():
                off, t, add, si = r['r_offset'], r['r_info_type'], r['r_addend'], r['r_info_sym']
                addr = JBASE + off
                if t == R_AARCH64_RELATIVE:
                    uc.mem_write(addr, struct.pack('<Q', (JBASE + add) & 0xFFFFFFFFFFFFFFFF))
                    n_rel += 1
                    continue
                nm = names[si] if si < len(names) else '?'
                v = eh.HOOKS_ADDR.get(nm) or self.hls_exports.get(nm) \
                    or self.emu.DATA_SYMS.get(nm, 0)
                if v:
                    uc.mem_write(addr, struct.pack('<Q', v))
                else:
                    unresolved[nm] = unresolved.get(nm, 0) + 1
        log(f'[jiagu] relocs: {n_rel} RELATIVE; SIN resolver: {unresolved}')
        self.unresolved = unresolved

        self._wire_jiagu_hooks()

    def _wire_jiagu_hooks(self):
        uc = self.emu.uc

        def on_jblock(uc, address, size, ud):
            if not (JBASE <= address < JBASE + 0x100000):
                return
            self.jiagu_blocks.append(address)
            off = address - JBASE
            if off == 0x1b4d0:
                self.vm_calls += 1
                if self.vm_calls <= 8 or self.vm_calls % 500 == 0:
                    x0, x1, x2 = (uc.reg_read(r) for r in
                                  (UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2))
                    bc = f' (bc @ {hex(x0 - JBASE)})' if JBASE <= x0 < JBASE + 0x100000 else ''
                    log(f'[VM jiagu #{self.vm_calls}] x0={hex(x0)}{bc} '
                        f'x1={hex(x1)} x2={hex(x2)}')
            if R2_LO <= off < R2_HI and self.r2_hit is None:
                self.r2_hit = address
                log(f'\n**** PRIMER BLOQUE EN REGIÓN 2: {hex(address)} '
                    f'(off {hex(off)}) ****\n')
                uc.emu_stop()

        uc.hook_add(UC_HOOK_BLOCK, on_jblock, begin=JBASE, end=JBASE + 0x100000)

        def on_r2_write(uc, access, address, size, value, ud):
            if self.r2_writes is None:
                return
            pc = uc.reg_read(UC_ARM64_REG_PC)
            if len(self.r2_writes) < 30:
                self.r2_writes.append((address, size, pc))
                log(f'    [escritura región 2] {hex(address)} size={size} desde PC={hex(pc)}')
            if len(self.r2_writes) == 30:
                log('    [escrituras región 2: 30+ — silencio]')

        from unicorn import UC_HOOK_MEM_WRITE
        uc.hook_add(UC_HOOK_MEM_WRITE, on_r2_write,
                    begin=JBASE + R2_LO, end=JBASE + R2_HI)

    def jni_onload(self, budget=60_000_000):
        log('\n=== jiagu: JNI_OnLoad ===')
        self.emu._build_jni()
        req = (b'GET /control?msg=verify&device_id=testdevice1'
               b'&ts=1789712000000 HTTP/1.1\r\nHost: 127.0.0.1\r\n'
               b'Connection: close\r\n\r\n')
        self.host.conn_recv_queue.append(req)
        try:
            self.emu.call(JBASE + 0x10dcc,
                          (self.emu.java_vm, self.emu.jni_env, 0),
                          budget=budget, label='jiagu JNI_OnLoad')
        except RuntimeError as re_:
            log(f'  fin por RuntimeError: {re_}')
        except UcError as e:
            log(f'  UcError: {e}')
        return self.r2_hit

    def dump_r2(self, path=None):
        path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    'jiagu_region2_viva.bin')
        data = bytes(self.emu.uc.mem_read(JBASE + R2_LO, R2_HI - R2_LO))
        open(path, 'wb').write(data)
        log(f'[región 2] volcada → {path} ({len(data)} B, {data.count(0)} ceros)')
        return data


def peek_and_dump(ge):
    uc = ge.emu.uc
    import math
    def ent(b):
        c = {}
        for x in b:
            c[x] = c.get(x, 0) + 1
        n = len(b)
        return -sum((v / n) * math.log2(v / n) for v in c.values())
    for name, addr, size in (('modulo_uncompress', 0x500c9000, 0x1d4000),
                             ('region_501f8000', 0x501f8000, 0xf000)):
        parts = []
        for o in range(0, size, 0x1000):
            try:
                parts.append(bytes(uc.mem_read(addr + o, 0x1000)))
            except Exception:
                parts.append(b'\0' * 0x1000)
        data = b''.join(parts)
        nz = len(data) - data.count(0)
        log(f'[peek] {name} @ {hex(addr)}: entropía {ent(data[:0x20000]):.2f}, '
            f'no-ceros {nz}/{len(data)}')
        log(f'       primeros 96 bytes: {data[:96].hex()}')
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            f'jiagu_{name}.bin')
        open(path, 'wb').write(data)
        log(f'       volcado → {path}')


MBASE = 0x500c9000
MENTRY = 0x2bb70
MSIZE = 0x1d4000


def modinit(ge, budget=20_000_000, stop_at=(0x70ef8,)):
    """Vuelve a mapear el módulo volcado en su base original, rearma
    punteros autorreferentes y ejecuta su entry point (autodescifrado)."""
    uc = ge.emu.uc
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        'jiagu_modulo_uncompress.bin')
    d = open(path, 'rb').read()
    log(f'[mod] mapeando {len(d)} bytes en {hex(MBASE)}')
    for o in range(0, len(d), 0x1000):
        try:
            uc.mem_map(MBASE + o, 0x1000)
            uc.mem_write(MBASE + o, d[o:o + 0x1000])
        except Exception:
            uc.mem_write(MBASE + o, d[o:o + 0x1000])  # ya mapeada
    # punteros autorreferentes → ajustar a MBASE
    n_fix = 0
    for o in range(0, len(d) - 8, 8):
        v = struct.unpack('<Q', d[o:o + 8])[0]
        if 0 < v < MSIZE:
            uc.mem_write(MBASE + o, struct.pack('<Q', MBASE + v))
            n_fix += 1
    log(f'[mod] {n_fix} punteros autorreferentes ajustados')

    hits = []

    def on_mblock(uc2, address, size, ud):
        off = address - MBASE
        if off in stop_at:
            hits.append(off)
            log(f'\n**** MÓDULO: ejecución llegó a {hex(off)} ****\n')
            uc2.emu_stop()

    uc.hook_add(UC_HOOK_BLOCK, on_mblock, begin=MBASE, end=MBASE + MSIZE)
    try:
        ge.emu.call(MBASE + MENTRY, (MBASE,), budget=budget, label='módulo entry')
    except RuntimeError as e:
        log(f'  fin: {e}')
    except UcError as e:
        pc = uc.reg_read(0x200)  # UC_ARM64_REG_PC
        log(f'  UcError {e} en {hex(pc)} (off {hex(pc - MBASE)})')
    return hits


def dump_mod(ge, path=None):
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                'jiagu_modulo_vivo.bin')
    uc = ge.emu.uc
    parts = []
    for o in range(0, MSIZE, 0x1000):
        try:
            parts.append(bytes(uc.mem_read(MBASE + o, 0x1000)))
        except Exception:
            parts.append(b'\0' * 0x1000)
    data = b''.join(parts)
    open(path, 'wb').write(data)
    log(f'[mod] volcado vivo → {path}')
    return data


EXPORTS_J = {
    '__arm_a_0': 0x1f318, '__arm_a_1': 0x115dc, '__arm_a_2': 0x10270,
    '__arm_a_20': 0x79c8, '__arm_a_21': 0x790c,
    'DynCryptor_c0': 0x7214, 'c1_c0': 0x68b4,
}


def probar_exports(ge, budget=40_000_000):
    emu = ge.emu
    emu._build_jni()
    # jstrings para load(extFiles, extStorage, tc, hash, pkg, "63", "1")
    strs = [b'/data/user/0/com.movievn.cinevi/files',
            b'/storage/emulated/0/Android/data/com.movievn.cinevi/files',
            b'87c2cb7ff568d602d5f806c473345600',
            b'87c2cb7ff568d602d5f806c473345600',
            b'com.movievn.cinevi', b'63', b'1']
    refs = [emu._jni_ref(('str', x)) for x in strs]
    for nm, off in EXPORTS_J.items():
        log(f'\n======== export {nm} @ {hex(off)} ========')
        n0 = len(ge.sock_names); m0 = len(ge.mmaps); r2 = ge.r2_hit
        # el stub reordena: x3..x6 = args java (x3 = JNIEnv*)
        argsets = [
            (emu.jni_env, refs[0], refs[1], refs[4]),
            (emu.jni_env, refs[3], refs[4], refs[5]),
            (emu.jni_env, refs[0], refs[1], 0),
        ]
        for ai, aa in enumerate(argsets):
            log(f'  -- {nm} intento {ai}: {[hex(x) for x in aa]}')
            try:
                emu.call(JBASE + off, aa, budget=budget // 3, label=f'{nm}#{ai}')
            except RuntimeError as e:
                log(f'  fin: {e}')
            except UcError as e:
                log(f'  UcError {e}')
            if ge.sock_names[n0:]:
                break
        log(f'  → red nueva: {ge.sock_names[n0:]}; mmaps nuevos: {len(ge.mmaps)-m0}; '
            f'r2_hit={hex(ge.r2_hit) if ge.r2_hit else None}')
        if ge.sock_names[n0:] or (ge.r2_hit and ge.r2_hit != r2):
            log(f'  **** {nm} ES EL ARRANCADOR ****')
        if ge.host.captured_send:
            break


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--load', action='store_true')
    ap.add_argument('--run', action='store_true')
    ap.add_argument('--budget', type=int, default=60)
    ap.add_argument('--modinit', action='store_true')
    ap.add_argument('--exports-j', action='store_true')
    ap.add_argument('--server-directo', action='store_true')
    args = ap.parse_args()

    ge = JiaguEmu()
    if args.load or (not args.run and not args.modinit and not args.exports_j
                    and not args.server_directo):
        log('[solo carga OK]')
        return
    if args.modinit and not args.run:
        ge.emu._build_jni()
        modinit(ge)
        dump_mod(ge)
        return
    if args.server_directo:
        ge.emu._build_jni()
        req = (b'GET /control?msg=verify&device_id=testdevice1'
               b'&ts=1789712000000 HTTP/1.1\r\nHost: 127.0.0.1\r\n'
               b'Connection: close\r\n\r\n')
        ge.host.conn_recv_queue.append(req)
        try:
            ge.emu.call(JBASE + 0x8634, (), budget=args.budget * 1_000_000,
                        label='start_server 0x8634')
        except RuntimeError as e:
            log(f'  fin: {e}')
        except UcError as e:
            log(f'  UcError {e}')
        log(f'\n== red ==\n{ge.sock_names}')
        log(f'r2_hit={hex(ge.r2_hit) if ge.r2_hit else None}')
        # ejecutar hilos encolados (handler de conexión)
        while ge.pending_threads:
            fn, arg = ge.pending_threads.pop()
            log(f'\n=== ejecutando hilo {hex(fn)} arg={hex(arg)} ===')
            try:
                ge.emu.call(fn, (arg,), budget=20_000_000, label=f'hilo {hex(fn)}')
            except RuntimeError as e:
                log(f'  fin: {e}')
            except UcError as e:
                log(f'  UcError {e}')
            log(f'r2_hit={hex(ge.r2_hit) if ge.r2_hit else None}')
        if ge.host.captured_send:
            log(f'\n== RESPUESTA ==\n{bytes(ge.host.captured_send)!r}')
        return
    if args.exports_j:
        ge.r2_writes = []
        ge.jni_onload(budget=30_000_000)
        log(f'[escrituras r2 en JNI_OnLoad: {len(ge.r2_writes)}]')
        probar_exports(ge, budget=args.budget * 1_000_000)
        log(f'[escrituras r2 tras exports: {len(ge.r2_writes)}]')
        peek_and_dump(ge)
        log(f'\n== red total ==\n{ge.sock_names}')
        if ge.host.captured_send:
            log(f'\n== RESPUESTA ==\n{bytes(ge.host.captured_send)!r}')
        return
    ge.r2_writes = []
    hit = ge.jni_onload(budget=args.budget * 1_000_000)
    if hit is not None:
        ge.dump_r2()
    peek_and_dump(ge)
    log(f'escrituras región2 durante JNI_OnLoad: {len(ge.r2_writes)}')
    log(f'\n== JNI ==\nnatives={ge.emu.jni_natives}')
    for fn, a in ge.emu.jni_log[:40]:
        log(f'  JNI {fn} {[hex(x) if isinstance(x,int) else x for x in a[:4]]}')
    log(f'\n== red ==\n{ge.sock_names}')
    log(f'forks={ge.fork_calls} hilos={[hex(f) for f, _ in ge.pending_threads]} '
        f'vm_calls={ge.vm_calls}')
    if ge.host.captured_send:
        log(f'\n== RESPUESTA CAPTURADA ==\n{bytes(ge.host.captured_send)!r}')


if __name__ == '__main__':
    main()
