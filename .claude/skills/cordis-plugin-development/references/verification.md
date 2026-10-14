# プラグインの検証

配布予定のGitHub tag・tarballと、対象DSHの隔離profileを使います。workspace symlinkで通った結果だけを配布物の成功としません。

## 確認を分ける

| 確認 | 観測するもの |
| --- | --- |
| file | manifest、entry、patch、資源、licenseと実際の配布byte |
| Loader | 依存解決、Config、activation診断、managerの適用結果 |
| 機能 | 実agentのtool一覧・呼出し、provider要求、route、保存 |
| Client | 表示、locale、幅、操作、失敗、切断・復帰 |
| 解除 | OFF、uninstall、slot終了で登録・通信・process・CSSが残らない |
| 更新 | 旧設定、ON/OFF、資格情報、導入版・再起動後の実行版 |

対象の `package.json` にあるコマンドから、変更を確かめるtypecheck・lint・build・テストを選びます。境界の回帰は、同期throw、世代交代、権限拒否、取消、部分保存等を制御して再現します。

ブラウザーが使えない場合は、出力と登録を確認し、描画・操作は未確認とします。API鍵がない場合はmockや記録済み応答でadapterを確認し、実認証・実API成功へ広げません。

確認したDSH版、plugin commit、導入元、コマンド、操作、結果を報告します。作者の試験件数やCI成功、Issue closeは、今回実行した検証へ加算しません。
