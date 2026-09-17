#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Parche: añade un JNI de juguete y la fase JNI_OnLoad a emu_hls.py"""
import io, sys

p = 'emu_hls.py'
s = io.open(p, encoding='utf-8').read()

s = s.replace("CLOSURE_PAGE = 0x62000000",
              "CLOSURE_PAGE = 0x62000000\nJNI_PAGE   = 0x64000000")

s = s.replace("                           (CLOSURE_PAGE, 0x100000)):",
              "                           (CLOSURE_PAGE, 0x100000),\n                           (JNI_PAGE, 0x40000)):")

JNI_BLOCK = '''
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
        table = self.host._alloc(232 * 8)
        for i in range(232):
            a = JNI_PAGE + 0x1000 + i * 0x10
            self.JNI_SLOT_ADDR[a] = i
            uc.mem_write(a, b'\\xc0\\x03\\x5f\\xd6')
            uc.mem_write(table + i * 8, struct.pack('<Q', a))
        env = self.host._alloc(8)
        uc.mem_write(env, struct.pack('<Q', table))
        itab = self.host._alloc(7 * 8)
        for i in range(7):
            a = JNI_PAGE + 0x2000 + i * 0x10
            self.JNI_SLOT_ADDR[a] = ('vm', i)
            uc.mem_write(a, b'\\xc0\\x03\\x5f\\xd6')
            uc.mem_write(itab + i * 8, struct.pack('<Q', a))
        vm = self.host._alloc(8)
        uc.mem_write(vm, struct.pack('<Q', itab))
        self.jni_env = env
        self.java_vm = vm
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
                log(f'    [JNI GetEnv -> env {hex(self.jni_env)}]')
            else:
                log(f'    [JNI vm slot {slot[1]} -> 0]')
        else:
            nm = self.JNI_NAMES.get(slot, f'slot{slot}')
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
            elif nm == 'ExceptionCheck':
                r = 0
            else:
                log(f'    [JNI {nm} args={tuple(hex(x) for x in a[1:5])} -> 0]')
        uc.reg_write(UC_ARM64_REG_X0, r & 0xFFFFFFFFFFFFFFFF)
        uc.reg_write(UC_ARM64_REG_PC, lr)

    def _jni_ret_object(self, mname, a):
        """Respuestas m\u00ednimas a getters de Java que el sign pueda usar."""
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

    def _do_call(self, addr):'''

s = s.replace("    def _do_call(self, addr):", JNI_BLOCK, 1)

s = s.replace("        uc.hook_add(UC_HOOK_BLOCK, on_closure, begin=CLOSURE_PAGE, end=CLOSURE_PAGE + 0x100000)",
              "        uc.hook_add(UC_HOOK_BLOCK, on_closure, begin=CLOSURE_PAGE, end=CLOSURE_PAGE + 0x100000)\n"
              "\n        def on_jni(uc, address, size, ud):\n"
              "            if address in self.JNI_SLOT_ADDR:\n"
              "                self._do_jni(address)\n"
              "\n        uc.hook_add(UC_HOOK_BLOCK, on_jni, begin=JNI_PAGE, end=JNI_PAGE + 0x40000)")

FASE2 = '''    # ---------- FASE 2: JNI_OnLoad ----------
    jni_onload = 0xe7c34
    log(f'\\n== llamando JNI_OnLoad ({hex(jni_onload)}) con JavaVM de juguete ==')
    vm = emu._build_jni()
    try:
        rv = emu.call(BASE + jni_onload, (vm,), budget=400_000_000, label='JNI_OnLoad')
        log(f'JNI_OnLoad devolvio {hex(rv)} (JNI_VERSION_1_6 = 0x10006)')
    except Exception as ex:
        log(f'JNI_OnLoad aborto: {ex}')
    log(f'\\n== metodos nativos registrados: {len(emu.jni_natives)} ==')
    for c, nm2, sg, fn in emu.jni_natives:
        off = f'lib+{hex(fn - BASE)}' if BASE <= fn < BASE + 0x200000 else hex(fn)
        log(f'  {c}.{nm2}{sg} -> {off}')
    with open(os.path.join(HERE, 'jni_natives.txt'), 'w') as f:
        for c, nm2, sg, fn in emu.jni_natives:
            off = fn - BASE if BASE <= fn < BASE + 0x200000 else 0
            f.write(f'{c}\\t{nm2}\\t{sg}\\t{hex(off)}\\n')

    from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN'''

s = s.replace("    from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN", FASE2, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('parche JNI aplicado')
