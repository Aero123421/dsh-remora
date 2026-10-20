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

`e2e.patch.yml` は次の 2 つを入れるオーバーレイです（プロファイルには書き込みません）。

- `workspace-controller` の `documentsDirectory` を一時ディレクトリの `Documents` に固定する。Linux では「書類」フォルダを `xdg-user-dir` で調べるため、これが無いコンテナでは既定のワークスペースが作られず（`spawn xdg-user-dir ENOENT`）、チャット欄が出ません。
- 各エージェントプリセット（`preset-standard`・`preset-ptc`・`preset-cordis`）の `tool-ask-user` を `mode: timed`（1 秒）にする。timed モードでは 1 秒後に質問が「続き」扱いになり、`attention.respond` が `userQuestions.answer` で答えられます。モックが `timeout: -1` を付けると、timed モードでも legacy と同じく答えが来るまで止まる質問になり、Remora が waterfall で受け付けた質問への回答を試せます。ツールの行はプリセットの `config.plugins` の中にあり、パッチで id 指定できないため、`dsh --dump-config` からプリセットの行を写して `config` を足したものを追記します（`enableTimedQuestions`）。

### モックのモデル（`e2e/lib/mock-llm.mjs`）

Anthropic Messages（`POST /v1/messages`）と OpenAI Chat Completions（`POST /v1/chat/completions`）を SSE で返します。返答は最新のユーザー発話で決まります。

| 発話 | 返答 |
| --- | --- |
| 通常 | `REMORA-MOCK-REPLY <nonce>`（発話中の `nonce=<id>`、無ければ `none`） |
| `remora-e2e:ask` を含む（`ask_user_question` が使えるとき） | `ask_user_question` のツール呼び出し（Teal／Navy の 2 択） |
| timed モードで回答待ちのツール結果の直後 | `REMORA-MOCK-WAITING <nonce>` |
| `remora-e2e:ask-blocking` を含む | 同じ質問に `timeout: -1` を付けたもの（答えが来るまで止まる質問） |
| `remora-e2e:approve` を含む（`write` が使えるとき） | `write`（`remora-e2e-<nonce>.txt`）を `sandbox_permissions: danger-full-access` 付きで呼ぶ。DSH はこれを承認としてユーザーに尋ねる |
| 回答（legacy のツール結果、または timed の `answer_to_pending_question`）の直後 | `REMORA-MOCK-ANSWERED <nonce> <回答>` |
| `write` の結果の直後 | `REMORA-MOCK-WRITE <nonce> done`（書けた）／`refused`（拒否・エラー） |
| `remora-e2e:job` を含む（`bash` が使えるとき） | `bash` を `run_in_background: true` で呼ぶ（`echo REMORA-JOB-<nonce>; sleep 600`） |
| `bash` の結果の直後 | `REMORA-MOCK-JOB <nonce> started`（ジョブ ID が返った）／`failed` |

`node e2e/lib/mock-llm.mjs --port 4200` で単体でも起動できます。DSH の pi-ai 経由で試す場合は、プロファイルの `cordis.patch.yml` に `llm-pi-ai` のカスタムプロバイダー（`api: openai-completions`、`baseURL: http://127.0.0.1:4200/v1`）を足します。

## 各ステップが示すこと

### 準備（setup.*）

| ステップ | 示すこと |
| --- | --- |
| `browser.settings-layout` / `remote.settings-layout` | 幅1280pxと600pxで全タブとキーボード操作を確認。選択枠と選択したタブの位置・幅、表示パネルが一致し、権限カードが2列または1列で収まる |
| `setup.plugin-tarball` | tarball が作られ、`SHA256SUMS` と一致する |
| `setup.dsh-install` | 指定の版の DSH が npm から入り、`dsh --version` が一致する |
| `setup.plugin-install` | `dsh plugin add` で入り、プロファイルの bundles と合成後の設定に `dsh-remora` の行がある（peer の範囲外なら DSH がここで拒否する） |
| `setup.dsh-web` | プラグイン入りの DSH Web が起動する |

### ブラウザ確認（browser.*）

