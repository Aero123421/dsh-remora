# UIプラグイン

表示先のslotとprops、登録オプション、locale、theme tokenを対象DSHで確認してから画面を作ります。settings内のpanelと、独立したpageでは使える幅と寿命が異なります。

## Client artifact

Hostとは別のClient entryと `dsh.client` 宣言を用意します。`./client` export、依存serviceのinject、runtime importの扱いを、対象版のLoaderへ合わせます。通常のNode用bundleをそのままブラウザーへ渡しません。

基準版のplain JSでは、package名に一致するClient factoryをmodule tableへ登録し、Reactもそのtableから使います。module factory内は副作用を持たせず、登録は `apply` へ置きます。compiled Clientの場合は対象版の出力形式とexternalを確認します。

`dsh.client.inject` はCordisのactivation順序・依存です。それだけでClient packageを `import` / `require` できるとは限りません。公開import契約を確認できないprimitiveは、tokenと既存の操作パターンへ合わせたlocal componentを使います。公式の[Client参照](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md)と[UIの前提](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md)が確認版の根拠です。

## 表示と寿命

slotが割り当てた場所にReact componentを表示します。rootを置き換えたり、別アプリを `document.body` に追加してsettings UIを再現したりしません。Portalが必要なoverlayも、自分のcomponentの寿命で解除します。

同じ目的のrow・control・spacing・fontを既存のDSH画面から選びます。色はtheme tokenを使い、日本語を含む製品文字列とaccessibility labelをlocaleへ置きます。モデル出力、入力値、wire IDは翻訳しません。

CSSはpluginのclassやrootに限定します。共有styleの変更が必要なら、設定前の値と自分が設定した値を記録し、他pluginの後続変更を上書きしない復元方法を選びます。observer、listener、timer、通信もOFF・slot解除で止めます。

## 検証する表示

設定内容領域の狭い幅、長い日本語ラベル、ライト・ダーク、scroll、menuの収まり、Escape・外側クリック・focusを確認します。保存中・失敗・古い応答・切断後の復帰も実際に操作します。登録済みという結果だけで描画を確認済みとしません。
