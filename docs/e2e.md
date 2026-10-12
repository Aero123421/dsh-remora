# E2E テスト

npm に公開されている本物の DSH に、`pnpm pack:plugin` で作ったプラグインの tarball を DSH の正規の手順で入れ、Playwright で DSH Web を操作して確かめます。ハブは `wrangler dev` で手元に立てます。外部に出ていく通信は、npm レジストリ（DSH・Playwright・pnpm のメタデータ）だけです。

## 動かし方

Node.js 22.19 以上と pnpm が必要です。

```sh
pnpm install
pnpm e2e:install          # e2e/ の依存（playwright 1.56.1）を npm ci で入れる
npx --prefix e2e playwright install chromium   # Chromium が無い環境だけ

pnpm e2e                  # 全部（ブラウザ確認 → フロー → 別端末相当の確認）
pnpm e2e:browser          # ブラウザ確認だけ（--only=browser）
pnpm e2e:flow             # ハブとフローだけ（--only=flow）
node e2e/run.mjs --help   # オプション一覧
```

結果は `artifacts/e2e/` に出ます。

| ファイル | 中身 |
| --- | --- |
| `summary.md`／`summary.json` | ステップごとの pass／fail／skip と理由 |
| `run.log` | 実行の全ログ（モックへのリクエストも含む） |
| `*.png` | 各ステップのスクリーンショット（失敗時は `*-FAILED-*.png`） |
| `trace-loopback.zip`／`trace-remote.zip` | Playwright のトレース（`npx --prefix e2e playwright show-trace <zip>`） |
| `dsh-web.log`／`dsh-plugin-add.log`／`dsh-dump-config.log`／`hub.log` | 起動した各プロセスの出力 |

終了コードは、0 が成功（skip はあってよい）、1 がどこかの失敗、2 が `--strict` 指定時に skip があったことを表します。

主なオプション:

| オプション | 意味 |
| --- | --- |
| `--dsh-version=<版>` | DSH の版。既定は `upstream.json` の版。npm の dist-tag や `newest`（公開済みの最大の版）も可 |
| `--fresh-dsh` | キャッシュした DSH を入れ直す |
| `--plugin=<tgz>`／`--no-pack` | 指定の tarball を使う／`pnpm pack:plugin` を実行しない（既定は毎回作り直す） |
| `--hub-url=<URL> --setup-token=<値>` | `wrangler dev` を起動せず、すでに動いているハブを使う |
| `--strict` | skip を失敗として扱う（全機能がそろった後の CI 用） |
| `--keep` | 一時ディレクトリ（HOME・DSH_HOME など）を消さずに残す |
| `--headed` | ブラウザを表示して実行する |
| `--no-remote` | 非ループバックのアドレスでの確認を省く |

## DSH の起動と設定

ハーネスが実行する内容は次のとおりです（`e2e/lib/dsh.mjs`）。

1. `.cache/e2e/dsh-<版>/` に `npm install --save-exact @deepseek-ai/dsh@<版>` で入れる（ワークスペースの外。2 回目以降は再利用）。
2. 一時ディレクトリに、専用の `HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`、作業ディレクトリを作る。開発者の `~/.dsh` には触れません。
3. プラグインを入れる: `dsh plugin --profile web add <リポジトリ>/artifacts/dsh-remora-<版>.tgz`（作業ディレクトリで実行）。その後 `$DSH_HOME/profiles/web/package.json` の bundles と `dsh --profile web --dump-config` に `dsh-remora` があることを確かめます。
4. 起動する: `dsh web --patch <一時dir>/e2e.patch.yml --no-open --host 127.0.0.1 --port <4100〜4199 の空き>`。標準出力の `dsh web: http://127.0.0.1:<port>/?token=…` が認証付きの URL です。

DSH に渡す環境変数:

| 変数 | 値 | 理由 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | ダミー | DSH 標準の DeepSeek アダプタ（Anthropic Messages 形式）を有効にする |
| `DEEPSEEK_BASE_URL` | `http://127.0.0.1:<4200〜4299>` | モデル呼び出しをモックへ向ける。設定画面やカタログの編集は不要 |
| `DSH_TELEMETRY_MODE` | `DISABLED` | OTel の送信を止める |
| `HOME`／`DSH_HOME`／`DSH_AGENTS_HOME`／`XDG_*` | 一時ディレクトリ | 隔離 |

