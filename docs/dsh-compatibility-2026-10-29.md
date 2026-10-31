# DSH 互換性確認（2026-10-29）

統合担当の独立 executor でも、npm latest `0.2.1-rc.2` で修正後の 11 plugin を併用するローカル smoke が成功しました。Host は宣言した互換範囲内でしたが、分離 prefix 構成の依存解決先の違いによる peer 警告は残っています。実アカウント、有料推論、全 OS、全機能の組合せは未検証です。

公式配布元は [npm の @deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)、本体は [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) です。当初確認時の dist-tag は次のとおりです。`latest` も RC であり、正式安定版を意味しません。公開 versions に prerelease でない版はありませんでした。

| channel | 版 | 公式コミット |
| --- | --- | --- |
| latest（基本の受入対象） | 0.2.1-rc.2 | [687f282e8625c6b8d11ff58211a90524be2e4317](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317) |
| next | 0.2.1-rc.4 | [504a01a9578abc2c6f1fb896b1dc322c9fe24f66](https://github.com/deepseek-ai/deepseek-harness/tree/504a01a9578abc2c6f1fb896b1dc322c9fe24f66) |
| alpha | 0.2.2-alpha.2 | [f3803c96974ad4a94195fb97e5c637e9c2a3afe3](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3) |

## 履歴の読み取り

0.2.2-alpha.2 では `sessionController.inspect()` がなくなっています。Remora は `inspect()` がある旧版ではその経路を使い、ない版では公開 [`events()`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/api/session-controller/src/history/controller.ts) のページを読みます。最初の cursor を `throughSeq` に固定し、古いページを `beforeSeq` でたどって時系列順に戻します。読み取りのために Agent を起こしません。subagent は durable parent を含む address を渡します。ページ間と応答後に取消を確認し、前へ進まないページは失敗として扱います。

`Watcher.refresh()` の直接 `inspect()` 呼び出しも同じ読み取り経路へ移しました。操作後の認可再確認を維持します。互換 peer の上限は確認済みの `0.2.2-alpha.2` とし、その後の alpha・RC・正式版を自動で許可しません。

0.2.2 のアプリケーション同意は、質問の `intent.kind` が `approval` になります。無関係な `ask_user_question` が保留中でも、その同意をツールの質問へ関連付けず、DSH の承認 UI へそのまま委譲します。再現 fixture と回帰テストで、質問の保持も signal の差し替えも起きないことを確認しました。

## 検証の境界

Linux x64、Node.js 24.19.0。DSH は公式 npm の固定版を独立ディレクトリへ導入しました。実アカウント、実 Hub、Cloudflare の認証・API・Tunnel、外部公開、モデル課金は使っていません。

- `adapter-history.test.ts` は注入した DSH API でページング、cursor 固定、subagent address、取消、非進行ページ、消失、認可失効を確認します。
- 最終差分で `pnpm check`（型検査、protocol 29 件、CLI 87 件、plugin 393 件、ビルド、vendor 一致）が成功し、互換検証スクリプトの回帰 4 件も成功しました。
- リポジトリの `test:compat` は 0.2.1-alpha.3（既存 pin）、latest 0.2.1-rc.2、next 0.2.1-rc.4、alpha 0.2.2-alpha.2 の公式ソースそれぞれで 16/16 成功しました。タスク投入・完了・キュー／実行中の取消、再起動後の読み取り、質問、承認、検索、fork、schedule、ローカル subprocess、範囲外拒否を確認します。モデル応答、未使用の周辺サービス、ファイルロック shim は fixture です。0.2.2 で分離された native tool executor を実サービスとして合成し、Remote gateway の pending-event 一覧だけ空の stub にしました。配布 CLI とブラウザーを通る検査とは別です。
- 隔離した npm DSH latest rc.2、next rc.4、alpha 0.2.2-alpha.2 に packed Remora と dsh-cf を同時導入し、設定 RPC、起動・停止・再起動、CF のローカル gate からの Remora 状態取得、gate からの全権拡大拒否を確認しました。rc.4 は導入順を逆にしても通過しました。3版とも Chromium で両設定画面を描画し、再起動後も開け、console/page error は 0 件でした。gate は生成 RSA/JWT の fixture で、実 Cloudflare ではありません。

最終 plugin tarball の SHA-256 は `94b77e5ca7ebb4beec9b372e6c089dd8894488dc714f6e60f7ed16f36a6b0008` です。版番号は公開版と同じ 0.1.7 ですが、公開済み資産を差し替える用途ではなくローカル検証用です。

既存の [PR #24](https://github.com/Aero123421/dsh-remora/pull/24) および [#21](https://github.com/Aero123421/dsh-remora/issues/21)、[#25](https://github.com/Aero123421/dsh-remora/issues/25)、[#26](https://github.com/Aero123421/dsh-remora/issues/26)、[#27](https://github.com/Aero123421/dsh-remora/issues/27) の修正は含めていません。実 Hub の認証、パスキー、ネットワーク経由の実モデル操作、macOS/Windows は未検証です。公開版 0.1.7 のタグ・資産は変更していません。

## 15:00 UTCの締切で追加したrc.5

公式 registry の `0.2.1-rc.5` 公開時刻は `2026-10-29T14:15:23.355Z` で、版確認締切 `2026-10-29T15:00:00Z` より前でした。締切時の next は rc.5、latest と alpha は上記のままです。公式 npm CLI tarball の SHA-256 は `60987566f19e0ded1f7918c00a65c19c56ea25f5977ee0bfd5697c5c113ec4e1` です。

rc.5 の公式 git tag は照合時に取得できなかったため、git のコミット同士の比較ではなく、公式 npm 配布物を比較しました。rc.4 → rc.5 の Remora 関連 37 package では型宣言 300 ファイルと JavaScript 233 ファイルがすべて byte 一致し、実行コード・peer・テストの追加変更は不要でした。rc.5 の正確な source commit は未照合です。

rc.5 の公式 npm 実サービスを元の module 位置から読み込む検証で 16/16 成功しました。モデルだけ rc.4 公式ソースの MockAdapter を使い、周辺 stub は従来の互換ハーネスと同じです。rc.5 の隔離 Host に同じ packed Remora + cf を導入した Chromium 設定表示、停止・再起動、HTTP/RPC/WS、gate 経由状態取得、権限拡大拒否も成功し、console/page error は 0 件でした。当初の rc.2 / rc.4 / alpha の結果はそのまま残し、締切後の新 release は今回の対象に追加しません。
