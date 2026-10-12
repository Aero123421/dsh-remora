# 開発

Node.js 22.19 以上と pnpm（`packageManager` に固定した版。`corepack enable` で入ります）が必要です。

## よく使うコマンド

```sh
pnpm install
pnpm typecheck      # TypeScript の型検査（protocol・プラグイン・CLI）
pnpm test           # node:test（TypeScript をそのまま実行）
pnpm build          # プラグインと CLI を dist/ にビルド
pnpm pack:plugin    # artifacts/dsh-remora-<版>.tgz と SHA256SUMS
pnpm vendor:sync    # protocol を hub/src/vendor/protocol に、ロゴを hub/public にコピー
pnpm vendor:check   # コピーが古くないか（CI でも実行）
pnpm hub:check      # hub/ の依存を入れて型検査とテスト
```

### 設定タブのビルドとオフライン

設定タブは DSH 公式の UI 部品（Switch・Button・Modal など）を、ルートの `upstream.json` に固定した DSH のソースからビルド時にコンパイルして使います。初回の `pnpm build` は `packages/client/ui-primitives` だけを sparse・blob なしで `packages/dsh-remora/.cache/upstream-<commit>/` に取得します（git とネットワークが必要）。オフラインでは、同じコミットの DSH チェックアウトを指定します。

```sh
DSH_UPSTREAM_DIR=/path/to/deepseek-harness pnpm build
```

ハブは pnpm のワークスペースに入れていません。Deploy to Cloudflare ボタンが `hub/` だけを複製してビルドするため、`hub/` は自分の `package-lock.json` を持ちます。

```sh
cd hub
npm ci
npm run dev         # wrangler dev（http://127.0.0.1:8787）
npm run typecheck   # wrangler types → tsc
npm test
```

## 決まりごと

- DSH のパッケージは依存に入れません。プラグインが触る DSH の API は `packages/dsh-remora/src/dsh.ts` に型を書き、アダプタ層からだけ使います。
- プラグインの `peerDependencies` は DSH の互換性チェック用です（`@deepseek-ai/dsh` の範囲だけ）。ワークスペースには `autoInstallPeers: false` を設定しています。
- 配布するプラグインは実行時の依存なし、インストール時のスクリプトなしです。`pack:plugin` は `scripts` と `devDependencies` を外した `package.json` で固めます。
- TypeScript は型を消すだけで動く書き方に限ります（`erasableSyntaxOnly`）。テストは Node が `.ts` をそのまま読みます。
- 操作を追加するときは `packages/protocol/src/operations.ts` に足し、`packages/dsh-remora/src/features.ts` に必要な DSH サービスを書きます。中核ツールの名前と説明文は変えません。
- プラグインのデータは `$DSH_HOME/storages/dsh-remora/` の JSON（スキーマ版数つき、tmp → rename で原子的に書く）、ホスト鍵は `ctx.credentials`（無ければ `host-key.json`、どちらも平文・0600）に置きます。
- 設定 RPC で権限や範囲を広げる変更は、ループバックの DSH Web からだけ受け付けます（`src/routes.ts` の `isLocalRequest`）。狭める変更と緊急停止はどこからでも可。
- ハブへの WebSocket がプロキシを通るのは、DSH を `NODE_USE_ENV_PROXY=1` で起動したときだけです（Node 22.21 以上。Node 22.22 で確認）。
- 外から答えられる質問は `tool-ask-user` が `timed` モードのものだけです。プランの確認と承認は外から答えられません。
- `packages/protocol` や `assets/` のロゴを変えたら `pnpm vendor:sync` を実行し、`hub/` 側のコピーも一緒にコミットします。

## 確認済みのこと（2026-10-12）

- protocol・プラグイン・CLI・ハブのテストと型検査が通る
- `wrangler dev` でハブを起動し、トップページ（CSP 付き）、アイコンの静的配信、`/mcp` の 501、ホスト用 WebSocket のチャレンジ送信・キープアライブの自動応答・プロトコル不一致での切断・未実装の認証での切断を確認

DSH 実機へのインストールと、Cloudflare への実デプロイはまだです。

## リリース（予定）

タグ `v<版>` で、プラグインの tarball と `SHA256SUMS`、CLI の単体実行ファイルとインストールスクリプトを GitHub Releases に置きます。プラグイン・CLI・ハブは同じ版番号にします。
