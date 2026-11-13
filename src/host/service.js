import { createSshPool, readHosts, saveHost } from './ssh.js'

const MAX_PREVIEW = 1024 * 1024
const MAX_TRANSFER = 32 * 1024 * 1024
const PY = String.raw`
import base64, datetime, getpass, json, os, re, shlex, shutil, subprocess, sys, time, threading
from concurrent.futures import ThreadPoolExecutor

def run(args, timeout=12, data=None):
    try:
        p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout, check=False)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:
        return 127, '', str(e)

def path(value):
    value = os.path.expanduser(str(value or '~'))
    if not os.path.isabs(value) or '\\0' in value or any(x == '..' for x in value.split('/')):
        raise ValueError('路径必须是绝对路径，且不能包含 ..')
    return os.path.normpath(value)

def elapsed(value):
    # ps etime: [[dd-]hh:]mm:ss
    try:
        days, rest = (value.split('-', 1) if '-' in value else ('0', value))
        parts = [int(x) for x in rest.split(':')]
        if len(parts) == 3: h, m, s = parts
        elif len(parts) == 2: h, (m, s) = 0, parts
        else: return 0
        return int(days) * 86400 + h * 3600 + m * 60 + s
    except Exception: return 0

def snapshot():
    ident = getpass.getuser()
    hostname = os.uname().nodename
    cpu = None; cpu_percent = 0
    try:
        with open('/proc/stat') as f: first_cpu = [int(x) for x in f.readline().split()[1:]]
        time.sleep(0.2)
        with open('/proc/stat') as f: cpu = [int(x) for x in f.readline().split()[1:]]
        total_delta = sum(cpu) - sum(first_cpu)
        idle_delta = cpu[3] + (cpu[4] if len(cpu) > 4 else 0) - first_cpu[3] - (first_cpu[4] if len(first_cpu) > 4 else 0)
        if total_delta > 0: cpu_percent = round((1 - idle_delta / total_delta) * 100)
    except Exception: pass
    mem = {}
    try:
        for line in open('/proc/meminfo'):
            k, v = line.split(':', 1); mem[k] = int(v.strip().split()[0]) * 1024
    except Exception: pass
    net = {}
    try:
        for line in open('/proc/net/dev').read().splitlines()[2:]:
            name, vals = line.split(':', 1); values = [int(x) for x in vals.split()]
            if name.strip() != 'lo': net[name.strip()] = {'rx': values[0], 'tx': values[8]}
    except Exception: pass
    disks = {}
    try:
        for line in open('/proc/diskstats'):
            v = line.split()
            if len(v) >= 14 and not re.match(r'^(loop|ram|fd|sr)', v[2]) and not os.path.exists('/sys/dev/block/'+v[0]+':'+v[1]+'/partition'): disks[v[2]] = {'read': int(v[5]) * 512, 'write': int(v[9]) * 512}
    except Exception: pass
    filesystems = []
    try:
        for line in open('/proc/mounts'):
            cols = line.split()
            if cols[2] not in ('ext4','xfs','btrfs','zfs') or cols[1].startswith(('/proc','/sys','/dev')): continue
            try:
                stat = os.statvfs(cols[1]); total = stat.f_blocks * stat.f_frsize; free = stat.f_bavail * stat.f_frsize
                if total: filesystems.append({'mount': cols[1], 'used': total-free, 'total': total})
            except Exception: pass
    except Exception: pass
    gpus = []
    rc, out, err = run(['nvidia-smi', '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw,power.limit,temperature.gpu', '--format=csv,noheader,nounits'], timeout=5)
    if rc == 0:
        for line in out.splitlines():
            v = [x.strip() for x in line.split(',', 7)]
            if len(v) != 8: continue
            def num(x):
                try: return float(x)
                except Exception: return None
            gpus.append({'id': int(v[0]), 'model': v[1], 'util': num(v[2]), 'used': num(v[3]), 'total': num(v[4]), 'power': num(v[5]), 'powerLimit': num(v[6]), 'temp': num(v[7])})
    slurm = bool(shutil.which('squeue') and shutil.which('sbatch') and shutil.which('scancel'))
    return {'identity': ident, 'hostname': hostname, 'home': os.path.expanduser('~'), 'os': os.uname().sysname, 'release': os.uname().release, 'cores': os.cpu_count() or 1,
      'loadAverage': ' / '.join('%.2f' % x for x in os.getloadavg()) if hasattr(os, 'getloadavg') else '',
      'cpuTicks': cpu, 'cpuPercent': cpu_percent, 'memory': {'total': mem.get('MemTotal', 0), 'available': mem.get('MemAvailable', 0), 'swapTotal': mem.get('SwapTotal', 0), 'swapFree': mem.get('SwapFree', 0)},
      'network': net, 'disks': disks, 'filesystems': filesystems, 'gpus': gpus, 'slurm': slurm}

def process_list():
    rc, out, err = run(['ps', '-eo', 'pid=,user=,pcpu=,rss=,etime=,args='], timeout=10)
    if rc: raise RuntimeError(err or '无法读取进程列表')
    result = []
    for line in out.splitlines():
        v = line.strip().split(None, 5)
        if len(v) < 6: continue
        try:
            result.append({'pid': int(v[0]), 'user': v[1], 'cpu': float(v[2]), 'rss': int(v[3]) / 1024 / 1024, 'runtime': elapsed(v[4]), 'command': v[5][:1000], 'gpuMemory': 0, 'gpuIds': '—'})
        except Exception: pass
    rc, out, err = run(['nvidia-smi', '--query-compute-apps=pid,used_memory,gpu_uuid', '--format=csv,noheader,nounits'], timeout=5)
    gpu_by_uuid = {}
    if rc == 0:
        rc2, ids, err2 = run(['nvidia-smi', '--query-gpu=index,uuid', '--format=csv,noheader'], timeout=5)
        if rc2 == 0:
            for line in ids.splitlines():
                values = [x.strip() for x in line.split(',', 1)]
                if len(values) == 2: gpu_by_uuid[values[1]] = values[0]
        by_pid = {row['pid']: row for row in result}
        for line in out.splitlines():
            values = [x.strip() for x in line.split(',', 2)]
            if len(values) != 3: continue
            try:
                row = by_pid.get(int(values[0]))
                if row:
                    row['gpuMemory'] += float(values[1]) / 1024
                    gpu_id = gpu_by_uuid.get(values[2])
                    if gpu_id is not None: row['gpuIds'] = ('GPU '+gpu_id) if row['gpuIds'] == '—' else row['gpuIds']+', GPU '+gpu_id
            except Exception: pass
    return result[:3000]

def jobs(scope):
    fmt = '%i|%j|%T|%P|%D|%b|%M|%R|%u'
    args = ['squeue', '--noheader', '--format=' + fmt]
    if scope == 'mine': args += ['--user', getpass.getuser()]
    rc, out, err = run(args, timeout=12)
    if rc: raise RuntimeError(err.strip() or 'squeue 查询失败')
    rows = []
    for line in out.splitlines():
        v = line.split('|', 8)
        if len(v) != 9: continue
        gres = v[5].lower(); match = re.search(r'gpu(?::(?:[^:,()]+:)?(\d+))?', gres)
        rows.append({'id': v[0], 'name': v[1], 'state': v[2], 'part': v[3], 'nodes': int(v[4]) if v[4].isdigit() else 0,
          'gpu': int(match.group(1) or 1) if match else 0, 'time': v[6], 'reason': v[7], 'user': v[8]})
    return rows

def partitions():
    rc, out, err = run(['sinfo', '--noheader', '--format=%P|%D|%C|%G|%a|%l|%N'], timeout=12)
    if rc: raise RuntimeError(err.strip() or 'sinfo 查询失败')
    rows=[]
    for line in out.splitlines():
        v=line.split('|',6)
        if len(v)!=7: continue
        cpus=v[2].split('/')
        rows.append({'name':v[0].rstrip('*'),'nodes':v[1],'cpus':cpus[0] if cpus else '', 'gres':v[3], 'availability':v[4], 'timeLimit':v[5], 'nodeList':v[6]})
    return rows

def dispatch(payload):
    action = payload.get('action')
    if action == 'ping': return {'home': os.path.expanduser('~'), 'identity': getpass.getuser()}
    if action == 'snapshot': return snapshot()
    if action == 'processes': return process_list()
    if action == 'files':
        folder = path(payload.get('path'))
        result = []
        with os.scandir(folder) as it:
            for item in it:
                if len(result) >= 5000: break
                try:
                    st = item.stat(follow_symlinks=False)
                    result.append({'name': item.name, 'dir': item.is_dir(follow_symlinks=False), 'sizeBytes': st.st_size, 'modifiedAt': st.st_mtime, 'mode': st.st_mode})
                except OSError: pass
        return {'path': folder, 'home': os.path.expanduser('~'), 'identity': getpass.getuser(), 'entries': sorted(result, key=lambda x: (not x['dir'], x['name'].lower()))}
    if action == 'read':
        filename = path(payload.get('path')); size = os.path.getsize(filename)
        if size > int(payload.get('maxBytes', 1048576)): raise ValueError('文件超过预览大小限制')
        with open(filename, 'rb') as f: data = f.read(int(payload.get('maxBytes', 1048576)) + 1)
        try: text = data.decode('utf-8')
        except UnicodeDecodeError: raise ValueError('该文件不是 UTF-8 文本，无法在预览页显示')
        return {'text': text, 'sizeBytes': size}
    if action in ('mkdir','touch','rename','delete','write','download'):
        target = path(payload.get('path'))
        if action == 'mkdir': os.mkdir(target); return {'ok': True}
        if action == 'touch':
            fd = os.open(target, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o644); os.close(fd); return {'ok': True}
        if action == 'rename':
            dest = path(payload.get('to'))
            if os.path.dirname(target) != os.path.dirname(dest): raise ValueError('重命名不能移动到其他目录')
            if os.path.exists(dest): raise ValueError('目标名称已存在')
            os.rename(target, dest); return {'ok': True}
        if action == 'delete':
            if os.path.isdir(target) and not os.path.islink(target): os.rmdir(target)
            else: os.unlink(target)
            return {'ok': True}
        if action == 'write':
            data = base64.b64decode(payload.get('base64',''), validate=True)
            if len(data) > 33554432: raise ValueError('单文件上限为 32 MiB')
            if os.path.exists(target): raise ValueError('目标文件已存在')
            with open(target, 'xb') as f: f.write(data)
            return {'ok': True, 'sizeBytes': len(data)}
        if action == 'download':
            size = os.path.getsize(target)
            if size > 33554432: raise ValueError('单文件上限为 32 MiB')
            with open(target, 'rb') as f: data = f.read(33554433)
            return {'name': os.path.basename(target), 'base64': base64.b64encode(data).decode(), 'sizeBytes': size}
    if action == 'jobs': return jobs(payload.get('scope', 'mine'))
    if action == 'partitions': return partitions()
    if action == 'job':
        job_id = str(payload.get('id',''))
        if not re.fullmatch(r'\d+(?:_\d+)?', job_id): raise ValueError('作业 ID 无效')
        rc, out, err = run(['scontrol', 'show', 'job', '-o', job_id], timeout=10)
        if rc: raise RuntimeError(err.strip() or '作业详情读取失败')
        return dict(re.findall(r'([A-Za-z][A-Za-z0-9_]*)=([^ ]*)', out))
    if action == 'cancel':
        jid = str(payload.get('id',''))
        if not re.fullmatch(r'\d+(?:_\d+)?', jid): raise ValueError('作业 ID 无效')
        rc, out, err = run(['scancel', jid], timeout=10)
        if rc: raise RuntimeError(err.strip() or '取消作业失败')
        return {'accepted': True, 'id': jid}
    if action == 'submit':
        form = payload.get('job') or {}
        name = str(form.get('name',''))
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', name): raise ValueError('作业名称格式无效')
        wd = path(form.get('workdir'))
        command = str(form.get('command','')).strip()
        if not command or len(command) > 10000: raise ValueError('运行命令不能为空且不能超过 10000 字符')
        def posint(k, default, maximum):
            n = int(form.get(k, default));
            if n < 1 or n > maximum: raise ValueError(k + ' 超出允许范围')
            return n
        workers=posint('workers',1,1024); cpu=posint('cpu',1,4096); memory=posint('memory',1,1048576); gpu=int(form.get('gpu',0))
        if gpu < 0 or gpu > 64: raise ValueError('GPU 数量无效')
        partition=str(form.get('part','')).strip()
        if partition and not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', partition): raise ValueError('分区名称无效')
        time_limit=str(form.get('time','01:00:00')).strip()
        if not re.fullmatch(r'(?:\d+-)?\d{1,3}:\d{2}:\d{2}', time_limit): raise ValueError('时限格式无效')
        script=['#!/bin/bash', '#SBATCH --job-name='+name, '#SBATCH --nodes=2', '#SBATCH --ntasks='+str(workers), '#SBATCH --cpus-per-task='+str(cpu), '#SBATCH --mem='+str(memory*2)+'G', '#SBATCH --time='+time_limit]
        if partition: script.append('#SBATCH --partition='+partition)
        if gpu: script.append('#SBATCH --gpus-per-task='+str(gpu))
        log_path=str(form.get('logPath','slurm-%j.out')).strip()
        if not log_path or len(log_path)>1024 or '\n' in log_path or '\r' in log_path: raise ValueError('日志路径无效')
        script.append('#SBATCH --output='+log_path)
        for key, flag in (('account','account'),('qos','qos')):
            val=str(form.get(key,'')).strip()
            if val:
                if not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', val): raise ValueError(key+' 格式无效')
                script.append('#SBATCH --'+flag+'='+val)
        env_text=str(form.get('environment',''))
        for line in env_text.splitlines():
            if not line.strip(): continue
            if '=' not in line: raise ValueError('环境变量须使用 NAME=value 格式')
            env_name, env_value = line.split('=',1)
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', env_name) or '\0' in env_value: raise ValueError('环境变量名称或值无效')
            script.append('export '+env_name+'='+shlex.quote(env_value))
        launch = command if command.startswith('srun ') else 'srun '+command
        script += ['', 'set -e', 'cd '+shlex.quote(wd), launch, '']
        rc, out, err = run(['sbatch'], timeout=15, data='\n'.join(script))
        if rc: raise RuntimeError(err.strip() or 'sbatch 提交失败')
        match = re.search(r'(\d+)', out)
        if not match: raise RuntimeError('sbatch 已返回，但无法解析作业 ID：'+out[:200])
        return {'id': match.group(1), 'output': out.strip()}
    raise ValueError('不支持的远程操作')

output_lock = threading.Lock()
def handle(request):
    request_id = request.get('id')
    try:
        response = {'id': request_id, 'ok': True, 'value': dispatch(request)}
    except Exception as exc:
        response = {'id': request_id, 'ok': False, 'error': str(exc)[:500]}
    with output_lock:
        print(json.dumps(response, ensure_ascii=False), flush=True)

with ThreadPoolExecutor(max_workers=4) as executor:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            executor.submit(handle, request)
        except Exception:
            break

`

