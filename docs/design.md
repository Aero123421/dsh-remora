# Remora 設計書

2026-10-12 時点の設計書（claude.ai のドキュメントから書き出し）。

## 概要と決定事項

Remora は、すでに動いている DSH Web のセッションを、ChatGPT・Claude・CLI・HTTP API から見て、指示し、答えられるようにする非公式のリモートコントロールです。複数の DSH ホストを、自分の Cloudflare に立てた 1 つのハブで束ねます。新しい DSH ランタイムは起動せず、DSH Web と同じプロセスの中で動くプラグインが、既存のセッションを操作します。

| 項目 | 決定 |
| --- | --- |
| 運用形態 | セルフホスト専用。各自が自分の Cloudflare にハブを立て、オーナーは 1 人 |
| 配布 | GitHub Releases（npm は使わない） |
| リポジトリ | 1 つにまとめる。`hub/` だけは依存ごと自己完結させる |
| 画面の表記 | 「ワークスペース」（DSH 本体と同じ） |
| 権限レベルの名前 | 見るだけ／依頼できる／リモート全権／カスタム |
| DSH 側の設定 | 設定画面の左ナビに Remora タブ。Plugins 画面にもそこへのリンク |
| OAuth の登録方式 | CIMD を使う。DCR は既定でオフ、ハブの設定でオンにできる |
| Cloudflare | 無料枠に収める。Durable Objects は SQLite 版と WebSocket Hibernation を使う |
| 言語 | TypeScript。CLI は Windows / macOS / Linux |
| 名前とアイコン | Remora。上向きのコバンザメと青緑の泡。公式 DSH ロゴは使わない |

この設計は、DSH の公式ソース（commit `d743267`、0.2.1-alpha.2）と、観点の違う 3 本のレビュー（利用者体験、DSH 統合と配布、セキュリティと運用）を反映しています。P0〜P2 の範囲は実装済みで、何をどこまで確かめたかは [development.md](development.md) の「確認済みのこと」にまとめています。

## 全体構成

Remora は 3 つの部品でできていて、DSH 側からハブへ外向きに接続するので、DSH 側に受信ポートは要りません。外部のクライアントはハブにだけ接続し、ハブが各 DSH のプラグインへ指示を中継します。

（全体構成の図は README の「しくみ」を参照）

外部クライアントはすべてハブの Worker に入り、ハブはホストごとの DO を通して、DSH 側から張られた WSS で各ホストへ届けます。

| 部品 | 置き場所 | 役割 |
| --- | --- | --- |
| DSH プラグイン `dsh-remora` | 各 DSH Web ホストのプロセス内 | 権限の最終判定、Task の管理と状態の導出、監査ログ、設定タブ、ハブへの接続 |
| ハブ `remora-hub` | 利用者の Cloudflare（Worker ＋ Durable Objects ＋ KV） | パスキー認証、OAuth、MCP と REST の窓口、管理画面、通知 |
| CLI `remora` | 利用者の PC（Windows / macOS / Linux） | ハブの REST を叩く薄いクライアント。`remora mcp` で stdio ブリッジも提供 |

**リポジトリ構成**（1 つにまとめる）:

```
dsh-remora/
  packages/protocol    共通の型・スキーマ・PROTOCOL_VERSION（唯一の正本）
  packages/dsh-remora  DSH プラグイン（Host 側＋ブラウザ側）。protocol を同梱
  packages/cli         CLI
  hub/                 依存ごと自己完結。protocol はスクリプトで hub/src/vendor/ にコピーし、CI で差分ゼロを検査
```

**データの置き場所**:

- **会話本文**: ハブに保存しない。必要なときに DSH から取得し、受け渡したら破棄する。
- **Task の正本**: DSH 側のプラグイン（`ctx.storageDomain`）。ハブは taskId とホストの対応だけを持つ。
- **ハブの状態**: DO の SQLite に集約する（全体用の DO と、ホストごとの DO）。KV は OAuth ライブラリが必要とする分だけ。
- **オフラインのホスト**: 宛ての指示はハブで溜めず、すぐにエラーを返す。

## 認証とペアリング

ハブへのログインはパスキーだけで、それ以外の接続はすべて、ハブでパスキー承認したうえで発行するトークンか鍵で行います。

| 接続元 | 方式 | 補足 |
| --- | --- | --- |
| ハブのオーナー | パスキー（SimpleWebAuthn）、生体認証か PIN 必須 | 初回だけデプロイ時のシークレット `SETUP_TOKEN` を要求し、登録後は恒久的に無効化。リカバリーコードを発行。パスキーは 2 本以上の登録を促す |
| DSH ホスト | 設定タブの確認コードをハブで承認 → Ed25519 鍵ペア | 接続のたびに署名チャレンジ。署名対象はハブのオリジン・hostId・nonce・時刻。同じ鍵の同時接続を検知したら停止。鍵の更新 `remora hosts rotate-key` |
| ChatGPT・Claude・Claude Code | OAuth 2.1 ＋ PKCE、CIMD | 既知クライアントの許可リストを既定にする。ChatGPT は `chatgpt.com/plugins` の＋から追加 |
| その他の MCP クライアント | CIMD、または DCR（既定オフ） | DCR をオンにする場合も回数制限を付け、新規クライアントは「見るだけ」から |
| CLI | ループバック＋PKCE、SSH 先はデバイスコード | トークンは OS のキーチェーン（ネイティブ addon を避け OS のコマンドを使う）。使えなければ 0600 のファイル |
| HTTP API | ハブで発行する個人トークン | 発行時にパスキー再認証。期限とスコープ付き |

**OAuth の細部**（MCP 認可仕様 2026-07-28 に合わせる）:

- `@cloudflare/workers-oauth-provider` 1.2.3 以上を使い、CIMD のための `global_fetch_strictly_public` を有効にする。
- Claude が CIMD を使う条件（`client_id_metadata_document_supported` と `token_endpoint_auth_methods_supported` の `none`）をメタデータで満たす。
- `iss` の検証、resource indicator、audience の検証を行う。MCP と REST は別の resource（audience）にする。
- `offline_access` に対応して更新用トークンを発行し、`refreshTokenIdleTTL` を設定する。
- スコープは `dsh.read` / `dsh.content` / `dsh.tasks` / `dsh.admin` の固定セット。ホスト単位・操作単位の許可は grant の中に持つ。
- デバイスコード（CLI 用）はライブラリが未対応のため、自前で実装する。