`e2e.patch.yml` は `workspace-controller` の `documentsDirectory` を一時ディレクトリの `Documents` に固定するだけのオーバーレイです。Linux では「書類」フォルダを `xdg-user-dir` で調べるため、これが無いコンテナでは既定のワークスペースが作られず（`spawn xdg-user-dir ENOENT`）、チャット欄が出ません。

### モックのモデル（`e2e/lib/mock-llm.mjs`）

Anthropic Messages（`POST /v1/messages`）と OpenAI Chat Completions（`POST /v1/chat/completions`）を SSE で返します。返答は最新のユーザー発話で決まります。

| 発話 | 返答 |
| --- | --- |
| 通常 | `REMORA-MOCK-REPLY <nonce>`（発話中の `nonce=<id>`、無ければ `none`） |
| `remora-e2e:ask` を含む（`ask_user_question` が使えるとき） | `ask_user_question` のツール呼び出し（Teal／Navy の 2 択） |
| 質問への回答の直後 | `REMORA-MOCK-ANSWERED <nonce> <回答>` |

`node e2e/lib/mock-llm.mjs --port 4200` で単体でも起動できます。DSH の pi-ai 経由で試す場合は、プロファイルの `cordis.patch.yml` に `llm-pi-ai` のカスタムプロバイダー（`api: openai-completions`、`baseURL: http://127.0.0.1:4200/v1`）を足します。

## 各ステップが示すこと

### 準備（setup.*）

| ステップ | 示すこと |
| --- | --- |
| `setup.plugin-tarball` | tarball が作られ、`SHA256SUMS` と一致する |
| `setup.dsh-install` | 指定の版の DSH が npm から入り、`dsh --version` が一致する |
| `setup.plugin-install` | `dsh plugin add` で入り、プロファイルの bundles と合成後の設定に `dsh-remora` の行がある（peer の範囲外なら DSH がここで拒否する） |
| `setup.dsh-web` | プラグイン入りの DSH Web が起動する |

### ブラウザ確認（browser.*、2026-10-12 にこの環境で全て pass）

| ステップ | 示すこと |
| --- | --- |
| `browser.open` | 認証付き URL で DSH Web が開き、`window.__ModuleLoader__` がある |
| `browser.settings-nav` | 設定画面の左ナビに「Remora」が出る。**自前ビルドのブラウザ側コードが `__ModuleLoader__` 経由で読み込まれ、`settings.section` スロットに登録された**ことの確認 |
| `browser.remora-tab` | タブが `/api/remora/state`（`ctx.connection.fetch.register` の認証付きルート）から状態を取って描画する |
| `browser.kill-switch` | 緊急停止を入れると `/api/remora/kill-switch` が新しい状態を返し、再読み込み後も保たれ、切れる |
| `browser.plugins-page` | Plugins 画面に dsh-remora が出る（参考情報。無くても失敗にしない） |
| `browser.no-plugin-errors` | プラグイン由来のページエラー・コンソールエラーが無い |
| `browser.mock-model` | DSH Web でのチャットにモックが答え、`ask_user_question` の質問カードが出る（フローの前提になるモデル経路の確認） |
| `remote.*` | DSH を非ループバックのアドレス（例 `192.0.2.2`）で起動し直し、同じ確認をする。ブラウザからは別端末と同じに見えるので、**別端末から認証付きルートで保存できるか**の確認になる。該当するインターフェースが無ければ skip |

### フロー（hub.*、host.*、token.*、task.*、kill-switch.*）

ハブとプラグインの機能がそろうにつれて、skip が pass に変わります。足りない機能は 501 応答や UI の欠如で検出し、理由付きで skip します。

| ステップ | 示すこと | 現状（2026-10-12） |
| --- | --- | --- |
| `hub.start` | `wrangler dev` で空の状態のハブが 8788 番で起動し、`/healthz` が答える | pass（`/api/v1` は 501） |
| `hub.owner` | `SETUP_TOKEN` を入れ、仮想認証器（CDP の `WebAuthn.addVirtualAuthenticator`）でオーナーのパスキーを登録できる | skip（登録画面が未実装） |
| `host.pair` | Remora タブにハブの URL を入れて確認コードを出し、ハブの `/pair?code=…` で承認すると、タブが「Connected」になる | skip |
| `token.mint` | ハブの画面で個人トークンを発行する。無ければ CLI と同じ OAuth 2.1＋PKCE（`remora-cli`、ループバックのリダイレクトを Playwright が受ける） | skip |
| `task.complete` | `hosts.list` → `sessions.list` → `task.start`（同じ `idempotencyKey` で 2 回送って同じタスクになること）→ `task.wait` で `completed`、返答がモックの `REMORA-MOCK-REPLY <nonce>` で、モックがそのプロンプトを受け取っている | skip |
| `task.attention` | `ask_user_question` で `needs_attention`、`attention.respond` で答えて `completed` | skip |
| `kill-switch.enforced` | DSH 側で緊急停止を入れると `task.start` が拒否される | skip |