| ステップ | 示すこと |
| --- | --- |
| `browser.open` | 認証付き URL で DSH Web が開き、`window.__ModuleLoader__` がある |
| `browser.settings-nav` | 設定画面の左ナビに「Remora」が出る。**自前ビルドのブラウザ側コードが `__ModuleLoader__` 経由で読み込まれ、`settings.section` スロットに登録された**ことの確認 |
| `browser.remora-tab` | Remora ページが `/api/remora/state`（`ctx.connection.fetch.register` の認証付きルート）から状態を取って描画し、プラグインの版が一致する |
| `browser.kill-switch` | 緊急停止を入れると `/api/remora/kill-switch` が新しい状態を返し、再読み込み後も保たれ、切れる |
| `browser.plugins-page` | Plugins 画面に dsh-remora が出る（参考情報。無くても失敗にしない） |
| `browser.no-plugin-errors` | プラグイン由来のページエラー・コンソールエラーが無い |
| `browser.mock-model` | DSH Web でのチャットにモックが答え、`ask_user_question` の質問カードが出て、画面から答えると続きのターンが返る |
| `remote.*` | DSH を非ループバックのアドレス（例 `192.0.2.2`）で起動し直し、同じ確認をする。ブラウザからは別端末と同じに見えるので、**別端末から認証付きルートが使えるか**の確認になる。緊急停止は別端末から入れられるが、再開はできない（ボタンが無効）ことも確かめる。該当するインターフェースが無ければ skip |

### フロー（hub.*、host.*、token.*、task.*、kill-switch.*）

足りない機能は 501 応答や UI の欠如で検出し、理由付きで skip します（`--strict` では失敗）。2026-10-12 の統合版（`integrate`）では、`--strict` で全ステップが pass します。

| ステップ | 示すこと |
| --- | --- |
| `hub.start` | `wrangler dev` で空の状態のハブが 8788 番で起動し、`/healthz` が答え、認証なしの `/api/v1` は 401 |
| `hub.owner` | `/` の初期設定で `SETUP_TOKEN` を入れ、仮想認証器（CDP の `WebAuthn.addVirtualAuthenticator`）でオーナーのパスキーを登録し、リカバリーコードが 1 回だけ出て、ログイン状態になる |
| `hub.recovery` | 仮想認証器の既存キーをすべて消し、リカバリーコードでログインして新しいキーを登録。そのキーだけで再ログインできる |
| `host.pair` | Remora タブの「接続」でハブの URL を入れて確認コードを出し、ハブの `/pair?code=…` でパスキーの再確認つきで承認すると、タブが「Connected」になる |
| `host.permit` | Remora タブで上限を「依頼できる」にし、「範囲」で既定のワークスペースを許可する |
| `token.mint` | ハブの設定画面で個人トークン（`dsh.read`・`dsh.content`・`dsh.tasks`）をパスキーの再確認つきで発行し、「接続」画面でそのホストに「依頼できる」を付与する（ハブが DSH の上限を知るまで待つ） |
| `grant.cancel` | 権限を「見るだけ」へ変える確認を取り消し、表示・サーバー側・再読込後の権限が保存済みの「依頼できる」のままであることを確認する |
| `task.complete` | `hosts.list` → `sessions.list` → `task.start`（同じ `idempotencyKey` で 2 回送って同じタスクになること）→ `task.wait` で `completed`、返答がモックの `REMORA-MOCK-REPLY <nonce>` で、モックがそのプロンプトを受け取っている |
| `task.attention` | `ask_user_question`（timed モード）で `needs_attention`、`attention.list` に出て、`attention.respond` で答えると続きのターンが `REMORA-MOCK-ANSWERED <nonce> Teal` を返して `completed` |
| `answer.web-open` | DSH Web を開いたまま、答えが来るまで止まる質問を出す。Remora も受け付け（`answerVia: remote`、DSH Web が画面で待つ間は締め切り無し）、`attention.respond` で Navy と答えると続きが `REMORA-MOCK-ANSWERED <nonce> … Navy …` で `completed` |
| `answer.no-web` | DSH Web のページを離れて（イベントの流れが切れる）同じ質問を出す。締め切り（約 10 分後）付きで受け付けられ、項目の `answerUrl`（ハブの回答ページ）で Teal を選んで答えると `completed`。最後に DSH Web へ戻る |
| `approval.passkey` | モックが `write` に権限の拡大を求め、DSH が承認を尋ねる。既定では `answerVia: hub-passkey`、HTTP API の `approval.respond` は 403（`confirmation-failed`）でハブの回答ページへのリンクを返す。そのページで「パスキーで確認して今回だけ許可」を押すと、DSH 側が署名を確かめて許可し、`REMORA-MOCK-WRITE <nonce> done` で `completed`（ファイルが既定のワークスペースにできる） |
| `approval.remote` | Remora タブで「Allow approvals from MCP and CLI」をオンにすると、項目が `answerVia: remote` になり、`approval.respond`（拒否）がパスキーなしで通って `REMORA-MOCK-WRITE <nonce> refused` で `completed`、ファイルはできない。最後にスイッチを戻す |
| `sessions.search` | `sessions.search` で `task.complete` の nonce を探すと、そのセッションの依頼（`user`）と返答（`assistant`）の両方が見つかり、ありえない語を足すと 0 件 |
| `session.fork` | `task.complete` のターンまでを `session.fork` で写すと、同じワークスペースに指定したタイトルで新しいセッションができ、`session.read` でそのターンで終わっている |
| `job.stop` | モックが `bash` を `run_in_background: true` で呼び、`sleep` するジョブを残す。そのタスクは終わらずに動き続け、`session.get` の `jobs` に実行中で出て、`job.output` に目印が出る。`job.stop` で止まり（2 回目は `stopped: false`）、タスクは `completed` になる（DSH がジョブの終了を伝えて続きのターンが入ることがある） |
| `schedule.create` | 毎日のスケジュールを作る（同じ冪等キーでは同じものが返る）と `schedules.list` に依頼文つきで出て、`schedule.delete` で消える。2 秒後の 1 回きりのスケジュールは、DSH が依頼として届けてモックの返答のターンができる。最後に 1 時間ごとのものを 1 つ残す（`createdBy` 付き） |
| `terminal.run` | 「依頼できる」のトークンからの `terminal.run` は 403 で断られる。Remora タブで上限を「リモート全権」にする（確認ダイアログ）と、ハブのホスト画面にターミナルが出る。コマンドを送ると `/confirm/<ホスト>/<ID>` に移り、コマンドが表示され、パスキーで確認すると、出力（目印とワークスペースのフォルダ）がその画面に出る。2 つ目は「拒否する」で拒否済みになる。最後に上限を「依頼できる」に戻す |
| `maintenance.audit` | ハブの設定画面で `dsh.read`・`dsh.admin` の個人トークンを発行し、HTTP API の `audit.export` を呼ぶと `pending`（`/confirm/hub/<ID>`）で返る。承認前の `confirmation.get` には結果が無い。そのページでパスキーを使って承認すると `done` になり、受け取ったハブとホストの監査ログのハッシュ連鎖が、ハブの外（`packages/protocol/src/audit.ts`）で計算し直して正しい |
| `maintenance.rotate-key` | ハブのホスト画面の「ホスト鍵の更新」をパスキーの再確認つきで押すと、実際のプラグインが新しい鍵を証明してつなぎ直し、`msg=key-rotated` になる。DSH の Remora タブは再び「Connected」になり、そのあとタスクが完了する。古い鍵のファイルは残らない |
| `kill-switch.enforced` | DSH 側で緊急停止を入れると `task.start` が 403（`denied`、層は dsh）で拒否され、切ると再接続してタスクがまた完了する。`schedule.create` で残しておいた Remora 経由のスケジュールは消えている |
| `host.safety` | 同じデータを使う npm 版 DSH を 2 プロセス起動し、別プロセスから緊急停止する。停止後の新規依頼と Hub で取り消したスケジュールがモデルへ届かないこと、LAN 接続で Host・Origin をループバックに偽装しても権限を上げられないことを確認する |