**ドメインを変えたとき**: パスキーと OAuth の発行者（issuer）が変わるので、リカバリーコードでログインしてパスキーを登録し直し、各クライアントも接続し直してもらう。

## 権限モデル

実効権限は「DSH 側の上限 ∩ ハブでの付与 ∩ トークンのスコープ」で、最終判定は毎回 DSH 側のプラグインが行います。権限の上限は DSH の画面でしか上げられず、ハブからは下げるか止めることしかできません。

**2 層の権限**:

| 層 | 決めること | 選択肢 |
| --- | --- | --- |
| Remora の権限 | 外部の AI や CLI に何をさせるか | 見るだけ／依頼できる／リモート全権／カスタム（操作ごとのスライドスイッチ） |
| DSH 標準の権限プリセット | エージェント自身が何をできるか | read-only／workspace-write／danger-full-access |

**不変ルール**（リモート全権でも変わらない）:

1. 権限の引き上げは DSH の画面からのみ。ブラウザが DSH Web のループバック以外から開かれている場合は、ハブ側のパスキー確認も追加で求める。
2. 秘密の値（API キー、トークン、鍵）は返さない。会話本文に紛れたものも、外へ出す前に伏せ字にする。
3. 新しく現れた操作・エージェントプリセット・スラッシュコマンド・スキルは既定でオフ（リモート全権では全部オン）。
4. 次の操作は遠隔からは常に不可: 権限プリセットを強める変更（`/permission danger-full-access` を含む）、プラグイン管理、資格情報の読み書き、`/feedback`、`/export`、Remora 自身の設定変更。

**範囲**:

- 基本はワークスペース単位で許可する。どのワークスペースにも属さないセッションは別スイッチで既定オフ。セッション個別の例外も作れる。
- 「置き場所」（新しいワークスペースを作ってよい親フォルダ）をホストごとに登録する。置き場所の下のワークスペースは自動的に範囲に入るので、外から作っても権限設定を書き換えずに済む。
- 置き場所に `$DSH_HOME`、`~/.ssh`、ホームディレクトリそのものは登録できない。判定は realpath で行う。
- ここで決まるのは「どのセッションを外から触れるか」だけで、エージェントがどのファイルに触れるかは DSH のサンドボックスと権限プリセットが決める。

**リモート全権の扱い**: 有効化時に確認ダイアログ。DSH 側とハブの両方に赤いバッジ。既定で 24 時間後に自動失効し、1 タップで延長できる。

**ハブが乗っ取られたときの歯止め**: リモート全権への切り替え、ターミナルといった危険な操作と、DSH 側で MCP・CLI からの承認を許していない間の承認は、ペアリング時に固定したパスキーの公開鍵で、WebAuthn の署名をプラグイン側が直接検証する。ハブが乗っ取られても、これらは偽造できない。

**拒否の伝え方**: 拒否のエラーには、どの層で拒否されたか（DSH の上限／ハブの付与／トークン）と、直すための画面へのリンクを付ける。

## 機能と操作カタログ

MCP、CLI、HTTP API は同じ操作カタログを別の形で見せるだけで、中身は共通です。操作ごとに必要な権限、リスク、入力スキーマを決め、DSH 側のプラグインが能力マニフェストとしてハブへ送ります。

**設計ルール**:

- 中核ツールの名前と説明文は固定する。AI クライアントは説明文を学習済みの前提で動くので、版ごとに変えない。
- プリセット名やモデル名のような選択肢は enum に埋め込まず、文字列で受ける。照合は DSH 側で行い、合わなければ候補一覧を返す。
- 読み取り系には `readOnlyHint`、取り消せない操作には `destructiveHint` を付ける。
- エージェントプリセット、モデル、権限プリセット、スラッシュコマンド、スキルは毎回 DSH から読む。プラグインで追加されたものも自動で出る。
- 未知の独自 API は自動では出さない。汎用の入口はスラッシュコマンド実行で、コマンドごとに権限を割り当てる。

### 操作の範囲

| 分類 | できること | 使う DSH の仕組み |
| --- | --- | --- |
| 読み取り | ホスト／ワークスペース／セッション一覧（サイドバーと同じ階層、ピン留め、アーカイブ除外、サブエージェントは親の下）、セッション概要、会話本文、コンテキスト使用量、要対応、ジョブ、モデル一覧 | `sessionController.list`／`page`／`projections`（`turnOutline`、`tokenUsage`、`contextPressure`、`contextBreakdown`） |
| タスク | 投入（スキル＋プロンプト）、追加指示、キュー取り消し、中断 | `session.prompt`、`updateQueue`、`session.cancel`（中断はセッション全体） |
| セッション | 新規作成（エージェントプリセットを選ぶ）、名前変更、ゴールの設定・一時停止・解除、スラッシュコマンド実行（`/compact` など） | `session.create`、`commands.execute`、goal 系 |
| モデルとモード | モデル・プロバイダー・Effort の切り替え、プランモード | `modelCatalog`／`selectModel`、`ctx.planMode.set`（または `/plan`） |
| ワークスペース | 置き場所の下に新規作成、Git から作成、既存フォルダの登録（リモート全権のみ）、名前変更、一覧から外す（フォルダとログは残る） | `workspaceRegistry`、フォルダ作成はプラグイン自身が行う |
| 検索・フォーク | 会話の検索（範囲内のセッションのログを新しい順に読む。1 回 300 セッション・8 秒まで）、指定ターンまでのフォーク | `inspect`（全文検索の索引は DSH Web では既定オフ）、`sessionController.fork` |
| ジョブ・スケジュール | バックグラウンドジョブの一覧・出力・停止、決まった時間に依頼を送るスケジュールの一覧・追加・削除（追加はタスク投入と同じ条件） | `ctx.jobs`（`list`／`readAt`／`kill`）、`ctx.schedule`（`create`／`catalog`／`delete`） |
| 危険系（リモート全権のみ） | ターミナル（ワークスペースのフォルダでコマンドを 1 回）。毎回ハブでオーナーがパスキーで確認し、DSH 側が署名を検証してから動く | `ctx.subprocess`（`spawn`、`terminalEnvironment`） |