export function createRemoteHostService() {
  const samples = new Map()
  const pool = createSshPool(PY)
  async function remote(alias, action, payload = {}, timeout) {
    return pool.request(alias, { action, ...payload }, timeout || 25000)
  }
  return {
    dispose() { pool.dispose() },
    async call(op, payload) {
      if (op === 'hosts.list') return readHosts()
      if (op === 'hosts.save') return saveHost(payload)
      const alias = String(payload.host || '')
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) throw new Error('请选择有效的 SSH 配置项')
      const configured = await readHosts()
      if (!configured.some((host) => host.id.toLowerCase() === alias.toLowerCase())) throw new Error('该服务器不在本机 SSH 配置中')
      if (op === 'hosts.connect') return remote(alias, 'ping', {}, 15000)
      if (op === 'hosts.probe') {
        const snap = await remote(alias, 'snapshot', {}, 15000)
        const old = samples.get(alias)
        const derived = derive(snap, old, alias)
        samples.set(alias, { raw: snap, at: Date.now() })
        return derived
      }
      if (op === 'monitor.snapshot') {
        const snap = await remote(alias, 'snapshot', {}, 15000)
        const result = derive(snap, samples.get(alias), alias)
        samples.set(alias, { raw: snap, at: Date.now() })
        return result
      }
      if (op === 'processes.list') return remote(alias, 'processes')
      if (op === 'files.list') return remote(alias, 'files', { path: payload.path })
      if (op === 'files.read') return remote(alias, 'read', { path: payload.path, maxBytes: MAX_PREVIEW })
      if (op === 'files.create') return remote(alias, payload.type === 'dir' ? 'mkdir' : 'touch', { path: payload.path })
      if (op === 'files.rename') return remote(alias, 'rename', { path: payload.path, to: payload.to })
      if (op === 'files.delete') return remote(alias, 'delete', { path: payload.path })
      if (op === 'files.upload') {
        if (typeof payload.base64 !== 'string' || payload.base64.length > Math.ceil(MAX_TRANSFER * 4 / 3) + 8) throw new Error('单文件上限为 32 MiB')
        return remote(alias, 'write', { path: payload.path, base64: payload.base64 })
      }
      if (op === 'files.download') return remote(alias, 'download', { path: payload.path })
      if (op === 'slurm.jobs') return remote(alias, 'jobs', { scope: payload.scope })
      if (op === 'slurm.partitions') return remote(alias, 'partitions')
      if (op === 'slurm.job') return remote(alias, 'job', { id: payload.id })
      if (op === 'slurm.cancel') return remote(alias, 'cancel', { id: payload.id })
      if (op === 'slurm.submit') return remote(alias, 'submit', { job: payload.job }, 30000)
      throw new Error('未知的操作类型')
    },
  }
}

