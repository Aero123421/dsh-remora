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
- 権限や範囲を広げる変更（上限、リモート全権と延長、緊急停止の解除、ペアリング、範囲の追加、パスキー変更の承認など）は、ループバックで開いた DSH Web からだけ受け付ける。ほかの端末から開いた場合は「この PC の DSH Web から操作してください」と断る（ハブのパスキーは DSH Web のオリジンでは使えないため）。狭める変更と緊急停止はどこからでも可。

DSH のサンドボックスが制限するのはファイルの書き込みだけで、読み取りとネットワークは制限しない。タスクを投げられる＝その PC のファイルを読ませて外へ通信させられる、ということを「依頼できる」以上を付与する画面で明示する。

## 操作

操作の一覧、必要な権限、MCP のツール名と説明文は `packages/protocol/src/operations.ts` にある。中核ツールの名前と説明文は固定し、版ごとに変えない。

## 要対応と完了判定

- 承認待ち: ログの `approval/asked` に `approval/decided` がまだ無い（`approval/request` waterfall には差し込まない）。
- AI からの質問・プランの確認: `ask_user_question`／`exit_plan_mode` の `tool/call` に結果が無い。外から答えられるのは `tool-ask-user` が `timed` モードの質問だけ（DSH の既定 `legacy` では不可）。プランの確認と承認は外から答えられない。設定タブにプリセットごとのモードを出し、ローカルから `timed` に切り替えられる。
- 完了: `requestId`（＝ `remora:<clientId>:<taskId>`、user メッセージの `source.rpcId`）が一致するターンが終わり、セッションで何も動いておらず、キューが空で、要対応が無い。

## 無料枠

| 消費 | 無料枠 | 抑え方 |
| --- | --- | --- |
| Worker のリクエスト | 10 万／日 | アイコンなどは静的アセットで配り Worker を通さない。ポーリングしない |
| DO のリクエスト | 10 万／日 | 死活確認は `setWebSocketAutoResponse` で DO を起こさない。進行状況は 30 秒以上まとめる |
| DO の実行時間 | 13,000 GB 秒／日 | Hibernation |
| KV の書き込み | 1,000／日 | KV は OAuth だけ |

## 未検証

実機での結合テストはまだしていません。主なもの:

- 自前ビルドのブラウザ側コードが DSH Web で読み込まれ、設定タブが出るか（同じ方式は dsh-pi-login で動いている）
- Node 標準の WebSocket はプロキシ環境では `NODE_USE_ENV_PROXY=1` で起動したときだけプロキシを通る（ローカルの CONNECT プロキシで確認済み。実ネットワークは未確認）
- `workers-oauth-provider` の CIMD が Claude・ChatGPT の実際のメタデータで通るか
- ハブの同期ワークフロー（`hub/.github/workflows/sync-upstream.yml`）が複製先で動くか
- 無料枠の実使用量