**モードについて**: 通常と PTC はエージェントプリセット（standard／ptc／cordis など）の違いです。最初のターンの後はロックされるので、モードの選択は「新しいセッションを作るときに選ぶ」形になります。既存セッションのモードは表示だけです。

**モデル選択の副作用**: `selectModel` は、そのセッションだけでなく新規セッションの既定値にも保存されます。画面と MCP の説明文でこのことを明示します。

### MCP ツール

| ツール | 内容 | 必要な権限 | フェーズ |
| --- | --- | --- | --- |
| `dsh_status` | 接続状態、ホストの要約、要対応件数。最初に呼ぶ想定 | 見るだけ | P0 |
| `dsh_hosts_list`／`dsh_workspaces_list`／`dsh_sessions_list` | 一覧 | 見るだけ | P0 |
| `dsh_session_get` | モデル、モード、実行状態、コンテキスト圧、直近ターンのプレビュー | 見るだけ | P0 |
| `dsh_session_read` | 3 段階（概要／ターン一覧／本文ページ）で読む | 見るだけ | P0 |
| `dsh_skills_list` | そのセッションで使えるスキル | 見るだけ | P0 |
| `dsh_task_start` | スキル＋プロンプトを投入。宛先は id／最新／タイトル／別名で指定、新規セッション作成も 1 回で可。`idempotencyKey` 必須 | 依頼できる | P0 |
| `dsh_task_get`／`dsh_task_wait` | 状態を取得。wait は最大 25 秒で、完了か要対応で早めに戻る | 見るだけ | P0 |
| `dsh_attention_list` | 承認待ち、AI からの質問、止まったゴール、ログイン切れ | 見るだけ | P0 |
| `dsh_attention_respond` | 質問・プラン確認への回答、止まったゴールの再開 | 依頼できる | P1 |
| `dsh_approval_respond` | 承認待ちを 1 回だけ許可・拒否。DSH 側で MCP・CLI からの承認を許していなければ、パスキーで答えるハブのページのリンクを返す | 依頼できる | P1 |
| `dsh_changes_get`／`dsh_patch_get` | 変更ファイルの要約と差分 | 見るだけ | P1 |
| `dsh_deliverable_read` | エージェントが提示した成果物 | 見るだけ | P1 |
| `dsh_session_usage` | トークン使用量とコンテキストの内訳 | 見るだけ | P1 |
| `dsh_task_steer`／`dsh_task_cancel`／`dsh_task_resubmit` | 追加指示、取り消し・中断、同じ内容での再投入 | 依頼できる | P1 |
| `dsh_goal_*`、`dsh_job_output` | ゴール操作、ジョブの出力 | 操作ごと | P1 |
| `dsh_workspace_create` | 置き場所の下に作成、Git クローンも可 | 依頼できる＋置き場所 | P1 |
| `dsh_model_select` | モデル、プロバイダー、Effort | 依頼できる | P1 |
| `dsh_command_run` | スラッシュコマンド実行。コマンドごとに許可 | 操作ごと | P1 |
| `dsh_sessions_search` | 会話（タイトル・依頼・返答）をすべての語で探す。`dsh.content` が必要 | 見るだけ | P2 |
| `dsh_session_fork` | 指定ターンの終わりまでを写した新しいセッション | 依頼できる | P2 |
| `dsh_job_stop` | バックグラウンドジョブを止める | 依頼できる | P2 |
| `dsh_schedules_list`／`dsh_schedule_create`／`dsh_schedule_delete` | スケジュールの一覧・追加（`afterSeconds`／`at`／`everySeconds`／`daily`／`weekly`／`cron` のどれか、`idempotencyKey` 必須）・削除 | 見るだけ／依頼できる | P2 |
| `dsh_terminal_run` | ワークスペースのフォルダでコマンドを 1 回。すぐには動かず、オーナーが確認する `confirmUrl` を返す | リモート全権＋`dsh.admin` | P2 |
| `dsh_confirmation_get` | パスキー確認待ちの依頼の状態と結果（最長 25 秒待てる）。自分の依頼だけ | 見るだけ | P2 |

### CLI

`remora` コマンド 1 つで、全サブコマンドに `--json` を付けられます。

| サブコマンド | 用途 |
| --- | --- |
| `login [--device]`、`hosts`、`doctor` | ログイン、ホスト一覧、接続診断 |
| `sessions ls｜show｜read｜fork`、`search`、`open` | セッションの閲覧・フォーク・会話の検索と、ハブのセッション画面を開く |
| `tasks start｜status｜wait｜watch｜steer｜cancel`、`run --wait` | タスク操作。`run --wait` は投入から完了待ちまでを 1 回で行う |
| `attention`、`answer` | 要対応の一覧と回答、承認待ちの許可・拒否（approve／reject） |
| `patch` | 変更差分を取り出してローカルに適用する |
| `workspaces create` | ワークスペース作成 |
| `jobs ls｜output｜stop`、`schedules ls｜add｜rm` | バックグラウンドジョブとスケジュール |
| `terminal run｜status` | ターミナル（ハブの URL でオーナーがパスキーで確認するまで待ち、出力を表示する。`login --admin` が必要） |
| `mcp`、`mcp probe` | ローカルの MCP クライアント向け stdio ブリッジと疎通確認 |
| `rotate-key`、`audit verify`、`hub export` | 鍵の更新、監査ログの改ざん検査、ハブ設定の書き出し |
| `self-update` | GitHub Releases から自己更新 |

### HTTP API

同じ操作を `/api/v1` 以下の REST として公開します。認証は OAuth のアクセストークン（個人トークンは P1）です。

## 要対応と完了判定

外から投げた依頼が「終わったのか」「人の判断待ちで止まっているのか」を正しく返せるかどうかで、使い勝手がほぼ決まります。どちらも projection だけでは分からないので、セッションのログとイベントから組み立てます。