function derive(snap, previous, alias = snap.hostname) {
  const now = Date.now()
  const old = previous?.raw
  let cpu = snap.cpuPercent || 0
  if (snap.cpuTicks && old?.cpuTicks) {
    const a = old.cpuTicks, b = snap.cpuTicks
    const totalA = a.reduce((x,y)=>x+y,0), totalB = b.reduce((x,y)=>x+y,0)
    const idleA = a[3] + (a[4] || 0), idleB = b[3] + (b[4] || 0)
    if (totalB > totalA) cpu = Math.round((1 - (idleB-idleA)/(totalB-totalA))*100)
  }
  const total = snap.memory.total || 0, used = total - snap.memory.available
  const network = Object.entries(snap.network).map(([name, value]) => {
    const prior = old?.network?.[name]
    const seconds = previous ? Math.max(.1, (now-previous.at)/1000) : 0
    return { name, rx: prior && seconds ? Math.max(0,(value.rx-prior.rx)/seconds) : 0, tx: prior && seconds ? Math.max(0,(value.tx-prior.tx)/seconds) : 0 }
  })
  const disks = Object.entries(snap.disks).map(([name,value]) => {
    const prior=old?.disks?.[name], seconds=previous?Math.max(.1,(now-previous.at)/1000):0
    return {name,read:prior&&seconds?Math.max(0,(value.read-prior.read)/seconds):0,write:prior&&seconds?Math.max(0,(value.write-prior.write)/seconds):0}
  })
  return { id: alias, identity: snap.identity, sshUser: snap.identity, hostname: snap.hostname, home: snap.home, role: '', online: true, slurm: snap.slurm ? 'ready' : 'missing', os: snap.os+' '+snap.release, loadAverage: snap.loadAverage, cpu, mem: total ? Math.round(used/total*100) : 0, used: Math.round(used/1024/1024/1024), total: Math.round(total/1024/1024/1024), cores: snap.cores, swapTotal: Math.round((snap.memory.swapTotal||0)/1024/1024/1024), swapUsed: Math.round(((snap.memory.swapTotal||0)-(snap.memory.swapFree||0))/1024/1024/1024),
    gpus: snap.gpus.map(g=>({...g,util:g.util==null?0:Math.round(g.util),used:g.used==null?0:Math.round(g.used/1024),total:g.total==null?0:Math.round(g.total/1024),power:g.power==null?null:Math.round(g.power),powerLimit:g.powerLimit==null?null:Math.round(g.powerLimit),temp:g.temp==null?null:Math.round(g.temp)})),
    network, disks, filesystems: snap.filesystems.map(f=>({...f,used:Math.round(f.used/1024/1024),total:Math.round(f.total/1024/1024)})), sampledAt: now }
}
