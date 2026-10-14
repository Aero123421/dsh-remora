# 更新確認・導入・反映

モデルcatalogの取得、外部binaryの更新、plugin packageの更新、DSH Hostの更新、ブラウザーの再読込を区別します。更新機能が依頼されていない小さなpluginへ独自updaterを一律に足しません。

## 候補と導入

対象版のplugin managerが何を提供するか確認します。汎用の `update()` / `checkForUpdates()` があると仮定せず、候補の取得とコード導入を分けます。managerを使えない場合は、機能本体を止めず、対応する手動の導入元を案内します。

repository、package、channel、assetの選定はHost側で持ちます。Release/tag/asset/manifest/対応DSHを照合し、SemVerで比較します。通信失敗・不正metadata・互換性不明を「最新版です」へ変換しません。

checksumを使う配布経路では、候補IDと実byteを固定し、HTTPS・redirect先・timeout・累積サイズ・archiveのpathを検査します。checksumの元とtarballを照合したことは、作者認証やruntime成功と同じではありません。

導入はmanagerへ委譲し、事前のON/OFFを明示して維持します。再読込した導入状態で候補を再検査し、別Clientが導入した新版を古い候補で下げません。既存profileの設定・資格情報を保持します。

## 操作の寿命

profile、接続世代、操作ID、候補、実行結果を対応させます。連打防止は同一UIだけの制御なので、他Client・他pluginからの操作も共有managerの状態で扱います。

自己更新は古いpluginを解除して、返答の接続を切ることがあります。timeoutや通信切断では結果照合へ進み、導入要求を自動で再送しません。取消の受付、実処理の停止、保存・導入完了も分けます。operationの記録がprocess-localか永続かを確認し、存在しない履歴を再起動後に参照しません。

## 利用者へ返す状態

確認中、候補あり、導入中、失敗、結果不明、再起動待ち、実行版の反映を分けます。`restart-required` の場合、WebではHost再起動が必要です。導入版とRunning表示だけではClient metadataや新しい設定画面の反映を証明しません。

旧版→新版、OFFのままの更新、同時導入、切断直前・直後、再起動後を対象変更に応じて確認します。参照: [更新ボタン](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/update-button.md)、[Host再起動の事例](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/update-and-restart.md)。