ハブは `http://localhost:8788` として使います。WebAuthn は IP アドレスを RP ID にできないためです。ハブの状態は一時ディレクトリに置くので、毎回オーナー未登録の状態から始まります。`wrangler dev` には `WRANGLER_SEND_METRICS=false` と `CLOUDFLARE_CF_FETCH_ENABLED=false`（`Request.cf` を取りに行かない）を渡します。

## テスト用フック

セレクターは `e2e/lib/selectors.mjs` にまとめてあります。次の `data-testid` を優先し、無いときは既存のクラス・属性（`#kill-switch`、`form[data-setup]` など）で探します。

| 場所 | `data-testid` |
| --- | --- |
| Remora ページ（`packages/dsh-remora/src/ui/`） | `remora-page`、`remora-kill-switch`（`data-on` で状態）、`remora-hub-status`（`data-state` に接続状態）、`remora-hub-url`、`remora-pair-start`、`remora-pair-code`、`remora-ceiling-<view\|request\|full\|custom>`、`remora-answers`（「外からの回答」。承認のスイッチは名前で探す） |
| ハブ: 初回登録（`/`） | `hub-setup-token`、`hub-setup-label`、`hub-register-passkey`、`hub-recovery-codes`、`hub-recovery-ack` |
| ハブ: ログイン後のナビ | `hub-signed-in` |
| ハブ: 個人トークン（`/settings#tokens`） | `hub-token-name`、`hub-token-create`、一度だけ表示する値は `hub-secret` |
| ハブ: 接続（`/connections`） | `hub-grant-level`（クライアントごと・ホストごとの付与範囲） |
| ハブ: パスキー確認（`/confirm/<ホスト>/<ID>`） | `hub-confirm-command`、`hub-confirm-run`、`hub-confirm-deny`、`hub-confirm-state`、`hub-terminal-stdout`、`hub-terminal-stderr`。要対応の一覧の行は `hub-confirmation-item` |
| ハブ: セッション・ホスト | `hub-jobs`、`hub-schedules`、`hub-search` |
| ハブ: 書き出し | `hub-audit-export`（監査ログ画面）、`hub-settings-export`（設定画面） |
| ハブ: ペアリング（`/pair?code=`） | まだ無し（`strong.code` と `button[name=decision][value=approve]` で探す） |
| ハブ: 要対応の回答ページ（`/attention/<hostId>/<attentionId>`） | `hub-attention-item`、`hub-question-answer`、`hub-plan-approve`／`hub-plan-reject`、`hub-approval-allow`／`hub-approval-reject` |

