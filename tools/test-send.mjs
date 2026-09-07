#!/usr/bin/env node
// 文字化け修正の確認用テスト送信
//
//   node tools/test-send.mjs                 … ローカルのGASスタブへ送信（既定・安全）
//   node tools/test-send.mjs --url <GAS URL> … 実際のGASへ送信（Notionに本物のレコードが作成されます）
//   node tools/test-send.mjs --mojibake "å±±ç”°å¤ªéƒŽ"  … 実際に化けた文字列から元の文字列を復元
//
// 同じ入力データを「修正前（charset無し）」と「修正後（charset=UTF-8）」の
// 両方の実装で送信し、GAS側が受け取る文字列を並べて表示する。

import { loadApp, decodeLikeGas, startGasStub } from "../tests/harness.mjs";

const argv = process.argv.slice(2);
const getArg = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const realUrl = getArg("--url");
const mojibake = getArg("--mojibake");

// ------------------------------------------------------------------
//  復元モード：実際にNotionに入った文字化け文字列から元の日本語を求める
// ------------------------------------------------------------------
if (mojibake) {
  // 化けた文字は「UTF-8のバイト列を1バイト＝1文字として読んだもの」。
  // ただし WHATWG の "iso-8859-1" は実体が windows-1252 なので、
  // 0x80-0x9F は U+201D などに化ける。単純な & 0xff では戻せないため、
  // デコーダから逆引き表を作って正確にバイト列へ復元する。
  const byteOf = new Map();
  const dec = new TextDecoder("windows-1252");
  for (let b = 0; b < 256; b++) byteOf.set(dec.decode(Uint8Array.of(b)), b);

  const bytes = [];
  let unknown = 0;
  for (const ch of mojibake) {
    if (byteOf.has(ch)) bytes.push(byteOf.get(ch));
    else { bytes.push(ch.codePointAt(0) & 0xff); unknown++; }
  }
  const restored = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));

  console.log("文字化け文字列 :", mojibake);
  console.log("復元した元の値 :", restored);
  if (unknown) console.log(`（${unknown}文字は1バイト文字として解釈できませんでした）`);
  console.log(
    restored.includes("\uFFFD")
      ? "\n復元しきれていません。コピー時に文字が失われている可能性があります。"
      : "\n復元できました。＝UTF-8をISO-8859-1として読んだ文字化けであり、今回の修正で直ります。"
  );
  process.exit(0);
}

// ------------------------------------------------------------------
//  テスト送信データ（ロス記帳を含む棚卸データ）
// ------------------------------------------------------------------
const TEST_DATA = {
  staff: "山田太郎",
  location: "厨房コールドテーブル",
  items: [
    { id: "t1", name: "缶ビール 350ml（黄金麦酒）", unit: "本", category: "缶", theoreticalStock: 24 },
    { id: "t2", name: "缶ビール 500ml（暑寒別岳ピルスナー）", unit: "本", category: "缶", theoreticalStock: 12 },
    { id: "t3", name: "空缶（ロス・破損分）", unit: "缶", category: "ロス", theoreticalStock: 0 },
  ],
  counts: { t1: 20, t2: 12, t3: 3 },
};

async function sendVia(url, contentType) {
  const { evalIn, setState, localStorage } = loadApp(
    contentType === null ? {} : { forceContentType: contentType }
  );
  localStorage.setItem("daily-check-gas-url", url);
  setState({
    staff: TEST_DATA.staff,
    currentLocation: TEST_DATA.location,
    invItems: TEST_DATA.items,
    invCounts: TEST_DATA.counts,
  });
  await evalIn("sendInventory()");
}

function show(label, { raw, contentType }) {
  const payload = JSON.parse(decodeLikeGas(raw, contentType));
  console.log(`\n── ${label} ──`);
  console.log(`  Content-Type : ${contentType}`);
  console.log(`  保管場所      : ${payload.location}`);
  console.log(`  担当者        : ${payload.staff}`);
  for (const it of payload.items) {
    const loss = it.theoreticalStock != null ? it.theoreticalStock - it.qty : null;
    console.log(
      `  品目          : ${it.name}  実数 ${it.qty}${it.unit}` +
      (loss !== null ? `  理論値 ${it.theoreticalStock}  ロス ${loss}` : "")
    );
  }
  return payload;
}

// ------------------------------------------------------------------
//  1) ローカルスタブで 修正前 / 修正後 を比較
// ------------------------------------------------------------------
const gas = await startGasStub(() => ({ ok: true }));
console.log("=".repeat(64));
console.log(" 修正前と同じデータでテスト送信（GASスタブが受け取る内容）");
console.log("=".repeat(64));

await sendVia(gas.url, "text/plain");            // 修正前の実装
const before = show("修正前（Content-Type: text/plain）", gas.received.at(-1));

await sendVia(gas.url, null);                    // 現在の実装
const after = show("修正後（現在の実装）", gas.received.at(-1));

await gas.close();

const ok =
  after.location === TEST_DATA.location &&
  after.staff === TEST_DATA.staff &&
  after.items.every((it, i) => it.name === TEST_DATA.items[i].name);
const wasBroken = before.location !== TEST_DATA.location;

console.log("\n" + "=".repeat(64));
console.log(` 修正前: ${wasBroken ? "文字化けあり ❌" : "文字化けなし"}`);
console.log(` 修正後: ${ok ? "全項目が正しく復元 ✅" : "まだ文字化けしています ❌"}`);
console.log("=".repeat(64));

// ------------------------------------------------------------------
//  2) 実際のGASへ送信（--url 指定時のみ）
// ------------------------------------------------------------------
if (realUrl) {
  console.log(`\n実際のGASへテスト送信します: ${realUrl}`);
  console.log("※ Notionのデータベースに本物のレコードが作成されます\n");
  await sendVia(realUrl, null);
  console.log("送信完了。Notion側で以下が化けずに入っているか確認してください：");
  console.log(`  保管場所「${TEST_DATA.location}」/ 担当者「${TEST_DATA.staff}」`);
  console.log(`  品目「${TEST_DATA.items[2].name}」（ロス 3缶）`);
}

if (!ok) process.exit(1);