### 要対応の検出

| 種類 | 検出方法 | 外からの回答 |
| --- | --- | --- |
| 承認待ち | ログの `approval/asked` に対応する `approval/decided` がまだ無い | P1（既定はハブでパスキー確認。DSH 側で許せば MCP・CLI からも） |
| AI からの質問 | `ask_user_question` の `tool/call` に結果がまだ無い | P1 |
| プランの確認待ち | `exit_plan_mode` の `tool/call` に結果がまだ無い | P1 |
| ゴールの停止 | goal projection が停止状態 | P1（再開・解除） |
| ログイン切れ | プロバイダーの認証エラー（`api-session/error`） | 不可。DSH 側で再ログインを促す |

**外からの回答（質問・プラン確認・承認）**: プラグインは `user-questions/request` と `approval/request` の waterfall の先頭に入り、`next()`（DSH Web・TUI・ACP）と外からの回答を競わせます。先に答えた方が採用されます。外からの回答が勝ったときは、下流に渡した `request.signal`（差し替えた AbortSignal）を中断して DSH Web のカードを閉じさせます。

- 締め切り: 下流があきらめた（`NO_PROVIDER`／`'unavailable'`）か、DSH Web が一つもつながっていない（`typertGateway.hasLiveClient()`）ときだけ、DSH 側の設定「外からの回答を待つ時間」（既定 10 分、0 でオフ）で締め切ります。誰も答えなければ質問は `NO_PROVIDER`、承認は `'unavailable'`（DSH は拒否扱い）で返します。DSH Web が開いている間は締め切りを付けません。
- 受け付ける条件: ハブに接続中、緊急停止オフ、上限が答える操作（`attention.respond`／`approval.respond`）を許す、セッションが範囲内、ワークスペースが信頼済み。それ以外はそのまま DSH に渡します。
- 承認は `approval.respond`（依頼できる）。DSH 側の「承認を MCP・CLI からも許可する」（既定オフ、この PC からだけオン）がオフの間は、オーナーのパスキー確認が無いと DSH 側で断り、ハブはその断りに回答ページのリンクを付けます。
- 要対応の項目には、答え方（`answerVia`: `remote`／`hub-passkey`／`dsh-web`）と締め切り（`expiresAt`）を付けます。
- `timed` モードで「続き」になった質問は、これまでどおり `userQuestions.answer` で答えます。

### 完了判定

- **タスクとターンの対応**: `session.prompt` に渡す `requestId` は、user メッセージの `source.rpcId` として残ります。この値が一致するターンを、そのタスクの実行結果とみなします。
- **完了の条件**: そのセッションで何も動いていないこと（`workspace/session-activity` と `api-session/status` で判定）、キューが空であること、要対応が無いこと。
- **結果として返すもの**: そのターンの最後の返答、変更ファイルの要約、提示された成果物。

### タスクの状態

| 状態 | 意味 |
| --- | --- |
| `accepted` | DSH が受け付けた（`{accepted:true}`） |
| `running` | 該当ターンが進行中 |
| `needs_attention` | 上の要対応のどれかで止まっている |
| `completed`／`failed`／`cancelled` | 終了 |
| `parked` | ホストがオフラインなどで届けられず、ハブで保留中 |

**DSH Web で誰かが見ているとき**: `hasLiveClient` が真なら、ハブと MCP の応答に「DSH Web で誰かが見ています」と出します。要対応に DSH Web 側から先に答えた場合は、Remora からの回答を「回答済み」で弾きます。

## DSH プラグインの実装方針

DSH はまだ発展途上なので、DSH の API に触る場所を 1 か所に閉じ込め、使えない機能があってもその操作だけが無効になる作りにします。

### アダプタ層

- DSH の API を呼ぶのはアダプタ層だけ。ハブとの通信は、DSH とは別にバージョン管理する自前のイベント語彙とプロトコルで行う。
- **起こさない読み取りと、起こす操作を分ける**。`follow` は休眠中のセッションを起こして書き込みロックを取るので、一覧・概要・本文の読み取りでは使わない。`resolveAgent` や `follow` を通るのは、タスク投入などセッションを動かす操作だけ。
- セッションのイベントはプロセス内で購読する（HTTP を経由しない）。
- 能力ごとに `ctx.inject` を持つ子プラグインに分ける。goal、プランモード、userQuestions、workspaceRegistry などが無い DSH では、その子だけが起動せず、対応する操作がマニフェストから消える。
- 起動時に各サービスの有無とメソッドの形を確かめる（機能検出）。結果は設定タブの「互換性」に出す。

### タスクを確実に 1 回だけ届ける

1. ハブから届いたタスクに `requestId = remora:<clientId>:<taskId>` を割り当て、`session.prompt` を呼ぶ**前**に自前のストレージへ書く。
2. 再接続や再送で同じタスクがもう一度来ても、同じ `requestId` で呼ぶ。DSH が同一 `requestId` を元の受付として返すので二重投入にならない。
3. アーカイブ済みのセッションとサブエージェントのセッションへの投入は、DSH に渡す前に拒否する。
4. 削除されたセッションは墓標（tombstone）として一定期間覚えておき、「見つからない」ではなく「削除済み」と返す。
5. ホストがオフラインの間は、ハブ側でタスクを `parked` として保留する。再接続時にプラグインが取りに行く。

### 設定タブ

- DSH 設定画面の左ナビに `settings.section` スロットで Remora タブを足し、Plugins 画面の Remora の行（`plugins.bundle.config` スロット）からもリンクする。
- DSH Web がループバック以外から開かれている場合、`ui-settings` は memory モードになり、DSH 標準の設定フォームでは保存できない。そこで設定の読み書きは、認証付きルート `ctx.connection.fetch.register` で公開する `/api/remora/state` を通す。
- ブラウザ側のコードは、DSH のブラウザ用ビルド設定（tsdown プリセット）が公開されていないため自前でビルドし、`ctx.remote.$mount` で遅延読み込みする。
- ハブからのリンクは DSH Web の URL に `#remora=<id>` を付けて渡し、Remora タブの該当項目（ペアリング要求など）を直接開く。

### 保存と鍵

