# urx-device

[English](README.md)

YAMAHA URX22・URX44・URX44V の機器の定義・意味のある操作・Device Center との通信を共通にしたもの。ルーターの GUI と `urx` コマンドが、このリポジトリを `vendor/urx-device` に固定した Git サブモジュール (別のリポジトリの特定のコミットを取り込む仕組み) として使う。

**状態:** `0.1.0` に向けた初期の開発中。下のパッケージにはまだ機器の振る舞いが無い。

## 配置

| パス | 中身 |
| --- | --- |
| `packages/control` | `@urx/device-control`: TypeScript の定義・コーデック (値の変換)・呼び出し側が渡す通信の上で動く操作。`./catalog` と `./operations` は別の入口で、catalog は operations も OS やアプリの API も読み込まない |
| `crates/transport` | `urx-device-transport`: Rust の Device Center との通信。Tauri にも Node-API にも依存しない |

アプリのアダプター・GUI のプラン・端末の振る舞いは、それを使うアプリの側に置く。

## ビルドとテスト

必要なもの: Node.js 26 (`.node-version`)、pnpm (`package.json` の `packageManager`)、rustup (`rust-toolchain.toml` に固定した Rust のツールチェーンを入れる)。

```sh
pnpm install --frozen-lockfile
pnpm version:check
pnpm typecheck
pnpm build
pnpm test
cargo test --workspace --locked
```

## 版

手で書き換える版はルートの `package.json` の `version` だけ。`pnpm version:write` がパッケージとクレートの版と、`Cargo.lock` のクレートの項目の版をそこから作り直し、`pnpm version:check` はどれかが違うと失敗する。

## 協力

[CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照。セキュリティ上の問題は [SECURITY.ja.md](SECURITY.ja.md) の手順で報告する。

## 免責

このライブラリは、公式の資料ではなく独自の解析で割り出した制御プロトコルで機器と通信する。機器へデータを送ることには常に危険が伴う。ソフトウェアは「現状のまま」提供され、いかなる保証も無い。作者は、使用によって生じた機器の損傷・設定の消失・その他の損害について責任を負わない。

## ライセンス

[MIT](LICENSE)。
