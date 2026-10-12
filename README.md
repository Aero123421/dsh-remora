<p align="center"><img src="assets/remora-app.svg" width="96" height="96" alt=""></p>

# Remora

**Self-hosted remote control for DSH (DeepSeek Harness).** View and drive your DSH sessions from ChatGPT, Claude, a CLI or an HTTP API through your own Cloudflare hub. Unofficial.

自分の Cloudflare ハブ経由で、ChatGPT・Claude・CLI・HTTP API から DSH のセッションを見て、依頼して、終わったかどうかを知るためのプラグインです。DeepSeek とは関係のない非公式のプロジェクトです。

> **状態: 準備中（P0 の土台）。** まだ実際には使えません。今動くのは、DSH の設定画面の Remora タブ（状態と緊急停止）、ハブのトップページ、ホスト接続のハンドシェイクの骨組みです。

## しくみ

```text
ChatGPT / Claude / CLI / HTTP API / ハブの画面
        │  HTTPS（OAuth・パスキー）
        ▼
Cloudflare ハブ（Worker + Durable Objects、無料枠）
        ▲  WSS（DSH から外向き）
        │
DSH ホスト A, B, …（dsh-remora プラグイン）
```

- **ハブ**は自分の Cloudflare アカウントの無料枠で動かします。ログインはパスキー、外部クライアントは OAuth です。会話の本文は保存せず中継するだけです。
- **DSH 側**はプラグインを入れて、設定画面の「Remora」タブで接続と権限を決めます。DSH からハブへ外向きにつなぐので、DSH にポートを開ける必要はありません。
- **権限**は「見るだけ／依頼できる／リモート全権」と操作ごとのスイッチで決めます。上限は DSH の画面でしか上げられず、最終判定は毎回 DSH 側のプラグインが行います。

設計の詳細は [docs/architecture.md](docs/architecture.md) にあります。

## 構成

| 場所 | 中身 |
| --- | --- |
| `packages/protocol` | ハブ・プラグイン・CLI が共有する型（操作カタログ、権限判定、WebSocket のフレーム）。唯一の正本 |
| `packages/dsh-remora` | DSH プラグイン（ホスト側と DSH Web 側）。GitHub Releases に tarball で配布 |
| `packages/cli` | `remora` コマンド。Windows・macOS・Linux 向けの単体実行ファイルで配布予定 |
| `hub/` | Cloudflare Worker。Deploy to Cloudflare ボタンでこのフォルダだけを複製できるよう自己完結させている |
| `assets/` | ロゴ（コバンザメと泡）。SVG と PNG |

## 入れ方（予定）

- **プラグイン**: [Releases](https://github.com/Aero123421/dsh-remora/releases) の `dsh-remora-<版>.tgz` の URL を、DSH Web の「Plugins → Add plugin」に貼ります。
- **ハブ**: [hub/README.md](hub/README.md) の Deploy to Cloudflare ボタンから。
- **CLI**: Releases の `install.sh`／`install.ps1` から。

npm には公開しません。

## 開発

[docs/development.md](docs/development.md) を見てください。

## ライセンス

[MIT](LICENSE)。ロゴは独自に作ったもので、DSH の公式ロゴやブランド素材は使っていません（[NOTICE.md](NOTICE.md)）。
