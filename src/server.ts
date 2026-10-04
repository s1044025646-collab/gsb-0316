import * as http from 'node:http';
import * as path from 'node:path';
import { HeapService } from './store.ts';
import { GcError } from './errors.ts';

const DATA_DIR = process.env.GC_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.GC_DB ?? path.join(DATA_DIR, 'heap.db');

function parsePort(): number {
  const idx = process.argv.indexOf('--port');
  if (idx >= 0) {
    const p = Number(process.argv[idx + 1]);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      console.error('--port 必须是 0-65535 的整数（0 表示自动选择空闲端口）');
      process.exit(2);
    }
    return p;
  }
  return 0; // 默认自动选择空闲端口
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new GcError('INVALID_PARAM', '请求体不是合法 JSON', 400); }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function createServer(svc: HeapService) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      const route = `${req.method} /${parts.join('/')}`;

      if (route === 'POST /heap') {
        send(res, 200, svc.initHeap(body.capacity, { force: body.force === true }));
      } else if (route === 'GET /heap') {
        send(res, 200, svc.snapshot());
      } else if (route === 'POST /objects') {
        send(res, 200, svc.allocObject(body.id, body.payload, body.refs ?? []));
      } else if (parts[0] === 'objects' && parts.length === 2 && req.method === 'GET') {
        send(res, 200, svc.getObject(Number(parts[1])));
      } else if (route === 'GET /objects') {
        send(res, 200, svc.listObjects());
      } else if (parts[0] === 'objects' && parts[2] === 'refs' && req.method === 'PUT') {
        send(res, 200, svc.setRefs(Number(parts[1]), body.refs));
      } else if (parts[0] === 'roots' && parts.length === 2 && req.method === 'PUT') {
        send(res, 200, svc.setRoot(decodeURIComponent(parts[1]), body.target ?? null));
      } else if (parts[0] === 'roots' && parts.length === 2 && req.method === 'DELETE') {
        send(res, 200, svc.removeRoot(decodeURIComponent(parts[1])));
      } else if (route === 'POST /gc') {
        send(res, 200, svc.collect());
      } else if (route === 'GET /gc/reports') {
        send(res, 200, svc.listReports());
      } else if (parts[0] === 'gc' && parts[1] === 'reports' && parts.length === 3 && req.method === 'GET') {
        send(res, 200, svc.getReport(parts[2] === 'latest' ? undefined : Number(parts[2])));
      } else if (route === 'GET /snapshot') {
        send(res, 200, svc.snapshot());
      } else {
        send(res, 404, { error: { code: 'NOT_FOUND', message: `未知路由 ${route}` } });
      }
    } catch (e: any) {
      if (e instanceof GcError) {
        send(res, e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(res, 500, { error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
      }
    }
  });
}

import * as url from 'node:url';
if (process.argv[1] && url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const svc = new HeapService(DB_PATH);
  const server = createServer(svc);
  server.listen(parsePort(), () => {
    const addr = server.address() as any;
    console.log(`Cheney GC 模拟器已启动: http://127.0.0.1:${addr.port}  (数据目录: ${DATA_DIR})`);
  });
}



