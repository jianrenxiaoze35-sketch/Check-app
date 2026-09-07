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
import { HTML, loadApp, decodeLikeGas, startGasStub } from "./harness.mjs";

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

// ==================================================================
//  4. 文字化け復元ツール（tools/test-send.mjs --mojibake）
// ==================================================================
test("化けた文字列から元の日本語を復元できる", () => {
  const samples = [
    "山田太郎",
    "厨房コールドテーブル",
    "空缶（ロス・破損分）",
    "缶ビール 350ml（黄金麦酒）",
    "✅ 完了",
  ];

  // 逆引き表（tools/test-send.mjs と同じ手順）
  const byteOf = new Map();
  const dec = new TextDecoder("windows-1252");
  for (let b = 0; b < 256; b++) byteOf.set(dec.decode(Uint8Array.of(b)), b);
  const restore = s => new TextDecoder("utf-8").decode(
    Uint8Array.from([...s].map(ch => byteOf.has(ch) ? byteOf.get(ch) : ch.codePointAt(0) & 0xff))
  );

  for (const original of samples) {
    const broken = decodeLikeGas(new TextEncoder().encode(original), "text/plain");
    assert.notEqual(broken, original, `「${original}」が化けていない`);
    assert.equal(restore(broken), original, `「${original}」を復元できない`);
  }
});
