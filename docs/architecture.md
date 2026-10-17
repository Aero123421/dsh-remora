# Remora の設計

設計書の要点をまとめたものです。コードと食い違ったら、コードと `packages/protocol` を正とします。

## 決めたこと

| 項目 | 決定 |
| --- | --- |
| 配り方 | セルフホストのみ。プラグインと CLI は GitHub Releases、ハブは Deploy to Cloudflare。npm には公開しない |
| ハブ | Cloudflare Workers ＋ Durable Objects（SQLite）。無料枠に収める |
| ログイン | ハブはパスキーのみ。外部クライアントは OAuth 2.1 ＋ PKCE、CIMD。DCR は既定オフ |
| DSH との接続 | DSH 側のプラグインから外向きの WSS。DSH にポートは開けない |
| 権限 | 見るだけ／依頼できる／リモート全権／カスタム。上限は DSH の画面でのみ上げられる |
| 範囲 | ワークスペース単位。新規作成は登録した「置き場所」の下だけ |
| 用語 | UI では「ワークスペース」 |

## 部品

- **ハブ（`hub/`）**: Worker 1 本、ハブ全体用の Durable Object 1 個（オーナー、パスキー、ホスト、クライアント、付与）、ホストごとの Durable Object（WebSocket、タスク台帳、監査ログ）、KV（OAuth のトークンだけ）。会話の本文・差分・成果物は保存せず中継する。プロンプトは DSH に届いた時点で消す。
- **DSH プラグイン（`packages/dsh-remora`）**: DSH の API を触るのはアダプタ層だけ。設定画面の左ナビに「Remora」タブを足す。最終的な権限判定はここで行う。
- **CLI（`packages/cli`）**: `remora` コマンド。ハブの OAuth でログインし、MCP の stdio ブリッジも持つ。
- **共有の型（`packages/protocol`）**: 操作カタログ、権限判定、フレーム。`hub/src/vendor/protocol` にコピーする。

## 認証

| 接続元 | 方式 |
| --- | --- |
| ハブのオーナー | パスキー。初回だけデプロイ時の `SETUP_TOKEN` を要求し、登録後は無効化。リカバリーコードを発行 |
| DSH ホスト | 設定タブの確認コード（または QR）をハブで承認して Ed25519 鍵を登録。接続のたびに署名チャレンジ（ハブのオリジン・hostId・nonce・時刻を署名） |
| ChatGPT・Claude | OAuth 2.1 ＋ PKCE、CIMD。既知クライアントの許可リストを既定にする |
| CLI | ループバック＋PKCE。SSH 先はデバイスコード |
| HTTP API | ハブで発行する個人トークン（期限とスコープ付き） |

スコープは `dsh.read`／`dsh.content`／`dsh.tasks`／`dsh.admin`。ホスト単位・操作単位の許可は grant の中に持つ。

## 権限

実効権限 ＝ DSH 側の上限 ∩ ハブでの付与 ∩ トークンのスコープ（`packages/protocol/src/permissions.ts` の `decide`）。

