// 文字化け回帰テスト
//
// 背景:
//   本アプリは GAS (Google Apps Script) の doPost に JSON を POST し、
//   GAS が Notion のデータベースへ書き込む。CORS のプリフライトを避けるため
//   Content-Type は text/plain を使うが、charset を省略すると Apps Script は
//   RFC 2046 の既定に従って本文を ISO-8859-1 として解釈するため、
//   保管場所名・担当者名・品目名などの日本語が文字化けしたまま登録される。
//
// このテストは、
//   1. すべての GAS への POST が charset=UTF-8 を宣言していること
//   2. GAS 相当のデコード処理を通しても日本語が壊れないこと
//   3. charset を落とすと（＝修正前の実装では）実際に文字化けすること
//   を検証する。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// ------------------------------------------------------------------
//  GAS の doPost が e.postData.contents を組み立てる処理の再現
//  （Content-Type の charset パラメータで本文をデコードし、
//    無指定なら ISO-8859-1 として扱う）
// ------------------------------------------------------------------
function decodeLikeGas(rawBody, contentType) {
  const m = /charset=([^;\s]+)/i.exec(contentType || "");
  const charset = (m ? m[1] : "iso-8859-1").toLowerCase().replace(/^"|"$/g, "");
  const label = charset === "utf-8" || charset === "utf8" ? "utf-8" : "latin1";
  return new TextDecoder(label).decode(rawBody);
}

// ------------------------------------------------------------------
//  index.html の <script> を、最小限のDOMスタブ上で実行する
// ------------------------------------------------------------------
function loadApp() {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 1, "index.html のインラインscriptは1つである前提");

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
    // アプリ内の console.log / error はテスト出力を汚すので握りつぶして記録する
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
  vm.runInContext(scripts[0], sandbox, { filename: "index.html" });

  // index.html のトップレベル宣言は let/const（レキシカル束縛）なので
  // サンドボックスのプロパティ経由では触れない。コンテキスト内で評価する。
  const evalIn = code => vm.runInContext(code, sandbox, { filename: "test-eval" });
  const setState = obj => {
    for (const [k, v] of Object.entries(obj)) {
      sandbox.__v = v;
      evalIn(`${k} = __v;`);
    }
    delete sandbox.__v;
  };
  return { ctx: sandbox, evalIn, setState, localStorage, elements: store, alerts, logs };
}