- 設定・タスク台帳・監査ログは `ctx.storageDomain`（`$DSH_HOME/storages` の JSON）に置く。移行機能が無いので、自前でスキーマ版数を持って移行する。
- ホストの Ed25519 秘密鍵は `ctx.credentials` に置く。これは DSH 標準の保管場所だが平文 YAML（0600）であることを、設定タブと README に明記する。
- 同じ `$DSH_HOME` で DSH が複数起動しても、ハブにつなぐのは 1 つだけにする（ロックファイルによる単一インスタンス化）。

### DSH の進化への追従

- 互換性 CI: 固定した DSH の版と、DSH の master を毎晩テストする。
- `peerDependencies` の範囲が合わないと、DSH はプラグインを自動で無効化する。範囲の決め方は「配布と更新」に書く。

## ハブの実装方針

ハブは Cloudflare の無料枠に収まる小さな中継所です。会話の本文、差分、成果物は保存せず、DSH ホストとクライアントの間で中継するだけにします。

### 構成

| 部品 | 役割 | 保存するもの |
| --- | --- | --- |
| Worker（1 本） | 画面、`/mcp`、`/api/v1`、OAuth、ホストの WebSocket 受け口 | なし |
| 全体用 DO（1 個） | ハブのオーナー、パスキー、ホスト一覧、クライアントと付与 | SQLite |
| ホスト用 DO（ホストごと） | WebSocket 接続の保持、タスク台帳、要対応の一覧、監査ログ | SQLite |
| KV | OAuth のトークンと grant（`workers-oauth-provider` がこれを要求する） | OAuth 関連だけ |

タスク台帳に置くプロンプト本文は、DSH に届いた時点で消します。監査ログには「誰が・いつ・どの操作を・どこへ」を残し、本文は残しません。

### MCP

- `createMcpHandler` で、セッションを持たない作りにする（MCP 仕様 2026-07-28 の stateless に合わせる）。リクエストごとに OAuth で認証し、該当するホスト用 DO へ転送する。
- `dsh_task_wait` は 1 リクエスト内で最大 25 秒待つ。それより長い待ちは、クライアント側で繰り返し呼んでもらう。

### DSH ホストとの接続

- DSH 側のプラグインから外向きに WSS でつなぐ。DSH 側にポートを開ける必要はない。
- ホスト用 DO は WebSocket Hibernation を使い、通信が無い間は眠る。
- Node 標準の WebSocket にはプロトコルレベルの ping を送る API が無い。そこで死活確認は、アプリ側のテキスト ping を `setWebSocketAutoResponse` で返す。この応答は DO を起こさず、課金もされない。
- 進行状況は 30 秒以上の間隔でまとめて送る。完了と要対応だけは即時に送る。
- 期限のある処理（リモート全権の失効、`parked` タスクの期限切れ、古いデータの掃除）は DO の alarm で行う。

### 無料枠を守る工夫

| 主な消費源 | 無料枠 | 抑え方 |
| --- | --- | --- |
| Worker のリクエスト | 10 万／日 | 画面は静的配信＋必要な API だけ。ポーリングをしない |
| DO のリクエスト | 10 万／日 | 死活確認は自動応答で DO を起こさない。進行状況はまとめて送る。受信 WebSocket メッセージは 20 通で 1 リクエストと数えられる |
| DO の実行時間 | 13,000 GB 秒／日 | Hibernation で接続中も眠らせる |
| KV の書き込み | 1,000／日 | KV は OAuth だけに使い、トークン更新の頻度を抑える |

- 使用量はハブ自身が数え、ホームに無料枠メーターとして出す。いずれかが 80% を超えたら通知し、進行状況の送信間隔を延ばす。
- Cloudflare 側は無料プランのまま使う前提で、有料プランへの切り替えを前提にした機能は入れない。

### 防御

- 回数制限: ログイン試行、トークン発行、DCR 登録（オンの場合）、クライアントごとの API 呼び出し。
- 画面は厳しい CSP（インラインスクリプト禁止）にする。DSH から来た文字列はすべてテキストとして描画し、HTML としては扱わない。

## 画面

ハブは「管制塔」で、会話そのものは DSH Web で開きます。ハブは濃紺の背景に半透明のカードを並べるトーンで、スマホに入れて使える PWA にします。

### ハブ（8 画面）

| 画面 | 中身 |
| --- | --- |
| ホーム | 受信箱のように、要対応を一番上に置く。その下に実行中、最近の完了、ホストカード（接続状態、リモート全権の赤バッジ）、無料枠メーター。初回はオンボーディングのチェックリストを出す |
| ホスト詳細 | ワークスペースとセッションの階層（DSH のサイドバーと同じ並び）、互換性、使える操作 |
| セッション詳細 | モデル、モード、コンテキストの使用率と内訳、ターン一覧、操作ボタン（依頼、追加指示、中断、`/compact`、モデル変更）、「DSH で開く」 |
| タスク | 状態、最後の返答、変更ファイル、成果物 |
| 要対応 | 承認待ち・質問・プラン確認・ゴール停止・ログイン切れの一覧と回答。項目ごとの回答ページ（answerUrl）と締め切りのカウントダウン。承認はパスキーで確認 |
| 接続 | 接続中のクライアント（ChatGPT、Claude、CLI など）、付与範囲、取り消し。MCP の接続手順と、コネクター用アイコンのダウンロード |
| 監査ログ | 操作の履歴。拒否された操作には「なぜ拒否されたか」ビュー（どの層で止まったかと、直す場所へのリンク） |
| 設定 | パスキー、リカバリーコード、通知（Web Push）、ホストの追加（QR コードでペアリング）、個人トークン |

**オンボーディングのチェックリスト**: パスキーを 2 本登録 → DSH ホストをつなぐ → 権限と範囲を決める → AI クライアントをつなぐ → 最初のタスクを投げる。

**QR ペアリング**: DSH の設定タブにハブの URL と確認コードを QR コードで出し、ハブにログイン済みのスマホで読み取って承認する。確認コードを手で入力する方法も残す。

### DSH 側の設定タブ

DSH 設定画面の左ナビに「Remora」を足し、ここだけで接続から権限まで完結させます。

