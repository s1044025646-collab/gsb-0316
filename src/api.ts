import * as http from "node:http";
import * as net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { GcError } from "./errors";
import {
  allocObject,
  collectGarbage,
  getObject,
  getReport,
  initHeap,
  listReports,
  loadObjects,
  loadRoots,
  removeRoot,
  setRef,
  setRoot,
  snapshot,
  usedUnits,
  allocPtr,
  requireHeap,
} from "./heap";

const STATUS: Record<string, number> = {
  E_INVALID_ARG: 400,
  E_NOT_FOUND: 404,
  E_DANGLING_REF: 422,
  E_NO_SPACE: 507,
  E_LIMIT: 413,
  E_NO_HEAP: 409,
  E_INTERNAL: 500,
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GcError("E_INVALID_ARG", "请求体不是合法 JSON");
  }
}

export async function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(preferred, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname;
      const method = req.method || "GET";
      const body = (await readBody(req)) as Record<string, unknown>;

      if (method === "POST" && path === "/heap") {
        initHeap(db, Number(body.capacity));
        return send(200, { ok: true });
      }
      if (method === "POST" && path === "/objects") {
        const o = allocObject(db, Number(body.payload), (body.refs ?? []) as (number | null)[]);
        return send(201, o);
      }
      let m = path.match(/^\/objects\/(\d+)$/);
      if (method === "GET" && m) return send(200, getObject(db, Number(m[1])));
      m = path.match(/^\/objects\/(\d+)\/refs\/(\d+)$/);
      if (method === "PUT" && m) {
        const target = body.target === null || body.target === undefined ? null : Number(body.target);
        setRef(db, Number(m[1]), Number(m[2]), target);
        return send(200, { ok: true });
      }
      if (method === "GET" && path === "/objects") return send(200, loadObjects(db));
      m = path.match(/^\/roots\/([^/]+)$/);
      if (method === "PUT" && m) {
        const target = body.target === null || body.target === undefined ? null : Number(body.target);
        setRoot(db, decodeURIComponent(m[1]), target);
        return send(200, { ok: true });
      }
      if (method === "DELETE" && m) {
        removeRoot(db, decodeURIComponent(m[1]));
        return send(200, { ok: true });
      }
      if (method === "GET" && path === "/roots") return send(200, loadRoots(db));
      if (method === "POST" && path === "/gc") return send(200, collectGarbage(db));
      if (method === "GET" && path === "/snapshot") return send(200, snapshot(db));
      if (method === "GET" && path === "/state") {
        const { capacity, activeSpace } = requireHeap(db);
        return send(200, {
          capacity,
          activeSpace,
          allocPtr: allocPtr(db),
          usedUnits: usedUnits(db),
          remaining: capacity - allocPtr(db),
        });
      }
      if (method === "GET" && path === "/reports") return send(200, listReports(db));
      m = path.match(/^\/reports\/(\d+)$/);
      if (method === "GET" && m) return send(200, getReport(db, Number(m[1])));

      return send(404, { error: { code: "E_NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof GcError) {
        return send(STATUS[e.code] ?? 500, { error: { code: e.code, message: e.message } });
      }
      return send(500, { error: { code: "E_INTERNAL", message: String(e) } });
    }
  });
}

export async function serve(db: DatabaseSync, port?: number): Promise<{ port: number }> {
  const p = port ?? (await findFreePort());
  const server = createServer(db);
  await new Promise<void>((resolve) => server.listen(p, () => resolve()));
  console.log(`GC 模拟器 API 已启动: http://127.0.0.1:${p}`);
  return { port: p };
}
