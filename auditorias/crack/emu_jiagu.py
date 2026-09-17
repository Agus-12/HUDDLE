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
                                 UC_ARM64_REG_X2, UC_ARM64_REG_X30)

# Cifrado del módulo .mips: RC4 con PRGA no estándar en 0x64bc.
#   x0 = buffer (se cifra/descifra in situ), x1 = longitud, x2 = struct de estado
#   estado: [0x000..0x0ff] = S-box, [0x100] = i, [0x101] = j
#   PRGA:  i += 2; j = S[i] + j + 1; swap(S[i],S[j]);
#          out ^= S[(S[i_ANTES] + S[j_DESPUES]) & 0xff]
# Con el S-box ya inicializado (post-KSA) se puede reproducir en Python sin
# reimplementar la KSA — por eso se vuelca aquí.
RC4_OFF = 0x64bc
RC4_RET = 0x655c

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
    'sscanf': 6, 'fopen': 2, 'fgets': 3,
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


    # ---------------- zlib (streaming real sobre zlib de Python) ----------
    def _zstreams(self):
        if not hasattr(self, '_zs'):
            self._zs = {}
        return self._zs

    def deflateInit_(self, strm, level, ver, sz):
        return self.deflateInit2_(strm, level, 8, 15, 8, 0, ver, sz)

    def deflateInit2_(self, strm, level, method, wbits, memlvl, strat,
                      ver, sz):
        import zlib as _z
        st = {'co': _z.compressobj(max(-1, min(9, level & 0xffffffff if level >= 0 else -1)),
                                   _z.DEFLATED, wbits, memlvl or 8, strat or 0),
              'mode': 'd'}
        self._zstreams()[strm] = st
        # z_stream: total_in@16 total_out@40 state@56 adler@96 (64-bit)
        self.uc.mem_write(strm + 16, struct.pack('<Q', 0))
        self.uc.mem_write(strm + 40, struct.pack('<Q', 0))
        self.uc.mem_write(strm + 56, struct.pack('<Q', 0x5A11))
        self.uc.mem_write(strm + 96, struct.pack('<Q', 1))
        return 0

    def inflateInit_(self, strm, ver, sz):
        return self.inflateInit2_(strm, 15, ver, sz)

    def inflateInit2_(self, strm, wbits, ver, sz):
        import zlib as _z
        w = wbits if wbits < 0 or wbits > 15 else wbits
        st = {'do': _z.decompressobj(w), 'mode': 'i',
              'outq': b'', 'eos': False}
        self._zstreams()[strm] = st
        self.uc.mem_write(strm + 16, struct.pack('<Q', 0))
        self.uc.mem_write(strm + 40, struct.pack('<Q', 0))
        self.uc.mem_write(strm + 56, struct.pack('<Q', 0x5A12))
        self.uc.mem_write(strm + 96, struct.pack('<Q', 1))
        return 0

    def _zs_fields(self, strm):
        f = struct.unpack('<QQQQQQ', bytes(self.uc.mem_read(strm, 48)))
        return f  # next_in, avail_in, total_in, next_out, avail_out, total_out

    def _zs_set_out(self, strm, next_out, avail_out, total_out):
        self.uc.mem_write(strm + 24, struct.pack('<QQQ', next_out, avail_out,
                                                 total_out))

    def deflate(self, strm, flush):
        st = self._zstreams().get(strm)
        if not st:
            return -2
        ni, ai, ti, no, ao, to = self._zs_fields(strm)
        data = bytes(self.uc.mem_read(ni, ai)) if ai else b''
        import zlib as _z
        if flush == 4:  # Z_FINISH
            out = st['co'].compress(data) + st['co'].flush(_z.Z_FINISH)
        elif flush == 2:  # Z_FULL_FLUSH
            out = st['co'].compress(data) + st['co'].flush(_z.Z_FULL_FLUSH)
        elif flush == 3:  # Z_SYNC_FLUSH
            out = st['co'].compress(data) + st['co'].flush(_z.Z_SYNC_FLUSH)
        else:
            out = st['co'].compress(data)
        put = out[:ao]
        if put:
            self.uc.mem_write(no, put)
        self.uc.mem_write(strm, struct.pack('<QQQ', ni + ai, 0, ti + ai))
        self._zs_set_out(strm, no + len(put), ao - len(put), to + len(put))
        self.uc.mem_write(strm + 96, struct.pack('<Q', _z.adler32(data, 1)))
        if flush == 4:
            return 1 if len(out) <= ao else -5
        return 0 if len(out) <= ao else -5

    def inflate(self, strm, flush):
        st = self._zstreams().get(strm)
        if not st:
            return -2
        ni, ai, ti, no, ao, to = self._zs_fields(strm)
        data = bytes(self.uc.mem_read(ni, ai)) if ai else b''
        outq = st['outq']
        consumed = 0
        if data and not st['eos']:
            try:
                outq += st['do'].decompress(data) if not hasattr(st['do'], 'unused_data') or True else b''
                consumed = ai - len(getattr(st['do'], 'unused_data', b''))
                if st['do'].eof:
                    st['eos'] = True
            except Exception:
                return -3
        put = outq[:ao]
        if put:
            self.uc.mem_write(no, put)
        st['outq'] = outq[len(put):]
        self.uc.mem_write(strm, struct.pack('<QQQ', ni + consumed,
                                            ai - consumed, ti + consumed))
        self._zs_set_out(strm, no + len(put), ao - len(put), to + len(put))
        if st['eos'] and not st['outq']:
            return 1  # Z_STREAM_END
        return 0

    def deflateEnd(self, strm):
        self._zstreams().pop(strm, None)
        self.uc.mem_write(strm + 56, struct.pack('<Q', 0))
        return 0

    def inflateEnd(self, strm):
        return self.deflateEnd(strm)

    def inflateReset(self, strm):
        import zlib as _z
        st = self._zstreams().get(strm)
        if st:
            st['do'] = _z.decompressobj(15)
            st['outq'] = b''
            st['eos'] = False
        return 0

    def compress2(self, dst, dstlen_p, src, srclen, level):
        import zlib as _z
        data = bytes(self.uc.mem_read(src, srclen))
        out = _z.compress(data, 6 if level in (-1, 0) else level)
        if dstlen_p:
            cap = struct.unpack('<I', bytes(self.uc.mem_read(dstlen_p, 4)))[0]
            if cap < len(out):
                self.uc.mem_write(dstlen_p, struct.pack('<I', len(out)))
                return -5
            self.uc.mem_write(dstlen_p, struct.pack('<I', len(out)))
        self.uc.mem_write(dst, out)
        return 0

    def compress(self, dst, dstlen_p, src, srclen):
        return self.compress2(dst, dstlen_p, src, srclen, -1)

    def crc32(self, crc, buf, n=0):
        import zlib as _z
        data = bytes(self.uc.mem_read(buf, n)) if buf and n else b''
        return _z.crc32(data, crc & 0xFFFFFFFF) & 0xFFFFFFFF

    def adler32(self, ad, buf, n=0):
        import zlib as _z
        data = bytes(self.uc.mem_read(buf, n)) if buf and n else b''
        return _z.adler32(data, ad & 0xFFFFFFFF) & 0xFFFFFFFF

    def sprintf(self, buf, fmt_a, *rest):
        s = self.rstr(fmt_a)
        try:
            txt = s.decode('latin1')
        except Exception:
            txt = str(s)
        out = []
        it = iter(range(len(rest)))
        i = 0
        while i < len(txt):
            c = txt[i]
            if c == '%' and i + 1 < len(txt):
                j = i + 1
                while j < len(txt) and txt[j] in '#0-+. lhz':
                    j += 1
                conv = txt[j] if j < len(txt) else ''
                if conv == '%':
                    out.append('%')
                elif conv in ('d', 'i'):
                    out.append(str(struct.unpack('<i', struct.pack('<I', next(it, 0) & 0xffffffff))[0]))
                elif conv == 'u':
                    out.append(str(next(it, 0) & 0xffffffff))
                elif conv == 'x':
                    out.append('%x' % next(it, 0))
                elif conv == 'X':
                    out.append('%X' % next(it, 0))
                elif conv == 'p':
                    out.append('0x%x' % next(it, 0))
                elif conv == 's':
                    a = next(it, 0)
                    out.append(self.rstr(a).decode('latin1', 'replace') if a else '(null)')
                elif conv == 'c':
                    out.append(chr(next(it, 0) & 0xff))
                elif conv == 'l' and j + 1 < len(txt) and txt[j+1] in 'dux':
                    out.append(str(next(it, 0)))
                    j += 1
                else:
                    out.append(txt[i:j+1])
                i = j + 1
                continue
            out.append(c)
            i += 1
        data = ''.join(out).encode('latin1', 'replace') + b'\0'
        self.uc.mem_write(buf, data)
        return len(data) - 1

    def creat(self, p_a, mode):
        return self.open(p_a, 0o102, mode)

    def gzopen(self, *a):
        return 0

    def gzwrite(self, *a):
        return 0

    def gzclose(self, *a):
        return 0

    def zError(self, *a):
        return 0

    # ---------------- C++ ABI mínimos ------------------------------------
    def cxa_atexit_impl(self, *a):
        return 0

    def pthread_key_create(self, *a):
        return 0

    def pthread_once(self, *a):
        return 0

    # dlsym extendido: exports REALES de libpp_hls + símbolos de datos
    def dlsym(self, handle, name_a):
        self.calls['dlsym'] += 1
        nm = self.rstr(name_a).decode('latin1')
        self.dlsym_log.append(nm)
        if nm in self.hls_exports:
            addr = self.hls_exports[nm]
        else:
            addr = HOOKS_ADDR.get(nm, 0)
        if not addr:
            # símbolos de DATOS del emulador base (__sF, __stack_chk_guard…)
            addr = getattr(self.ge.emu, 'DATA_SYMS', {}).get(nm, 0)
        if not addr:
            # stub genérico dinámico: el dispatcher cae en Host.stub(nm,…) → 0
            ge = self.ge
            if not hasattr(ge, 'next_stub'):
                ge.next_stub = max(HOOKS_ADDR.values()) + 0x10
            addr = ge.next_stub
            ge.next_stub += 0x10
            HOOKS_NAME[addr] = nm
            self.uc.mem_write(addr, b'\xc0\x03\x5f\xd6')
            log(f'    [dlsym "{nm}" → {hex(addr)} (stub genérico)]')
        else:
            log(f'    [dlsym "{nm}" → {hex(addr)}]')
        return addr

    # fopen: /proc/self/maps incluye también los segmentos de jiagu
    def fopen(self, p_a, m_a):
        p = self.rstr(p_a).decode('latin1')
        if p == '/proc/self/maps':
            lines = eh.VFILE.get('/proc/self/maps', b'').decode().split('\n')
            extra = []
            for va, sz in getattr(self.ge, 'jiagu_segs', []):
                extra.append(f'{JBASE+va:x}-{JBASE+va+sz:x} r-xp 00000000 '
                             f'fe:00 1 /data/app/libpp_hls.so!libjiagu.so')
            body = ('\n'.join([l for l in lines if l] + extra) + '\n').encode()
            h = 0x7100 + len(self.files)
            self.files[h] = bytearray(body)
            self.calls['fopen'] += 1
            log(f'    [fopen "/proc/self/maps" (+{len(extra)} líneas jiagu)]')
            return h
        return eh.Host.fopen(self, p_a, m_a)

    # sscanf funcional: %lx %x %d %s %n %c y supresores %*
    def sscanf(self, s_a, fmt_a, *outs):
        self.calls['sscanf'] += 1
        s = self.rstr(s_a).decode('latin1', 'replace')
        fmt = self.rstr(fmt_a).decode('latin1', 'replace')
        i = j = n = 0
        L = len(s)
        while j < len(fmt):
            c = fmt[j]
            if c == '%':
                j += 1
                if j < len(fmt) and fmt[j] == '%':
                    j += 1
                    continue
                sup = False
                if j < len(fmt) and fmt[j] == '*':
                    sup = True
                    j += 1
                while j < len(fmt) and fmt[j].isdigit():
                    j += 1
                # modificadores de longitud: l, ll, h, hh, z, j, t
                while j < len(fmt) and fmt[j] in 'lhqjzt':
                    j += 1
                conv = fmt[j] if j < len(fmt) else ''
                j += 1
                if conv == 'n':
                    if not sup and n < len(outs) and outs[n]:
                        self.uc.mem_write(outs[n], struct.pack('<I', i))
                    continue
                while i < L and s[i] in ' \t\r\n':
                    i += 1
                if conv == 'x' or conv == 'p' or conv == 'X':
                    k = i
                    while k < L and s[k] in '0123456789abcdefABCDEF':
                        k += 1
                    if k == i:
                        break
                    val = int(s[i:k], 16)
                    i = k
                    if not sup:
                        if n >= len(outs) or not outs[n]:
                            break
                        self.uc.mem_write(outs[n], struct.pack('<Q', val))
                        n += 1
                elif conv == 'd' or conv == 'u':
                    k = i
                    if k < L and s[k] in '+-':
                        k += 1
                    while k < L and s[k].isdigit():
                        k += 1
                    if k == i or not s[i:k].lstrip('+-').isdigit():
                        break
                    val = int(s[i:k])
                    i = k
                    if not sup:
                        if n >= len(outs) or not outs[n]:
                            break
                        self.uc.mem_write(outs[n], struct.pack('<Q', val & 0xFFFFFFFFFFFFFFFF))
                        n += 1
                elif conv == 's':
                    k = i
                    while k < L and s[k] not in ' \t\r\n':
                        k += 1
                    if k == i:
                        break
                    if not sup:
                        if n >= len(outs) or not outs[n]:
                            break
                        self.uc.mem_write(outs[n], s[i:k].encode('latin1') + b'\0')
                        n += 1
                    i = k
                elif conv == 'c':
                    if i >= L:
                        break
                    if not sup:
                        if n >= len(outs) or not outs[n]:
                            break
                        self.uc.mem_write(outs[n], s[i].encode('latin1'))
                        n += 1
                    i += 1
                else:
                    break
            elif c in ' \t\r\n':
                while i < L and s[i] in ' \t\r\n':
                    i += 1
                j += 1
            else:
                if i >= L or s[i] != c:
                    break
                i += 1
                j += 1
        if self.calls['sscanf'] <= 6:
            log(f'    [sscanf "{s[:60]}" fmt="{fmt[:40]}" → {n}]')
        return n


