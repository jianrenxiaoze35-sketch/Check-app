// index.html を Node 上で動かすための最小ハーネス（テストと手動テスト送信で共用）
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/**
 * GAS の doPost が e.postData.contents を組み立てる処理の再現。
 * Content-Type の charset パラメータで本文をデコードし、
 * 無指定なら RFC 2046 の既定どおり ISO-8859-1 として扱う。
 */
export function decodeLikeGas(rawBody, contentType) {
  const m = /charset=([^;\s]+)/i.exec(contentType || "");
  const charset = (m ? m[1] : "iso-8859-1").toLowerCase().replace(/^"|"$/g, "");
  const label = charset === "utf-8" || charset === "utf8" ? "utf-8" : "latin1";
  return new TextDecoder(label).decode(rawBody);
}

/** index.html の <script> を最小限のDOMスタブ上で実行する */
export function loadApp({ html = HTML, forceContentType = null } = {}) {
  let source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(source.length, 1, "index.html のインラインscriptは1つである前提");
  let code = source[0];

  // 修正前の挙動を再現したい場合は Content-Type だけを差し替える
  if (forceContentType !== null) {
    code = code.replace(/const GAS_CONTENT_TYPE\s*=\s*"[^"]*"/,
      `const GAS_CONTENT_TYPE = ${JSON.stringify(forceContentType)}`);
  }

  const store = new Map();
  const makeEl = () => ({
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    className: "",
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  });
  const document = {
    getElementById(id) {
      if (!store.has(id)) store.set(id, makeEl());
      return store.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const localStorage = {
    _d: new Map(),
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
  };

  const alerts = [];
  const logs = [];
  const sandbox = {
    document,
    localStorage,
    // アプリ内の console 出力は結果表示を汚すので記録だけする
    console: { log: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
    fetch,
    TextDecoder,
    TextEncoder,
    alert: msg => alerts.push(String(msg)),
    confirm: () => true,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "index.html" });

  // index.html のトップレベル宣言は let/const（レキシカル束縛）なので
  // サンドボックスのプロパティ経由では触れない。コンテキスト内で評価する。
  const evalIn = c => vm.runInContext(c, sandbox, { filename: "test-eval" });
  const setState = obj => {
    for (const [k, v] of Object.entries(obj)) {
      sandbox.__v = v;
      evalIn(`${k} = __v;`);
    }
    delete sandbox.__v;
  };
  return { ctx: sandbox, evalIn, setState, localStorage, elements: store, alerts, logs };
}

/** GAS のスタブサーバ（受信した生バイトとヘッダを記録する） */
export async function startGasStub(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      received.push({ raw, contentType });
      const body = handler ? handler(raw, contentType) : { ok: true };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(Buffer.from(JSON.stringify(body), "utf8"));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/exec`,
    received,
    close: () => new Promise(r => server.close(r)),
  };
}