- 権限の引き上げ、プラグイン管理、資格情報、`/feedback`、`/export`、Remora 自身の設定は、リモート全権でも遠隔からは不可。
- 新しく現れた操作・プリセット・コマンド・スキルは既定でオフ。
- リモート全権は 24 時間で自動失効。危険な操作はペアリング時に固定したパスキーの署名を DSH 側で検証する（ハブが乗っ取られても偽造できない）。
- 拒否には、どの層で拒否されたかと、直す場所を付ける。
- 権限や範囲を広げる変更（上限、リモート全権と延長、緊急停止の解除、ペアリング、範囲の追加、パスキー変更の承認など）は、ループバックで開いた DSH Web からだけ受け付ける。`connection/request` のソケット接続元と Host・Origin を確認し、転送ヘッダー付きの要求はローカル扱いにしない。狭める変更と緊急停止はどこからでも可。2026-10-15 の確認では、ローカル扱いは `packages/dsh-remora/src/routes.ts` の `isLocalRequest` だけが決める。ソケットの接続元がループバックであること、Host がループバックであること、Origin があるときはそれもループバックであることがすべて必要で、Host だけではローカルにならない。`forwarded`、`x-forwarded-for`、`x-forwarded-host`、`x-real-ip`、`cf-connecting-ip`、`true-client-ip` のいずれかがあればローカルではない。ハブの `clientIp` が `cf-connecting-ip` を見るのはレート制限の区分けだけで、権限の判定には使わない。`sameOrigin` は CSRF の確認で、権限を上げない。SSH でループバックへ転送した接続は、その PC のシェルを持つ人としてローカルに扱う。CVE-2026-82533 の一次情報（NVD など）はこの確認では見つかっておらず、Issue が参照した二次情報だけがある。
- 同じデータフォルダーを使う DSH が複数ある場合、設定の変更を共有ファイルから読み直す。設定保存は、最新値の読み取り・変更・権限判定・保存を一つの排他処理で行う。緊急停止とペアリング解除は、接続を持つプロセスの終了処理が終わるまで応答を待つ。
- DSH 本体のデータはプロセスごとにキャッシュされる。別のプロセスが接続を持っていた DSH から接続を引き継ぐには、その DSH を再起動する。プラグインの読み込み直しだけでは引き継がない。

DSH のサンドボックスが制限するのはファイルの書き込みだけで、読み取りとネットワークは制限しない。タスクを投げられる＝その PC のファイルを読ませて外へ通信させられる、ということを「依頼できる」以上を付与する画面で明示する。

## 操作

操作の一覧、必要な権限、MCP のツール名と説明文は `packages/protocol/src/operations.ts` にある。中核ツールの名前と説明文は固定し、版ごとに変えない。

- 会話の検索（`sessions.search`、`dsh.content`）: DSH Web は全文検索の索引をオフで出荷している（`session-query-sqlite` が `openAt: never`）ため、プラグインが範囲内のセッションのログを `inspect`（セッションを起こさない読み取り）で新しい順に読む。1 回 300 セッション・8 秒・1 セッション 5 件まで。途中で止めたら `partial`。照合も抜き出しも伏せ字にした文で行う（検索語で秘密を当てたり、抜き出しの窓を秘密の途中から始めたりできないように）。先頭を切った出力（ジョブ・ターミナルの末尾）は、最初の不完全な行を捨ててから伏せる。
- フォーク（`session.fork`）: 指定ターンの `turn/end` までを `sessionController.fork` で写す。移行はしない（`allowMigration: false`）。
- ジョブ（`session.get` の `jobs`、`job.output`、`job.stop`）: `ctx.jobs` の、範囲内のセッションが持つジョブだけ。止めるときは理由に「Remora 経由」とクライアント名を残す。
- スケジュール（`schedules.list`／`schedule.create`／`schedule.delete`）: DSH の自動タスク（`ctx.schedule`）。作成条件はタスク投入と同じ。冪等キーと依頼内容のハッシュを 24 時間保存し、再起動後の再送も同じスケジュールに解決する。Remora 経由のものはクライアントと一緒に記録し（1 ホスト 20 件まで）、緊急停止・ペアリング解除・Hub からのホスト取り消しで削除する。削除に失敗した記録は再試行のために残す。DSH の作成処理と Remora の記録保存は別の処理なので、その間の強制終了まで含む完全な重複防止は保証しない。
- ワークスペースの clone 復旧・失敗時の削除は、承認した配置先と作成したフォルダーの所有情報（device・inode）が一致するときだけ行う。確認できない旧データや置き換わったフォルダーは残し、`clone-failed` とする。
- `task.get`／`task.wait` は所有者と現在の範囲を確認する。Hub オーナーはクライアントのタスクも確認・取消できるが、範囲と権限の制限は同じ。Hub は照会時にホストの状態を確認し、切断中に完了通知が失われても台帳を更新する。本文・差分・成果物は保存しない。
- ターミナル（`terminal.run`、リモート全権・`dsh.admin`）: `ctx.subprocess` で、ワークスペースのフォルダ（realpath）でシェルを 1 回起動する（macOS・Linux は既定のシェルで `-c`、Windows は `cmd.exe /d /s /c`）。子プロセスは DSH が資格情報らしい環境変数を除いた環境で動く。既定 60 秒・最長 10 分で止め、出力は各 64 KB まで、伏せ字を通して返す。