ハブは `http://localhost:8788` として使います。WebAuthn は IP アドレスを RP ID にできないためです。ハブの状態は一時ディレクトリに置くので、毎回オーナー未登録の状態から始まります。`wrangler dev` には `WRANGLER_SEND_METRICS=false` と `CLOUDFLARE_CF_FETCH_ENABLED=false`（`Request.cf` を取りに行かない）を渡します。

## テスト用フック

セレクターは `e2e/lib/selectors.mjs` にまとめてあります。プラグインとハブには次の `data-testid` を付けてもらう前提で、付くまではアクセシブルな名前（英語・日本語）で探します。

| 場所 | `data-testid` |
| --- | --- |
| Remora タブ | `remora-section`、`remora-kill-switch`（`aria-pressed` で状態）、`remora-version`、`remora-hub-status`（`data-state="connected"` など）、`remora-hub-url`、`remora-pair-start`、`remora-pair-code`、`remora-ceiling-request` |
| ハブ: 初回登録 | `hub-setup-token`、`hub-register-passkey`、`hub-recovery-codes`、`hub-recovery-ack`、`hub-signed-in`、`hub-sign-in` |
| ハブ: ペアリング（`/pair?code=`） | `hub-pair-code`、`hub-pair-approve`、`hub-pair-approved` |
| ハブ: 個人トークン（`/tokens`） | `hub-token-name`、`hub-token-scope-tasks`、`hub-token-create`、`hub-token-value` |
| ハブ: OAuth の同意画面 | `hub-consent-approve` |

## 後片付け

起動したプロセスはそれぞれ別のプロセスグループで動かし、終了時（正常終了・失敗・Ctrl-C・SIGTERM）にグループごと SIGTERM、8 秒後に SIGKILL します。一時ディレクトリは `--keep` が無ければ消します。各ステップには時間制限があります。

## CI

- `.github/workflows/e2e.yml`: プラグイン・protocol・ハブ・ハーネスに触れる PR、毎晩（固定の版と `newest`。`newest` の失敗はジョブを落とさない）、手動実行、リリースからの呼び出し。`artifacts/e2e/` をアップロードし、`summary.md` をジョブの概要に出します。
- `.github/workflows/release.yml`: `v*` タグで、版の一致（`scripts/check-version.mjs`）、型検査・テスト・ハブのバンドル、E2E（ブラウザ確認）、プラグインの tarball、5 プラットフォームの CLI（`packages/cli/scripts/build-binaries.mjs` をネイティブのランナーで実行）、インストールスクリプト、全アセットの `SHA256SUMS`、`actions/attest-build-provenance` による来歴の証明、GitHub Release の作成。

## 既知の制約

- DSH 0.2.1-alpha.2 は 2026-10-09 公開で、依存は「2 週間以上前の版」という決まりの例外です（`upstream.json` で固定している検証対象の版のため）。DSH の推移的な依存はロックしていません（DSH 自身が版を固定している範囲で再現します）。
- ブラウザ確認は DSH Web の英語表示に依存します（コンテキストを `en-US` で作る）。DSH の画面の文言や構造が変わると `selectors.mjs` の DSH 部分を直す必要があります。
- Linux と macOS を想定しています。Windows では未確認です。
- `dsh plugin add` は pnpm のメタデータを取りに npm レジストリへアクセスします。オフラインでは動きません。
- サンドボックスなど `HTTPS_PROXY` がある環境では、Chromium を `--no-proxy-server` で起動します。プロキシ経由になると、非ループバックのアドレスへの WebSocket（`/api/remote.mux`）がプロキシに 403 で拒否され、DSH の不具合のように見えるためです。
- `remote.*` は同じマシンの別アドレスから開くだけで、本当の別端末ではありません。DSH から見るとループバック以外の接続になる、という点だけを確かめます。
- フローの `task.*` は、オーナーのパスキー登録・ペアリング・トークン発行・HTTP API がそろうまで skip になります。
