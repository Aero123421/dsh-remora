# Hostとbundle

bundleは `package.json` の `dsh.bundle.patch` が指すpatchをprofileへ追加します。Cordis entryだけを持つライブラリと、管理画面から導入するbundleを区別します。

## manifestとpatch

確認するのは、package名・版・ESM、runtimeのexports、patch、必要な依存、実配布物のfile一覧です。runtimeがない設定専用bundleには、空のHost/Client entryを足しません。Host entryがある場合は、関数 `apply` または対応するservice exportを、対象Loaderが読む形で公開します。

patchのrow IDとpackage名は衝突しない名前にします。既存rowへのoverrideは `config` 全体を置き換えるため、変更しない必要fieldも含めます。既存bundleを二重にinsertして機能を増やしたことにしません。

CordisやDSH SDKのpeer条件と、bundlerのexternalを別に確認します。宣言だけpeerにしても、出力へ別コピーを埋め込むとHostとのserviceや型の識別が分かれる可能性があります。

## metadataと資源

管理画面に出るtitle・descriptionを実機能に合わせ、locale JSONとiconを対象DSHの仕組みで公開します。`./locale/*.json` や `./icon` 等のexports、patch、辞書、icon、runtimeが配布物にあることを確認します。画像の利用条件と必要なnoticeも含めます。

保存key・credential scope・既存row IDは、表示名の変更だけでは変えません。対象DSHでmetadataが反映されることを確認し、fallbackや描画を見ていない場合はその範囲を残します。

## Configと解除

Configは読み込まれる値のschemaを持ち、後から判明する依存の不一致も診断できるようにします。秘密情報をClientへ返す設定snapshotに混ぜません。

`ctx.effect()` / `ctx.on()` とregistryのdisposerで登録を解除します。別contextへ登録する場合は、pluginと登録先のどちらの終了でも残らない所有関係にします。解除の途中で待機中の保存・再試行・子processが残る場合は、その完了と失敗を扱います。

## 導入

DSH内の `plugin_manager`、Hostのplugin manager、`dsh plugin` のうち、環境で使える入口へ導入を委譲します。返されたfailure、pending、override、restart-requiredを保ちます。解釈できない結果を成功へ変換しません。

`pendingBuilds` が返った場合は、実行待ちのscriptと既存の利用者の許可を確認します。返されたpendingのうち、その許可に含まれる名前だけを、再確認せず `approvedBuilds` へ渡せます。許可に含まれないものを自動補完や設定変更で許可しません。コードの導入と、依存build scriptの実行は別の許可です。根拠: [tool引数](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/tools.ts#L28)、[managerの許可範囲](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/README.md#L61)。installer設定で既に許可された名前はpendingではなく、再送すると [stale-approval](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/build-approval.ts#L75) になります。

公式の[Host参照資料](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md)に基準版のmetadata形式があります。別の版では、実際のexport・Config・manager結果を確認します。