# atributos con nombre reservado / con mangling
setattr(JiaguHost, 'raise', JiaguHost.kill)
setattr(JiaguHost, '__errno', JiaguHost._errno_impl)
setattr(JiaguHost, '__cxa_atexit', JiaguHost.cxa_atexit_impl)
def _sysprop(self, name_a, val_a):
    nm = self.rstr(name_a).decode('latin1', 'replace')
    PROPS = {
        'ro.build.version.sdk': '33', 'ro.build.version.release': '13',
        'ro.product.cpu.abi': 'arm64-v8a', 'ro.product.model': 'Pixel 6',
        'ro.product.brand': 'google', 'ro.product.manufacturer': 'Google',
        'ro.build.display.id': 'TQ3A.230901.001',
        'ro.debuggable': '0', 'ro.secure': '1',
        'ro.kernel.qemu': '0', 'ro.hardware': 'oriole',
        'persist.sys.timezone': 'America/Mexico_City',
        'ro.build.fingerprint': 'google/oriole/oriole:13/TQ3A.230901.001',
    }
    v = PROPS.get(nm, '')
    if v:
        self.uc.mem_write(val_a, v.encode() + b'\0')
        log(f'    [__system_property_get("{nm}") = "{v}"]')
    else:
        log(f'    [__system_property_get("{nm}") → vacío]')
    return len(v)


