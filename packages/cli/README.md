# remora（CLI）

Remora のハブ経由で DSH Web のセッションを操作するコマンドです。GitHub Releases で配ります（npm には公開しません）。

## 入れ方

```sh
# macOS / Linux（~/.local/bin、または $REMORA_INSTALL_DIR）
curl -fsSL https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.sh | sh
# Windows（%LOCALAPPDATA%\remora\bin）
irm https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.ps1 | iex
```

形は 2 つあり、インストーラーが自動で選びます。どちらも `SHA256SUMS` を検証してから置きます。

| 形 | 中身 | 大きさ | 選ばれる条件 |
| --- | --- | --- | --- |
| Node.js 版（主） | `remora.mjs` ＋ 小さな起動スクリプト（`remora`／`remora.cmd`） | 約 135 KB | Node.js 22.19 以上がある |
| 単体実行ファイル | `remora-<os>-<arch>[.exe]`（Node.js を内蔵） | 約 100 MB（Linux は strip 済み） | Node.js が無いか古い、または `--form binary`／`-Form binary` |

- 起動スクリプトは `$REMORA_NODE` → インストール時に見つけた node → `PATH` の node の順に使います。`remora.mjs` の先頭で版を確かめ、22.19 未満なら案内を出して終わります。
- `REMORA_FORM=auto|node|binary`（PowerShell は `-Form`）で形を選べます。Node.js 版のリリースより前の版（`remora.mjs` が無い）を指定すると単体実行ファイルになります。
- 更新は `remora self-update`。動いている形のまま（`remora.mjs` か実行ファイルを）検証してから原子的に入れ替えます。Windows では動いているファイルを `.old` に退避してから置き換え、次回起動時に消します。
- Windows の Node.js 版は `remora.cmd` なので、シェルを通さずにコマンドを起動する MCP クライアントでは `cmd /c remora mcp` と書きます。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `login <ハブ URL> [--device] [--content] [--admin] [--scope …]` | OAuth 2.1 ＋ PKCE（S256）、ループバック `http://127.0.0.1:<任意のポート>/callback`。`--device` は RFC 8628。`--content` は `dsh.content`、`--admin` は `dsh.admin`（`terminal` に必要）も求める |
| `logout` | トークンをハブで取り消し（RFC 7009、メタデータに `revocation_endpoint` がある場合）、保存分を削除 |
| `hosts` | ホスト一覧 |
| `sessions ls｜show｜read｜fork` | `read --depth summary｜turns｜page`、`--cursor`、`--all`。`fork <ID> [--turn N] [--title]` は N ターン目の終わりまでを写した新しいセッションを作る |
| `search <語>…` | 会話（タイトル・依頼・返答）をすべての語で探す。`--workspace`、`--session`、`--limit`。`dsh.content` が必要 |
| `tasks start｜status｜wait｜watch｜steer｜cancel` | `start` の宛先は `--session｜--latest｜--title｜--alias｜--new <ワークスペース>`、`--skill` は繰り返し可、プロンプトは引数か標準入力、冪等キーは自動 |
| `run --wait` | 投入して 25 秒刻みで待ち、最後の返答を標準出力へ |
| `attention`、`answer <ID>` | 要対応の一覧（回答方法、期限までの残り時間、パスキーが要る承認はハブの URL）と、質問・プラン確認への回答 |
| `approve <ID>`、`reject <ID>` | DSH の承認待ちを 1 回だけ許可・拒否（`approval.respond`）。確認してから送る（`--yes` で省略）。DSH の設定タブで「MCP と CLI からの承認を許可」がオフ（既定）なら、ハブでパスキーを使う URL を表示して終了コード 5 |
| `patch [--apply]` | 差分を表示。`--apply` は `git apply --check` の後、確認して `git apply` |
| `workspaces ls｜create` | `create <名前> [--placement] [--git <https URL>]` |
| `jobs ls <セッション>｜output <ジョブ>｜stop <ジョブ>` | エージェントがバックグラウンドで動かしているコマンド（開発サーバーなど）の一覧・出力・停止 |
| `schedules ls｜add｜rm` | 決まった時間にセッションへ依頼を送る（DSH の自動タスク）。`add <セッション> --title <名前>` に `--after 15m`、`--at <日時>`、`--every 2h`、`--daily 09:00`、`--weekly mon,fri@18:30`、`--cron "<式>"` のどれか 1 つ。時刻は `--tz`（既定はこの PC のタイムゾーン） |
| `audit verify [--file <JSON>] [--out <保存先>]` | ハブとすべてのホストの監査ログを受け取り、この PC でハッシュ連鎖を計算し直す。前回の確認位置（各ログの最後の行）を設定フォルダの `audit-anchors.json` に保存し、次回その行が変わっていないことも確かめる。`--file` はハブの画面で書き出したファイルをハブに問い合わせずに検査。連鎖が途切れているか前回と食い違えば終了コード 1 |
| `hub export [--out <保存先>]` | ハブの設定（ホストと鍵の指紋、クライアントと付与範囲、トークン・パスキー・通知デバイスの一覧）を JSON で。秘密は含まない |
| `hosts rotate-key [<ホスト>]`、`rotate-key [<ホスト>]` | ホスト鍵の更新。ホストが新しい鍵を作り、古い鍵と新しい鍵の両方で署名して、新しい鍵でつなぎ直す |
| `terminal run --workspace <ID> -- <コマンド>`、`terminal status <確認 ID>` | ワークスペースのフォルダでコマンドを 1 回実行する。ハブが出す URL でオーナーがパスキーで確認するまで動かず、確認後に出力を表示する（確認の期限 10 分、`--timeout` はコマンドの制限時間で既定 60 秒・最長 10 分、`--no-wait` で URL だけ表示）。リモート全権と `dsh.admin` が必要。コマンドが 0 以外で終われば終了コード 1、拒否は 5、期限切れは 8 |
| `doctor` | ハブ・メタデータ・トークン・ホストの診断 |
| `mcp`、`mcp probe` | stdio MCP ブリッジと疎通確認 |
| `self-update [--check] [--version]` | GitHub Releases から更新 |

