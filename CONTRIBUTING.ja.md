# コントリビューションガイド

> For the English version, see [CONTRIBUTING.md](CONTRIBUTING.md).

urx-device は単独メンテナーのプロジェクトで、[URX Router](https://github.com/semnil/urx-router) と `urx` コマンドの裏にある共通ライブラリである。機器の振る舞いについての報告の多くは、それを見たアプリの側に出すこと。

セキュリティ上の問題は issue ではなく [SECURITY.ja.md](SECURITY.ja.md) の手順で報告すること。

## 協力できること

- **issue の登録。** このライブラリの定義・コーデック (値の変換)・通信の振る舞いの誤りを報告する。
- **プルリクエスト。** 機器へ送る内容を変える変更は、先に issue を立てること。これらは実機での裏付けが必要で、コードを書く前に根拠を合意しておくほうが早い。

## セットアップ

Node.js 26 (`.node-version`)、pnpm (`package.json` の `packageManager`)、rustup (`rust-toolchain.toml` に固定した Rust のツールチェーンを入れる)。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
cargo test --workspace --locked
```

## 規約

- 識別子とコメントは英語。コメントには経緯ではなく振る舞いを書く。
- 差分は最小にし、周りの書き方に合わせる。整形だけの変更は単独では受け付けない。
- Rust の変更には `cargo fmt --all` を掛ける。CI は差分があると失敗し、ブランチへは何も書き戻さない。
- control パッケージは自分の相対パスだけを読み込み、転送のクレートは Tauri にも Node-API にも依存しない。
- 文書には制御プロトコルのパラメータ番号も生の値も書かない。
- 英語と日本語の文書をそろえる。