// ------------------------------------------------------------------
//  GAS のスタブサーバ（受信した生バイトとヘッダを記録する）
// ------------------------------------------------------------------
async function startGasStub(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      received.push({ raw, contentType });
      const body = handler ? handler(raw, contentType) : { ok: true };
      const out = Buffer.from(JSON.stringify(body), "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(out);
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/exec`;
  return { url, received, close: () => new Promise(r => server.close(r)) };
}

// ==================================================================
//  1. 静的チェック
// ==================================================================
test("GASへのPOSTはすべて charset=UTF-8 を宣言している", () => {
  const headers = [...HTML.matchAll(/"Content-Type":\s*([^,}]+)/g)].map(m => m[1].trim());
  assert.ok(headers.length >= 8, `Content-Type ヘッダが見つからない: ${headers.length}`);

  const ctRe = /const GAS_CONTENT_TYPE\s*=\s*"([^"]+)"/;
  const decl = ctRe.exec(HTML);
  assert.ok(decl, "GAS_CONTENT_TYPE の定義が見つからない");
  assert.match(decl[1], /^text\/plain\s*;\s*charset=UTF-8$/i,
    "GAS_CONTENT_TYPE は text/plain;charset=UTF-8 であること");

  for (const h of headers) {
    const literal = /^"(.*)"$/.exec(h);
    const value = literal ? literal[1] : null;
    assert.ok(
      h === "GAS_CONTENT_TYPE" || (value && /charset=utf-?8/i.test(value)),
      `charset=UTF-8 の無い Content-Type が残っている: ${h}`
    );
  }
});

test("プリフライトを誘発する Content-Type を使っていない", () => {
  // application/json にすると GAS が対応していない CORS プリフライトが飛ぶ
  assert.doesNotMatch(HTML, /"Content-Type":\s*"application\/json/i);
});

// ==================================================================
//  2. 送信内容がGAS側で正しくデコードされる
// ==================================================================
test("棚卸の送信：日本語がGAS側で文字化けせずデコードできる", async () => {
  const gas = await startGasStub(() => ({ ok: true }));
  try {
    const { evalIn, setState, localStorage } = loadApp();
    localStorage.setItem("daily-check-gas-url", gas.url);
    setState({
      staff: "小沢健人",
      currentLocation: "厨房コールドテーブル",
      invItems: [
        { id: "i1", name: "缶ビール 350ml（黄金麦酒）", unit: "本", category: "缶", theoreticalStock: 24 },
        { id: "i2", name: "空缶（ロス・破損分）", unit: "缶", category: "缶", theoreticalStock: 0 },
      ],
      invCounts: { i1: 20, i2: 3 },
    });

    await evalIn("sendInventory()");

    assert.equal(gas.received.length, 1);
    const { raw, contentType } = gas.received[0];
    assert.match(contentType, /charset=utf-8/i);

    const payload = JSON.parse(decodeLikeGas(raw, contentType));
    assert.equal(payload.action, "submitInventory");
    assert.equal(payload.location, "厨房コールドテーブル");
    assert.equal(payload.staff, "小沢健人");
    assert.equal(payload.items[0].name, "缶ビール 350ml（黄金麦酒）");
    assert.equal(payload.items[0].unit, "本");
    assert.equal(payload.items[1].name, "空缶（ロス・破損分）");
    assert.equal(payload.items[1].qty, 3);
    // 理論値との差＝ロス分が欠落していないこと
    assert.equal(payload.items[0].theoreticalStock - payload.items[0].qty, 4);
  } finally {
    await gas.close();
  }
});

test("チェック記録の送信：ステータスの日本語・絵文字が保たれる", async () => {
  const gas = await startGasStub(() => ({ ok: true }));
  try {
    const { evalIn, setState, localStorage } = loadApp();
    localStorage.setItem("daily-check-gas-url", gas.url);
    setState({
      currentMode: "closing",
      staff: "山田太郎",
      checks: { "缶詰の在庫を数える": true, "ロス分を記帳する": true },
    });

    await evalIn("send()");

    const { raw, contentType } = gas.received[0];
    const payload = JSON.parse(decodeLikeGas(raw, contentType));
    assert.equal(payload.staff, "山田太郎");
    assert.equal(payload.status, "✅ 完了");
    assert.deepEqual(Object.keys(payload.checks), ["缶詰の在庫を数える", "ロス分を記帳する"]);
  } finally {
    await gas.close();
  }
});

test("品目一覧の取得：保管場所名が文字化けしない", async () => {
  const gas = await startGasStub(() => ({ ok: true, items: [] }));
  try {
    const { evalIn, setState, localStorage } = loadApp();
    localStorage.setItem("daily-check-gas-url", gas.url);
    setState({ currentLocation: "チェストストッカー", staff: "佐藤" });

    await evalIn("toInvCheck()");

    const { raw, contentType } = gas.received[0];
    const payload = JSON.parse(decodeLikeGas(raw, contentType));
    assert.equal(payload.action, "getInventoryItems");
    assert.equal(payload.location, "チェストストッカー");
  } finally {
    await gas.close();
  }
});

test("保管場所マスタの全キーが往復しても壊れない", async () => {
  const gas = await startGasStub(() => ({ ok: true, items: [] }));
  try {
    const { evalIn, setState, localStorage } = loadApp();
    localStorage.setItem("daily-check-gas-url", gas.url);
    setState({ staff: "テスト" });
    const locations = evalIn("INV_LOCATIONS.map(l => l.key)");
    assert.ok(locations.length > 0);
    for (const key of locations) {
      setState({ currentLocation: key });
      await evalIn("toInvCheck()");
      const { raw, contentType } = gas.received.at(-1);
      const payload = JSON.parse(decodeLikeGas(raw, contentType));
      assert.equal(payload.location, key, `保管場所「${key}」が文字化けした`);
    }
    assert.equal(gas.received.length, locations.length);
  } finally {
    await gas.close();
  }
});

// ==================================================================
//  3. 修正前の実装なら文字化けすることの確認（テストの妥当性）
// ==================================================================
test("charset を省略すると実際に文字化けする（バグ再現）", () => {
  const original = "厨房コールドテーブル／空缶（ロス）";
  const bytes = new TextEncoder().encode(JSON.stringify({ location: original }));

  const broken = JSON.parse(decodeLikeGas(bytes, "text/plain"));
  assert.notEqual(broken.location, original, "charset無しでも壊れないならテストが無意味");
  assert.match(broken.location, /Ã|å|ã/, "ISO-8859-1 誤読による典型的な文字化けになっていない");

  const fixed = JSON.parse(decodeLikeGas(bytes, "text/plain;charset=UTF-8"));
  assert.equal(fixed.location, original);
});