`open <セッション ID>` はハブのセッション画面（`/hosts/<ホスト>/sessions/<セッション>`）を開き、URL を表示します。

`audit verify`、`hub export`、`rotate-key` は、呼ぶたびにハブでオーナーの承認（パスキー）が要ります。ハブが出す URL をオーナーが開いて承認すると結果を受け取ります（承認の期限は 10 分、承認後 1 時間は `--resume <確認 ID>` で受け取り直せます）。`dsh.admin` スコープが必要なので、`remora login --admin` でログインしてください。

全コマンドに `--json` があります。エラー時の `--json` は標準出力に `{"error":{"code","message","hint?","fix?","exitCode"}}` を出します。人向けの出力では、DSH から来た文字列の制御文字（エスケープシーケンス、bidi 制御）を取り除きます。

### MCP クライアントから使う

```sh
claude mcp add remora -- remora mcp        # Claude Code
claude mcp add remora -- cmd /c remora mcp # Windows の Node.js 版
```

`remora mcp` は標準入力の JSON-RPC を 1 行ずつハブの `/mcp`（ステートレスな Streamable HTTP）へ CLI のトークン付きで POST し、JSON でも SSE でも応答を 1 行ずつ標準出力へ返します。`initialize` で決まったプロトコル版は以降 `MCP-Protocol-Version` ヘッダーで送ります。2026-07-28 の要求（`_meta` に版がある）には `MCP-Protocol-Version`／`Mcp-Method`／`Mcp-Name` ヘッダーを本文から付けます。`mcp probe` は 2026-07-28（`server/discover`）を先に試し、断られたら 2025-06-18 の `initialize` に戻ります。401 なら一度だけトークンを更新して再送し、ハブに届かないときは要求ごとに JSON-RPC エラーを返します。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 失敗（タスクの失敗・取り消し、ハブの内部エラーなど） |
| 2 | 未対応の機能 |
| 3 | 人の判断待ちで停止（`run --wait`、`tasks wait`。承認待ちも同じく、回答方法と URL を表示） |
| 4 | 未ログイン・ログイン切れ・取り消し |
| 5 | 権限で拒否（DSH 側の上限／ハブでの付与／トークンのスコープ）。パスキーが要る承認もここ |
| 6 | 見つからない |
| 7 | ハブやホストに届かない、回数制限 |
| 8 | 待機の打ち切り（`--timeout`） |
| 64 | 使い方の誤り、入力の検証エラー（送信前に `validateParams` で検査） |
| 130 | 待機中の Ctrl-C（タスクは続行） |

## 設定とトークン

- 設定: `config.json`（ハブの URL とスコープだけ）。場所は `REMORA_CONFIG_DIR`、なければ Linux `~/.config/remora`、macOS `~/Library/Application Support/remora`、Windows `%APPDATA%\remora`。
- トークン（OS のコマンドだけを使い、ネイティブ addon なし。値は base64 にして標準入力で渡し、argv には載せない）:
  - macOS: `security`（ログインキーチェーンの汎用パスワード、サービス名 `remora-cli`）。`security -i` に標準入力でコマンドを渡す
  - Linux: `secret-tool`（libsecret）。D-Bus セッションがあり、コマンドがある場合だけ
  - Windows: PowerShell の DPAPI（`ConvertFrom-SecureString`、現在のユーザー）で暗号化した `tokens-*.dpapi` を設定フォルダーへ
  - どれも使えなければ設定フォルダーの `tokens-*.json`（0600）に保存し、最初の 1 回だけ警告。保存後は読み戻して確認する
  - `REMORA_TOKEN_STORE=file` でファイルを明示
