# Remora hub

Remora のハブです。自分の Cloudflare アカウントの無料枠で動かし、DSH ホストと ChatGPT・Claude・CLI・HTTP API の間を中継します。会話の本文は保存しません。

> npm 版の DSH と手元の `wrangler dev` での通しテスト（ペアリング、タスク投入から完了、要対応への回答、会話の検索・フォーク・ジョブの停止・スケジュール、パスキー確認つきのターミナル、緊急停止）は通っています。実際の ChatGPT・Claude からの接続と、Cloudflare への実デプロイはまだ確かめていません。

## できること

- オーナーのログインはパスキーだけ。初回は `SETUP_TOKEN` で最初のパスキーを登録し、以後 `SETUP_TOKEN` は使えません。リカバリーコード 10 個（ハッシュで保存、1 回ずつ）。重要な操作の前にはパスキーで再確認します。
- DSH ホストのペアリング（確認コードまたは QR）。接続のたびに Ed25519 の署名チャレンジ。同じ鍵の同時接続は古い方を切って記録します。
- OAuth 2.1（`@cloudflare/workers-oauth-provider`）。MCP（`/mcp`）と HTTP API（`/api/v1/ops/*`）は別の audience。CIMD 対応、既知のクライアント（ChatGPT、Claude、Claude Code、Remora CLI）だけを既定で許可。DCR は既定オフ。CLI はループバック＋PKCE とデバイスコード（`/device`）。
- MCP はセッションを持たない作り（MCP 2026-07-28 と、`initialize` を使う 2025 年版の両方に対応）。
- HTTP API は OAuth のトークンか、ハブで発行する個人トークン（期限とスコープ付き）。
- タスク台帳（冪等キー、オフライン中は保留して再接続時に配送）、要対応のキャッシュ、内容を残さないハッシュ連鎖の監査ログ、無料枠メーター。
- 要対応への回答: AI からの質問とプランの確認は MCP・CLI・ハブの画面から、承認はハブの画面でパスキーを使って答えられます（DSH の Remora タブで許可すれば `dsh_approval_respond` からも）。要対応には `answerUrl`（ハブで直接開くページ）が付き、期限（`expiresAt`）はカウントダウンで表示します。
- パスキーで毎回確認する操作（ターミナル）: クライアントからの `dsh_terminal_run`（HTTP: `terminal.run`）はすぐには DSH へ送らず、ホストの Durable Object に 10 分だけ保留して `confirmUrl` を返します。オーナーは `/confirm/<ホスト>/<ID>` でコマンド・場所・依頼したクライアントを見て、パスキーで確認するか拒否します。確認すると、その時点の付与で判定し直してから DSH に送り、DSH 側がパスキーの署名を検証して実行します。クライアントは `dsh_confirmation_get`（`confirmation.get`）で結果を受け取ります。保留中の依頼は要対応の一覧と通知に出ます。
- ハブの保守: 監査ログ（`audit.export`）とハブ設定（`hub.export`、秘密は含まない）の書き出し、ホスト鍵の更新（`host.rotate-key`）。HTTP API からの依頼（`dsh.admin` が必要。MCP のツールにはしていません）は保留され、オーナーが `/confirm/hub/<ID>`（鍵の更新は `/confirm/<ホスト>/<ID>`）でパスキーの再確認をして承認したときだけ結果を返します。書き出しは保存せず、受け取りのたびに作ります（承認から 1 時間）。オーナーは監査ログ画面と設定画面から直接 JSON をダウンロードでき、ホストの画面から鍵を更新できます。1 つのクライアントが同時に保留できる依頼は 5 件までです。
- 鍵の更新では、ホストが新しい鍵を作って古い鍵と新しい鍵の両方で署名し、ハブはそれを確かめてから両方の鍵を受け付け、ホストが新しい鍵でつなぎ直した時点で古い鍵を捨てます。古い鍵でつながってきたら更新は取り消しです。
- 画面からの操作: ホストの画面で会話の検索とターミナル（上限がリモート全権のとき）、セッションの画面でフォーク、バックグラウンドジョブの停止、スケジュール（毎日・毎週・間隔・○分後・日時・cron）の追加と削除ができます。
- 通知（Web Push）: 要対応が出たとき、タスクが終わったとき、ホストが切れた・戻ったときに、登録したデバイスへ通知します（種類ごとにオン・オフ）。暗号化（RFC 8291）と VAPID（RFC 8292）は WebCrypto で自前実装し、通知に会話の本文は入れません。iPhone・iPad では Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面の Remora から開いたときだけ通知をオンにできます（iOS 16.4 以降）。

## 設定（シークレットと環境変数）

| 名前 | 必須 | 意味 |
| --- | --- | --- |
| `SETUP_TOKEN` | はい | 最初のパスキー登録だけに使う 16 文字以上の合言葉 |
| `ENABLE_DCR` | いいえ | `true` で動的クライアント登録を有効化（回数制限つき） |
| `HUB_ORIGIN` | いいえ | 複数のホスト名で公開するときの正式なオリジン |

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
npm test                         # node:test（純粋なモジュール）＋ vitest-pool-workers（結合テスト）
```

結合テストは workerd の中でハブを動かし、ソフトウェアのパスキーと Ed25519 の偽ホストで、ペアリング、ハンドシェイク、中継、タスクの冪等性と保留、MCP、OAuth（認可コード＋PKCE、デバイスコード、CIMD の許可リスト）、権限の拒否、パスキー確認待ちの保留・実行・拒否・期限切れ、画面を確かめます。

`src/vendor/protocol/` はリポジトリ直下の `packages/protocol/src` のコピーです。ここは直接編集せず、リポジトリ直下で `pnpm vendor:sync` を実行してください。