1. **接続**: ハブの URL、ペアリング（確認コードと QR）、接続状態、鍵の更新。
2. **権限**: 見るだけ／依頼できる／リモート全権／カスタムを選び、操作ごとのスライドスイッチで調整する。エージェントプリセット、スラッシュコマンド、スキルもここで個別に許可する。「外からの回答」で、質問・プラン確認・承認を待つ時間（オフ／5／10／30／60 分、既定 10 分）と、承認を MCP・CLI からも許すスイッチ（既定オフ）を決める。
3. **範囲**: ワークスペースごとの許可、置き場所、ワークスペース外のセッション、セッション個別の例外。
4. **接続中のクライアント**: 一覧と個別の取り消し。
5. **監査ログ**: このホストで実行された操作。
6. **互換性と更新**: 機能検出の結果、DSH と Remora の版、更新ボタン。
7. **緊急停止**: 外からの操作をすべて止めるキルスイッチ。ハブとの接続も切る。

### DSH Web の中の表示

Remora が接続中であること（リモート全権なら赤）を小さなチップで常に見せ、そこから 1 クリックで緊急停止できるようにします。置けるスロットがあるかは未確認です。無ければ設定タブの中だけにします。

## セキュリティと脅威モデル

Remora は「自分の PC で動くエージェントに、外から仕事を頼める」道具なので、乗っ取られたときの被害は大きくなります。最終判定を DSH 側に置き、ハブが破られても危険な操作は通らないようにします。

**前提として知っておくこと**: DSH のサンドボックスが制限するのはファイルの書き込みだけで、読み取りとネットワークは制限しません。タスクを投げられるということは、エージェントにその PC のファイルを読ませ、外へ通信させられるということです。「依頼できる」以上を付与する画面で、このことを明示します。

| 脅威 | 想定する場面 | 対策 |
| --- | --- | --- |
| ハブの乗っ取り | Cloudflare アカウントや Worker のコードが改ざんされる | 権限の上限は DSH の画面でしか上げられない。危険操作はペアリング時に固定したパスキーの署名を DSH 側で検証。DSH 側に緊急停止 |
| AI クライアント経由のプロンプト注入 | ChatGPT や Claude が読んだウェブページの指示で、勝手にタスクを投げる | 書き込み系ツールに注釈を付け、クライアント側の確認を促す。危険系は既定オフ。新しいクライアントは「見るだけ」から。すべて監査ログに残す |
| 会話内容からの注入 | 外部 AI が読んだ会話本文に入っている指示に従う | 会話本文を読む権限（`dsh.content`）を一覧を見る権限から分ける。返す本文には「信頼できないデータ」だと明記する |
| 秘密の流出 | 会話や差分に API キーが紛れている | DSH から出る前に伏せ字フィルターを通す。資格情報の読み出し、`/export`、`/feedback` は遠隔から不可 |
| ハブ画面の XSS | 会話本文やセッション名にスクリプトが仕込まれる | 厳しい CSP。DSH から来た文字列はテキストとしてだけ描画する |
| 同意画面を使ったフィッシング | 攻撃者の MCP クライアントを「許可」させられる | 既知クライアントの許可リストを既定にし、DCR は既定オフ。同意画面にクライアントのドメインと戻り先を大きく出し、パスキーで承認する |
| 悪意あるリポジトリのクローン | フック、サブモジュール、巨大なリポジトリ、リポジトリ内のスキルや指示ファイルによる注入 | https のみ、ホスト許可リスト、シェルを通さず実行、フック無効、サブモジュール既定オフ、認証情報を使わない、時間とサイズの上限。クローンしたワークスペースは「信頼していない」として扱い、その中のスキルは DSH の画面で許可するまで外から使えない |
| 置き場所の悪用 | ホームや `$DSH_HOME` にワークスペースを作らせる | 禁止パスを決め、シンボリックリンクを解決した realpath で判定する |
| ホスト鍵の盗難 | DSH の PC から鍵が持ち出される | 同じ鍵の同時接続を検知して停止。ハブから失効、`remora hosts rotate-key` で更新 |
| トークンの盗難 | CLI のトークンが漏れる | OS のキーチェーンに保存。アクセストークンは短命、更新トークンは放置で失効。MCP と REST で audience を分ける。「接続」画面から取り消し |
| リモート全権の放置 | 一時的に入れた全権を切り忘れる | 24 時間で自動失効、赤バッジで常に表示 |
| 二重実行 | 再送や再接続で同じ依頼が 2 回流れる | `idempotencyKey` と先書きの `requestId` |
| 監査ログの改ざん | 痕跡を消される | DSH 側とハブ側の両方にハッシュ連鎖で残し、`remora audit verify` で検査 |

## 配布と更新

セルフホスト前提で、npm には公開しません。プラグインと CLI は GitHub Releases、ハブは各自の Cloudflare アカウントへのデプロイで配ります。

| 配るもの | 形 | 入れ方 | 更新 |
| --- | --- | --- | --- |
| DSH プラグイン | Releases に置く tarball（実行時の依存なし、ライフサイクルスクリプトなし） | DSH Web の Plugins → Add plugin に tarball の URL を貼る。または `dsh plugin add <URL>` | 設定タブが新しい版を知らせ、更新ボタンで入れ替える |
| CLI | Node.js 版（remora.mjs、約 135 KB、Node.js 22.19 以上）が主。Node.js が無ければ単体実行ファイル（Windows／macOS／Linux、x64 と arm64） | `install.sh`／`install.ps1` | `remora self-update` |
| ハブ | リポジトリ内の自己完結した `hub/` | Deploy to Cloudflare ボタン（`hub/` を指す URL） | 自分のリポジトリに入る同期用ワークフローが、上流のリリースを PR で運ぶ |

### プラグイン

