# remora（CLI）

Remora のハブ経由で DSH Web のセッションを操作するコマンドです。GitHub Releases の単体実行ファイルとして配ります（npm には公開しません）。

## 入れ方

```sh
# macOS / Linux（~/.local/bin、または $REMORA_INSTALL_DIR）
curl -fsSL https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.sh | sh
# Windows（%LOCALAPPDATA%\remora\bin）
irm https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.ps1 | iex
```

どちらも `SHA256SUMS` を検証してから置きます。更新は `remora self-update`（同じく検証してから、実行ファイルを原子的に入れ替え。Windows では動いている `remora.exe` を `remora.exe.old` に退避してから置き換え、次回起動時に消します）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `login <ハブ URL> [--device] [--scope …]` | OAuth 2.1 ＋ PKCE（S256）、ループバック `http://127.0.0.1:<任意のポート>/callback`。`--device` は RFC 8628 |
| `logout` | トークンをハブで取り消し（RFC 7009、メタデータに `revocation_endpoint` がある場合）、保存分を削除 |
| `hosts` | ホスト一覧 |
| `sessions ls｜show｜read` | `read --depth summary｜turns｜page`、`--cursor`、`--all` |
| `tasks start｜status｜wait｜watch｜steer｜cancel` | `start` の宛先は `--session｜--latest｜--title｜--alias｜--new <ワークスペース>`、`--skill` は繰り返し可、プロンプトは引数か標準入力、冪等キーは自動 |
| `run --wait` | 投入して 25 秒刻みで待ち、最後の返答を標準出力へ |
| `attention`、`answer <ID>` | 要対応の一覧と回答 |
| `patch [--apply]` | 差分を表示。`--apply` は `git apply --check` の後、確認して `git apply` |
| `workspaces ls｜create` | `create <名前> [--placement] [--git <https URL>]` |
| `doctor` | ハブ・メタデータ・トークン・ホストの診断 |
| `mcp`、`mcp probe` | stdio MCP ブリッジと疎通確認 |
| `self-update [--check] [--version]` | GitHub Releases から更新 |

`audit verify`、`hub export`、`hosts rotate-key`、`open` はハブ側のエンドポイントが契約にまだ無いため「まだ使えません」と表示します（終了コード 2）。

全コマンドに `--json` があります。エラー時の `--json` は標準出力に `{"error":{"code","message","hint?","fix?","exitCode"}}` を出します。人向けの出力では、DSH から来た文字列の制御文字（エスケープシーケンス、bidi 制御）を取り除きます。

### MCP クライアントから使う

```sh
claude mcp add remora -- remora mcp        # Claude Code
```

`remora mcp` は標準入力の JSON-RPC を 1 行ずつハブの `/mcp`（ステートレスな Streamable HTTP）へ CLI のトークン付きで POST し、JSON でも SSE でも応答を 1 行ずつ標準出力へ返します。`initialize` で決まったプロトコル版は以降 `MCP-Protocol-Version` ヘッダーで送ります。401 なら一度だけトークンを更新して再送し、ハブに届かないときは要求ごとに JSON-RPC エラーを返します。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 失敗（タスクの失敗・取り消し、ハブの内部エラーなど） |
| 2 | 未対応の機能 |
| 3 | 人の判断待ちで停止（`run --wait`、`tasks wait`） |
| 4 | 未ログイン・ログイン切れ・取り消し |
| 5 | 権限で拒否（DSH 側の上限／ハブでの付与／トークンのスコープ） |
| 6 | 見つからない |
| 7 | ハブやホストに届かない、回数制限 |
| 8 | 待機の打ち切り（`--timeout`） |
| 64 | 使い方の誤り、入力の検証エラー（送信前に `validateParams` で検査） |

## 設定とトークン