## 後片付け

起動したプロセスはそれぞれ別のプロセスグループで動かし、終了時（正常終了・失敗・Ctrl-C・SIGTERM）にグループごと SIGTERM、8 秒後に SIGKILL します。一時ディレクトリは `--keep` が無ければ消します。各ステップには時間制限があります。

## CI

- `.github/workflows/e2e.yml`: 関連する PR では最低対応版を `--strict` で検証します。毎晩とリリースでは最低対応版と peer 範囲内の最新公開版（RC を含む）を検証し、どちらの失敗も検証失敗にします。手動実行でも対応版を選べます。`artifacts/e2e/` をアップロードし、`summary.md` をジョブの概要に出します。
- `.github/workflows/release.yml`: `v*` タグで、版の一致（`scripts/check-version.mjs`）、型検査・テスト・ハブのバンドル、E2E（全ステップ、`--strict`）、プラグインの tarball、5 プラットフォームの CLI（`packages/cli/scripts/build-binaries.mjs` をネイティブのランナーで実行）、インストールスクリプト、全アセットの `SHA256SUMS`、`actions/attest-build-provenance` による来歴の証明、下書きの GitHub Release の作成。既にある Release には同名の資産が無いときだけ資産を足し、同名があるときは残したまま失敗します。公開は人が行います。

## 既知の制約

- `upstream.json` の DSH は公開直後のプレリリースで、依存は「2 週間以上前の版」という決まりの例外です。現在の固定は 0.2.1-alpha.3（2026-10-14、`2fbf435`）です。DSH の推移的な依存はロックしていません（DSH 自身が版を固定している範囲で再現します）。ブラウザのセレクタは、0.2.1-alpha.2 のサイドバー「Settings」と、0.2.1-alpha.3 のアカウントメニュー（accessible name は Account menu。広い画面で未ログインのとき表示は More）から Settings を開く経路の両方に合わせてある。
- ブラウザ確認は DSH Web の英語表示に依存します（コンテキストを `en-US` で作る）。DSH の画面の文言や構造が変わると `selectors.mjs` の DSH 部分を直す必要があります。
- Linux と macOS を想定しています。Windows では未確認です。
- `dsh plugin add` は pnpm のメタデータを取りに npm レジストリへアクセスします。オフラインでは動きません。
- サンドボックスなど `HTTPS_PROXY` がある環境では、Chromium を `--no-proxy-server` で起動します。プロキシ経由になると、非ループバックのアドレスへの WebSocket（`/api/remote.mux`）がプロキシに 403 で拒否され、DSH の不具合のように見えるためです。
- `remote.*` は同じマシンの別アドレスから開くだけで、本当の別端末ではありません。DSH から見るとループバック以外の接続になる、という点だけを確かめます。
- 答えが来るまで止まる質問は、timed モードの `ask_user_question` に `timeout: -1` を付けて出します。既定の legacy ツール（呼び出し id を渡さない）とは入口が違うため、そちらは単体テストで確かめています。
- プランの確認（`exit_plan_mode`）は、プランモードへの切り替えをフローで扱わないため通していません（単体テストのみ）。
- 承認は `write` の権限拡大で出します。ツールの実行前の確認（フックなど）からの承認は通していません。
- トークンは個人トークンで作ります。OAuth＋PKCE の経路（`remora-cli`）はハブの単体テストと CLI 側の範囲で、このフローでは通しません。