- tarball から入れられることは、レビュー時の実験で確認済み（依存なし、ライフサイクルスクリプトなしの場合）。
- Releases には `SHA256SUMS` と GitHub の artifact attestation（ビルド元の証明）を付ける。
- `peerDependencies` は `>=0.2.1-alpha.2 <0.2.2-0` のように、動作を確認した DSH の範囲だけを書く。範囲外だと DSH がプラグインを自動で無効化するので、例外的に使いたい人には `dsh plugin allow-version` を案内する。
- DSH の新しい版が出たら、互換性 CI を通して範囲を広げた版を出す。
- 設定タブの更新ボタンは、Releases の最新版と変更内容を表示し、`SHA256SUMS` を検証してから入れ替える。プラグイン自身が自分を入れ替えられるかは未検証で、できなければ Plugins 画面での手順を案内する。

### CLI

- TypeScript で書き、単体実行ファイルにする（Node の SEA か Bun のコンパイルかは P0 で決める）。
- インストール用スクリプトも `remora self-update` も、`SHA256SUMS` を検証してから置き換える。

### ハブ

- Deploy to Cloudflare ボタンは、公開リポジトリを利用者の GitHub に複製してからデプロイする。サブディレクトリを指定できるが、その中で自己完結している必要があるので、`hub/` は共通パッケージに依存せず単体でビルドできる形にする（プロトコルの型はビルド時にコピーする）。
- 複製したリポジトリには上流の更新が届かない。そこで `hub/` に同期用の GitHub Actions ワークフローを同梱し、上流に新しいリリースが出たら PR を作らせる。マージすれば Cloudflare 側の自動ビルドで反映される。
- 利用者が wrangler の設定ファイルを書き換えなくても動くようにし、値はすべてシークレットと環境変数で渡す。同期 PR が衝突しないようにするためです。
- `SETUP_TOKEN` はデプロイ時にシークレットとして入れてもらう。

### 版の管理

- プラグイン、CLI、ハブは同じ版番号で出す。
- ハブとプラグインの間のプロトコルは別に版を持ち、ハブは現行と 1 つ前のプロトコルを受け付ける。ハブとプラグインの更新がずれても動き続けるためです。

## ブランド

**名前**: Remora（コバンザメ）。大きな魚である DSH に吸い付いて一緒に動く、というイメージです。

| 用途 | 名前 |
| --- | --- |
| 表示名 | Remora |
| リポジトリ | `dsh-remora` |
| DSH プラグインのパッケージ | `dsh-remora` |
| CLI のコマンド | `remora` |

**リポジトリの説明**（GitHub の About 欄）: Self-hosted remote control for DSH (DeepSeek Harness). View and drive your DSH sessions from ChatGPT, Claude, a CLI or an HTTP API through your own Cloudflare hub. Unofficial.

**Topics**: `dsh`、`deepseek-harness`、`mcp`、`cloudflare-workers`、`durable-objects`、`passkeys`、`self-hosted`

**DSH のブランドガイドラインに沿うこと**（`BRAND_GUIDELINES.md`）:

- 名前に「DSH」を入れて DSH 向けであることを示すのはよい。
- 公式ロゴやブランド素材は使わない。公式・提携と誤解させる表現もしない。
- README とハブのフッターに「DSH 向けの非公式プラグイン」と明記する。