- `REMORA_TOKEN`: 個人トークンをそのまま使う（更新しない）。`REMORA_HUB_URL`: 保存したハブの代わりに使う。
- スコープ: 既定は `dsh.read dsh.tasks offline_access`（一覧、タスクの投入と待機、そのタスク自身の最終返答まで）。`sessions read`、`patch`、要対応の質問の全文には `dsh.content` が要るので `login --content` を付けます。会話や差分には秘密が紛れうるため既定では求めません。足りないときは送信前に終了コード 5 と案内を出します。
- API 用と MCP 用のトークンは audience を分けて取得します（RFC 8707）。`resource` の値はハブの RFC 9728 メタデータ（`/.well-known/oauth-protected-resource/api/v1/ops` と `/mcp`）を正とし、取れなければ契約の `resourceIndicators()`。取り消しはメタデータの `revocation_endpoint`、無ければ `ENDPOINTS.revocation`。
- アセット名は契約の `RELEASE_ASSETS`（`self-update`、`install.sh`、`install.ps1` で共通）。
- プロキシの内側では Node の `NODE_USE_ENV_PROXY=1` と `HTTPS_PROXY` を設定してください（Node 22.21 以降）。

## 単体実行ファイル（Node SEA）

```sh
pnpm build
node packages/cli/scripts/build-binaries.mjs [--out-dir artifacts/cli] [--node <node の実行ファイル>] [--skip-smoke] [--no-strip]
# → artifacts/cli/remora-<process.platform>-<process.arch>[.exe]
```

1. `dist/remora.mjs` を CommonJS に変換（Node 22 の SEA は CJS のみ）
2. `node --experimental-sea-config`（`useSnapshot`／`useCodeCache` は false）で blob を作る。埋め込む node と同じ node で作る
3. node をコピーし（Linux はここで `strip --strip-all`。macOS は署名、Windows はウイルス対策の誤検知を避けるため縮めない）、`postject@1.0.0-alpha.6`（devDependency に固定）で `NODE_SEA_BLOB` を注入。macOS は事前に `codesign --remove-signature`、事後に `codesign --sign -`（ad-hoc）
4. `--version` が package.json の版と一致するかを確かめる

標準出力の最後の 2 行は `<sha256>  <ファイル名>` と出力先のパスです。クロスビルドはしません（各 OS のランナーで実行）。

### リリースのマトリクス

| 出力 | ランナー |
| --- | --- |
| `remora.mjs` | `ubuntu-24.04`（`pnpm --filter @dsh-remora/cli build` の `dist/remora.mjs`） |
| `remora-linux-x64` | `ubuntu-24.04` |
| `remora-linux-arm64` | `ubuntu-24.04-arm` |
| `remora-darwin-x64` | `macos-15-intel`（Intel。`macos-13` は廃止済み） |
| `remora-darwin-arm64` | `macos-15`（Apple Silicon） |
| `remora-win32-x64.exe` | `windows-2025` |

各ジョブ: `actions/setup-node`（Node 22 の固定版。nodejs.org の公式ビルドを使う。ディストリの node は SEA のヒューズが無いことがある）→ `pnpm install --frozen-lockfile` → `pnpm build` → `node packages/cli/scripts/build-binaries.mjs` → `artifacts/cli/*` をアップロード。最後のジョブで全ファイルを集めて `remora.mjs` も含めた `SHA256SUMS`（ファイル名だけの行）を作り、`install.sh`／`install.ps1` と一緒にリリースへ添付します。

### macOS の署名

- ad-hoc 署名なので Gatekeeper の公証はありません。`curl` や `install.sh` で入れた場合は quarantine 属性が付かないので、そのまま動きます。ブラウザで落とした場合は `xattr -d com.apple.quarantine remora` が必要です。
- 正式に配るなら Developer ID で `codesign --sign "Developer ID Application: …" --options runtime --entitlements` し（JIT のため `com.apple.security.cs.allow-jit` と `allow-unsigned-executable-memory` が要る）、`notarytool` で公証します。生の実行ファイルはステープルできないため、公証は zip で行います。
- Windows も未署名です（SmartScreen の警告が出る場合があります）。

### 大きさ（v0.1.0 → この版、linux-x64 で計測）

| もの | 以前 | 今 |
| --- | --- | --- |
| `remora.mjs`（Node.js 版） | — | 135 KB（gzip 38 KB）。日本語を `\u` エスケープしない UTF-8 出力で 142 KB から縮小 |
| `remora-linux-x64` | 117.9 MiB | 101.1 MiB（`strip --strip-all`） |

単体実行ファイルは Node.js 本体がほとんどを占めます。gzip すると約 39 MB（xz なら約 26 MB）になりますが、既存の `remora self-update` が生の実行ファイル名を探すため、圧縮版は配っていません。
