---
name: dsh-client-ui-ux
description: DSHプラグインの画面を設計・レビューし、既存UIへの適合、設定内容幅、locale、theme、menu、保存・失敗状態を確認する。
license: MIT
---

# DSHに合わせたUI

対象DSHの同じ種類の画面と、表示先のslot・props・tokenを確認します。設定panel、page、sidebar、overlayのどこに置くかを決めてから実装します。

## 表示

既存の色、文字サイズ、weight、余白、角丸、row、iconを使います。独立Clientでprimitiveをimportする場合は、その公開module契約を確認します。injectの宣言だけでimportできるとは判断しません。

ライト・ダークで文字の読みやすさを確認し、操作と説明の階層を揃えます。ラベル、tooltip、accessibility textはlocaleから出します。日本語や長いmodel名は省略後も識別できる形にします。

CSSはpluginの範囲へ限定し、共有theme/fontを変更する機能は解除時の所有を持ちます。設定panelの内容幅で折返し・control・scrollを確認します。viewport全体が広いことを理由に固定列数へしません。

## 操作とfeedback

保存待ちと保存済みを分け、失敗時は入力と既存データを残します。古い編集・接続の応答で新しい状態を消しません。

操作によって画面やメニューを閉じる場合は、閉じた後も結果を確認できるtoast等へ出します。画面が残る操作の結果、query失敗、field検証は、既存のその場の表示を使います。結果不明や継続する障害は、状態と次の操作を確認できる表示にします。

menu・popoverは外側クリックとEscape、focus、viewport内への配置、overflow親からのclippingを確認します。Portal、observer、timer、CSSはcomponent/pluginの解除で片付けます。

## 実画面で確認する

狭い内容幅、日本語、明暗、keyboard、保存中・失敗・切断、Desktopのwindow chromeを変更箇所に応じて確認します。調整は自分の領域で行い、1ページの問題をglobalな余白変更で隠しません。

スクリーンショット・GIFは確認に役立つ場合に使います。描画を確認できなければ、登録・buildまでの結果と残る未確認を報告します。例: [UIとフォント](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/ui.md)。