### パスキーで毎回確認する操作

`REQUIRES_CONFIRMATION`（リモート全権の操作。今は `terminal.run` だけ）は、クライアントから届いてもすぐにはホストへ送らない。

1. ホストの Durable Object が権限を判定したうえで依頼を保留し（10 分）、オーナーに通知して、`ConfirmationInfo`（`confirmationId`、`confirmUrl` = `/confirm/<ホスト>/<ID>`）を返す。
2. オーナーはその画面で内容（コマンド、場所、タイムアウト、依頼したクライアント）を見て、パスキーで確認する。チャレンジは保存してある params（`hostId` 込み）で作るので、ブラウザ側が中身を変えることはできない。拒否もできる。
3. ハブは依頼したクライアントの今の付与で権限を判定し直し、`confirmation` 付きでホストへ送る。DSH 側のプラグインが署名を検証してから実行する（ハブが乗っ取られても偽造できない）。
4. クライアントは `confirmation.get`（最長 25 秒ずつ待てる）で `pending`→`running`→`done`／`failed`／`denied`／`expired` を見て、`done` なら `result` に出力が入る。自分の依頼しか見えない。期限切れや拒否の行は params を消す。

### ハブの保守（オーナーが毎回承認する操作）

`OWNER_APPROVED_OPERATIONS`（`audit.export`、`hub.export`、`host.rotate-key`）は HTTP API だけの操作で（MCP のツールにはしない）、`dsh.admin` が要る。DSH 側で検証できるものが無いので、承認はハブでのパスキーの再確認（`session.fresh`）で行う。

- `audit.export`・`hub.export`: ハブの Durable Object に保留し（`approvals`、10 分、1 クライアント 5 件まで）、オーナーが `/confirm/hub/<ID>` で承認すると、依頼したクライアントが `confirmation.get` で結果を受け取れる（承認から 1 時間・3 回まで）。結果は保存せず、受け取りのたびに作る。監査ログのハッシュの定義は `packages/protocol/src/audit.ts` にあり、CLI はそれでハブの外で計算し直す。CLI は各ログの最後の行を「確認位置」として覚え、次回その行が同じハッシュで残っているかを見る。残っていないとき、そのログが 10,000 行（ハブが古い行を消し始める数）に満たなければ改ざんとみなす。
- `host.rotate-key`: ホストの Durable Object に保留し、承認されると `rotate-key` フレームを送る。ホストは新しい鍵を作り、`rotateKeyMessage(...)` に古い鍵と新しい鍵の両方で署名して返す。ハブは両方を確かめて新しい鍵を「次の鍵」として持ち、`rotate-key-commit` を返す。ホストは両方の鍵を保存してから新しい鍵でつなぎ直し、ハブはその握手で次の鍵を正式な鍵にする（ハブ全体の Durable Object の記録も更新）。古い鍵で握手してきたら次の鍵を捨てる（更新の取り消し）。ホストは握手を断られたらもう一方の鍵で試し直すので、途中で止まっても締め出されない。

## 要対応と完了判定