**アイコン**（[アイコン案のキャンバス](https://claude.ai/artifact/S5gFPRNXcXfY7oh3qppLec)）:

- 少し上を向いたコバンザメを、単色・一つの形で描く。頭の上の吸盤は溝で表す。
- 差し色は泡の 3 粒（青緑 `#1FA89A`）だけで、魚は墨（`#111111`）か白（`#F5F5F2`）。
- 使い分け:
  - アイコン: 魚＋泡。アプリアイコン、MCP コネクターのアイコン、ファビコンに使う。
  - バッジ: 円の中に魚と泡を白抜きにしたもの。16px まで潰れないことをキャンバスで確認済み。
  - ロゴタイプ: 魚＋泡＋「Remora」の文字。
- ハブの「接続」画面から、コネクター設定用のアイコンをダウンロードできるようにする。

**まだ決めていないこと**: ロゴタイプの書体（セリフの Instrument Serif か、サンセリフの Bricolage Grotesque か）。書き出し（SVG、PNG の 512／192／180px、ファビコン）は書体が決まってから行う。

## フェーズ

P0 は「外から見て、頼んで、終わったか分かる」ところまでです。P0 の最初に、次の章の検証（特にブラウザ側の自前ビルド）を片付けます。

| フェーズ | 範囲 | 完了の条件 |
| --- | --- | --- |
| P0 | ハブ: パスキー（`SETUP_TOKEN`、リカバリーコード）、ホストのペアリング、OAuth（CIMD、既知クライアント）、MCP、監査ログ、無料枠メーター。プラグイン: 設定タブ（接続・権限・範囲・緊急停止）、一覧と読み取り、タスク投入・確認・待機、スキル指定、要対応の一覧。CLI: `login`、`hosts`、`sessions`、`tasks`、`run --wait`、`attention`、`doctor`、`mcp`。配布: Releases の tarball と Deploy ボタン | Claude と ChatGPT の両方から、2 台の DSH のセッションが見え、スキル付きでタスクを投げ、完了と要対応を正しく受け取れる。1 週間使って無料枠に収まる |
| P1 | 追加指示・取り消し・中断・再投入。要対応への回答（質問、プラン確認、承認）。新規セッション（モード選択）、ワークスペース作成と Git クローン。モデル・プロバイダー・Effort、プランモード、コンテキストの内訳と `/compact`、スラッシュコマンド。ゴール、ジョブの出力、変更要約と差分、成果物。個人トークンと HTTP API、Web Push 通知、QR ペアリング、互換性 CI、設定タブからの更新、CLI の `patch`／`answer`／`open`／`self-update` | スマホだけで、ワークスペース作成から依頼、質問への回答、差分の確認までを一通りできる |
| P2 | リモート全権での危険系（ターミナル）、ジョブ停止、スケジュール、フォーク、検索（いずれも実装済み）。複数ユーザーはセルフホスト前提なので優先度低（未着手） | ハブを乗っ取った想定のテストで、危険操作が一つも通らない（プラグインの単体テストで、パスキーの署名が無い・使い回したターミナルの依頼を DSH 側が断ることを確認） |

## 未検証事項と検証計画

ここまでの内容は DSH のソースと公開資料を読んだ結果で、実機での結合テストはまだしていません。次の項目は、確かめるまでは「そうなるはず」の段階です。

| 項目 | 外れたときの影響 | 確かめ方 | 時期 |
| --- | --- | --- | --- |
| 自前ビルドしたブラウザ側コードが DSH Web で読み込まれ、設定タブが出るか | 最大の山場（ただし同じ方式は dsh-pi-login で動作済み）。設定タブの作り方を大きく変えることになる | タブを 1 つ出すだけの最小プラグインを作り、ループバックと別端末の両方から開く | P0 の最初 |
| 認証付きルート `/api/remora/state` が別端末のブラウザから使えるか | リモートで設定を保存できない | 上の最小プラグインで、保存と再読み込みを試す | P0 の最初 |
| Node 標準の WebSocket がプロキシのある環境で外向きにつながるか | 会社のネットワークなどでつながらない | `HTTPS_PROXY` ありの環境で接続し、駄目なら代替経路を決める | P0 |
| 自動応答の死活確認が、実際に DO を起こさず課金もされないか | 無料枠の見積もりが崩れる | ホストをつないだまま 1 日放置し、使用量を確認する | P0 |
| `workers-oauth-provider` の CIMD が Claude と ChatGPT の実際のメタデータで通るか（過去にサイズ上限のエラー事例あり） | AI クライアントからつながらない | 両方の実際の画面から接続する | P0 |
| CLI 用のデバイスコードを自前で実装して、ライブラリと共存できるか | SSH 先から CLI にログインできない | 試作して、発行したトークンが通常のものと同じように使えるか見る | P0 |
| `approval/asked`／`approval/decided` が、すべての承認の経路でログに残るか | 承認待ちを見落とす | 承認が出る操作を一通り起こしてログを見る | P0 |
| `rpcId` によるタスクとターンの対応が、キューや追加指示を挟んでも崩れないか | 完了判定がずれる | 実行中に続けて投入し、対応を確かめる | P0 |
| legacy モードの `ask_user_question` に外から答えられるか | 既定設定のままでは質問に答えられない | 確認済み（2026-10-12）: Remora が waterfall の先頭で受け付けて答える。答えが来るまで止まる質問は実 DSH の E2E、legacy ツールそのものは単体テストで確認 | P1 |
| プラグインが自分自身を更新できるか | 設定タブの更新ボタンが作れない | 試作して、駄目なら手順の案内にする | P1 |
| Git クローンを DSH のサンドボックスに閉じ込められるか | クローンが置き場所の外に書き込めてしまう | workspace-write の下で実行してみる | P1 |
| DSH Web に常時表示のチップを置けるスロットがあるか | 接続中であることが設定タブでしか見えない | スロット一覧を調べる | P1 |
| 無料枠の実使用量 | 有料になる | P0 の完成後、普段使いで 1 週間計測する | P0 の最後 |

**確認済みのこと**（参考）: GitHub Releases の tarball からプラグインを入れられること（レビュー時の実験）。それ以外の DSH の挙動は、コミット `d743267` のソースを読んだ結果です。

## 根拠

### DSH のソース

[deepseek-harness のコミット d743267](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)（0.2.1-alpha.2）で読んだ箇所です。

| 内容 | ファイル |
| --- | --- |
| セッション操作、`requestId`、projection、`follow` | `packages/api/session-controller/src/index.ts`、`types.ts`、`history.ts`、`commands.ts`、`README.md` |
| 承認の型と outcome | `packages/interaction/user-approval/src/types.ts` |
| ブラウザ側 Remote とループバック判定 | `packages/api/remotes/src/index.ts` |
| AI からの質問（既定は legacy） | `packages/interaction/user-questions/src/projection.ts`、`packages/interaction/tool-ask-user/src/index.ts` |
| スキルの読み込み条件と置き場所 | `packages/skill/tool-skill/src/index.ts` |
| ワークスペース | `packages/workspace/workspace/src/`、`packages/api/workspace-controller/src/` |
| フォルダ選択（閲覧のみ） | `packages/host/directory-picker*/src` |
| 設定画面のスロットと memory モード | `packages/client/ui-settings/src/client/index.ts`、`contract/slots.ts` |
| 通常と PTC | `packages/core/tools/src/index.ts`、`packages/core/agent-tool-presentation/README.md`、`packages/bundle/web-app/presets/` |
| 権限プリセット | `packages/bundle/base/cordis.patch.yml` |
| トークン使用量 | `packages/llm/token-meter/src/projection.ts` |
| スラッシュコマンド | `packages/interaction/commands/src/index.ts` |
| サンドボックスの範囲 | `packages/sandbox/sandbox/README.md` |
| プラグインの追加と互換性チェック | `apps/cli/src/plugin.ts`、`packages/boot/app-boot/src/plugin-compatibility.ts` |
| ブランドの扱い | `BRAND_GUIDELINES.md` |

### MCP と認可

- [MCP 仕様 2026-07-28: Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP 仕様 2026-07-28: Security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [MCP 仕様 2026-07-28: Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP 仕様 2026-07-28: Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP Tasks 拡張](https://modelcontextprotocol.io/extensions/tasks/overview)
- [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)、[RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)

### AI クライアント

- [Claude: コネクターの認証](https://claude.com/docs/connectors/building/authentication)
- [OpenAI: Apps SDK の認証](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI: カスタム MCP サーバー](https://developers.openai.com/api/docs/guides/custom-mcp-server.md)
- [OpenAI: Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)

### Cloudflare

- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [Durable Objects の料金](https://developers.cloudflare.com/durable-objects/platform/pricing)、[制限](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects と WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[State API](https://developers.cloudflare.com/durable-objects/api/state/)、[SQL ストレージ](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
- [Workers の制限](https://developers.cloudflare.com/workers/platform/limits/)、[KV の制限](https://developers.cloudflare.com/kv/platform/limits/)、[Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Deploy to Cloudflare ボタン](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

### その他

- [Node.js（undici）の WebSocket](https://undici.nodejs.org/api/WebSocket)
- 既存の自作プラグイン: [dsh-pwa](https://github.com/Aero123421/dsh-pwa)、[dsh-pi-login](https://github.com/Aero123421/dsh-pi-login)
