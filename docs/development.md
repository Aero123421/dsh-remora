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

- DSH の実行時依存は配布物に追加しません。更新処理の型検査だけに、固定版の plugin-manager 型を開発依存として使います。起動・終了処理と設定 RPC の型は `src/dsh.ts`、操作で使うサービスの型は `src/adapter/dsh-types.ts` に置きます。DSH の操作はアダプタ層から呼びます。
- プラグインの `peerDependencies` は DSH の互換性チェック用です（`@deepseek-ai/dsh` の範囲だけ）。ワークスペースには `autoInstallPeers: false` を設定しています。
- 配布するプラグインは実行時の依存なし、インストール時のスクリプトなしです。`pack:plugin` は `scripts` と `devDependencies` を外した `package.json` で固めます。
- TypeScript は型を消すだけで動く書き方に限ります（`erasableSyntaxOnly`）。テストは Node が `.ts` をそのまま読みます。
- 操作を追加するときは `packages/protocol/src/operations.ts` に足し、`packages/dsh-remora/src/features.ts` に必要な DSH サービスを書きます。中核ツールの名前と説明文は変えません。
- プラグインのデータは `$DSH_HOME/storages/dsh-remora/` の JSON（スキーマ版数つき、tmp → rename で原子的に書く）、ホスト鍵は `ctx.credentials`（無ければ `host-key.json`、どちらも平文・0600）に置きます。
- 設定 RPC で権限や範囲を広げる変更は、ソケット接続元と Host・Origin がループバックの場合だけ受け付けます（`src/routes.ts` の `isLocalRequest`）。狭める変更と緊急停止はどこからでも可。
- ハブへの WebSocket がプロキシを通るのは、DSH を `NODE_USE_ENV_PROXY=1` で起動したときだけです（Node 22.21 以上。Node 22.22 で確認）。
- 質問・プランの確認・承認への外からの回答は `src/adapter/answerer.ts` が DSH の waterfall に入って受け付けます。`timed` モードの質問は `userQuestions.answer` で答えます。承認はパスキー確認が既定で、DSH 側のスイッチで MCP・CLI からも許可できます。
- `packages/protocol` や `assets/` のロゴを変えたら `pnpm vendor:sync` を実行し、`hub/` 側のコピーも一緒にコミットします。

## DSH 0.2.1-alpha.3

`upstream.json` は `2fbf435`（0.2.1-alpha.3、2026-10-14）です。`peerDependencies` の `@deepseek-ai/dsh` は `>=0.2.1-alpha.2 <0.2.2-0` のままです。DSH は `semver.satisfies(runtime, range, { includePrerelease: true })` で見るので、0.2.1-alpha.3 と、それ以降の 0.2.1 プレリリース（`alpha.10`、`beta`、`rc` を含む）および 0.2.1 ではプラグインを読み飛ばしません。`0.2.2-alpha.1` 以降はこの範囲の外で、DSH は起動時に読み飛ばします。

HMR のあるプロファイルでは、導入済みパッケージへの `installBundle` はファイルを変えずに `already-installed` で失敗します。自己更新はそのときだけ `removeBundle` してから、外す前のオン／オフで入れ直します。HMR がない取り外しが `stop-profile` のときは、入ったままのパッケージへ `installBundle` します。取り外しがそれ以外で失敗したときは入れ直しません。

CI のジョブ `Adapter compat (latest DSH alpha)` は、`dsh-v*-alpha.*` で最も新しいタグのコミットに `DSH_UPSTREAM_COMMIT` を渡して `pnpm --filter dsh-remora test:compat` を実行します。ローカルの `test:compat` は `upstream.json` のコミットです。

## v0.1.2 の追加検証（2026-10-13）

権限取り消し後の操作・遅延応答、タスクの配達とキャンセル、ペアリングの中断と複数インスタンス、設定画面の古い応答、更新処理の回帰テストを追加しました。protocol・プラグイン・CLI のテスト計 370 件、ハブの単体テスト 15 件と結合テスト 51 件、固定 DSH ソースとの互換テスト 15 件、厳密モードの通しテスト 43 項目を確認しています。通しテストのモデル応答は模擬プロバイダです。変更点と更新時の注意は [v0.1.2 のリリースノート](releases/v0.1.2.md) に記載しています。

## v0.1.1 時点の確認記録（2026-10-13）

- protocol・プラグイン・CLI の単体テスト（計 285 件）と型検査、ハブの単体テスト 15 件と結合テスト（workerd 上、35 件）が通る
- 公式 DSH のソース（`upstream.json` の固定コミット）と組み合わせた互換テスト 15 件が通る（`pnpm --filter dsh-remora test:compat`）。答えが来るまで止まる質問と承認を、本物の waterfall で受け付けて答えるところ、本物の `sessionController.fork`、自動タスク（1 回きりのものが実際にターンとして届く）、サブプロセスでのコマンド実行を含む
- npm 版の DSH 0.2.1-alpha.2 と `wrangler dev` のハブで、通しテスト 43 項目が `--strict` で通る（`pnpm e2e`、[docs/e2e.md](e2e.md)）: 設定タブの表示、緊急停止、パスキー登録、ペアリング、トークン発行、タスク投入から完了、要対応への回答（DSH Web を開いたまま／閉じたまま、ハブの回答ページから）、承認（パスキーなしは断られ、ハブでパスキーを使って許可、DSH 側のスイッチをオンにすると API から拒否）、会話の検索、フォーク、バックグラウンドジョブの一覧・出力・停止、スケジュールの追加・削除と配達、ターミナル（「依頼できる」のトークンは断られ、リモート全権でハブの画面からパスキーで確認して実行・拒否）、監査ログの書き出し（API からの依頼をハブでパスキーで承認し、ハッシュ連鎖をハブの外で検査）、ホスト鍵の更新（実際のプラグインが新しい鍵でつなぎ直し、古い鍵が DSH の資格情報ストアから消える）、緊急停止の強制、別端末からの表示と制限
- 作業に関わっていないレビュアーによるセキュリティレビューと、指摘の修正の再確認。検索・フォーク・ジョブ・スケジュール・ターミナル・ハブの保守は別のレビュアーが見直し、指摘（検索語で秘密を当てられること、Remora 経由のスケジュールが取り消し後も残ること、監査の確認位置の甘さ、鍵の入れ替えの書き込み順、見えない文字の取りこぼしなど）を直し、同じレビュアーが修正を確かめた（そこで出た追加の指摘も直した）

まだ確かめていないこと: 実際の ChatGPT・Claude からの接続（OAuth と MCP。`dsh_terminal_run` の `confirmUrl` をクライアントが利用者に見せるかを含む）、CLI の `terminal`・`schedules`・`audit verify`・`hub export`・`rotate-key` などを実際のハブに向けて使うこと（偽のハブでのテストのみ。同じ操作を HTTP API で呼ぶところは通しテストで確認）、Cloudflare への実デプロイと無料枠の実使用量、実機のスマホへの Web Push、macOS・Windows での CLI とキーチェーン、プロキシ環境での接続、タブからの質問モード切り替え、プランの確認（プランモード）を実 DSH で外から答えること、フックなどツール実行前の確認から出る承認。

## リリース

プラグイン・CLI・ハブを同じ版番号にそろえ（`pnpm check:version`）、タグ `v<版>` を push すると `.github/workflows/release.yml` が検査・通しテスト・ビルドを行い、プラグインの tarball、5 種類の CLI 実行ファイル、インストールスクリプト、まとめた `SHA256SUMS` とビルド来歴を GitHub Releases に置きます。