setattr(JiaguHost, '__system_property_get', _sysprop)
setattr(JiaguHost, '__system_property_find', lambda self, n: 0)
setattr(JiaguHost, '__system_property_read_callback',
        lambda self, a, b, c: 0)
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
        # trampolines zlib/C++ faltantes (el módulo 360 los resuelve por dlsym)
        _ZLIB = {
            'deflateInit_': 4, 'deflateInit2_': 8, 'deflate': 2,
            'deflateEnd': 1, 'inflateInit_': 3, 'inflateInit2_': 4,
            'inflate': 2, 'inflateEnd': 1, 'inflateReset': 1,
            'compress': 4, 'compress2': 5, 'uncompress': 4, 'crc32': 3,
            'adler32': 3, 'gzopen': 2, 'gzwrite': 4, 'gzclose': 1,
            'zError': 1, 'zlibVersion': 0,
            '__cxa_atexit': 3, 'pthread_key_create': 2, 'pthread_once': 2,
            '__system_property_get': 2, '__system_property_find': 1,
            '__system_property_read_callback': 3, 'getrandom': 3,
            'sysconf': 1, 'mmap64': 6, 'pread64': 5, 'pwrite64': 5,
            'strlen': 1, 'strcmp': 2, 'strncmp': 3, 'strchr': 2,
            'memmove': 3, 'memcpy': 3, 'strtol': 3, 'strtod': 2,
            'atoi': 1, 'getenv': 1, 'localtime_r': 2,
            'srandom': 1, 'random': 0, 'abort': 0, 'longjmp': 2,
            'setjmp': 1, 'vfprintf': 3, 'vsprintf': 2, 'vsnprintf': 4,
            'snprintf': 4, 'sprintf': 3, 'printf': 2, 'strrchr': 2,
            'strstr': 2, 'strdup': 1, 'strncat': 3, 'strncpy': 3,
            'memset': 3, 'memchr': 3, 'memcmp': 3, 'qsort': 4,
            'pthread_mutex_trylock': 1, 'pthread_cond_broadcast': 1,
            'pthread_cond_init': 2, 'pthread_cond_destroy': 1,
            'pthread_mutexattr_init': 1, 'pthread_mutexattr_settype': 2,
            'pthread_mutexattr_destroy': 1, 'pthread_getattr_np': 2,
            'pthread_attr_getstack': 2, 'pthread_attr_destroy': 1,
            'dl_iterate_phdr': 2, 'dlclose': 1, 'dlerror': 0,
            'getauxval': 1, 'prctl': 5, 'sigaction': 3,
            'sigaltstack': 2, 'gettid': 0, 'nanosleep': 2,
            'clock_gettime': 2, 'gettimeofday': 2, 'time': 1,
            'strtoll': 3, 'strtoull': 3, 'atoll': 1, 'llabs': 1,
            'fabs': 1, 'floor': 1, 'ceil': 1, 'sqrt': 1, 'pow': 2,
            '__assert2': 4, '__assert': 4, 'err': 2, 'errx': 2,
            'syscall': 6, 'getpid': 0, 'getuid': 0, 'geteuid': 0,
            'open64': 3, 'fopen64': 2, 'freopen': 3, 'fclose': 1,
            'fread': 4, 'fwrite': 4, 'fflush': 1, 'feof': 1,
            'fgets': 3, 'fseek': 3, 'ftell': 1, 'rewind': 1,
            'isatty': 1, 'fileno': 1, 'write': 3, 'read': 3,
            'close': 1, 'lseek64': 3, 'fstat64': 2, 'stat64': 2,
            'access': 2, 'unlink': 1, 'rename': 2, 'remove': 1,
            'creat': 2, 'link': 2, 'symlink': 2, 'readlink': 3,
            'chmod': 2, 'utimes': 2, 'truncate': 2, 'statfs': 2,
            'mkdir': 2, 'rmdir': 1, 'opendir': 1, 'readdir': 1,
            'closedir': 1, 'realpath': 2, 'getcwd': 2, 'chdir': 1,
        }
        # (registrados en HOOK_TABLE_NAMES antes de eh.Emu(): el emulador
        #  base crea sus trampolines automáticamente para estos nombres)
        for _nm, _k in _ZLIB.items():
            if _nm not in eh.HOOK_TABLE_NAMES:   # no pisar mapeos base
                eh.HOOK_TABLE_NAMES[_nm] = _nm
            eh.Emu.NARGS.setdefault(_nm, _k)
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

        self.jiagu_segs = []
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
            self.jiagu_segs.append((p0, size))
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

        # escrituras en el módulo 360 (para ver su autodescifrado)
        self.mod_pages = set()

        def on_mod_write(uc, access, address, size, value, ud):
            pg = (address - MBASE) >> 12
            if pg not in self.mod_pages:
                self.mod_pages.add(pg)
                pc = uc.reg_read(0x200)
                log(f'    [1ª escritura módulo pág {hex(pg << 12)} '
                    f'desde PC={hex(pc)} (off {hex(pc - MBASE)})]')

        uc.hook_add(UC_HOOK_MEM_WRITE, on_mod_write,
                    begin=MBASE, end=MBASE + MSIZE)

        # ---- volcado del RC4 (0x64bc): entradas + S-box + salida ----
        self.rc4_calls = []

        def on_rc4(uc, address, size, ud):
            off = address - JBASE
            if off == RC4_OFF:
                x0 = uc.reg_read(UC_ARM64_REG_X0)
                x1 = uc.reg_read(UC_ARM64_REG_X1)
                x2 = uc.reg_read(UC_ARM64_REG_X2)
                info = {'buf': x0, 'len': x1, 'state': x2}
                self.rc4_calls.append(info)
                log(f'\n[RC4] llamada #{len(self.rc4_calls)}: buf={hex(x0)} '
                    f'len={x1} ({hex(x1)}) estado={hex(x2)}')
                if 0 < x1 <= 8 << 20:
                    info['entrada'] = bytes(uc.mem_read(x0, x1))
                try:
                    info['sbox'] = bytes(uc.mem_read(x2, 0x100))
                    info['i0'] = uc.mem_read(x2 + 0x100, 1)[0]
                    info['j0'] = uc.mem_read(x2 + 0x101, 1)[0]
                    log(f'[RC4]   S-box capturado (i0={info["i0"]} '
                        f'j0={info["j0"]}): {info["sbox"][:24].hex()}…')
                    d = os.path.dirname(os.path.abspath(__file__))
                    p = os.path.join(d, f'rc4_sbox_{len(self.rc4_calls)}.bin')
                    open(p, 'wb').write(info['sbox'])
                    log(f'[RC4]   → {p}')
                except Exception as e:
                    log(f'[RC4]   no pude leer el estado: {e}')
            elif off == RC4_RET and self.rc4_calls:
                info = self.rc4_calls[-1]
                if info.get('salida') is None and info.get('len'):
                    try:
                        info['salida'] = bytes(uc.mem_read(info['buf'],
                                                           info['len']))
                        d = os.path.dirname(os.path.abspath(__file__))
                        p = os.path.join(
                            d, f'rc4_out_{len(self.rc4_calls)}.bin')
                        open(p, 'wb').write(info['salida'])
                        log(f'[RC4]   salida {len(info["salida"])} B → {p} '
                            f'(cabeza {info["salida"][:8].hex()})')
                    except Exception as e:
                        log(f'[RC4]   no pude leer la salida: {e}')

        uc.hook_add(UC_HOOK_BLOCK, on_rc4, begin=JBASE, end=JBASE + 0x100000)

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
    ap.add_argument('--natives', action='store_true')
    ap.add_argument('--nargs', type=int, default=12)
    args = ap.parse_args()

    ge = JiaguEmu()
    if args.load or (not args.run and not args.modinit and not args.exports_j
                    and not args.server_directo and not args.natives):
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
    if args.natives:
        ge.r2_writes = []
        ge.jni_onload(budget=args.budget * 1_000_000)
        log(f'\n== llamando natives registrados ({len(ge.emu.jni_natives)}) ==')
        cls = ge.emu._jni_ref(('class', 'com/stub/StubApp'))
        for cname, nm_, sig, fn in ge.emu.jni_natives:
            for i in range(args.nargs):
                n0 = len(ge.r2_writes)
                r2b = ge.r2_hit
                log(f'\n---- {nm_}({i}) fn={hex(fn)} ----')
                try:
                    r = ge.emu.call(fn, (ge.emu.jni_env, cls, i),
                                    budget=30_000_000, label=f'{nm_}({i})')
                    info = ge.emu.jni_strings.get(r)
                    if info:
                        log(f'  → {nm_}({i}) = {hex(r)} {info!r}')
                    else:
                        log(f'  → {nm_}({i}) = {hex(r)}')
                except RuntimeError as e:
                    log(f'  fin: {e}')
                except UcError as e:
                    log(f'  UcError: {e}')
                nw = len(ge.r2_writes) - n0
                if nw or ge.r2_hit != r2b:
                    log(f'  **** {nm_}({i}): {nw} escrituras r2, '
                        f'hit={hex(ge.r2_hit) if ge.r2_hit else None} ****')
                    ge.dump_r2()
        peek_and_dump(ge)
        log(f'\n== JNI ==\nnatives={ge.emu.jni_natives}')
        log(f'\n== red ==\n{ge.sock_names}')
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
