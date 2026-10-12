# Remora hub

Remora のハブです。自分の Cloudflare アカウントの無料枠で動かし、DSH ホストと ChatGPT・Claude・CLI・HTTP API の間を中継します。会話の本文は保存しません。

> まだ準備中の版です。今はトップページ、ホスト用 WebSocket の入口（ハンドシェイクの骨組み）、Durable Object の土台だけが動きます。パスキー、OAuth、MCP は次の版で追加します。

## デプロイ

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Aero123421/dsh-remora/tree/main/hub)

ボタンを押すと、このフォルダが自分の GitHub に複製され、Cloudflare にデプロイされます。途中で `SETUP_TOKEN` を聞かれたら、長いランダムな文字列を入れてください。最初のパスキーを登録すると使えなくなる、一度きりの合言葉です。

使うもの（すべて無料枠）: Workers、Durable Objects（SQLite）、KV（OAuth のトークンだけ）、静的アセット（アイコン）。

## 更新

複製したリポジトリには、このリポジトリの更新が自動では届きません。代わりに同梱の `.github/workflows/sync-upstream.yml` が週 1 回、新しいリリースを見つけたら更新の PR を作ります。マージすれば Cloudflare 側の自動ビルドで反映されます。

PR を作らせるには、複製したリポジトリの Settings → Actions → General で「Allow GitHub Actions to create and approve pull requests」をオンにしてください。

設定はすべてシークレットと環境変数で渡し、`wrangler.jsonc` は書き換えない前提です。書き換えた場合、同期の PR はその変更を残し、本文で知らせます。

## 手元で動かす

```sh
npm ci
cp .dev.vars.example .dev.vars   # SETUP_TOKEN を入れる
npm run dev                      # http://127.0.0.1:8787
npm run typecheck
npm test
```

`src/vendor/protocol/` はリポジトリ直下の `packages/protocol/src` のコピーです。ここは直接編集せず、リポジトリ直下で `pnpm vendor:sync` を実行してください。