- 設定: `config.json`（ハブの URL とスコープだけ）。場所は `REMORA_CONFIG_DIR`、なければ Linux `~/.config/remora`、macOS `~/Library/Application Support/remora`、Windows `%APPDATA%\remora`。
- トークン（OS のコマンドだけを使い、ネイティブ addon なし。値は base64 にして標準入力で渡し、argv には載せない）:
  - macOS: `security`（ログインキーチェーンの汎用パスワード、サービス名 `remora-cli`）。`security -i` に標準入力でコマンドを渡す
  - Linux: `secret-tool`（libsecret）。D-Bus セッションがあり、コマンドがある場合だけ
  - Windows: PowerShell の DPAPI（`ConvertFrom-SecureString`、現在のユーザー）で暗号化した `tokens-*.dpapi` を設定フォルダーへ
  - どれも使えなければ設定フォルダーの `tokens-*.json`（0600）に保存し、最初の 1 回だけ警告。保存後は読み戻して確認する
  - `REMORA_TOKEN_STORE=file` でファイルを明示
- `REMORA_TOKEN`: 個人トークンをそのまま使う（更新しない）。`REMORA_HUB_URL`: 保存したハブの代わりに使う。
- ハブが RFC 9728 の保護リソースメタデータ（`/.well-known/oauth-protected-resource/api/v1` と `/mcp`）を出していれば、`resource` を付けて API 用と MCP 用のトークンを分けて取得します。出していなければ 1 つのトークンを共用します。
- プロキシの内側では Node の `NODE_USE_ENV_PROXY=1` と `HTTPS_PROXY` を設定してください（Node 22.21 以降）。

## 単体実行ファイル（Node SEA）

```sh
pnpm build
node packages/cli/scripts/build-binaries.mjs [--out-dir artifacts/cli] [--node <node の実行ファイル>] [--skip-smoke]
# → artifacts/cli/remora-<process.platform>-<process.arch>[.exe]
```

1. `dist/remora.mjs` を CommonJS に変換（Node 22 の SEA は CJS のみ）
2. `node --experimental-sea-config`（`useSnapshot`／`useCodeCache` は false）で blob を作る。埋め込む node と同じ node で作る
3. node をコピーし、`postject@1.0.0-alpha.6`（devDependency に固定）で `NODE_SEA_BLOB` を注入。macOS は事前に `codesign --remove-signature`、事後に `codesign --sign -`（ad-hoc）
4. `--version` が package.json の版と一致するかを確かめる

標準出力の最後の 2 行は `<sha256>  <ファイル名>` と出力先のパスです。クロスビルドはしません（各 OS のランナーで実行）。

### リリースのマトリクス

| 出力 | ランナー |
| --- | --- |
| `remora-linux-x64` | `ubuntu-latest` |
| `remora-linux-arm64` | `ubuntu-24.04-arm` |
| `remora-darwin-x64` | `macos-15-intel`（Intel。`macos-13` は廃止済み） |
| `remora-darwin-arm64` | `macos-latest`（Apple Silicon） |
| `remora-win32-x64.exe` | `windows-latest` |

各ジョブ: `actions/setup-node`（Node 22 の固定版。nodejs.org の公式ビルドを使う。ディストリの node は SEA のヒューズが無いことがある）→ `pnpm install --frozen-lockfile` → `pnpm build` → `node packages/cli/scripts/build-binaries.mjs` → `artifacts/cli/*` をアップロード。最後のジョブで全ファイルを集めて `sha256sum remora-* > SHA256SUMS`（ファイル名だけの行）を作り、`install.sh`／`install.ps1` と一緒にリリースへ添付します。

### macOS の署名

- ad-hoc 署名なので Gatekeeper の公証はありません。`curl` や `install.sh` で入れた場合は quarantine 属性が付かないので、そのまま動きます。ブラウザで落とした場合は `xattr -d com.apple.quarantine remora` が必要です。
- 正式に配るなら Developer ID で `codesign --sign "Developer ID Application: …" --options runtime --entitlements` し（JIT のため `com.apple.security.cs.allow-jit` と `allow-unsigned-executable-memory` が要る）、`notarytool` で公証します。生の実行ファイルはステープルできないため、公証は zip で行います。
- Windows も未署名です（SmartScreen の警告が出る場合があります）。

大きさは 1 本あたり約 110〜120 MB（Node 本体を含むため）です。
