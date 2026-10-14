---
name: cordis-plugin-development
description: DSH向けの独立したHost・UI・MCPプラグインを設計、実装、導入、検証する。配布・更新・解除の変更にも使う。
license: MIT
---

# DSHプラグインの開発

利用者が使えるbundleを、対象DSHの拡張点で実装します。設計・レビューだけの依頼では調査と指摘を返し、profileの変更まで進めません。

## 対象を確認する

対象DSHの版、利用するprofile、配布元、HostとClientの担当、既存設定を確認します。DSH内でinspectionが使えるなら必要なservice・event・slot・configを調べます。Codexなどでソースを読む場合は、対象版のREADME・型宣言・登録実装を確認します。存在しないinspection toolやmanager APIを仮定しません。

作業内容に応じて次だけを読みます。

| 作業 | 参照資料 |
| --- | --- |
| bundle、Host entry、Config、表示metadata | [Hostとbundle](references/host-plugin.md) |
| 設定ページ、panel、装飾、Client artifact | [UIプラグイン](references/ui-plugin.md) |
| MCP接続だけのbundle | [MCP](references/mcp-bundle.md) |
| 状態、context、event、他pluginとの併用 | [拡張点と共存](references/practices.md) |
| UI操作やagent toolの入口 | [操作と呼出し元](references/user-actions.md) |
| GitHub、npm、Releaseでの配布 | [配布](references/distribution.md) |
| 更新確認、自己更新、再起動、結果照合 | [更新](references/updates.md) |
| 導入、解除、旧版からの更新の確認 | [検証](references/verification.md) |

## 実装から確認へ

1. 必要なservice・provider・event・slotを選び、所有するcontextと解除処理を決めます。モデル指示や権限の変更は、依頼された範囲に限ります。
2. 作業用ディレクトリにmanifest・patch・実装を書きます。コード、辞書、CSS、icon等が公開物のentryから解決できる構成にします。
3. 設定入力、保存・通信、非同期処理の世代、失敗と取消を扱います。利用者のprofile内部を、独自installerで直接編集しません。
4. 新規pluginや公開entry・Loaderの変更では、対象のmanagerまたはCLIで隔離profileへ導入し、適用状態と機能を確認します。UIの変更は対象DSHの画面で確認します。
5. 新規pluginや資源の寿命を変える変更ではOFF/ON・削除を、保存形式や更新処理の変更では旧版からの更新・再起動後の反映を確認します。利用者の接続や保存設定へ触れた検証では、終了時の状態も記録します。

導入成功、slot登録、HTTP成功、実行版の反映は別の観測です。実行した範囲、導入元、対象版、残る未検証を報告します。追加機能や別の画面案は、依頼された目的に必要な場合に進めます。
