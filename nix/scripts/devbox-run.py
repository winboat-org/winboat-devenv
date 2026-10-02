"""Nix-owned container entry point. Persistent state belongs to one devbox."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def save(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2) + '\n')
    os.replace(temp, path)


state = Path('/state')
settings = json.loads((state / 'launch.json').read_text())
stack = Path(os.environ['WB_STACK'])
children = []


def stop(signum, frame):
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
for directory in ['tpm', 'samba', 'samba/private', 'samba/lock', 'samba/cache']:
    (state / directory).mkdir(parents=True, exist_ok=True)

# The workspace is read-only in both the container mount and SMB configuration.
# Authenticated SMB avoids enabling insecure guest logons in Windows.
config = state / 'samba/smb.conf'
config.write_text('''[global]
  server role = standalone server
  security = user
  map to guest = Never
  smb ports = 445
  server min protocol = SMB2
  private dir = /state/samba/private
  lock directory = /state/samba/lock
  state directory = /state/samba
  cache directory = /state/samba/cache
  log file = /state/samba/log.%m
  load printers = no
  disable spoolss = yes
  printing = bsd
[workspace]
  path = /workspace
  read only = yes
  valid users = wbdev
  follow symlinks = no
  wide links = no
  veto files = /.state/.git/.devenv*/.direnv/.codex/.agents/.aws/.claude/out/build/node_modules/local*.json/.env*/*.key/*.pfx/*.p12/*.iso/*.qcow2/*.vhd*/
  delete veto files = no
''')
password = (state / 'secrets/password').read_text().strip()
subprocess.run([os.environ['WB_SMBPASSWD'], '-s', '-a', 'wbdev', '-c', str(config)],
               input=password + '\n' + password + '\n', text=True, check=True)
children.append(subprocess.Popen([os.environ['WB_SMBD'], '--foreground', '--no-process-group',
                                 '--configfile=' + str(config)]))
tpm_socket = state / 'tpm.sock'
tpm_socket.unlink(missing_ok=True)
children.append(subprocess.Popen([os.environ['WB_SWTPM'], 'socket', '--tpm2',
                                 '--tpmstate', 'dir=/state/tpm', '--ctrl',
                                 'type=unixio,path=/state/tpm.sock', '--flags', 'not-need-init']))
for _ in range(100):
    if tpm_socket.exists():
        break
    time.sleep(0.05)
else:
    raise RuntimeError('TPM emulator did not start')

qmp = state / 'qmp.sock'
qmp.unlink(missing_ok=True)
firmware = stack / 'share/qemu'
nvram = state / 'nvram.fd'
if not nvram.exists():
    raise RuntimeError('NVRAM must be initialized by wb devbox create')
qemu = stack / 'bin/qemu-system-x86_64'
command = [str(qemu), '-name', 'WB-DEVBOX', '-machine', 'q35,accel=kvm,smm=on',
           '-cpu', 'host', '-smp', str(settings['cpus']), '-m', str(settings['memoryMiB']),
           '-L', str(firmware), '-nodefaults', '-no-user-config',
           '-drive', 'if=pflash,format=raw,readonly=on,file=' + str(firmware / 'edk2-x86_64-secure-code.fd'),
           '-drive', 'if=pflash,format=raw,file=/state/nvram.fd',
           '-drive', 'if=none,id=os,format=qcow2,file=/state/disk.qcow2',
           '-device', 'ich9-ahci,id=ahci', '-device', 'ide-hd,drive=os,bus=ahci.0',
           '-chardev', 'socket,id=tpm,path=/state/tpm.sock', '-tpmdev', 'emulator,id=tpm,chardev=tpm',
           '-device', 'tpm-tis,tpmdev=tpm', '-device', 'virtio-vga-gl',
           '-display', 'egl-headless,rendernode=' + settings['renderNode'],
           '-vnc', '0.0.0.0:0', '-qmp', 'unix:/state/qmp.sock,server=on,wait=off',
           '-device', 'qemu-xhci', '-device', 'usb-tablet',
           '-netdev', 'user,id=net,hostfwd=tcp::22-:22', '-device', 'e1000e,netdev=net',
           '-serial', 'file:/state/serial.log', '-monitor', 'none',
           '-boot', 'order=c,menu=off' + (',once=d' if settings['initialBoot'] else '')]
if settings['attachMedia']:
    command += ['-drive', 'if=none,id=iso,media=cdrom,readonly=on,file=/media/windows.iso',
                '-device', 'ide-cd,drive=iso,bus=ahci.1',
                '-drive', 'if=none,id=answer,media=cdrom,readonly=on,file=/state/answer.iso',
                '-device', 'ide-cd,drive=answer,bus=ahci.2']
environment = dict(os.environ, QEMU_MODULE_DIR=str(stack / 'lib/qemu'))
environment.setdefault('LIBGL_DRIVERS_PATH', os.environ['WB_MESA'] + '/lib/dri')
environment.setdefault('GBM_BACKENDS_PATH', os.environ['WB_MESA'] + '/lib/gbm')
environment.setdefault('__EGL_VENDOR_LIBRARY_FILENAMES', ':'.join(str(path) for path in Path(os.environ['WB_MESA']).glob('share/glvnd/egl_vendor.d/*.json')))
environment.setdefault('VK_DRIVER_FILES', ':'.join(str(path) for path in Path(os.environ['WB_MESA']).glob('share/vulkan/icd.d/*.json')))
with (state / 'qemu.log').open('a') as log:
    vm = subprocess.Popen(command, env=environment, stdout=log, stderr=log)
    children.append(vm)
    identity = {'schemaVersion': 1, 'state': 'starting', 'pid': vm.pid,
                'command': command, 'hostStack': str(stack), 'loaded': False}
    try:
        for _ in range(200):
            if vm.poll() is not None:
                raise RuntimeError('QEMU exited: inspect qemu.log')
            if qmp.exists():
                with socket.socket(socket.AF_UNIX) as client:
                    client.connect(str(qmp))
                    stream = client.makefile('rwb')
                    json.loads(stream.readline())
                    stream.write(b'{"execute":"qmp_capabilities"}\n'); stream.flush()
                    while 'return' not in json.loads(stream.readline()):
                        pass
                    stream.write(b'{"execute":"query-status"}\n'); stream.flush()
                    while True:
                        response = json.loads(stream.readline())
                        if 'return' in response:
                            identity['qmp'] = response['return']
                            break
                    stream.close()
                # Only the initial installation boot receives keys. Later starts
                # boot the persistent disk and cannot replay an unattended wipe.
                if settings['initialBoot']:
                    with socket.socket(socket.AF_UNIX) as client:
                        client.connect(str(qmp))
                        stream = client.makefile('rwb')
                        stream.readline()
                        stream.write(b'{"execute":"qmp_capabilities"}\n'); stream.flush()
                        while 'return' not in json.loads(stream.readline()):
                            pass
                        for _ in range(12):
                            request = {'execute': 'send-key', 'arguments': {'keys': [{'type': 'qcode', 'data': 'spc'}]}}
                            stream.write(json.dumps(request).encode() + b'\n'); stream.flush()
                            while True:
                                response = json.loads(stream.readline())
                                if 'return' in response:
                                    break
                                if 'error' in response:
                                    raise RuntimeError('Initial boot key delivery failed: ' + str(response))
                            time.sleep(0.5)
                        stream.close()
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('QMP did not become ready')
        executable = Path('/proc') / str(vm.pid) / 'exe'
        mapped = sorted({line.split()[-1] for line in (Path('/proc') / str(vm.pid) / 'maps').read_text().splitlines()
                         if len(line.split()) >= 6 and line.split()[-1].startswith('/nix/store/')})
        selected = [path for path in mapped if 'libvirglrenderer' in path or '/lib/qemu/' in path]
        if not any('libvirglrenderer' in path for path in selected):
            raise RuntimeError('QEMU has not loaded the selected renderer')
        if not any('virtio-vga-gl' in path for path in selected):
            raise RuntimeError('QEMU has not loaded its virtio-vga-gl module')
        # Allowed images are independently selected in the host artifact manifest.
        expected = settings['expectedImages']
        images = [{'path': os.readlink(executable), 'sha256': sha(executable)}]
        images += [{'path': path, 'sha256': sha(path)} for path in selected]
        if any(expected.get(item['path']) != item['sha256'] for item in images):
            raise RuntimeError('Loaded executable/renderer/modules differ from the artifact manifest')
        identity.update(state='running', loaded=True, images=images)
        save(state / 'host-observation.json', identity)
        code = vm.wait()
        identity.update(state='stopped', exitCode=code, loaded=False)
    except Exception as error:
        identity.update(state='failed', error=str(error), loaded=False)
        code = 1
    finally:
        save(state / 'host-observation.json', identity)
        stop(None, None)
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
    raise SystemExit(code)