- 承認待ち: ログの `approval/asked` に `approval/decided` がまだ無い。
- AI からの質問・プランの確認: `ask_user_question`／`exit_plan_mode` の `tool/call` に結果が無い（`timed` モードで「続き」になった質問は `userQuestions` プロジェクションから）。
- 外からの回答（`src/adapter/answerer.ts`）: プラグインは `user-questions/request` と `approval/request` の waterfall に `prepend`・`global` で入り、`next()`（DSH Web・TUI・ACP）と外からの回答を競わせる。外が勝つと、下流に渡した `request.signal` を差し替えた AbortSignal で中断し、DSH Web のカードを閉じさせる。下流があきらめた（`NO_PROVIDER`／`'unavailable'`）か、DSH Web が一つもつながっていない（`typertGateway.hasLiveClient()`）ときだけ、設定の待ち時間で締め切り、誰も答えなければ質問は `NO_PROVIDER`、承認は `'unavailable'`（DSH は拒否扱い）で返す。受け付けるのはハブ接続中・緊急停止オフ・上限が答える操作を許す・範囲内・信頼済みワークスペースのときだけ。項目には `answerVia`（`remote`／`hub-passkey`／`dsh-web`）と `expiresAt` を付ける。
- 承認（`approval.respond`、「依頼できる」）は `CONFIRMATION_UNLESS_ALLOWED`: DSH 側の「承認を MCP・CLI からも許可する」（既定オフ、ローカルからだけオン）がオフの間は、オーナーのパスキー確認（`confirmationChallenge`）が無いと DSH 側で `confirmation-failed` として断る。ハブはその断りにハブの回答ページのリンクを付けて返す。
- 完了: `requestId`（＝ `remora:<clientId>:<taskId>`、user メッセージの `source.rpcId`）が一致するターンが終わり、セッションで何も動いておらず、キューが空で、要対応が無い。

## 無料枠

| 消費 | 無料枠 | 抑え方 |
| --- | --- | --- |
| Worker のリクエスト | 10 万／日 | アイコンなどは静的アセットで配り Worker を通さない。ポーリングしない |
| DO のリクエスト | 10 万／日 | 死活確認は `setWebSocketAutoResponse` で DO を起こさない。進行状況は 30 秒以上まとめる |
| DO の実行時間 | 13,000 GB 秒／日 | Hibernation |
| KV の書き込み | 1,000／日 | KV は OAuth だけ |

タスクと確認結果の長時間待機では、Worker が一時的な通知用 WebSocket とタイマーを持ちます。Durable Object は Hibernation 対応のソケットを受け付け、状態変化だけを通知します。結果を返す前に所有者・範囲・現在の権限を確認します。待機ソケットの入口は短期の署名付き capability で制限し、同時接続数・有効期限を制限します。クライアント向けの最大 25 秒待機と、完了・要対応時の即時応答は維持します。

この方式では、保留する待機 1 回あたりの HostDO 呼び出しは capability 発行・接続・最終確認の 3 回になり、従来の 1 回より増えます。その代わり、25 秒間の待機を DO の実行時間にしません。25 秒待機を 24 時間続けると、1 ホスト約 10,368 回に認証などの呼び出しが加わります。署名鍵の保存は初回だけで、通知用ソケットのための定期ポーリングや待機行の SQL 保存は行いません。リクエストの無料枠も有限で、実使用量の確認は必要です。

画面の使用量は一部の項目の概算です。DO 実行時間、SQL 読み書き・保存量、KV 読み取り等の上限は Cloudflare 側でも確認します。WebSocket の未集計メッセージ数は attachment に保持し、Hibernation で失わないようにします。契約の Free/Paid はアプリから変更しません。追加課金を避ける運用は Workers Free を前提とし、無料枠超過で操作が失敗することを許容します。有料契約の料金や別アプリとの枠の共有を、このメーターで制御することはできません。

## 未検証

npm 版の DSH と手元のハブでの通しテスト（[e2e.md](e2e.md)）は通っています。まだ確かめていない主なもの:

- Node 標準の WebSocket はプロキシ環境では `NODE_USE_ENV_PROXY=1` で起動したときだけプロキシを通る（ローカルの CONNECT プロキシで確認済み。実ネットワークは未確認）
- `workers-oauth-provider` の CIMD が Claude・ChatGPT の実際のメタデータで通るか
- ハブの同期ワークフロー（`hub/.github/workflows/sync-upstream.yml`）が複製先で動くか
- 無料枠の実使用量
